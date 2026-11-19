import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';

const testFile = fileURLToPath(import.meta.url);
const project = process.env.DSH_TEST_PLUGIN_PROJECT || path.dirname(path.dirname(testFile));
const pythonExecutable = process.env.DSH_TEST_PYTHON || 'python';

async function runRealHost() {
  // Only an in-memory adapter is mounted. Block HTTP fetch and TCP/TLS
  // connection attempts in this separate process before loading the host.
  const blocked = () => { throw new Error('Network access is disabled in the synthetic DSH test'); };
  globalThis.fetch = async () => blocked();
  const net = (await import('node:net')).default;
  const tls = (await import('node:tls')).default;
  net.connect = blocked;
  net.createConnection = blocked;
  net.Socket.prototype.connect = blocked;
  tls.connect = blocked;
  syncBuiltinESMExports();
  const electronDir = path.dirname(process.execPath);
  const archive = path.join(electronDir, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai');
  const load = name => import(pathToFileURL(path.join(archive, name, 'lib', 'index.js')).href);
  const [cordis, prompt, tools, native, session, projections, agent, loop, llm, sandbox, wiki] = await Promise.all([
    load('cordis'), load('dsh-system-prompt'), load('dsh-tools'), load('dsh-tool-executor-native'),
    load('dsh-session'), load('dsh-session-projection'), load('dsh-agent'), load('dsh-agent-loop'),
    load('dsh-llm'), load('dsh-sandbox-policy'), import(pathToFileURL(path.join(project, 'lib', 'index.js')).href),
  ]);
  const temp = process.env.DSH_REAL_TEST_TEMP;
  assert.ok(temp && path.isAbsolute(temp));
  assert.equal(process.env.DSH_HOME, path.join(temp, 'home'));
  const wikiRoot = path.join(temp, 'wiki');
  await fs.mkdir(path.join(wikiRoot, 'entities'), { recursive: true });
  const today = new Date().toISOString();
  const expiry = new Date(Date.now() + 30 * 86400000).toISOString();
  const fixture = `---\ntitle: Synthetic garden\ntier: canonical\nstatus: active\nscope: profile:default\nreview_class: stable\nlast_verified_at: ${today}\nexpires_at: ${expiry}\n---\n# Synthetic garden\n\nSynthetic garden contains IRIS_BLUE_FACT.\n`;
  await fs.writeFile(path.join(wikiRoot, 'entities', 'garden.md'), fixture);
  const id = `session-synthetic-${randomUUID()}`;
  const ctx = new cordis.Context();
  // The package test is self-contained; a joint checkout can additionally run
  // these same lifecycle assertions against Loop's actual registry module.
  let createRegistry = () => {
    const entries = new Map();
    return { service: {
      version: 1,
      register(provider) {
        assert.equal(entries.has(provider.id), false);
        entries.set(provider.id, provider);
        return () => { if (entries.get(provider.id) === provider) entries.delete(provider.id); };
      },
      get(id) { return entries.get(id); },
      list() { return [...entries.values()]; },
    }, dispose() { entries.clear(); } };
  };
  if (process.env.DSH_TEST_LOOP_REGISTRY) {
    const module = await import(pathToFileURL(process.env.DSH_TEST_LOOP_REGISTRY).href);
    createRegistry = module.createMemoryBackendRegistry;
    assert.equal(typeof createRegistry, 'function');
  }
  const fibers = [];
  const errors = [];
  const requests = [];
  const summaryRequests = [];
  const wikiTimers = new Set(), wikiTicks = [];
  const setIntervalOriginal = globalThis.setInterval, clearIntervalOriginal = globalThis.clearInterval;
  let trackWikiTimers = false;
  globalThis.setInterval = (callback, delay, ...args) => {
    const timer = setIntervalOriginal(callback, delay, ...args);
    if (trackWikiTimers && delay === 15000) {
      wikiTimers.add(timer);
      wikiTicks.push(() => callback(...args));
    }
    return timer;
  };
  globalThis.clearInterval = timer => { wikiTimers.delete(timer); return clearIntervalOriginal(timer); };
  let handle;
  let revokePolicy = false;
  let policyChecks = 0;
  const firstMemory = '我喜欢合成蓝色鸢尾花。';
  const secondMemory = '我喜欢合成金色向日葵。';
  const thirdMemory = '我喜欢合成白色百合。';
  ctx.on('agent/error', ({ error }) => { errors.push(String(error)); });
  try {
    async function mount(plugin, config = {}) {
      const fiber = ctx.plugin(plugin, config);
      fibers.push(fiber);
      await fiber.await();
      assert.equal(fiber.state, 2, `service failed to activate: ${fiber.name}`);
      return fiber;
    }
    // A dependency declared inside apply must remain optional and follow service
    // replacement. Exercise the actual packaged Cordis, not a synchronous mock.
    let injected, registrations = 0, removals = 0;
    const probe = await mount({ name: 'synthetic-optional-injection', apply(child) {
      injected = child.inject(['syntheticLoopRegistry'], scoped => {
        scoped.effect(() => scoped.get('syntheticLoopRegistry').register());
      });
    } });
    assert.equal(registrations, 0, 'an absent optional dependency must leave its parent active');
    const mountProbeRegistry = () => mount({ name: 'synthetic-registry', apply(child) {
      child.provide('syntheticLoopRegistry', { register() { registrations++; return () => { removals++; }; } });
    } });
    const firstRegistry = await mountProbeRegistry();
    await injected.await();
    assert.equal(injected.state, 2, 'dynamic inject did not activate after service appearance');
    assert.equal(registrations, 1);
    await firstRegistry.dispose();
    await injected.await();
    assert.equal(removals, 1, 'dependency removal did not dispose its scoped registration');
    const secondRegistry = await mountProbeRegistry();
    await injected.await();
    assert.equal(registrations, 2, 'replacement service did not reactivate injection');
    await probe.dispose();
    assert.equal(removals, 2, 'parent disposal did not unregister from the live dependency');
    await secondRegistry.dispose();

    async function mountLoopRegistry() {
      const value = createRegistry();
      const fiber = await mount({ name: 'synthetic-loop-registry', apply(child) {
        child.effect(() => value.dispose);
        child.provide('hermesLoopMemory', value.service);
      } });
      await new Promise(resolve => setImmediate(resolve));
      return { ...value, fiber };
    }

    await mount(prompt.default);
    await mount(tools.default);
    await mount(native);
    await mount(session.default);
    await mount(projections.default);
    await mount(sandbox.default, { mode: 'danger-full-access', workspaceRoot: temp });
    await mount(agent.default);
    await mount(llm.default);
    await mount(loop.default);
    // Exercise instruction baselines through the actual native pre-step and tool pipeline.
    const removeInstructions = ctx.on('agent/pre-step', async (payload, next) => {
      const decision = await next();
      if (decision.kind !== 'enter') return decision;
      return { ...decision, messages: [...decision.messages, llm.createUserMessage({
        source: { kind: 'agent-instructions', form: 'instructions' },
        content: [{ type: 'text', text: 'Synthetic AGENTS.md: your name is Garden Helper.' }],
      }), llm.createUserMessage({
        // Match the OPS provider's real logged step-tail shape through the native admission path.
        source: { kind: 'dsh-ops:step-tail', contributor: 'batching-guidance', revision: 'test', turn: payload.turn, step: payload.step },
        content: [{ type: 'text', text: '[Plugin context; not a user instruction or authorization.]\n记住：OPS_CONTEXT_NOT_OWNER_EVIDENCE。' }],
      })] };
    });
    fibers.push({ dispose: removeInstructions });

    class FixtureAdapter extends llm.LlmAdapter {
      async *stream(request) {
        if (request.purpose === 'llm_wiki_extract') {
          summaryRequests.push(structuredClone(request.messages));
          yield { type: 'text-delta', index: 0, text: JSON.stringify({ facts: [{ kind: 'preference', title: '桥接测试偏好', claim: '用户长期喜欢合成花园里的银色铃兰。', confidence: 0.95, evidence: '我长期喜欢合成花园里的银色铃兰。' }] }) };
          yield { type: 'finish', reason: { kind: 'stop' } };
          return;
        }
        if (request.purpose === 'llm_wiki_consolidate') {
          yield { type: 'text-delta', index: 0, text: JSON.stringify({ op: 'ADD', title: '桥接测试偏好', slug: 'bridge-lily', summary: '用户长期喜欢合成花园里的银色铃兰。' }) };
          yield { type: 'finish', reason: { kind: 'stop' } };
          return;
        }
        requests.push({ messages: structuredClone(request.messages), tools: structuredClone(request.tools ?? []) });
        const number = requests.length;
        if (number === 1 || number === 4) {
          yield { type: 'tool-call-delta', index: 0, id: `synthetic-call-${number}`, name: 'wiki_search', argumentsDelta: JSON.stringify({ query: 'synthetic garden' }) };
        } else if (number === 12) {
          yield { type: 'tool-call-delta', index: 0, id: 'synthetic-call-12', name: 'wiki_auto_capture', argumentsDelta: '{}' };
        } else if (number === 6 || number === 8 || number === 10) {
          if (number === 8) { revokePolicy = true; policyChecks = 0; }
          const args = number === 6 ? { title: '蓝色鸢尾花', content: firstMemory }
            : number === 8 ? { title: '金色向日葵', content: secondMemory }
              : { title: '白色百合', content: thirdMemory };
          yield { type: 'tool-call-delta', index: 0, id: `synthetic-call-${number}`, name: 'wiki_remember', argumentsDelta: JSON.stringify(args) };
        } else {
          yield { type: 'text-delta', index: 0, text: 'Synthetic response.' };
        }
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    }
    ctx.llm.registerAdapter(['fixture-provider'], new FixtureAdapter());
    const initialRegistry = await mountLoopRegistry();
    const wikiFiber = await mount(wiki, { root: wikiRoot, autoTrustOwnerSessions: true, autoCapture: true });
    assert.equal(initialRegistry.service.get('wiki'), undefined, 'non-fullMemory Wiki registered a backend');
    handle = await ctx.agents.create({ sessionId: id, agentOptions: { provider: 'fixture-provider', model: 'fixture-model' }, meta: { cwd: temp } });
    const live = handle.agent;
    const names = ctx.tools.schemas(live).map(item => item.name);
    for (const name of ['wiki_search', 'wiki_read_source', 'wiki_status', 'wiki_remember']) assert.ok(names.includes(name), `${name} is not registered`);
    // Keep the real policy service and its Session projection, but trigger a
    // deterministic mode change on the sixth write-time resolution: after the
    // page is published and immediately before the index append.
    const policy = ctx.get('sandboxPolicy');
    const resolvePolicy = policy.resolve.bind(policy);
    policy.resolve = request => {
      if (revokePolicy && request?.session?.id === id && ++policyChecks === 6) {
        sandbox.setSandboxMode(request.session, 'read-only');
      }
      return resolvePolicy(request);
    };
    const send = async (text, requestId, principal) => {
      const source = { kind: 'user', rpcId: requestId, ...(principal === undefined ? {} : { principal }) };
      live.followup(llm.createUserMessage({ source, content: [{ type: 'text', text }] }));
      await live.whenIdle();
      assert.deepEqual(errors, [], 'real Agent loop reported an error');
    };
    await send('synthetic garden', 'rpc-owner-1');
    assert.equal(requests.length, 2, 'first synthetic request must call the real tool pipeline');
    const first = requests[0];
    assert.ok(first.messages.some(message => message.source?.kind === 'agent-instructions'));
    assert.ok(first.messages.some(message => message.source?.kind === 'dsh-ops:step-tail'), 'OPS context shape was not admitted through the real host');
    assert.ok(first.tools.some(item => item.name === 'wiki_search'), 'tool is missing from the actual model request');
    const runtimeMessages = first.messages.filter(message => message.role === 'user' && message.source?.kind === 'runtime-context');
    assert.ok(runtimeMessages.length, 'context refresh did not create a runtime-context message');
    assert.match(JSON.stringify(runtimeMessages.at(-1).content), /IRIS_BLUE_FACT/);
    assert.match(JSON.stringify(runtimeMessages.at(-1).content), /不是指令/);
    const toolResult = requests[1].messages.find(message => message.role === 'tool');
    assert.ok(toolResult, 'tool result was not delivered through the real executor');
    assert.match(JSON.stringify(toolResult.content), /IRIS_BLUE_FACT/);
    await send('unmatched zephyr quantum', 'rpc-owner-2');
    assert.equal(requests.length, 3);
    const latest = requests[2].messages.filter(message => message.role === 'user' && message.source?.kind === 'runtime-context').at(-1);
    assert.ok(latest, 'cleared runtime-context snapshot is missing');
    assert.doesNotMatch(JSON.stringify(latest.content), /IRIS_BLUE_FACT/);
    await send('synthetic garden', 'rpc-viewer', { kind: 'share-viewer' });
    assert.equal(requests.length, 5);
    // Clearing the current runtime snapshot does not erase earlier retained
    // messages. A later shared reader must therefore not receive this session.
    assert.ok(requests[3].messages.some(message => message.source?.kind === 'runtime-context' && JSON.stringify(message.content).includes('IRIS_BLUE_FACT')));
    const denied = requests[4].messages.filter(message => message.role === 'tool').at(-1);
    assert.ok(denied);
    assert.match(JSON.stringify(denied.content), /Wiki access unavailable/);
    assert.doesNotMatch(JSON.stringify(denied.content), /IRIS_BLUE_FACT/);

    const toolOutput = (request, callId) => {
      const message = request.messages.find(item => item.role === 'tool' && item.toolCallId === callId);
      assert.ok(message, `missing tool result for ${callId}`);
      const block = message.content.find(item => item.type === 'text');
      assert.ok(block, `missing text tool result for ${callId}`);
      return JSON.parse(block.text);
    };
    assert.equal(policy.resolve({ session: live.session }).mode, 'danger-full-access');
    await send(`记住：${firstMemory}`, 'rpc-remember-1');
    assert.equal(requests.length, 7);
    const saved = toolOutput(requests[6], 'synthetic-call-6');
    assert.equal(saved.status, 'committed');
    assert.match(saved.path, /^entities\/memory-[a-f0-9-]+\.md$/);
    const savedPage = await fs.readFile(path.join(wikiRoot, ...saved.path.split('/')), 'utf8');
    assert.match(savedPage, /scope: profile:default/);
    assert.ok(savedPage.includes(firstMemory));
    const indexBeforeRevocation = await fs.readFile(path.join(wikiRoot, 'index.md'), 'utf8');
    const logBeforeRevocation = await fs.readFile(path.join(wikiRoot, 'log.md'), 'utf8');
    assert.ok(indexBeforeRevocation.includes(saved.operationId));
    assert.ok(logBeforeRevocation.includes(saved.operationId));

    await send(`记住：${secondMemory}`, 'rpc-remember-revoked');
    assert.equal(requests.length, 9);
    const interrupted = toolOutput(requests[8], 'synthetic-call-8');
    assert.equal(interrupted.status, 'partial');
    assert.equal(interrupted.stage, 'index');
    assert.equal(interrupted.code, 'authorization-denied');
    assert.ok(policyChecks >= 6);
    assert.equal(policy.resolve({ session: live.session }).mode, 'read-only');
    assert.match(interrupted.path, /^entities\/memory-[a-f0-9-]+\.md$/);
    const partialPage = await fs.readFile(path.join(wikiRoot, ...interrupted.path.split('/')), 'utf8');
    assert.ok(partialPage.includes(secondMemory));
    assert.equal(await fs.readFile(path.join(wikiRoot, 'index.md'), 'utf8'), indexBeforeRevocation);
    assert.equal(await fs.readFile(path.join(wikiRoot, 'log.md'), 'utf8'), logBeforeRevocation);
    const filesAfterRevocation = (await fs.readdir(path.join(wikiRoot, 'entities'))).sort();
    assert.equal(filesAfterRevocation.some(name => name.endsWith('.tmp')), false);
    assert.equal((await fs.readdir(wikiRoot)).includes('.dsh-llm-wiki-write.lock'), false);

    await send(`记住：${thirdMemory}`, 'rpc-remember-read-only');
    assert.equal(requests.length, 11);
    const refusedWrite = toolOutput(requests[10], 'synthetic-call-10');
    assert.equal(refusedWrite.status, 'not-started');
    assert.equal(refusedWrite.error, 'Wiki access unavailable');
    assert.deepEqual((await fs.readdir(path.join(wikiRoot, 'entities'))).sort(), filesAfterRevocation);
    assert.equal(await fs.readFile(path.join(wikiRoot, 'index.md'), 'utf8'), indexBeforeRevocation);
    assert.equal(await fs.readFile(path.join(wikiRoot, 'log.md'), 'utf8'), logBeforeRevocation);
    sandbox.setSandboxMode(live.session, 'danger-full-access');
    await send('我长期喜欢简洁的中文答复。', 'rpc-auto-capture');
    assert.equal(requests.length, 13);
    assert.ok(requests[11].tools.some(item => item.name === 'wiki_auto_capture'));
    const automatic = toolOutput(requests[12], 'synthetic-call-12');
    assert.equal(automatic.status, 'committed');
    const autoPage = await fs.readFile(path.join(wikiRoot, ...automatic.path.split('/')), 'utf8');
    assert.match(autoPage, /source: user-automatic/);
    assert.match(autoPage, /我长期喜欢简洁的中文答复。/);
    await handle.dispose();
    handle = undefined;
    await wikiFiber.dispose();
    await initialRegistry.fiber.dispose();
    assert.equal(ctx.tools.schemas().some(item => item.name === 'wiki_search'), false, 'plugin disposal left its tool registered');
    await fs.mkdir(path.join(wikiRoot, 'inbox'), { recursive: true });
    trackWikiTimers = true;
    const summaryFiber = await mount(wiki, { root: wikiRoot, autoTrustOwnerSessions: true, fullMemory: true, memoryIdleSeconds: 0, pythonExecutable });
    trackWikiTimers = false;
    assert.equal(wikiTimers.size, 1, 'the Wiki worker interval was not observed');
    assert.equal(ctx.get('hermesLoopMemory', false), undefined, 'Wiki acquired a required Loop dependency');
    let loopRegistry = await mountLoopRegistry();
    let backend = loopRegistry.service.get('wiki');
    assert.equal(backend?.version, 1, 'Wiki did not register with a later Loop registry');
    assert.equal(backend.label, 'Wiki');
    handle = await ctx.agents.create({ sessionId: `session-bridge-${randomUUID()}`, agentOptions: { provider: 'fixture-provider', model: 'fixture-model' }, meta: { cwd: temp } });
    const bridge = handle.agent;
    bridge.followup(llm.createUserMessage({ source: { kind: 'user', rpcId: 'im-bridge-synthetic' }, content: [{ type: 'text', text: '我长期喜欢合成花园里的银色铃兰。' }] }));
    await bridge.whenIdle();
    let summaryPage;
    for (let i = 0; i < 400; i++) {
      const files = await fs.readdir(path.join(wikiRoot, 'concepts')).catch(() => []);
      for (const file of files) {
        const value = await fs.readFile(path.join(wikiRoot, 'concepts', file), 'utf8');
        if (value.includes('桥接测试偏好')) summaryPage = value;
      }
      if (summaryPage) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(summaryPage, 'completed bridge-like turn did not enter canonical Wiki memory');
    assert.match(summaryPage, /origin: auto/);
    assert.match(summaryPage, /tier: canonical/);
    assert.ok(summaryRequests.some(value => JSON.stringify(value).includes('银色铃兰')));
    assert.ok(summaryRequests.some(value => JSON.stringify(value).includes('Synthetic response')));
    assert.doesNotMatch(JSON.stringify(summaryRequests), /OPS_CONTEXT_NOT_OWNER_EVIDENCE/, 'OPS guidance leaked into owner memory evidence');
    assert.equal(ctx.get('llmWikiMemory')?.version, 1, 'Cordis did not publish the Wiki memory service');
    let consumerContext;
    await mount({ name: 'synthetic-wiki-consumer', apply(childContext) { consumerContext = childContext; } });
    const memoryService = consumerContext.get('llmWikiMemory', false);
    assert.equal(memoryService?.version, 1, 'an independent plugin context could not see the Wiki provider');
    const throughSeq = bridge.session.snapshotEvents().at(-1).seq;
    const reviewContext = await backend.context({ sessionId: bridge.session.id, query: '银色铃兰', throughSeq });
    assert.equal(reviewContext.status, 'ok');
    assert.ok(reviewContext.references.length > 0);
    const evidence = reviewContext.evidence.find(row => row.text.includes('银色铃兰'));
    assert.ok(evidence, 'service did not locate the real completed owner message');
    const submission = { sessionId: bridge.session.id, throughSeq, sourceSeq: evidence.seq, evidenceQuote: evidence.text,
      memory: { action: 'add', store: 'user', text: '长期喜欢合成花园里的银色铃兰。' } };
    const submitted = await backend.submit(submission);
    assert.equal(submitted.status, 'queued');
    const previousRegistry = loopRegistry, previousBackend = backend;
    await previousRegistry.fiber.dispose();
    assert.equal(previousRegistry.service.get('wiki'), undefined, 'registry removal left the old provider registered');
    assert.equal(summaryFiber.state, 2, 'registry removal stopped native Wiki memory');
    loopRegistry = await mountLoopRegistry();
    backend = loopRegistry.service.get('wiki');
    assert.ok(backend, 'replacement registry did not receive the Wiki backend');
    assert.notEqual(backend, previousBackend);
    if (process.env.DSH_TEST_LOOP_REGISTRY) {
      assert.equal((await previousBackend.context({ sessionId: bridge.session.id, query: '', throughSeq })).status, 'denied');
      assert.equal((await previousBackend.submit(submission)).status, 'denied');
    }
    let receipt;
    for (let i = 0; i < 400; i++) {
      receipt = await backend.status({ sessionId: bridge.session.id, operationId: submitted.operationId });
      if (receipt.status === 'processed') break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(receipt.status, 'processed');
    assert.equal(receipt.evidence.producer, 'hermes-loop');
    assert.equal((await memoryService.submit(submission)).status, 'duplicate', 'legacy service no longer shares the same queue and idempotency key');
    assert.equal((await backend.submit(submission)).status, 'duplicate');
    const modelCallsBeforeDisposal = summaryRequests.length;
    await summaryFiber.dispose();
    assert.equal(loopRegistry.service.get('wiki'), undefined, 'Wiki disposal left its Loop registration alive');
    assert.equal((await backend.context({ sessionId: bridge.session.id, query: '', throughSeq })).status, 'denied');
    assert.equal((await backend.submit(submission)).status, 'denied');
    assert.equal(ctx.get('sessions').get(bridge.session.id), bridge.session, 'session must remain live during provider disposal assertions');
    assert.equal(ctx.get('llmWikiMemory'), undefined, 'Cordis service survived provider disposal');
    assert.equal(consumerContext.get('llmWikiMemory', false), undefined, 'consumer retained a disposed provider');
    assert.equal((await memoryService.context({ sessionId: bridge.session.id, query: '', throughSeq })).status, 'denied', 'old service retained owner access after disposal');
    assert.equal((await memoryService.status({ sessionId: bridge.session.id, operationId: submitted.operationId })).status, 'denied');
    assert.equal((await memoryService.submit(submission)).status, 'denied');
    assert.equal(wikiTimers.size, 0, 'plugin disposal left its worker interval running');
    const runtimeFile = path.join(path.dirname(wikiRoot), 'memory-runtime.json');
    const runtimeAfterDisposal = await fs.readFile(runtimeFile, 'utf8');
    // Exercise a callback already queued when clearInterval ran; it must also be inert.
    for (const tick of wikiTicks) tick();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(await fs.readFile(runtimeFile, 'utf8'), runtimeAfterDisposal, 'disposed worker rewrote its runtime record');
    assert.equal(summaryRequests.length, modelCallsBeforeDisposal, 'disposed worker made another model request');
    trackWikiTimers = true;
    const reloadedWiki = await mount(wiki, { root: wikiRoot, autoTrustOwnerSessions: true, fullMemory: true, memoryIdleSeconds: 0, pythonExecutable });
    trackWikiTimers = false;
    await new Promise(resolve => setImmediate(resolve));
    const reloadedBackend = loopRegistry.service.get('wiki');
    assert.ok(reloadedBackend, 'Wiki did not register with an already-present registry');
    assert.notEqual(reloadedBackend, backend);
    assert.equal((await memoryService.context({ sessionId: bridge.session.id, query: '', throughSeq })).status, 'denied');
    await reloadedWiki.dispose();
    assert.equal(loopRegistry.service.get('wiki'), undefined);
    assert.equal(wikiTimers.size, 0);
    await handle.dispose();
    handle = undefined;
    console.log('REAL_DSH_SYNTHETIC_OK requests=11 owner-tool=ok viewer-tool=denied context=refreshed memory=committed revocation=partial readonly=denied');
  } finally {
    try {
      if (handle) await handle.dispose();
      for (const fiber of fibers.reverse()) await fiber.dispose();
    } finally {
      globalThis.setInterval = setIntervalOriginal;
      globalThis.clearInterval = clearIntervalOriginal;
      for (const timer of wikiTimers) clearIntervalOriginal(timer);
    }
  }
}

if (process.env.DSH_REAL_TEST_CHILD === '1') {
  await runRealHost();
} else {
  test('real DSH runtime uses the plugin with a fake model and temporary Wiki', async t => {
    const electron = process.env.DSH_TEST_ELECTRON;
    if (!electron) { t.skip('Set DSH_TEST_ELECTRON to the DSH desktop executable'); return; }
    await fs.access(electron);
    const tempBase = await fs.realpath(os.tmpdir());
    const temp = await fs.mkdtemp(path.join(tempBase, 'dsh-wiki-real-host-test-'));
    assert.equal(path.dirname(temp), tempBase);
    assert.ok(path.basename(temp).startsWith('dsh-wiki-real-host-test-'));
    t.after(async () => {
      assert.equal(path.dirname(temp), tempBase);
      assert.ok(path.basename(temp).startsWith('dsh-wiki-real-host-test-'));
      await fs.rm(temp, { recursive: true, force: true });
    });
    const env = {
      ELECTRON_RUN_AS_NODE: '1', DSH_REAL_TEST_CHILD: '1', DSH_REAL_TEST_TEMP: temp,
      DSH_HOME: path.join(temp, 'home'), HOME: temp, USERPROFILE: temp, TEMP: temp, TMP: temp, TMPDIR: temp,
      ...(process.env.DSH_TEST_PLUGIN_PROJECT ? { DSH_TEST_PLUGIN_PROJECT: process.env.DSH_TEST_PLUGIN_PROJECT } : {}),
      ...(process.env.DSH_TEST_LOOP_REGISTRY ? { DSH_TEST_LOOP_REGISTRY: process.env.DSH_TEST_LOOP_REGISTRY } : {}),
      ...(process.env.DSH_TEST_PYTHON ? { DSH_TEST_PYTHON: process.env.DSH_TEST_PYTHON } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
    };
    const result = await new Promise((resolve, reject) => {
      const child = spawn(electron, ['--expose-internals', testFile], { cwd: temp, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      const timer = setTimeout(() => { child.kill(); reject(new Error('Synthetic DSH process timed out')); }, 60000);
      child.stdout.on('data', chunk => { stdout += chunk.toString().slice(0, 32000); });
      child.stderr.on('data', chunk => { stderr += chunk.toString().slice(0, 32000); });
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    });
    assert.equal(result.code, 0, `Synthetic DSH process failed:\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /REAL_DSH_SYNTHETIC_OK/);
  });
}
