import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const bridge = fileURLToPath(new URL('../engine/bridge.py', import.meta.url));

const PYTHON_ERRORS = new Set(['WikiError', 'WikiAccessError', 'WikiConflictError', 'ValueError', 'TypeError', 'KeyError',
  'AttributeError', 'RuntimeError', 'OSError', 'PermissionError', 'FileNotFoundError', 'ImportError', 'ModuleNotFoundError',
  'SyntaxError', 'JSONDecodeError', 'UnicodeEncodeError', 'UnicodeDecodeError', 'MemoryError', 'TimeoutError', 'BrokenPipeError']);
const HOST_ERRORS = new Set(['access-revoked', 'unsupported-engine-request', 'model-route-unavailable',
  'model-output-too-large', 'model-incomplete', 'model-invalid-json', 'model-offline']);

/** Only bounded enums and process counters may reach queue metadata or status. */
export function safeEngineDiagnostic(value) {
  if (!value || !['spawn-error', 'stdin-error', 'timeout', 'host-request-failed', 'worker-exit',
    'missing-result', 'worker-error', 'protocol-error', 'output-too-large'].includes(value.reason)) return undefined;
  const result = { reason: value.reason };
  if (Number.isSafeInteger(value.exitCode)) result.exitCode = value.exitCode;
  if (['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGABRT', 'SIGSEGV'].includes(value.signal)) result.signal = value.signal;
  if (['ENOENT', 'EACCES', 'EPERM', 'EINVAL', 'EAGAIN', 'EMFILE', 'ENFILE', 'ENOMEM', 'EPIPE'].includes(value.spawnCode)) result.spawnCode = value.spawnCode;
  if (Number.isSafeInteger(value.stderrBytes) && value.stderrBytes >= 0) result.stderrBytes = value.stderrBytes;
  if (PYTHON_ERRORS.has(value.pythonException)) result.pythonException = value.pythonException;
  if (['llm', 'authorize'].includes(value.requestType)) result.requestType = value.requestType;
  return result;
}

export async function modelJson(ctx, route, request, signal) {
  if (!route?.provider || !route?.model) throw new Error('model-route-unavailable');
  const deadline = AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(120000)]);
  const config = { provider: route.provider, model: route.model, maxTokens: Math.max(4096, request.maxTokens ?? 4096) };
  const call = ctx.llm.prepareCall ? await ctx.llm.prepareCall(config, deadline, (controls, model) => ({
    ...controls, ...(model.reasoning?.efforts?.length ? { reasoningEffort: model.reasoning.efforts[0].id } : {}),
  })) : { config, stream: options => ctx.llm.stream(options) };
  let output = '', finish;
  const options = { ...call.config, system: request.system, messages: [{ id: randomUUID(), role: 'user',
    source: { kind: 'dsh-llm-wiki' }, content: [{ type: 'text', text: request.user }] }],
    sessionId: route.sessionId, purpose: request.task, signal: deadline };
  for await (const chunk of call.stream(options)) {
    deadline.throwIfAborted();
    if (chunk.type === 'text-delta') output += chunk.text;
    if (chunk.type === 'finish') finish = chunk.reason?.kind;
    if (output.length > 64000) throw new Error('model-output-too-large');
  }
  if (finish !== 'stop') throw new Error('model-incomplete');
  try {
    const result = JSON.parse(output.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error();
    return result;
  } catch { throw new Error('model-invalid-json'); }
}

/** Hidden, short-lived worker. No Hermes imports, credentials or independent network client. */
export async function runEngine(config, action, args = {}, { complete, authorize = () => false, signal } = {}) {
  signal?.throwIfAborted();
  const child = spawn(config.pythonExecutable || 'python', ['-I', '-u', '-c',
    'import runpy,sys; from pathlib import Path; p=Path(sys.argv[1]); sys.path.insert(0,str(p.parent)); runpy.run_path(str(p),run_name="__main__")', bridge],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  const diagnostic = { stderrBytes: 0 };
  const failure = (message, reason) => Object.assign(new Error(message), {
    engineDiagnostic: safeEngineDiagnostic({ ...diagnostic, reason }),
  });
  const abort = () => child.kill();
  signal?.addEventListener('abort', abort, { once: true });
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; abort(); }, 600000);
  let exitError, outcome, stderrTail = '';
  child.on('error', error => { exitError = error; diagnostic.spawnCode = error.code; diagnostic.reason = 'spawn-error'; });
  child.stdin.on('error', error => { diagnostic.spawnCode ??= error.code; diagnostic.reason ??= 'stdin-error'; });
  child.stderr.on('data', chunk => {
    diagnostic.stderrBytes += chunk.length;
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-4096);
    for (const match of stderrTail.matchAll(/(?:^|\n)([A-Za-z]+Error):/g)) {
      if (PYTHON_ERRORS.has(match[1])) diagnostic.pythonException = match[1];
    }
  });
  const exited = new Promise(resolve => child.on('close', (code, signal) => {
    diagnostic.exitCode = code; diagnostic.signal = signal; resolve(code);
  }));
  const reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
  try {
    child.stdin.write(JSON.stringify({ config: { root: config.root, profile: config.profile, maxChars: config.maxChars }, action, args }) + '\n');
    for await (const line of reader) {
      if (line.length > 4000000) throw failure('engine-output-too-large', 'output-too-large');
      let message;
      try { message = JSON.parse(line); } catch { throw failure('engine-unavailable', 'protocol-error'); }
      if (!message || !['result', 'llm', 'authorize'].includes(message.type)) throw failure('engine-unavailable', 'protocol-error');
      if (message.type === 'result') { outcome = message; continue; }
      let answer;
      try {
        if (!await authorize() || signal?.aborted) throw new Error('access-revoked');
        if (message.type === 'authorize') answer = { ok: true };
        else if (complete) answer = { ok: true, value: await complete(message) };
        else throw new Error('unsupported-engine-request');
      } catch (error) {
        exitError = error; diagnostic.reason = 'host-request-failed'; diagnostic.requestType = message.type; answer = { ok: false };
      }
      if (!child.killed) child.stdin.write(JSON.stringify(answer) + '\n');
    }
    const code = await exited;
    signal?.throwIfAborted();
    if (timedOut) throw failure('engine-unavailable', 'timeout');
    if (exitError) throw failure(HOST_ERRORS.has(exitError.message) ? exitError.message : 'engine-unavailable', diagnostic.reason);
    if (code !== 0 || !outcome) throw failure('engine-unavailable', diagnostic.reason ?? (code !== 0 ? 'worker-exit' : 'missing-result'));
    if (!outcome.ok) {
      if (PYTHON_ERRORS.has(outcome.error)) diagnostic.pythonException = outcome.error;
      throw failure(`engine-${PYTHON_ERRORS.has(outcome.error) ? outcome.error : 'failure'}`, 'worker-error');
    }
    return outcome.value;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
    if (child.exitCode === null) child.kill();
    reader.close();
    await exited;
    stderrTail = '';
  }
}
