import test from 'node:test';
import assert from 'node:assert/strict';
import { mountLoopBackend } from '../lib/loop-backend.js';

function fixture(initial) {
  const calls = [], warnings = [], effects = [];
  let callback, registry = initial, stopped = false, disposals = 0;
  const activate = () => {
    if (!registry || stopped) return;
    callback({
      get(name) { assert.equal(name, 'hermesLoopMemory'); return registry; },
      effect(run) { const remove = run(); if (typeof remove === 'function') effects.push(remove); },
    });
  };
  const ctx = {
    logger() { return { warn(message) { warnings.push(message); } }; },
    inject(names, run) {
      assert.deepEqual(names, ['hermesLoopMemory']);
      callback = run;
      activate();
      return { async dispose() { stopped = true; disposals++; for (const remove of effects.splice(0)) remove(); } };
    },
  };
  const bridge = Object.freeze(Object.fromEntries(['context', 'submit', 'status'].map(method => [method, input => {
    calls.push({ method, input });
    return Promise.resolve({ status: method === 'context' ? 'ok' : method === 'submit' ? 'unknown' : 'processed', input });
  }])));
  return {
    ctx, bridge, calls, warnings,
    get disposals() { return disposals; },
    replace(next) { for (const remove of effects.splice(0)) remove(); registry = next; activate(); },
    lateCallback() { callback({ get() { throw new Error('disposed callback must not access service'); } }); },
  };
}

function registry() {
  const entries = new Map();
  let removed = 0;
  return {
    version: 1,
    register(provider) {
      assert.equal(entries.has(provider.id), false);
      entries.set(provider.id, provider);
      return () => { removed++; if (entries.get(provider.id) === provider) entries.delete(provider.id); };
    },
    get(id) { return entries.get(id); },
    list() { return [...entries.values()]; },
    get removed() { return removed; },
  };
}

test('optional backend stays independent when the host has no injection API', async () => {
  const dispose = mountLoopBackend({}, {});
  await dispose();
  await dispose();
});

test('Wiki registers when a registry appears and preserves exact bridge input and receipts', async () => {
  const env = fixture();
  const dispose = mountLoopBackend(env.ctx, env.bridge);
  assert.deepEqual(env.warnings, []);
  const target = registry();
  env.replace(target);
  const provider = target.get('wiki');
  assert.deepEqual(Object.keys(provider).sort(), ['context', 'id', 'label', 'status', 'submit', 'version']);
  assert.equal(provider.label, 'Wiki');
  assert.equal(provider.version, 1);
  assert.ok(Object.isFrozen(provider));
  const inputs = [
    { sessionId: 'owner', throughSeq: 9, query: 'quoted context' },
    { sessionId: 'owner', throughSeq: 9, sourceSeq: 3, evidenceQuote: '  原话\r\n', memory: { action: 'replace', store: 'user', scope: 'global', text: '建议', oldText: '旧值', rationale: '' } },
    { sessionId: 'owner', operationId: 'receipt' },
  ];
  for (const [index, method] of ['context', 'submit', 'status'].entries()) {
    const result = await provider[method](inputs[index]);
    assert.equal(env.calls[index].input, inputs[index], 'adapter cloned or altered the bridge protocol');
    assert.equal(result.input, inputs[index]);
  }
  assert.equal((await provider.submit(inputs[1])).status, 'unknown', 'uncertain queue acceptance must not become rejected');
  await dispose();
  assert.equal(target.get('wiki'), undefined);
  assert.equal(target.removed, 1);
});

test('registry replacement gets a fresh provider and owns only its current registration', async () => {
  const first = registry(), second = registry();
  const env = fixture(first);
  const dispose = mountLoopBackend(env.ctx, env.bridge);
  const old = first.get('wiki');
  env.replace(undefined);
  assert.equal(first.get('wiki'), undefined);
  assert.equal(first.removed, 1);
  env.replace(second);
  assert.notEqual(second.get('wiki'), old);
  const initialDisposal = dispose();
  assert.equal(dispose(), initialDisposal);
  await initialDisposal;
  assert.equal(second.get('wiki'), undefined);
  assert.equal(second.removed, 1);
  assert.equal(env.disposals, 1);
  env.lateCallback();
  assert.deepEqual(env.warnings, []);
});

test('unsupported or malformed registries do not stop independent Wiki memory', async () => {
  for (const target of [{ ...registry(), version: 2 }, { version: 1 }, { ...registry(), register: 'invalid' }]) {
    const env = fixture(target);
    const dispose = mountLoopBackend(env.ctx, env.bridge);
    assert.equal(env.warnings.length, 1);
    assert.equal((await env.bridge.context({})).status, 'ok');
    await dispose();
  }
});

test('duplicate registration and injection failures are contained without logging input', async () => {
  const env = fixture({ ...registry(), register() { throw new Error('private failure details'); } });
  const dispose = mountLoopBackend(env.ctx, env.bridge);
  assert.equal(env.warnings.length, 1);
  assert.doesNotMatch(env.warnings[0], /private failure details/);
  await dispose();
  env.ctx.inject = () => { throw new Error('host failure'); };
  await mountLoopBackend(env.ctx, env.bridge)();
  assert.equal(env.warnings.length, 2);
});

test('a registry cleanup failure cannot prevent adapter disposal', async () => {
  const env = fixture({ ...registry(), register() { return () => { throw new Error('cleanup failure'); }; } });
  const dispose = mountLoopBackend(env.ctx, env.bridge);
  await dispose();
  await dispose();
  assert.equal(env.warnings.length, 1);
  assert.equal(env.disposals, 1);
});
