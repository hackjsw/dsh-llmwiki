import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const MAX_FILE_BYTES = 64 * 1024 * 1024;
const compare = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function checkedBytes(root, parts, limit = MAX_FILE_BYTES) {
  let current = root;
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    const info = await fs.lstat(current);
    if (info.isSymbolicLink() || (index === parts.length - 1 ? !info.isFile() : !info.isDirectory()) ||
        compare(await fs.realpath(current)) !== compare(current)) throw new Error('unsafe or unavailable path');
  }
  const before = await fs.lstat(current);
  if (before.size > limit) throw new Error('file exceeds verification limit');
  const handle = await fs.open(current, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > limit) throw new Error('source changed');
    const chunks = [];
    let offset = 0;
    while (offset <= limit) {
      const block = Buffer.allocUnsafe(Math.min(65536, limit + 1 - offset));
      const { bytesRead } = await handle.read(block, 0, block.length, offset);
      if (!bytesRead) break;
      chunks.push(block.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = await handle.stat();
    const named = await fs.lstat(current);
    if (offset > limit || opened.size !== after.size || opened.mtimeMs !== after.mtimeMs ||
        opened.dev !== named.dev || opened.ino !== named.ino || named.isSymbolicLink()) throw new Error('source changed');
    return Buffer.concat(chunks, offset);
  } finally { await handle.close(); }
}

/** Compare the current copy with the import receipt; later edits are reported as drift. */
export async function verifyMigration(input) {
  if (!input || !path.isAbsolute(input)) throw new Error('Wiki root must be absolute');
  const root = await fs.realpath(input);
  const rootInfo = await fs.lstat(input);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || compare(root) !== compare(input)) throw new Error('unsafe Wiki root');
  const manifest = JSON.parse((await checkedBytes(root, ['.dsh-llm-wiki-import.json'], 1024 * 1024)).toString('utf8'));
  if (!Array.isArray(manifest.files) || !Array.isArray(manifest.skipped)) throw new Error('invalid migration receipt');
  const changedAfterImport = [];
  const unavailable = [];
  let unchanged = 0;
  for (const entry of manifest.files) {
    const parts = typeof entry.path === 'string' ? entry.path.split('/') : [];
    if (!parts.length || parts.some(part => !part || part === '.' || part === '..' || /[\\:\x00-\x1f]/.test(part))) throw new Error('invalid receipt path');
    try {
      const bytes = await checkedBytes(root, parts);
      if (bytes.length !== entry.size || hash(bytes) !== entry.sha256) changedAfterImport.push(entry.path);
      else unchanged++;
    } catch { unavailable.push(entry.path); }
  }
  return { copiedAtImport: manifest.files.length, unchanged, changedAfterImport, unavailable,
    omittedSourceFiles: manifest.skipped.length, reconstructedIndex: manifest.indexReconstructed,
    copyFinishedWithoutOmissions: manifest.skipped.length === 0,
    sourceConsistentAtLastCheck: manifest.sourceConsistency ? manifest.complete : null,
    sourceRecheckedAt: manifest.sourceConsistency?.checkedAt ?? null,
    sourceCopyStartedAt: manifest.createdAt };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  verifyMigration(process.argv[2]).then(result => {
    console.log(JSON.stringify(result, null, 2));
    if (result.unavailable.length) process.exitCode = 1;
  }).catch(error => { console.error(`verification failed: ${error.message}`); process.exitCode = 1; });
}
