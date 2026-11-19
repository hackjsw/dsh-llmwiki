import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { readTrustedSessions } from '../lib/trust.js';
import { updateTrustedSessions } from '../scripts/trust-session.js';

async function fixture(t) {
  const tempRoot = await fs.realpath(os.tmpdir());
  const temp = await fs.mkdtemp(path.join(tempRoot, 'dsh-wiki-trust-test-'));
  assert.equal(path.dirname(temp), tempRoot);
  assert.match(path.basename(temp), /^dsh-wiki-trust-test-/);
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  return { temp, file: path.join(temp, 'trusted-sessions.json') };
}

test('owner can explicitly add and revoke sessions without granting others', async t => {
  const { file } = await fixture(t);
  assert.deepEqual(readTrustedSessions(file), []);
  assert.equal((await updateTrustedSessions(file, 'add', 'session-abc')).trusted, true);
  assert.equal((await updateTrustedSessions(file, 'add', 'session-def')).count, 2);
  assert.deepEqual(readTrustedSessions(file), ['session-abc', 'session-def']);
  assert.equal((await updateTrustedSessions(file, 'remove', 'session-abc')).trusted, false);
  assert.deepEqual(readTrustedSessions(file), ['session-def']);
});

test('malformed files and session ids fail closed without overwriting data', async t => {
  const { file } = await fixture(t);
  await fs.writeFile(file, 'not valid JSON');
  assert.deepEqual(readTrustedSessions(file), []);
  await assert.rejects(updateTrustedSessions(file, 'add', 'session-abc'));
  assert.equal(await fs.readFile(file, 'utf8'), 'not valid JSON');
  await assert.rejects(updateTrustedSessions(file, 'add', '../other'));
  await assert.rejects(fs.stat(`${file}.lock`), { code: 'ENOENT' });
});

test('a concurrent trust update respects the exclusive lock', async t => {
  const { file } = await fixture(t);
  await fs.writeFile(`${file}.lock`, 'held');
  await assert.rejects(updateTrustedSessions(file, 'add', 'session-abc'), { code: 'EEXIST' });
  assert.deepEqual(readTrustedSessions(file), []);
  assert.equal(await fs.readFile(`${file}.lock`, 'utf8'), 'held');
});
