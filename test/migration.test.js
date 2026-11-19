import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { migrateWiki } from '../scripts/migrate.js';
import { verifyMigration } from '../scripts/verify-migration.js';
import { MemoryStore } from '../lib/memory.js';
import { resumeMigration } from '../scripts/resume-migration.js';

async function fixture(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-wiki-migration-test-'));
  assert.equal(path.dirname(temp), path.resolve(os.tmpdir()));
  assert.match(path.basename(temp), /^dsh-wiki-migration-test-/);
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const source = path.join(temp, 'source');
  const destination = path.join(temp, 'destination');
  await fs.mkdir(path.join(source, 'concepts'), { recursive: true });
  await fs.mkdir(path.join(source, 'entities'), { recursive: true });
  await fs.mkdir(path.join(source, 'raw'), { recursive: true });
  await fs.writeFile(path.join(source, 'index.md'), '# Original navigation\n');
  await fs.writeFile(path.join(source, 'CURRENT_STATE.md'), '# Source state\n');
  await fs.writeFile(path.join(source, 'SCHEMA.md'), '# Source schema\n');
  await fs.writeFile(path.join(source, 'log.md'), '# Source log\n');
  await fs.writeFile(path.join(source, 'concepts', '示例.md'), '# Example\n');
  await fs.writeFile(path.join(source, 'raw', 'index.md'), '# Historical original\n');
  return { temp, source, destination };
}

test('copies a complete snapshot byte-for-byte and refuses overwrite', async t => {
  const { source, destination } = await fixture(t);
  const result = await migrateWiki({ source, destination, skipKnownDeniedIndex: false });
  assert.equal(result.complete, true);
  assert.equal(result.files.length, 6);
  assert.equal(await fs.readFile(path.join(destination, 'index.md'), 'utf8'), '# Original navigation\n');
  assert.equal(await fs.readFile(path.join(source, 'concepts', '示例.md'), 'utf8'), '# Example\n');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(destination, '.dsh-llm-wiki-import.json'), 'utf8')), result);
  await assert.rejects(migrateWiki({ source, destination }), /destination already exists/);
  assert.equal(await fs.readFile(path.join(destination, 'index.md'), 'utf8'), '# Original navigation\n');
});

test('records a previously denied root index and rebuilds only the navigation page', async t => {
  const { source, destination } = await fixture(t);
  const result = await migrateWiki({ source, destination });
  assert.equal(result.complete, false);
  assert.deepEqual(result.skipped, [{ path: 'index.md', reason: 'PREVIOUSLY_DENIED' }]);
  assert.equal(result.indexReconstructed, true);
  assert.match(await fs.readFile(path.join(destination, 'index.md'), 'utf8'), /导航/);
  assert.equal(await fs.readFile(path.join(destination, 'raw', 'index.md'), 'utf8'), '# Historical original\n');
  assert.equal(await fs.readFile(path.join(source, 'index.md'), 'utf8'), '# Original navigation\n');
});

test('permission-confirmed recovery retains the original index without overwriting the rebuilt one', async t => {
  const { source, destination } = await fixture(t);
  await migrateWiki({ source, destination });
  const rebuilt = await fs.readFile(path.join(destination, 'index.md'), 'utf8');
  await assert.rejects(resumeMigration({ source, destination }), /permission repair must be confirmed/);
  const result = await resumeMigration({ source, destination, permissionRestored: true });
  assert.equal(result.complete, true);
  assert.deepEqual(result.recovered, [{ source: 'index.md', destination: 'import-evidence/hermes-index.original.md' }]);
  assert.equal(await fs.readFile(path.join(destination, 'index.md'), 'utf8'), rebuilt);
  assert.equal(await fs.readFile(path.join(destination, 'import-evidence', 'hermes-index.original.md'), 'utf8'), '# Original navigation\n');
  const report = await verifyMigration(destination);
  assert.equal(report.sourceConsistentAtLastCheck, true);
  assert.deepEqual(report.changedAfterImport, []);
  assert.deepEqual(report.unavailable, []);
});

test('recovery does not claim a complete snapshot when already-copied source changed', async t => {
  const { source, destination } = await fixture(t);
  await migrateWiki({ source, destination });
  await fs.writeFile(path.join(source, 'concepts', '示例.md'), '# Updated after import\n');
  const result = await resumeMigration({ source, destination, permissionRestored: true });
  assert.equal(result.complete, false);
  assert.ok(result.sourceConsistency.drifted.includes('concepts/示例.md'));
  assert.equal(await fs.readFile(path.join(destination, 'concepts', '示例.md'), 'utf8'), '# Example\n');
  const report = await verifyMigration(destination);
  assert.equal(report.sourceConsistentAtLastCheck, false);
});

test('recovery reports new source files added since the original copy', async t => {
  const { source, destination } = await fixture(t);
  await migrateWiki({ source, destination });
  await fs.writeFile(path.join(source, 'concepts', 'new.md'), '# Added later\n');
  const result = await resumeMigration({ source, destination, permissionRestored: true });
  assert.equal(result.complete, false);
  assert.ok(result.sourceConsistency.added.includes('concepts/new.md'));
});

test('a previously unreadable directory is traversed when permissions are restored', async t => {
  const { source, destination } = await fixture(t);
  await migrateWiki({ source, destination });
  const missing = path.join(source, 'raw', 'denied-dir');
  await fs.mkdir(missing);
  await fs.writeFile(path.join(missing, 'item.md'), '# Recovered evidence\n');
  const receiptPath = path.join(destination, '.dsh-llm-wiki-import.json');
  const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
  receipt.skipped.push({ path: 'raw/denied-dir', reason: 'EACCES' });
  await fs.writeFile(receiptPath, JSON.stringify(receipt));
  const result = await resumeMigration({ source, destination, permissionRestored: true });
  assert.equal(result.complete, true);
  assert.ok(result.recovered.some(item => item.source === 'raw/denied-dir/item.md'));
  assert.equal(await fs.readFile(path.join(destination, 'raw', 'denied-dir', 'item.md'), 'utf8'), '# Recovered evidence\n');
  assert.deepEqual((await verifyMigration(destination)).unavailable, []);
});

test('recovery does not overwrite a conflicting existing original index', async t => {
  const { source, destination } = await fixture(t);
  await migrateWiki({ source, destination });
  const evidence = path.join(destination, 'import-evidence');
  await fs.mkdir(evidence);
  const existing = path.join(evidence, 'hermes-index.original.md');
  await fs.writeFile(existing, 'user content');
  const result = await resumeMigration({ source, destination, permissionRestored: true });
  assert.equal(result.complete, false);
  assert.equal(result.skipped[0].reason, 'PREVIOUSLY_DENIED');
  assert.equal(result.skipped[0].lastError, 'TARGET_CONFLICT');
  assert.equal(await fs.readFile(existing, 'utf8'), 'user content');
});

test('verification reports normal later edits as drift rather than an import failure', async t => {
  const { source, destination } = await fixture(t);
  await migrateWiki({ source, destination, skipKnownDeniedIndex: false });
  const memory = new MemoryStore({ root: destination });
  const plan = memory.prepare({ title: '蓝色', content: '我喜欢蓝色', sessionId: 'session-test', explicit: true });
  assert.equal((await memory.commit(plan, { authorize: () => true })).status, 'committed');
  const report = await verifyMigration(destination);
  assert.deepEqual(new Set(report.changedAfterImport), new Set(['index.md', 'log.md']));
  assert.deepEqual(report.unavailable, []);
  assert.equal(report.unchanged + report.changedAfterImport.length, report.copiedAtImport);
});

test('verification does not follow a directory junction outside the copy', async t => {
  const { source, destination, temp } = await fixture(t);
  await migrateWiki({ source, destination, skipKnownDeniedIndex: false });
  const outside = path.join(temp, 'outside-concepts');
  const inside = path.join(destination, 'concepts');
  assert.equal(path.dirname(outside), temp);
  assert.equal(path.dirname(inside), destination);
  await fs.rename(inside, outside);
  await fs.symlink(outside, inside, process.platform === 'win32' ? 'junction' : 'dir');
  const report = await verifyMigration(destination);
  assert.ok(report.unavailable.includes('concepts/示例.md'));
  assert.equal(report.changedAfterImport.length, 0);
});

test('rejects an overlapping destination', async t => {
  const { source } = await fixture(t);
  await assert.rejects(migrateWiki({ source, destination: path.join(source, 'nested') }), /overlap/);
});

test('never follows an out-of-root directory link', async t => {
  const { source, destination, temp } = await fixture(t);
  const outside = path.join(temp, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'secret.md'), 'not part of the source');
  try { await fs.symlink(outside, path.join(source, 'raw', 'link'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code === 'EPERM') return t.skip('directory links unavailable'); throw error; }
  const result = await migrateWiki({ source, destination });
  assert.ok(result.skipped.some(item => item.path === 'raw/link' && item.reason === 'SYMLINK_OR_JUNCTION'));
  await assert.rejects(fs.stat(path.join(destination, 'raw', 'link')), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(outside, 'secret.md'), 'utf8'), 'not part of the source');
});
