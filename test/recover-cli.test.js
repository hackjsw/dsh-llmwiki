import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MemoryStore } from '../lib/memory.js';

const cli = fileURLToPath(new URL('../scripts/recover-memory.js', import.meta.url));

test('recovery CLI honors a custom Wiki root and profile', async t => {
  const base = await fs.realpath(os.tmpdir());
  const temp = await fs.mkdtemp(path.join(base, 'dsh-wiki-recover-cli-'));
  assert.equal(path.dirname(temp), base);
  assert.match(path.basename(temp), /^dsh-wiki-recover-cli-/);
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'wiki');
  await fs.mkdir(path.join(root, 'entities'), { recursive: true });
  await fs.writeFile(path.join(root, 'index.md'), '# index\n');
  await fs.writeFile(path.join(root, 'log.md'), '# log\n');
  const memory = new MemoryStore({ root, profile: 'other' });
  const plan = memory.prepare({ title: '蓝色', content: '我喜欢蓝色', sessionId: 'session-test', explicit: true });
  const partial = await memory.commit(plan, { authorize: ({ stage }) => stage !== 'log' });
  assert.equal(partial.status, 'partial');
  const args = [cli, plan.operationId, '--root', root, '--profile', 'other'];
  const beforeReview = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(beforeReview.status, 1);
  assert.equal(JSON.parse(beforeReview.stdout).code, 'recovery-review-required');
  const afterReview = spawnSync(process.execPath, [...args, '--reviewed'], { encoding: 'utf8' });
  assert.equal(afterReview.status, 0);
  assert.equal(JSON.parse(afterReview.stdout).status, 'committed');
});
