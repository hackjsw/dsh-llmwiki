import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { runEngine, modelJson, safeEngineDiagnostic } from './engine.js';
import { readTrustedSessions } from './trust.js';
import { createLoopMemoryBridge } from './loop-memory.js';

const JOB = /^[a-f0-9]{64}\.json$/;
const owner = m => m?.role === 'user' && m.source?.kind === 'user' && m.source.rpcId && !('principal' in m.source);
const textOf = m => (m?.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n');
export function redact(text) {
  for (const pattern of [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/gi,
    /\b(?:sk-|ghp_|github_pat_|xox[baprs]-|AIza|hf_|npm_|pypi-|gsk_|xai-)[A-Za-z0-9_.=-]{10,}\b/gi,
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/g,
    /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret|credential)\s*["']?\s*[:=]\s*["']?[^\s"']+/gi,
    /^\s*(?:[>*+-]\s*)?(?:cookie|set-cookie|authorization)\s*:[^\r\n]*/gim,
    /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
    /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/gi,
    /(?:密码|密钥|令牌|验证码)\s*[:：=]\s*[^\s，。；]+/g,
  ]) text = text.replace(pattern, '[REDACTED]');
  return text;
}

// Bound JSON-escaped text; never silently truncate a long conversation.
export function partitionTurn(user, assistant) {
  const split = value => {
    const parts = [];
    for (let offset = 0; offset < value.length;) {
      let end = Math.min(value.length, offset + 7000);
      while (JSON.stringify(value.slice(offset, end)).length > 10000) end = offset + Math.floor((end - offset) / 2);
      if (/[\uD800-\uDBFF]/.test(value[end - 1] ?? '')) end--;
      parts.push(value.slice(offset, end)); offset = end;
    }
    return parts;
  };
  const users = split(user), replies = split(assistant);
  return Array.from({ length: Math.max(users.length, replies.length) }, (_, i) => [{
    kind: 'turn', user: users[i] ?? user.slice(0, 1500), assistant: replies[i] ?? '',
  }]);
}

export async function atomicJson(file, value, exclusive = false) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(tmp, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value), 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
  try {
    if (exclusive) { try { await fs.link(tmp, file); } catch (e) { if (e.code !== 'EEXIST') throw e; } }
    else await fs.rename(tmp, file);
  } finally { await fs.unlink(tmp).catch(() => {}); }
}
async function read(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}

/** DSH owns the queue, model route and permissions; Python owns Wiki policy. */
export function memoryPipeline(ctx, config, store) {
  const base = path.dirname(config.root);
  const pending = path.join(base, 'conversation-pending');
  const receipts = path.join(base, 'memory-receipts');
  const stateFile = path.join(base, 'memory-state.json');
  const runtimeFile = path.join(base, 'memory-runtime.json');
  const controller = new AbortController();
  let stopped = false, active, serial = Promise.resolve(), capturing = Promise.resolve(), lastWarning = 0, state;
  const revisions = new Map();
  const warn = () => {
    if (Date.now() - lastWarning < 60000) return;
    lastWarning = Date.now();
    try { ctx.logger?.('dsh-llm-wiki')?.warn?.('Wiki 整理尚未完成；可用 wiki_status 查看待处理任务'); } catch {}
  };
  const ready = (async () => {
    state = await read(stateFile, { startedAt: Date.now(), version: 2 });
    await fs.mkdir(pending, { recursive: true, mode: 0o700 });
    await fs.mkdir(receipts, { recursive: true, mode: 0o700 });
    await atomicJson(stateFile, state);
    await atomicJson(runtimeFile, { version: '0.2.7', pid: process.pid, loadedAt: new Date().toISOString(),
      profile: config.profile, engine: 'bundled-python', trigger: `turn/end + ${config.memoryIdleSeconds ?? 30}s` });
  })();
  const selected = id => config.autoTrustOwnerSessions || config.allowedSessionIds?.includes(id) ||
    (config.trustedSessionsFile && readTrustedSessions(config.trustedSessionsFile).includes(id));
  async function snapshot(id, live) {
    const session = live ?? ctx.get('sessions')?.get(id);
    if (session) return { session, header: session.header, events: session.snapshotEvents() };
    const handle = await ctx.get('sessionPersistence')?.open(id, 'read');
    if (!handle) return undefined;
    try { return { header: handle.header, events: (await handle.read()).events }; }
    finally { await handle.close(); }
  }
  function allowed(snap, id) {
    if (stopped || !selected(id) || !snap || snap.header?.origin === 'subagent' || ctx.get('liveshareShares')) return false;
    if (snap.events.some(e => e.type === 'user/message' && e.data?.source?.principal)) return false;
    const policy = ctx.get('sandboxPolicy');
    const mode = snap.session ? policy?.resolve({ session: snap.session })?.mode :
      snap.events.findLast(e => e.type === 'sandbox/mode')?.data?.mode ?? policy?.resolve({})?.mode;
    return mode === 'danger-full-access';
  }
  async function authorize(id, live) {
    try { return allowed(await snapshot(id, live), id); } catch { return false; }
  }
  async function bridgeAccess(id) {
    try {
      const snap = await snapshot(id);
      return allowed(snap, id) && !snap.events.some(e => e.type === 'user/message' && e.data?.source && Object.hasOwn(e.data.source, 'principal')) ? snap : undefined;
    } catch { return undefined; }
  }
  async function lookupLoop(sessionId, operationId) {
    await ready;
    const name = `${operationId}.json`;
    const receipt = await read(path.join(receipts, name), null);
    const row = receipt ?? await read(path.join(pending, name), null) ?? await read(path.join(receipts, name), null);
    if (!row || row.producer !== 'hermes-loop' || row.sessionId !== sessionId) return { status: 'not-found' };
    return { status: row.completedAt ? 'processed' : 'queued', operationId,
      stage: row.stage, attempts: row.attempts ?? 0, error: row.lastError, evidence: row.evidence,
      lastDiagnostic: safeEngineDiagnostic(row.lastDiagnostic),
      candidates: row.candidates ?? [], outcomes: row.outcomes ?? [], completedAt: row.completedAt };
  }
  const loopBridge = createLoopMemoryBridge({
    access: bridgeAccess, redact,
    search: query => store ? store.search(query, { recall: true, includeHistorical: false, limit: config.maxResults }) : Promise.resolve({ results: [] }),
    lookup: lookupLoop,
    async enqueue(operationId, job) {
      const task = capturing.then(async () => {
        await ready;
        if (!await loopBridge.authorizeJob(job)) return { status: 'denied' };
        const previous = await lookupLoop(job.sessionId, operationId);
        if (previous.status !== 'not-found') return { ...previous, status: 'duplicate', state: previous.status };
        const route = routeOf((await snapshot(job.sessionId)).events, job.sessionId);
        if (!await loopBridge.authorizeJob(job)) return { status: 'denied' };
        try {
          await atomicJson(path.join(pending, `${operationId}.json`), {
            ...job, ...route, dueAt: Date.now() + (config.memoryIdleSeconds ?? 30) * 1000,
          }, true);
        } catch { return { status: 'unknown', operationId, error: 'queue-unavailable' }; }
        return { status: 'queued', operationId };
      });
      capturing = task.catch(warn);
      const result = await task;
      if ((config.memoryIdleSeconds ?? 30) === 0) void (async () => { if (active) await active; await processQueue(); })().catch(warn);
      return result;
    },
  });
  function routeOf(events, sessionId) {
    const route = events.findLast(e => e.type === 'request/header')?.data?.header?.config ??
      events.findLast(e => e.type === 'assistant/message' && e.data?.message?.source?.provider)?.data?.message?.source;
    return route?.provider && route?.model ? { provider: route.provider, model: route.model, sessionId } : undefined;
  }
  function execute(action, args, route, grant, signal) {
    const combined = AbortSignal.any([controller.signal, signal ?? new AbortController().signal]);
    const task = serial.then(() => runEngine(config, action, args, {
      authorize: grant, signal: combined, complete: request => modelJson(ctx, route, request, combined),
    }));
    serial = task.catch(() => {});
    return task;
  }
  async function capture(id, snap, end) {
    if (!allowed(snap, id) || !Number.isSafeInteger(end.data?.turn)) return;
    const stop = snap.events.findLastIndex(e => e.type === 'turn/end' && e.data?.turn === end.data.turn);
    const prefix = stop < 0 ? snap.events : snap.events.slice(0, stop + 1);
    const start = prefix.findLastIndex(e => e.type === 'turn/start' && e.data?.turn === end.data.turn);
    if (start < 0) return;
    const turn = prefix.slice(start);
    const inputs = turn.filter(e => e.type === 'user/message').map(e => e.data);
    if (!inputs.some(owner) || inputs.some(m => m?.source?.principal)) return;
    const user = redact(inputs.filter(owner).map(textOf).join('\n'));
    if (!user.trim()) return;
    const assistant = redact(turn.filter(e => e.type === 'assistant/message').map(e => textOf(e.data?.message)).join('\n'));
    const route = routeOf(prefix, id);
    const parts = partitionTurn(user, assistant);
    const contextMessages = prefix.slice(0, start).flatMap(e => {
      const message = e.type === 'user/message' && owner(e.data) ? e.data : e.type === 'assistant/message' ? e.data?.message : undefined;
      return message ? [`${message.role}: ${textOf(message)}`] : [];
    });
    let context = redact(contextMessages.slice(-4).join('\n')).slice(-2000);
    while (JSON.stringify(context).length > 2500) context = context.slice(Math.floor(context.length / 4));
    if (context) for (const entries of parts) entries.unshift({ kind: 'context', text: context });
    for (let part = 0; part < parts.length; part++) {
      const key = createHash('sha256').update(JSON.stringify([id, end.data.turn, part])).digest('hex');
      if (await read(path.join(receipts, `${key}.json`), null)) continue;
      await atomicJson(path.join(pending, `${key}.json`), {
        version: 2, sessionId: id, turn: end.data.turn, part, ...route,
        entries: parts[part], stage: 'extract', createdAt: Date.now(), attempts: 0,
        dueAt: Date.now() + (config.memoryIdleSeconds ?? 30) * 1000,
        endReason: end.data.reason?.kind ?? 'interrupted',
      }, true);
    }
  }
  async function scan() {
    const persistence = ctx.get('sessionPersistence');
    if (!persistence?.list) return;
    for (const item of await persistence.list()) {
      if (stopped || item.header?.origin === 'subagent' || !selected(item.header.id)) continue;
      if (item.revision !== undefined && revisions.get(item.header.id) === item.revision) continue;
      const snap = await snapshot(item.header.id);
      if (!allowed(snap, item.header.id)) continue;
      for (const event of snap.events) if (event.type === 'turn/end' && event.time >= state.startedAt) {
        await capture(item.header.id, snap, event);
      }
      revisions.set(item.header.id, item.revision);
    }
  }
  async function work(force = false) {
    await ready;
    await capturing;
    if (stopped) return;
    try { await scan(); delete state.scanError; } catch { state.scanError = 'session-scan-unavailable'; warn(); }
    const jobs = [];
    for (const name of (await fs.readdir(pending)).filter(n => JOB.test(n))) {
      try { jobs.push({ name, job: await read(path.join(pending, name)) }); } catch { warn(); }
    }
    jobs.sort((a, b) => (a.job.createdAt ?? 0) - (b.job.createdAt ?? 0));
    let maintenanceGrant;
    for (const { name, job } of jobs) {
      if (stopped) break;
      const file = path.join(pending, name);
      if (await read(path.join(receipts, name), null)) { await fs.unlink(file); continue; }
      if (!force && job.dueAt > Date.now()) continue;
      const grant = () => job.producer === 'hermes-loop' ? loopBridge.authorizeJob(job) : authorize(job.sessionId);
      try {
        if (!await grant()) throw new Error('session-access-unavailable');
        maintenanceGrant = grant;
        state.lastSessionId = job.sessionId;
        if (!job.provider || !job.model) Object.assign(job, routeOf((await snapshot(job.sessionId)).events, job.sessionId));
        if (!job.entries && !job.candidates) {
          job.entries = [{ kind: 'turn', user: job.messages.filter(m => m.role === 'user').map(m => redact(m.text)).join('\n'),
            assistant: job.messages.filter(m => m.role === 'assistant').map(m => redact(m.text)).join('\n') }];
          delete job.summary; delete job.messages;
        }
        if (!job.candidates) {
          const extracted = await execute('extract', { entries: job.entries, provenance: {
            session_id: job.sessionId, platform: 'dsh', profile: config.profile,
            ...(job.producer === 'hermes-loop' ? { producer: job.producer, source_seq: job.evidence.sourceSeq,
              turn: job.turn, source_hash: job.evidence.sourceHash, evidence_quote: job.evidence.quote } : {}),
          } }, job, grant);
          job.candidates = extracted.candidates;
          delete job.lastDiagnostic;
          job.stage = 'consolidate';
          delete job.entries;
          await atomicJson(file, job);
        }
        const ids = job.candidates.map(c => c.candidate_id).filter(Boolean);
        const result = ids.length ? await execute('consolidate', { candidateIds: ids }, job, grant) : { ran: true, outcomes: [] };
        if (!result.ran || result.outcomes.some(o => ['error', 'deferred'].includes(o.result))) throw new Error('consolidation-pending');
        await atomicJson(path.join(receipts, name), { sessionId: job.sessionId, turn: job.turn, part: job.part,
          ...(job.producer === 'hermes-loop' ? { producer: job.producer, evidence: job.evidence } : {}),
          completedAt: new Date().toISOString(), candidates: job.candidates, outcomes: result.outcomes });
        await fs.unlink(file);
        state.lastCompletedAt = new Date().toISOString();
      } catch (error) {
        job.attempts = (job.attempts ?? 0) + 1;
        job.lastError = /^[a-zA-Z-]{1,80}$/.test(error?.message ?? '') ? error.message : 'processing-failed';
        const diagnostic = safeEngineDiagnostic(error?.engineDiagnostic);
        if (diagnostic) job.lastDiagnostic = diagnostic; else delete job.lastDiagnostic;
        job.lastAttemptAt = new Date().toISOString();
        job.dueAt = Date.now() + Math.min(3600000, 60000 * 2 ** Math.min(job.attempts - 1, 6));
        await atomicJson(file, job);
        warn();
      }
    }
    maintenanceGrant ??= state.lastSessionId ? () => authorize(state.lastSessionId) : undefined;
    if (maintenanceGrant && Date.now() - (state.lastMaintenanceAt ?? 0) > 86400000 && !stopped && await maintenanceGrant()) {
      try {
        state.maintenance = await execute('maintenance', {}, undefined, maintenanceGrant);
        state.lastMaintenanceAt = Date.now(); delete state.maintenanceError;
      } catch { state.maintenanceError = 'maintenance-failed'; }
    }
    await atomicJson(stateFile, state);
    await atomicJson(runtimeFile, { version: '0.2.7', pid: process.pid, checkedAt: new Date().toISOString(),
      profile: config.profile, persistenceAvailable: Boolean(ctx.get('sessionPersistence')), engine: 'bundled-python' });
  }
  function processQueue(force = false) {
    if (stopped) return Promise.resolve();
    if (active) return active;
    active = work(force).finally(() => { active = undefined; });
    return active;
  }
  const timer = setInterval(() => void processQueue().catch(warn), 15000);
  timer.unref?.();
  void ready.then(() => processQueue()).catch(warn);
  return {
    bridge: loopBridge.service,
    async enqueue(session, end) {
      const task = capturing.then(async () => { await ready; await capture(session.id, await snapshot(session.id, session), end); });
      capturing = task.catch(warn);
      await task;
      if ((config.memoryIdleSeconds ?? 30) === 0) void (async () => { if (active) await active; await processQueue(); })().catch(warn);
    },
    async flush() { if (active) await active; await processQueue(true); return this.status(); },
    async status() {
      await ready;
      const rows = [];
      for (const name of (await fs.readdir(pending)).filter(n => JOB.test(n))) {
        try {
          const j = await read(path.join(pending, name));
          rows.push({ sessionId: j.sessionId, turn: j.turn, stage: j.stage ?? 'extract', attempts: j.attempts ?? 0, error: j.lastError,
            lastDiagnostic: safeEngineDiagnostic(j.lastDiagnostic) });
        } catch { rows.push({ error: 'queue-file-unreadable' }); }
      }
      return { active: Boolean(active), pending: rows.length, jobs: rows.slice(0, 30),
        completed: (await fs.readdir(receipts)).filter(n => JOB.test(n)).length,
        lastCompletedAt: state.lastCompletedAt, digest: state.maintenance?.digest ?? '',
        scanError: state.scanError, maintenanceError: state.maintenanceError,
        trigger: `turn/end + ${config.memoryIdleSeconds ?? 30}s`, startedAt: state.startedAt };
    },
    run(action, args, session, grant, signal) {
      return execute(action, args, routeOf(session.snapshotEvents(), session.id), grant, signal);
    },
    async stop() {
      stopped = true; clearInterval(timer); controller.abort();
      await ready.catch(() => {});
      await capturing; await active?.catch(() => {}); await serial;
    },
  };
}
