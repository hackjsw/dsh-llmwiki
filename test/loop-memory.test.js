import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { memoryPipeline } from '../lib/memory-pipeline.js';
import { WikiStore } from '../lib/wiki.js';

const text = '我长期偏好中文说明，\n包含具体例子和😀。';
const pythonExecutable = process.env.DSH_TEST_PYTHON || 'python';
async function fixture(t) {
  const base = await fs.realpath(os.tmpdir());
  const dir = await fs.mkdtemp(path.join(base, 'dsh-wiki-loop-'));
  const root = path.join(dir, 'wiki');
  for (const name of ['inbox', 'concepts', 'entities']) await fs.mkdir(path.join(root, name), { recursive: true });
  await fs.writeFile(path.join(root, 'index.md'), '# Index\n');
  await fs.writeFile(path.join(root, 'log.md'), '# Log\n');
  const events = [
    { seq: 1, type: 'turn/start', data: { turn: 1 } },
    { seq: 2, type: 'user/message', data: { id: 'owner-input', role: 'user', source: { kind: 'user', rpcId: 'fixture' }, content: [{ type: 'text', text }] } },
    { seq: 3, type: 'assistant/message', data: { message: { role: 'assistant', source: { provider: 'fixture', model: 'fixture' }, content: [{ type: 'text', text: 'Assistant-only guess.' }] } } },
    { seq: 4, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ];
  const session = { id: 'owner-session', header: { origin: 'user' }, snapshotEvents: () => events };
  const state = { mode: 'danger-full-access', loaded: true, shared: false, failPlan: false, extractCalls: 0, closed: 0,
    fact: { kind: 'preference', title: '中文与例子', claim: '用户长期偏好中文说明并包含具体例子。', evidence: text, confidence: .95 },
    plan: { op: 'ADD', title: '中文与例子', slug: 'chinese-examples', summary: '用户长期偏好中文说明并包含具体例子。' }, requests: [] };
  const ctx = {
    get(name) {
      if (name === 'sessions') return { get: id => state.loaded && id === session.id ? session : undefined };
      if (name === 'sandboxPolicy') return { resolve: () => ({ mode: state.mode }) };
      if (name === 'liveshareShares') return state.shared ? {} : undefined;
      if (name === 'sessionPersistence') return { open: async id => id === session.id ? {
        header: session.header, read: async () => ({ events }), close: async () => { state.closed++; },
      } : undefined };
    },
    llm: { async *stream(request) {
      state.requests.push(request);
      if (request.purpose === 'llm_wiki_extract') {
        state.extractCalls++;
        yield { type: 'text-delta', text: JSON.stringify({ facts: [state.fact] }) };
      } else {
        if (state.failPlan) throw new Error('model-offline');
        yield { type: 'text-delta', text: JSON.stringify(state.plan) };
      }
      yield { type: 'finish', reason: { kind: 'stop' } };
    } },
  };
  const config = { root, profile: 'default', pythonExecutable, autoTrustOwnerSessions: true, memoryIdleSeconds: 3600 };
  const store = new WikiStore({ root, profile: 'default' });
  const f = { dir, root, events, session, state, ctx, config, store };
  f.queue = memoryPipeline(ctx, config, store);
  f.request = (overrides = {}) => ({ sessionId: session.id, throughSeq: 4, sourceSeq: 2, evidenceQuote: text,
    memory: { action: 'add', store: 'user', text: '长期使用中文和具体例子。', rationale: '长期偏好' }, ...overrides });
  t.after(async () => {
    await f.queue.stop();
    assert.equal(path.dirname(dir), base);
    assert.ok(path.basename(dir).startsWith('dsh-wiki-loop-'));
    await fs.rm(dir, { recursive: true, force: true });
  });
  return f;
}

test('context exposes only completed owner evidence and canonical references; input cannot select authorization', async t => {
  const f = await fixture(t);
  const api = f.queue.bridge;
  assert.equal(api.version, 1);
  const result = await api.context({ sessionId: f.session.id, query: '中文', throughSeq: 4 });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.evidence, [{ seq: 2, turn: 1, text }]);
  assert.deepEqual(result.references, []);
  assert.equal((await api.context({ sessionId: f.session.id, query: '', throughSeq: 3 })).status, 'denied');
  assert.equal((await api.context({ sessionId: f.session.id, query: '', throughSeq: 99 })).error, 'invalid-cursor');
  assert.equal((await api.submit({ ...f.request(), root: f.root })).error, 'invalid-arguments');
  for (const change of [() => { f.state.mode = 'read-only'; }, () => { f.session.header.origin = 'subagent'; },
    () => { f.state.shared = true; }, () => { f.events[1].data.source.principal = null; }]) {
    change();
    assert.equal((await api.submit(f.request())).status, 'denied');
    f.state.mode = 'danger-full-access'; f.session.header.origin = 'user'; f.state.shared = false; delete f.events[1].data.source.principal;
  }
  f.config.autoTrustOwnerSessions = false;
  assert.equal((await api.submit(f.request())).status, 'denied');
  assert.equal((await f.queue.status()).pending, 0);
});

test('context keeps a bounded tail of complete messages and rechecks access after search', async t => {
  const f = await fixture(t);
  f.events.length = 0;
  for (let turn = 1; turn <= 50; turn++) f.events.push(
    { seq: turn * 3 - 2, type: 'turn/start', data: { turn } },
    { seq: turn * 3 - 1, type: 'user/message', data: { role: 'user', source: { kind: 'user', rpcId: `owner-${turn}` }, content: [{ type: 'text', text: `偏好${turn}：` + '中文'.repeat(200) }] } },
    { seq: turn * 3, type: 'turn/end', data: { turn } });
  const args = { sessionId: f.session.id, query: '中文', throughSeq: 150 };
  const result = await f.queue.bridge.context(args);
  assert.equal(result.status, 'ok');
  assert.ok(result.evidence.length <= 40);
  assert.ok(result.evidence.reduce((sum, row) => sum + row.text.length, 0) <= 12000);
  assert.equal(result.evidence.at(-1).seq, 149);
  for (const row of result.evidence) assert.equal(row.text, f.events.find(event => event.seq === row.seq).data.content[0].text);
  f.store.search = async () => { f.state.mode = 'read-only'; return { results: [{ title: 'must not leak' }] }; };
  assert.deepEqual(await f.queue.bridge.context(args), { status: 'denied' });
});

test('a suggestion with no supported facts completes without claiming canonical application', async t => {
  const f = await fixture(t);
  f.state.fact = null;
  const submitted = await f.queue.bridge.submit(f.request());
  await f.queue.flush();
  const receipt = await f.queue.bridge.status({ sessionId: f.session.id, operationId: submitted.operationId });
  assert.equal(receipt.status, 'processed');
  assert.deepEqual(receipt.candidates, []);
  assert.deepEqual(receipt.outcomes, []);
  assert.equal((await f.queue.bridge.submit(f.request())).status, 'duplicate');
});

test('fake sources, secret or opted-out evidence and deletion are rejected before queue writes', async t => {
  const f = await fixture(t);
  const api = f.queue.bridge;
  assert.equal((await api.submit(f.request({ sourceSeq: 3 }))).error, 'invalid-source');
  assert.equal((await api.submit(f.request({ evidenceQuote: 'Assistant-only guess.' }))).error, 'invalid-evidence');
  assert.equal((await api.submit(f.request({ memory: { action: 'remove', store: 'user', oldText: text } }))).error, 'unsupported-action');
  assert.equal((await api.submit(f.request({ memory: { action: 'add', store: 'user', text: 'password=synthetic-not-real' } }))).error, 'secret-rejected');
  f.events[1].data.content[0].text = 'password=synthetic-not-real';
  assert.deepEqual((await api.context({ sessionId: f.session.id, throughSeq: 4, query: '' })).evidence, []);
  assert.equal((await api.submit(f.request())).error, 'secret-rejected');
  f.events[1].data.content[0].text = '不要记住：' + text;
  assert.equal((await api.submit(f.request())).error, 'owner-opted-out');
  assert.equal((await f.queue.status()).pending, 0);
});

test('durable independent delivery survives restart, retries consolidation only, and retains precise provenance', async t => {
  const f = await fixture(t);
  f.state.failPlan = true;
  const queued = await f.queue.bridge.submit(f.request());
  assert.equal(queued.status, 'queued');
  assert.match(queued.operationId, /^[a-f0-9]{64}$/);
  const duplicates = await Promise.all(Array.from({ length: 3 }, () => f.queue.bridge.submit(f.request())));
  assert.ok(duplicates.every(result => result.status === 'duplicate' && result.operationId === queued.operationId));
  await f.queue.flush();
  let status = await f.queue.bridge.status({ sessionId: f.session.id, operationId: queued.operationId });
  assert.equal(status.status, 'queued');
  assert.equal(status.stage, 'consolidate');
  assert.equal(f.state.extractCalls, 1);
  const job = JSON.parse(await fs.readFile(path.join(f.dir, 'conversation-pending', `${queued.operationId}.json`), 'utf8'));
  assert.equal(job.entries, undefined);
  assert.equal(job.evidence.quote, text);
  await f.queue.stop();
  f.state.loaded = false; f.state.failPlan = false;
  f.queue = memoryPipeline(f.ctx, f.config, f.store);
  await f.queue.flush();
  status = await f.queue.bridge.status({ sessionId: f.session.id, operationId: queued.operationId });
  assert.equal(status.status, 'processed');
  assert.equal(status.outcomes[0].result, 'applied');
  assert.equal(status.evidence.quote, text);
  assert.equal(f.state.extractCalls, 1);
  assert.ok(f.state.closed > 0);
  assert.equal((await f.queue.bridge.submit(f.request())).status, 'duplicate');
  const candidate = await fs.readFile(path.join(f.root, status.candidates[0].path), 'utf8');
  assert.match(candidate, /producer: hermes-loop/);
  assert.match(candidate, /source_seq: 2/);
  assert.match(candidate, /source: hermes_loop_extract/);
  assert.match(candidate, /source_hash: [a-f0-9]{64}/);
  assert.equal((await f.queue.bridge.status({ sessionId: 'other-session', operationId: queued.operationId })).status, 'denied');
  assert.equal((await f.queue.bridge.status({ sessionId: f.session.id, operationId: '../bad' })).error, 'invalid-arguments');
  const context = await f.queue.bridge.context({ sessionId: f.session.id, throughSeq: 4, query: '中文具体例子' });
  assert.equal(context.references.length, 1);
});

test('revocation or changed source blocks processing without discarding accepted work', async t => {
  const f = await fixture(t);
  const queued = await f.queue.bridge.submit(f.request());
  f.state.mode = 'read-only';
  await f.queue.flush();
  assert.equal(f.state.extractCalls, 0);
  assert.equal((await f.queue.status()).pending, 1);
  assert.equal((await f.queue.bridge.status({ sessionId: f.session.id, operationId: queued.operationId })).status, 'denied');
  f.state.mode = 'danger-full-access';
  f.events[1].data.content[0].text = text + ' changed';
  await f.queue.flush();
  assert.equal(f.state.extractCalls, 0);
  f.events[1].data.content[0].text = text;
  await f.queue.flush();
  assert.equal(f.state.extractCalls, 1);
  assert.equal((await f.queue.status()).pending, 0);
});

test('native and late Loop jobs coexist; candidate/canonical dedup prevents duplicate pages', async t => {
  const f = await fixture(t);
  await f.queue.enqueue(f.session, f.events.at(-1));
  await f.queue.flush();
  assert.equal(f.state.extractCalls, 1);
  const queued = await f.queue.bridge.submit(f.request());
  assert.equal(queued.status, 'queued');
  await f.queue.flush();
  assert.equal(f.state.extractCalls, 2);
  assert.equal((await f.queue.status()).completed, 2);
  assert.equal((await fs.readdir(path.join(f.root, 'concepts'))).filter(name => name.endsWith('.md')).length, 1);
  const status = await f.queue.bridge.status({ sessionId: f.session.id, operationId: queued.operationId });
  assert.equal(status.status, 'processed');
  assert.equal(status.candidates[0].duplicate, true);
});

test('replace is only an untrusted suggestion; conflicts remain awaiting owner review', async t => {
  const f = await fixture(t);
  await f.queue.enqueue(f.session, f.events.at(-1));
  await f.queue.flush();
  const original = await fs.readFile(path.join(f.root, 'concepts', 'chinese-examples.md'), 'utf8');
  const newText = '我现在长期希望改用英文说明，并保留具体例子。';
  f.events.push({ seq: 5, type: 'turn/start', data: { turn: 2 } },
    { seq: 6, type: 'user/message', data: { role: 'user', source: { kind: 'user', rpcId: 'next-owner' }, content: [{ type: 'text', text: newText }] } },
    { seq: 7, type: 'turn/end', data: { turn: 2 } });
  f.state.fact = { kind: 'preference', title: '语言偏好变化', claim: '用户现在长期希望英文说明并保留具体例子。', evidence: newText, confidence: .95 };
  f.state.plan = { op: 'CONFLICT', target: 0, record: '用户希望改为英文说明。' };
  const queued = await f.queue.bridge.submit(f.request({ throughSeq: 7, sourceSeq: 6, evidenceQuote: newText,
    memory: { action: 'replace', store: 'user', text: newText, oldText: text } }));
  assert.equal(queued.status, 'queued');
  await f.queue.flush();
  const status = await f.queue.bridge.status({ sessionId: f.session.id, operationId: queued.operationId });
  assert.equal(status.status, 'processed');
  assert.equal(status.outcomes[0].result, 'needs_review');
  assert.equal(await fs.readFile(path.join(f.root, 'concepts', 'chinese-examples.md'), 'utf8'), original);
  assert.match(JSON.stringify(f.state.requests.filter(row => row.purpose === 'llm_wiki_extract').at(-1).messages), /Untrusted Hermes Loop/);
});
