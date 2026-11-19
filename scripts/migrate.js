import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;

function inside(root, item) {
  const rel = path.relative(root, item);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function sameFile(before, after) {
  return before.isFile() && after.isFile() && before.dev === after.dev && before.ino === after.ino &&
    before.size === after.size && before.mtimeMs === after.mtimeMs;
}

async function exists(file) {
  try { await fs.lstat(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function rebuiltIndex(paths) {
  const groups = ['entities', 'concepts', 'comparisons', 'queries'];
  const lines = [
    '# DSH LLM Wiki 导航',
    '',
    '> 此索引由迁移时实际复制的文件名重建；源索引读取失败，未将其内容复制。',
    '> 本页仅用于导航，页面是否有效以正文的来源、状态和复核时间为准。',
    '',
    '- [当前状态（Hermes 迁移快照）](CURRENT_STATE.md)',
    '- [结构和管理规则](SCHEMA.md)',
  ];
  for (const group of groups) {
    const entries = paths.filter(item => item.startsWith(`${group}/`) && item.toLowerCase().endsWith('.md')).sort();
    if (!entries.length) continue;
    lines.push('', `## ${group}`, '');
    for (const entry of entries) {
      const label = path.posix.basename(entry, '.md').replaceAll('[', '\\[').replaceAll(']', '\\]');
      lines.push(`- [${label}](${entry.split('/').map(encodeURIComponent).join('/')})`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/** Copy a snapshot into a new destination. Never overwrite or mutate the source. */
export async function migrateWiki({ source, destination, skipKnownDeniedIndex = true }) {
  if (!path.isAbsolute(source) || !path.isAbsolute(destination)) throw new Error('source and destination must be absolute');
  const sourceRoot = await fs.realpath(source);
  const sourceStat = await fs.lstat(source);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) throw new Error('source must be a real directory');
  const destinationPath = path.resolve(destination);
  const destinationParent = await fs.realpath(path.dirname(destinationPath));
  const actualDestination = path.join(destinationParent, path.basename(destinationPath));
  if (inside(sourceRoot, actualDestination) || inside(actualDestination, sourceRoot)) throw new Error('source and destination overlap');
  if (await exists(actualDestination)) throw new Error('destination already exists');
  const staging = path.join(destinationParent, `.${path.basename(destinationPath)}-import-${randomUUID()}`);
  await fs.mkdir(staging, { mode: 0o700 });
  const report = { version: 1, source: sourceRoot, destination: actualDestination,
    createdAt: new Date().toISOString(), files: [], skipped: [], totalBytes: 0, indexReconstructed: false };
  const failed = (rel, reason) => report.skipped.push({ path: rel, reason: String(reason || 'UNKNOWN') });

  async function visit(from, relative = '') {
    let entries;
    try { entries = await fs.readdir(from, { withFileTypes: true }); }
    catch (error) { failed(relative || '.', error.code); return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      if (rel === 'index.md' && skipKnownDeniedIndex) { failed(rel, 'PREVIOUSLY_DENIED'); continue; }
      const sourceFile = path.join(from, entry.name);
      const destinationFile = path.join(staging, ...rel.split('/'));
      if (!inside(staging, destinationFile)) { failed(rel, 'UNSAFE_PATH'); continue; }
      if (entry.isSymbolicLink()) { failed(rel, 'SYMLINK_OR_JUNCTION'); continue; }
      if (entry.isDirectory()) {
        await fs.mkdir(destinationFile, { mode: 0o700 });
        await visit(sourceFile, rel);
        continue;
      }
      if (!entry.isFile()) { failed(rel, 'UNSUPPORTED_FILE_TYPE'); continue; }
      let handle;
      let outputHandle;
      let writingDestination = false;
      try {
        const before = await fs.lstat(sourceFile);
        if (before.isSymbolicLink() || !before.isFile()) { failed(rel, 'UNSAFE_FILE'); continue; }
        if (before.size > MAX_FILE_BYTES || report.totalBytes + before.size > MAX_TOTAL_BYTES) { failed(rel, 'SIZE_LIMIT'); continue; }
        handle = await fs.open(sourceFile, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
        const opened = await handle.stat();
        if (!sameFile(before, opened)) { failed(rel, 'SOURCE_CHANGED'); continue; }
        const bytes = await handle.readFile();
        const after = await handle.stat();
        if (!sameFile(opened, after) || bytes.length !== opened.size) { failed(rel, 'SOURCE_CHANGED'); continue; }
        outputHandle = await fs.open(destinationFile, 'wx', 0o600);
        writingDestination = true;
        await outputHandle.writeFile(bytes);
        await outputHandle.close();
        outputHandle = undefined;
        const written = await fs.readFile(destinationFile);
        const digest = hash(bytes);
        if (hash(written) !== digest) {
          await fs.unlink(destinationFile);
          writingDestination = false;
          failed(rel, 'VERIFY_FAILED');
          continue;
        }
        const namedAfter = await fs.lstat(sourceFile);
        if (!sameFile(opened, namedAfter)) {
          await fs.unlink(destinationFile);
          writingDestination = false;
          failed(rel, 'SOURCE_CHANGED');
          continue;
        }
        report.files.push({ path: rel, size: bytes.length, sha256: digest });
        report.totalBytes += bytes.length;
        writingDestination = false;
      } catch (error) {
        await outputHandle?.close().catch(() => {});
        outputHandle = undefined;
        if (writingDestination) await fs.unlink(destinationFile).catch(cleanup => {
          if (cleanup.code !== 'ENOENT') throw cleanup;
        });
        failed(rel, error.code || 'READ_OR_WRITE_ERROR');
      } finally {
        await outputHandle?.close();
        await handle?.close();
      }
    }
  }

  try {
    await visit(sourceRoot);
    if (skipKnownDeniedIndex) {
      const text = rebuiltIndex(report.files.map(file => file.path));
      await fs.writeFile(path.join(staging, 'index.md'), text, { flag: 'wx', mode: 0o600 });
      report.indexReconstructed = true;
    }
    const result = { ...report, complete: report.skipped.length === 0 };
    // Keep the evidence alongside the snapshot before publication, never in the source.
    await fs.writeFile(path.join(staging, '.dsh-llm-wiki-import.json'), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    if (await exists(actualDestination)) throw new Error('destination appeared during migration');
    // Publish only after the snapshot and its receipt are complete.
    await fs.rename(staging, actualDestination);
    return result;
  } catch (error) {
    // Keep a failed staging directory for inspection; never remove an unverified tree.
    error.staging = staging;
    throw error;
  }
}

async function main() {
  const [, , source, destination] = process.argv;
  if (!source || !destination) {
    throw new Error('usage: node scripts/migrate.js ABSOLUTE_SOURCE ABSOLUTE_DESTINATION');
  }
  const result = await migrateWiki({ source, destination });
  console.log(JSON.stringify({ complete: result.complete, copiedFiles: result.files.length,
    totalBytes: result.totalBytes, skipped: result.skipped, indexReconstructed: result.indexReconstructed }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(`migration failed: ${error.message}`); process.exitCode = 1; });
}
