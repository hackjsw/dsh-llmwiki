import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { memoryPipeline, partitionTurn, redact } from '../lib/memory-pipeline.js';
import { WikiStore } from '../lib/wiki.js';

const pythonExecutable = process.env.DSH_TEST_PYTHON || 'python';
async function fixture(t) {
  const base = await fs.realpath(os.tmpdir());
  const dir = await fs.mkdtemp(path.join(base, 'dsh-wiki-pipeline-'));
  t.after(async () => {
    assert.equal(path.dirname(dir), base);
    assert.ok(path.basename(dir).startsWith('dsh-wiki-pipeline-'));
    await fs.rm(dir, { recursive: true, force: true });
  });
  const root = path.join(dir, 'wiki');
  for (const folder of ['inbox','concepts','entities']) await fs.mkdir(path.join(root, folder), { recursive: true });
  await fs.writeFile(path.join(root, 'index.md'), '# Index\n');
  await fs.writeFile(path.join(root, 'log.md'), '# Log\n');
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { role: 'user', source: { kind: 'user', rpcId: 'telegram-fixture' }, content: [{ type: 'text', text: '我长期偏好中文说明，包含具体例子。' }] } },
    { type: 'assistant/message', data: { message: { role: 'assistant', source: { provider: 'fixture', model: 'model' }, content: [{ type: 'text', text: '会用中文和具体例子。' }] } } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ];
  const session = { id: 'bridge-fixture', header: { origin: 'user' }, snapshotEvents: () => events };
  let loaded = true, mode = 'danger-full-access', failPlan = true, extractCalls = 0, closed = 0;
  const ctx = {
    get(name) {
      return name === 'sessions' ? { get: () => loaded ? session : undefined } :
        name === 'sandboxPolicy' ? { resolve: () => ({ mode }) } :
        name === 'sessionPersistence' ? { open: async () => ({ header: session.header, read: async () => ({ events }), close: async () => { closed++; } }) } : undefined;
    },
    llm: { async *stream(request) {
      if (request.purpose === 'llm_wiki_extract') {
        extractCalls++;
        assert.match(JSON.stringify(request.messages), /具体例子/);
        yield { type: 'text-delta', text: JSON.stringify({ facts: [{ kind: 'preference', title: '中文与例子', claim: '用户长期偏好中文说明并包含具体例子。', evidence: '我长期偏好中文说明，包含具体例子。', confidence: .95 }] }) };
      } else {
        if (failPlan) throw new Error('model-offline');
        yield { type: 'text-delta', text: JSON.stringify({ op: 'ADD', title: '中文与例子', slug: 'chinese-examples', summary: '用户长期偏好中文说明并包含具体例子。' }) };
      }
      yield { type: 'finish', reason: { kind: 'stop' } };
    } },
  };
  const config = { root, profile: 'default', pythonExecutable, autoTrustOwnerSessions: true, memoryIdleSeconds: 3600 };
  return { dir, root, ctx, config, events, session, setLoaded: v => { loaded = v; }, setMode: v => { mode = v; }, setFail: v => { failPlan = v; }, counters: () => ({ extractCalls, closed }) };
}

test('bridge memory retries consolidation after restart with unloaded session, without re-extracting', async t => {
  const f = await fixture(t);
  let queue = memoryPipeline(f.ctx, f.config);
  t.after(() => queue.stop());
  await queue.enqueue(f.session, f.events.at(-1));
  await queue.flush();
  const waiting = await queue.status();
  assert.equal(waiting.pending, 1);
  assert.equal(waiting.jobs[0].stage, 'consolidate');
  assert.equal(f.counters().extractCalls, 1);
  const jobFile = path.join(f.dir, 'conversation-pending', (await fs.readdir(path.join(f.dir, 'conversation-pending'))).find(n => n.endsWith('.json')));
  assert.equal(JSON.parse(await fs.readFile(jobFile, 'utf8')).entries, undefined);
  await queue.stop();
  f.setLoaded(false); f.setFail(false);
  queue = memoryPipeline(f.ctx, f.config);
  await queue.flush();
  assert.equal((await queue.status()).pending, 0);
  assert.equal((await queue.status()).completed, 1);
  assert.equal(f.counters().extractCalls, 1);
  assert.ok(f.counters().closed > 0, 'cold-read handles were closed');
  const wiki = new WikiStore({ root: f.root, profile: 'default' });
  assert.equal((await wiki.search('中文说明具体例子', { recall: true })).results.length, 1);
  f.setLoaded(true);
  await queue.enqueue(f.session, f.events.at(-1));
  await queue.flush();
  assert.equal((await queue.status()).completed, 1);
  assert.equal(f.counters().extractCalls, 1);
});

test('permission revocation preserves pending job, restoring access resumes it', async t => {
  const f = await fixture(t);
  const queue = memoryPipeline(f.ctx, f.config);
  t.after(() => queue.stop());
  await queue.enqueue(f.session, f.events.at(-1));
  f.setMode('read-only');
  await queue.flush();
  assert.equal((await queue.status()).jobs[0].error, 'session-access-unavailable');
  assert.equal(f.counters().extractCalls, 0);
  f.setMode('danger-full-access'); f.setFail(false);
  await queue.flush();
  assert.equal((await queue.status()).completed, 1);
});

test('immediate stop waits for initialization and prevents later worker writes', async t => {
  const f = await fixture(t);
  const queue = memoryPipeline(f.ctx, f.config);
  t.after(() => queue.stop());
  await queue.stop();
  const runtimeFile = path.join(f.dir, 'memory-runtime.json');
  const initialized = await fs.readFile(runtimeFile, 'utf8');
  assert.ok(JSON.parse(initialized).loadedAt, 'stop returned before initialization settled');
  await queue.enqueue(f.session, f.events.at(-1));
  await queue.flush();
  assert.equal((await queue.status()).pending, 0);
  assert.equal(await fs.readFile(runtimeFile, 'utf8'), initialized);
  assert.equal(f.counters().extractCalls, 0);
});

test('queue persists safe host diagnostics, sanitizes status, and clears stale diagnostics', async t => {
  const f = await fixture(t);
  const privateText = 'Synthetic session lookup failure sk-private1234567890 C:/private/session';
  f.ctx.llm.prepareCall = async () => { throw new Error(privateText); };
  const queue = memoryPipeline(f.ctx, f.config);
  t.after(() => queue.stop());
  await queue.enqueue(f.session, f.events.at(-1));
  await queue.flush();
  const pending = path.join(f.dir, 'conversation-pending');
  const name = (await fs.readdir(pending)).find(n => n.endsWith('.json'));
  const file = path.join(pending, name);
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  const expected = { reason: 'host-request-failed', exitCode: 0, stderrBytes: 0, requestType: 'llm' };
  assert.equal(saved.lastError, 'engine-unavailable');
  assert.deepEqual(saved.lastDiagnostic, expected);
  assert.ok(!JSON.stringify(saved).includes(privateText));
  assert.deepEqual((await queue.status()).jobs[0].lastDiagnostic, expected);
  saved.lastDiagnostic = { ...saved.lastDiagnostic, stderr: privateText, cause: privateText, pythonException: privateText };
  await fs.writeFile(file, JSON.stringify(saved));
  assert.deepEqual((await queue.status()).jobs[0].lastDiagnostic, expected);
  f.setMode('read-only');
  await queue.flush();
  assert.equal((await queue.status()).jobs[0].error, 'session-access-unavailable');
  assert.equal((await queue.status()).jobs[0].lastDiagnostic, undefined);
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).lastDiagnostic, undefined);
  delete f.ctx.llm.prepareCall;
  f.setMode('danger-full-access'); f.setFail(false);
  await queue.flush();
  assert.equal((await queue.status()).pending, 0);
  const receipt = JSON.parse(await fs.readFile(path.join(f.dir, 'memory-receipts', name), 'utf8'));
  assert.equal(receipt.lastDiagnostic, undefined);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.dir, 'memory-runtime.json'), 'utf8')).version, '0.2.7');
});

test('long transcripts preserve all text, bound escaping, redact credentials', () => {
  const user = ('中\n"😀').repeat(6500), assistant = '中文答复'.repeat(8000);
  const parts = partitionTurn(user, assistant);
  assert.ok(parts.every(p => JSON.stringify(p).length < 24000));
  const actualUser = parts.map(p => p[0].user).join('');
  assert.ok(actualUser.startsWith(user)); // Extra assistant pieces carry quoted user context.
  assert.equal(parts.map(p => p[0].assistant).join(''), assistant);
  assert.equal(redact('token=synthetic-private-value\n密码：不可保留'), '[REDACTED]\n[REDACTED]');
});
