import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 100_000;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const compare = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const safeParts = relative => typeof relative === 'string' && relative.split('/').every(part => part && part !== '.' && part !== '..' && !/[\\:\x00-\x1f]/.test(part));
const sameFile = (a, b) => a.isFile() && b.isFile() && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;

async function regularBytes(file, withStat = false) {
  const before = await fs.lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_FILE_BYTES || compare(await fs.realpath(file)) !== compare(file)) throw new Error('UNSAFE_SOURCE');
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!sameFile(before, opened)) throw new Error('SOURCE_CHANGED');
    const chunks = [];
    let offset = 0;
    while (offset <= MAX_FILE_BYTES) {
      const block = Buffer.allocUnsafe(Math.min(65536, MAX_FILE_BYTES + 1 - offset));
      const { bytesRead } = await handle.read(block, 0, block.length, offset);
      if (!bytesRead) break;
      chunks.push(block.subarray(0, bytesRead));
      offset += bytesRead;
    }
    if (offset > MAX_FILE_BYTES) throw new Error('SIZE_LIMIT');
    const bytes = Buffer.concat(chunks, offset);
    const after = await handle.stat();
    const named = await fs.lstat(file);
    if (!sameFile(opened, after) || !sameFile(opened, named) || bytes.length !== opened.size) throw new Error('SOURCE_CHANGED');
    return withStat ? { bytes, stat: named } : bytes;
  } finally { await handle.close(); }
}

async function ensureDestinationDirectory(root, parts) {
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    await fs.mkdir(current, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const info = await fs.lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink() || compare(await fs.realpath(current)) !== compare(current)) throw new Error('UNSAFE_DESTINATION');
  }
}

/** Retry only recorded omissions after the owner has restored read access. */
export async function resumeMigration({ source, destination, permissionRestored = false }) {
  if (!permissionRestored) throw new Error('permission repair must be confirmed before retrying source files');
  if (!path.isAbsolute(source) || !path.isAbsolute(destination)) throw new Error('source and destination must be absolute');
  const sourceRoot = await fs.realpath(source);
  const destRoot = await fs.realpath(destination);
  if (compare(sourceRoot) !== compare(source) || compare(destRoot) !== compare(destination) || compare(sourceRoot) === compare(destRoot)) throw new Error('unsafe migration roots');
  const receiptPath = path.join(destRoot, '.dsh-llm-wiki-import.json');
  const lockPath = path.join(destRoot, '.dsh-llm-wiki-resume.lock');
  const temp = path.join(destRoot, `.dsh-llm-wiki-resume-${randomUUID()}.tmp`);
  let lock;
  let tempCreated = false;
  try {
    lock = await fs.open(lockPath, 'wx', 0o600);
    const originalBytes = await regularBytes(receiptPath);
    if (originalBytes.length > 1024 * 1024) throw new Error('receipt too large');
    const originalHash = hash(originalBytes);
    const receipt = JSON.parse(originalBytes.toString('utf8'));
    if (!Array.isArray(receipt.files) || !Array.isArray(receipt.skipped) || compare(receipt.source) !== compare(sourceRoot) || compare(receipt.destination) !== compare(destRoot)) throw new Error('receipt does not match these roots');
    const remaining = [];
    const recovered = [];
    let visited = 0;

    async function recover(item, depth = 0) {
      if (!safeParts(item.path) || depth > 64 || ++visited > MAX_ENTRIES) {
        remaining.push({ path: item.path, reason: item.reason, lastError: 'UNSAFE_OR_LIMITED_PATH' });
        return;
      }
      const input = path.join(sourceRoot, ...item.path.split('/'));
      const outputRel = item.path === 'index.md' ? 'import-evidence/hermes-index.original.md' : item.path;
      const outputParts = outputRel.split('/');
      const output = path.join(destRoot, ...outputParts);
      try {
        const sourceInfo = await fs.lstat(input);
        if (sourceInfo.isSymbolicLink() || compare(await fs.realpath(input)) !== compare(input)) throw new Error('UNSAFE_SOURCE');
        if (sourceInfo.isDirectory()) {
          await ensureDestinationDirectory(destRoot, outputParts);
          const children = await fs.readdir(input, { withFileTypes: true });
          if (!children.length) recovered.push({ source: item.path, destination: outputRel, directory: true });
          for (const child of children) await recover({ path: `${item.path}/${child.name}`, reason: item.reason }, depth + 1);
          return;
        }
        if (!sourceInfo.isFile()) throw new Error('UNSAFE_SOURCE');
        await ensureDestinationDirectory(destRoot, outputParts.slice(0, -1));
        const bytes = await regularBytes(input);
        const digest = hash(bytes);
        let created = false;
        let outputHandle;
        try {
          outputHandle = await fs.open(output, 'wx', 0o600);
          created = true;
          await outputHandle.writeFile(bytes);
          await outputHandle.sync();
          await outputHandle.close();
          outputHandle = undefined;
        } catch (error) {
          await outputHandle?.close().catch(() => {});
          if (created) {
            try { await fs.unlink(output); }
            catch { throw new Error('OUTPUT_CLEANUP_UNKNOWN'); }
          }
          if (error.code !== 'EEXIST') throw error;
        }
        const written = await regularBytes(output);
        if (hash(written) !== digest) throw new Error('TARGET_CONFLICT');
        const previous = receipt.files.find(entry => entry.path === outputRel);
        if (previous && (previous.sha256 !== digest || previous.size !== bytes.length)) throw new Error('RECEIPT_CONFLICT');
        if (!previous) {
          receipt.files.push({ path: outputRel, ...(item.path === outputRel ? {} : { sourcePath: item.path }), size: bytes.length, sha256: digest });
          receipt.totalBytes += bytes.length;
        }
        if (item.path === 'index.md') receipt.originalIndexRetained = true;
        recovered.push({ source: item.path, destination: outputRel });
      } catch (error) {
        remaining.push({ path: item.path, reason: item.reason, lastError: error.code || error.message || 'READ_OR_WRITE_ERROR' });
      }
    }

    for (const item of receipt.skipped) {
      if (!safeParts(item.path) || !['PREVIOUSLY_DENIED', 'EPERM', 'EACCES'].includes(item.reason)) { remaining.push(item); continue; }
      await recover(item);
    }
    // A recovery may happen days later. Recheck every copied source against the
    // original bytes so a mixed-time copy is never labelled a complete snapshot.
    const sourceDrift = [];
    const sourceUnavailable = [];
    const sourceRevisions = new Map();
    for (const entry of receipt.files) {
      const relative = entry.sourcePath || entry.path;
      if (!safeParts(relative)) { sourceUnavailable.push(String(relative)); continue; }
      try {
        const snapshot = await regularBytes(path.join(sourceRoot, ...relative.split('/')), true);
        sourceRevisions.set(relative, snapshot.stat);
        if (snapshot.bytes.length !== entry.size || hash(snapshot.bytes) !== entry.sha256) sourceDrift.push(relative);
      } catch { sourceUnavailable.push(relative); }
    }
    const represented = new Set(receipt.files.map(entry => entry.sourcePath || entry.path));
    const sourceAdded = [];
    const inventoryUnavailable = [];
    let inventoried = 0;
    async function inventory(dir, relative = '', depth = 0) {
      if (depth > 64 || ++inventoried > MAX_ENTRIES) { inventoryUnavailable.push(relative || '.'); return; }
      let children;
      try {
        const info = await fs.lstat(dir);
        if (!info.isDirectory() || info.isSymbolicLink() || compare(await fs.realpath(dir)) !== compare(dir)) throw new Error('UNSAFE_SOURCE');
        children = await fs.readdir(dir, { withFileTypes: true });
      } catch { inventoryUnavailable.push(relative || '.'); return; }
      for (const child of children) {
        const childPath = relative ? `${relative}/${child.name}` : child.name;
        if (++inventoried > MAX_ENTRIES) { inventoryUnavailable.push(childPath); return; }
        if (!safeParts(childPath)) { inventoryUnavailable.push(childPath); continue; }
        if (child.isDirectory() && !child.isSymbolicLink()) await inventory(path.join(dir, child.name), childPath, depth + 1);
        else if (!represented.has(childPath)) sourceAdded.push(childPath);
      }
    }
    await inventory(sourceRoot);
    for (const [relative, previous] of sourceRevisions) {
      try {
        const latest = await fs.lstat(path.join(sourceRoot, ...relative.split('/')));
        if (!sameFile(previous, latest) && !sourceDrift.includes(relative)) sourceDrift.push(relative);
      } catch { if (!sourceUnavailable.includes(relative)) sourceUnavailable.push(relative); }
    }
    receipt.skipped = remaining;
    receipt.lastResumedAt = new Date().toISOString();
    receipt.sourceConsistency = { checkedAt: receipt.lastResumedAt, drifted: sourceDrift, unavailable: sourceUnavailable,
      added: sourceAdded, inventoryUnavailable };
    receipt.complete = remaining.length === 0 && sourceDrift.length === 0 && sourceUnavailable.length === 0 &&
      sourceAdded.length === 0 && inventoryUnavailable.length === 0;
    const out = await fs.open(temp, 'wx', 0o600);
    tempCreated = true;
    try { await out.writeFile(`${JSON.stringify(receipt, null, 2)}\n`); await out.sync(); } finally { await out.close(); }
    if (hash(await regularBytes(receiptPath)) !== originalHash) throw new Error('receipt changed; inspect recovered files before retrying');
    await fs.rename(temp, receiptPath);
    tempCreated = false;
    return { complete: receipt.complete, recovered, skipped: remaining, sourceConsistency: receipt.sourceConsistency };
  } finally {
    if (tempCreated) await fs.unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (lock) { await lock.close(); await fs.unlink(lockPath); }
  }
}

async function main() {
  const [, , source, destination, flag] = process.argv;
  if (!source || !destination || flag !== '--permissions-fixed') throw new Error('usage: node scripts/resume-migration.js SOURCE DESTINATION --permissions-fixed');
  const result = await resumeMigration({ source, destination, permissionRestored: true });
  console.log(JSON.stringify(result, null, 2));
  if (!result.complete) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(`migration recovery failed: ${error.message}`); process.exitCode = 1; });
}
