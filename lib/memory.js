import * as nodeFs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { TextDecoder } from 'node:util';
import yaml from 'js-yaml';

const DAY = 86_400_000;
const REVIEW_DAYS = 365;
const MAX_INDEX_BYTES = 8 * 1024 * 1024;
const MAX_PAGE_BYTES = 128 * 1024;
const LOCK_NAME = '.dsh-llm-wiki-write.lock';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SESSION_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/;
const PROFILE_RE = /^[a-z0-9_-]{1,64}$/;
const decoder = new TextDecoder('utf-8', { fatal: true });

// Inputs are explicit user-provided memory, but known credentials and prompt
// control text must not be persisted. These patterns are defense in depth.
const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /\b(?:sk-|ghp_|github_pat_|xox[baprs]-|AIza|hf_|npm_|pypi-|gsk_|xai-)[A-Za-z0-9_.=-]{10,}\b/i,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret|credential)\s*["']?\s*[:=]\s*["']?[^\s"']+/i,
  /(?:^|\n)\s*(?:(?:>\s*)|(?:(?:[-+*]|\d+[.)])\s+)|(?:\[[ xX]\]\s+))*(?:cookie|set-cookie|authorization)\s*:/im,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/i,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/i,
];
const INJECTION_PATTERNS = [
  /\b(?:ignore|disregard|override|forget)\b.{0,80}\b(?:instructions?|rules?|prompts?)\b/i,
  /\b(?:reveal|show|print|exfiltrate|leak)\b.{0,80}\b(?:system|developer|hidden|internal)\s+(?:prompts?|instructions?|rules?)\b/i,
  /(?:忽略|无视|覆盖|绕过|泄露|输出|打印|透露).{0,40}(?:系统|开发者|上级|之前|先前).{0,20}(?:指令|提示|规则|提示词)/,
];

class WriteFault extends Error {
  constructor(code, uncertain = false) { super(code); this.code = code; this.uncertain = uncertain; }
}
const fail = (code, uncertain = false) => { throw new WriteFault(code, uncertain); };

function samePath(a, b) {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}
function sameFile(a, b) { return a.dev === b.dev && a.ino === b.ino; }
function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function hash(values) { return createHash('sha256').update(JSON.stringify(values)).digest('hex'); }
function digestOf(meta, content) { return hash([meta.operation_id, meta.title, content, meta.source_session, meta.scope, meta.created_at]); }
function decode(buffer) {
  try { return decoder.decode(buffer); } catch { return fail('invalid-utf8'); }
}
async function readBounded(handle, limit) {
  const chunks = [];
  let offset = 0;
  while (offset <= limit) {
    const block = Buffer.allocUnsafe(Math.min(65536, limit + 1 - offset));
    const { bytesRead } = await handle.read(block, 0, block.length, offset);
    if (!bytesRead) break;
    chunks.push(block.subarray(0, bytesRead));
    offset += bytesRead;
  }
  if (offset > limit) fail('file-too-large');
  return Buffer.concat(chunks, offset);
}
function safeText(value, max, multiline = false) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value) || (!multiline && /[\r\n]/.test(value))) {
    throw new TypeError('Memory input rejected');
  }
  const normalized = value.normalize('NFKC');
  const compact = normalized.replace(/\s+/g, ' ');
  if (SECRET_PATTERNS.some(pattern => pattern.test(normalized)) || INJECTION_PATTERNS.some(pattern => pattern.test(compact)) ||
      /(?:^|[\s"'`(])\.\.[\\/]/.test(normalized)) throw new TypeError('Memory input rejected');
  return value.trim();
}
function marker(id, type) { return `<!-- dsh-llm-wiki:${id}:${type} -->`; }
function relativePath(id) { return `entities/memory-${id}.md`; }
function label(title) { return title.replace(/[\\\[\]]/g, '\\$&'); }
function linesFor(meta) {
  const target = relativePath(meta.operation_id);
  const action = meta.source === 'conversation-summary' ? '对话整理' : meta.source === 'user-automatic' ? '自动记忆' : '显式记忆';
  return {
    index: `\n- [${label(meta.title)}](${target}) ${marker(meta.operation_id, 'index')}\n`,
    log: `\n- ${meta.created_at} · ${action} · [${label(meta.title)}](${target}) · 来源会话 ${meta.source_session} ${marker(meta.operation_id, 'log')}\n`,
  };
}
function pageFor(meta, content) {
  const intro = meta.source === 'conversation-summary' ? '以下内容由模型根据对话整理，可能有误，请结合来源会话核对：' : '以下是用户原话，第一人称指用户：';
  return `---\n${yaml.dump(meta, { lineWidth: -1, noRefs: true })}---\n# ${meta.title}\n\n${intro}\n\n${content}\n\n<!-- dsh-llm-wiki:${meta.operation_id}:page:${digestOf(meta, content)} -->\n`;
}

/** Reject malformed, modified, cross-profile or incomplete pages during recovery. */
function parsePage(bytes, id, profile) {
  if (bytes.length > MAX_PAGE_BYTES) fail('page-invalid');
  const page = decode(bytes);
  if (!page.startsWith('---\n')) fail('page-incomplete');
  const end = page.indexOf('\n---\n', 4);
  if (end < 0 || end > 65536) fail('page-incomplete');
  let meta;
  try { meta = yaml.load(page.slice(4, end), { schema: yaml.JSON_SCHEMA }); } catch { fail('page-invalid'); }
  if (!record(meta) || meta.operation_id !== id || meta.tier !== 'canonical' || meta.status !== 'active' ||
      meta.scope !== `profile:${profile}` || meta.review_class !== 'stable' || !['user-explicit', 'user-automatic', 'conversation-summary'].includes(meta.source) ||
      typeof meta.source_session !== 'string' || !SESSION_RE.test(meta.source_session) ||
      typeof meta.title !== 'string' || typeof meta.created_at !== 'string' ||
      meta.last_verified_at !== meta.created_at || typeof meta.expires_at !== 'string') fail('page-invalid');
  const created = Date.parse(meta.created_at);
  if (!Number.isFinite(created) || new Date(created).toISOString() !== meta.created_at ||
      new Date(created + REVIEW_DAYS * DAY).toISOString() !== meta.expires_at ||
      meta.created !== meta.created_at.slice(0, 10) || meta.updated !== meta.created || meta.type !== 'entity' || meta.origin !== 'dsh' ||
      !Array.isArray(meta.tags) || meta.tags.length !== 1 || meta.tags[0] !== 'memory' ||
      !Array.isArray(meta.aliases) || meta.aliases.length !== 0 || !Array.isArray(meta.sources) || meta.sources.length !== 0) fail('page-invalid');
  const body = page.slice(end + '\n---\n'.length);
  const intro = meta.source === 'conversation-summary' ? '以下内容由模型根据对话整理，可能有误，请结合来源会话核对：' : '以下是用户原话，第一人称指用户：';
  const prefix = `# ${meta.title}\n\n${intro}\n\n`;
  const tailPrefix = `\n\n<!-- dsh-llm-wiki:${id}:page:`;
  const tailAt = body.lastIndexOf(tailPrefix);
  if (!body.startsWith(prefix) || tailAt < prefix.length || !body.endsWith(' -->\n')) fail('page-incomplete');
  const content = body.slice(prefix.length, tailAt);
  const expected = `${tailPrefix}${digestOf(meta, content)} -->\n`;
  if (body.slice(tailAt) !== expected) fail('page-incomplete');
  try { safeText(meta.title, 120); safeText(content, 6000, true); } catch { fail('page-invalid'); }
  return { meta, content, bytes };
}

/**
 * Explicit-only canonical memory persistence. This class does not evaluate
 * user consent, sandbox policy, sharing state, or model provenance: its owner
 * must establish those before calling prepare/commit. It never promotes candidates.
 *
 * The lock serializes this implementation's writers. Other editors need not
 * honor it, so index/log are append-only and identities are rechecked; no
 * overwrite or filesystem-wide isolation is claimed. A crash may leave a
 * lock that requires operator inspection before removal.
 */
export class MemoryStore {
  #root;
  #profile;
  #fs;
  #plans = new WeakMap();
  #lockTimeoutMs;

  constructor({ root, profile = 'default', io = nodeFs, lockTimeoutMs = 2000 } = {}) {
    if (typeof root !== 'string' || !path.isAbsolute(root) || !root.trim() ||
        typeof profile !== 'string' || !PROFILE_RE.test(profile) ||
        !record(io) || !Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs < 0 || lockTimeoutMs > 10000) {
      throw new TypeError('Invalid memory store configuration');
    }
    this.#root = path.resolve(root);
    this.#profile = profile;
    this.#fs = io;
    this.#lockTimeoutMs = lockTimeoutMs;
  }

  /** Validate and mint an operation identity without touching the filesystem. */
  prepare(input) {
    if (!record(input) || Object.keys(input).some(key => !['title', 'content', 'sessionId', 'explicit', 'automatic', 'summaryKey'].includes(key)) ||
        input.explicit !== true || (input.automatic !== undefined && typeof input.automatic !== 'boolean') ||
        (input.summaryKey !== undefined && (typeof input.summaryKey !== 'string' || !input.summaryKey || input.summaryKey.length > 300)) ||
        typeof input.sessionId !== 'string' || !SESSION_RE.test(input.sessionId)) {
      throw new TypeError('Memory input rejected');
    }
    const title = safeText(input.title, 120);
    const content = safeText(input.content, 6000, true);
    const combined = `${title}\n${content}`;
    // Keep foreign-profile identifiers out of a profile-scoped source as the
    // reader treats embedded foreign scope declarations as unavailable.
    for (const match of combined.matchAll(/["']?scope["']?\s*:\s*["']?(profile:[a-z0-9_-]{1,64})/gi)) {
      if (match[1].toLowerCase() !== `profile:${this.#profile}`) throw new TypeError('Memory input rejected');
    }
    let operationId = randomUUID();
    if (input.automatic || input.summaryKey) {
      const identity = input.summaryKey ? ['dsh-summary-v1', this.#profile, input.sessionId, input.summaryKey] : ['dsh-auto-v1', this.#profile, content];
      const bytes = createHash('sha256').update(JSON.stringify(identity)).digest().subarray(0, 16);
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const hex = bytes.toString('hex');
      operationId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }
    const created = new Date();
    const createdAt = created.toISOString();
    const meta = {
      operation_id: operationId,
      title,
      created: createdAt.slice(0, 10),
      updated: createdAt.slice(0, 10),
      type: 'entity',
      tags: ['memory'],
      aliases: [],
      sources: [],
      origin: 'dsh',
      tier: 'canonical',
      status: 'active',
      scope: `profile:${this.#profile}`,
      source: input.summaryKey ? 'conversation-summary' : input.automatic ? 'user-automatic' : 'user-explicit',
      source_session: input.sessionId,
      review_class: 'stable',
      last_verified_at: createdAt,
      created_at: createdAt,
      expires_at: new Date(created.getTime() + REVIEW_DAYS * DAY).toISOString(),
    };
    const plan = Object.freeze({ operationId, path: relativePath(operationId), expiresAt: meta.expires_at });
    this.#plans.set(plan, { meta, content, bytes: Buffer.from(pageFor(meta, content), 'utf8') });
    return plan;
  }

  /** Write the prepared page and append its index/log records. Never overwrites. */
  async commit(plan, { authorize } = {}) {
    const entry = record(plan) ? this.#plans.get(plan) : undefined;
    if (!entry) throw new TypeError('Invalid memory plan');
    if (typeof authorize !== 'function') throw new TypeError('Memory authorization callback required');
    return this.#run(entry.meta.operation_id, entry, authorize);
  }

  /** Complete an interrupted operation if its page is intact and the lock is free. */
  async recover(operationId, { authorize, reviewed = false } = {}) {
    if (typeof operationId !== 'string' || !UUID_RE.test(operationId)) throw new TypeError('Invalid memory operation');
    if (typeof authorize !== 'function') throw new TypeError('Memory authorization callback required');
    if (typeof reviewed !== 'boolean') throw new TypeError('Invalid memory recovery review');
    return this.#run(operationId, undefined, authorize, reviewed);
  }

  async #authorize(authorize, id, stage) {
    try {
      if (await authorize({ operationId: id, stage }) === false) fail('authorization-denied');
    } catch {
      fail('authorization-denied');
    }
  }

  async #checkedDirectory(dir) {
    const info = await this.#fs.lstat(dir);
    if (!info.isDirectory() || info.isSymbolicLink() || !samePath(await this.#fs.realpath(dir), dir)) fail('unsafe-directory');
    return info;
  }

  async #checkRoots() {
    await this.#checkedDirectory(this.#root);
    await this.#checkedDirectory(path.join(this.#root, 'entities'));
  }

  async #acquire(authorize, id) {
    const lockPath = path.join(this.#root, LOCK_NAME);
    const token = randomUUID();
    const payload = JSON.stringify({ token, pid: process.pid, createdAt: new Date().toISOString() });
    const deadline = performance.now() + this.#lockTimeoutMs;
    for (;;) {
      let handle;
      await this.#authorize(authorize, id, 'lock');
      try {
        handle = await this.#fs.open(lockPath, 'wx', 0o600);
      } catch (error) {
        if (error?.code !== 'EEXIST') fail('lock-unavailable');
        if (performance.now() >= deadline) fail('lock-busy');
        await delay(Math.min(25, Math.max(1, deadline - performance.now())));
        continue;
      }
      let stat;
      try {
        stat = await handle.stat();
        await handle.writeFile(payload, 'utf8');
        await handle.sync();
        return { path: lockPath, handle, stat, payload };
      } catch {
        // Do not delete a replaced lock. A failed cleanup is an unknown effect.
        try {
          await handle.close();
          const named = await this.#fs.lstat(lockPath);
          if (!stat || !named.isFile() || named.isSymbolicLink() || !sameFile(stat, named)) fail('lock-setup-unknown', true);
          await this.#fs.unlink(lockPath);
        } catch { fail('lock-setup-unknown', true); }
        fail('lock-unavailable');
      }
    }
  }

  async #release(lock) {
    try {
      await lock.handle.close();
      const named = await this.#fs.lstat(lock.path);
      if (!named.isFile() || named.isSymbolicLink() || !sameFile(lock.stat, named) || await this.#fs.readFile(lock.path, 'utf8') !== lock.payload) fail('lock-release-unknown', true);
      await this.#fs.unlink(lock.path);
    } catch { fail('lock-release-unknown', true); }
  }

  async #readPage(id) {
    const target = path.join(this.#root, 'entities', `memory-${id}.md`);
    const before = await this.#fs.lstat(target);
    if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_PAGE_BYTES || !samePath(await this.#fs.realpath(target), target)) fail('page-invalid');
    const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
    const handle = await this.#fs.open(target, flags);
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || !sameFile(before, opened) || opened.size > MAX_PAGE_BYTES) fail('page-invalid');
      const bytes = await readBounded(handle, MAX_PAGE_BYTES);
      const after = await handle.stat();
      const named = await this.#fs.lstat(target);
      if (!named.isFile() || named.isSymbolicLink() || !sameFile(opened, named) ||
          opened.size !== after.size || opened.mtimeMs !== after.mtimeMs) fail('page-changed');
      return parsePage(bytes, id, this.#profile);
    } finally { await handle.close(); }
  }

  async #createPage(entry, authorize, onCreate) {
    const id = entry.meta.operation_id;
    const directory = path.join(this.#root, 'entities');
    const target = path.join(directory, `memory-${id}.md`);
    const staged = path.join(directory, `.memory-${id}-${randomUUID()}.tmp`);
    let handle;
    let stagingCreated = false;
    let stagedStat;
    let published = false;
    await this.#authorize(authorize, id, 'page');
    try {
      try { handle = await this.#fs.open(staged, 'wx', 0o600); stagingCreated = true; }
      catch { fail('page-stage-failed'); }
      try {
        stagedStat = await handle.stat();
        await this.#authorize(authorize, id, 'page');
        try { await handle.writeFile(entry.bytes); await handle.sync(); }
        catch { fail('page-stage-write-failed'); }
      } finally {
        try { await handle.close(); } catch { fail('page-stage-close-unknown', true); }
      }
      // Linking a complete same-volume staging file creates the final name
      // atomically and never replaces an existing page.
      await this.#authorize(authorize, id, 'page');
      try { await this.#fs.link(staged, target); published = true; onCreate(); }
      catch (error) {
        if (error?.code !== 'EEXIST') fail('page-publish-unknown', true);
      }
      return published;
    } finally {
      if (stagingCreated) {
        try {
          const current = await this.#fs.lstat(staged);
          if (!current.isFile() || current.isSymbolicLink() || !stagedStat || !sameFile(current, stagedStat)) fail('page-stage-cleanup-unknown', true);
          await this.#fs.unlink(staged);
        } catch { fail('page-stage-cleanup-unknown', true); }
      }
    }
  }

  async #appendOnce(fileName, line, expectedMarker, authorize, id, stage) {
    const target = path.join(this.#root, fileName);
    let handle;
    const noFollow = constants.O_NOFOLLOW ?? 0;
    for (let attempt = 0; attempt < 2; attempt++) {
      try { handle = await this.#fs.open(target, constants.O_RDWR | constants.O_APPEND | noFollow); break; }
      catch (error) {
        if (error?.code !== 'ENOENT') fail('append-open-failed');
        await this.#authorize(authorize, id, stage);
        try { handle = await this.#fs.open(target, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600); break; }
        catch (created) { if (created?.code !== 'EEXIST') fail('append-open-failed'); }
      }
    }
    if (!handle) fail('append-open-failed');
    try {
      const opened = await handle.stat();
      const named = await this.#fs.lstat(target);
      if (!opened.isFile() || !named.isFile() || named.isSymbolicLink() || !sameFile(opened, named) ||
          opened.size > MAX_INDEX_BYTES || !samePath(await this.#fs.realpath(target), target)) fail('append-target-invalid');
      const previous = decode(await readBounded(handle, MAX_INDEX_BYTES));
      if (previous.includes(expectedMarker)) {
        if (!previous.includes(line)) fail('marker-conflict');
        return;
      }
      // A concurrent replacement is never overwritten; the open handle must
      // still refer to the named file immediately before the append.
      const current = await this.#fs.lstat(target);
      if (!current.isFile() || current.isSymbolicLink() || !sameFile(opened, current)) fail('append-target-changed');
      await this.#authorize(authorize, id, stage);
      try {
        await handle.writeFile(line, 'utf8');
        await handle.sync();
      } catch { fail('append-write-unknown', true); }
      const after = await this.#fs.lstat(target);
      if (!after.isFile() || after.isSymbolicLink() || !sameFile(opened, after)) fail('append-write-unknown', true);
      const verify = await this.#fs.readFile(target);
      if (verify.length > MAX_INDEX_BYTES || !decode(verify).includes(line)) fail('append-write-unknown', true);
    } finally {
      try { await handle.close(); } catch { fail('append-close-unknown', true); }
    }
  }

  async #linePresent(fileName, line, expectedMarker) {
    const target = path.join(this.#root, fileName);
    let handle;
    try { handle = await this.#fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
    catch (error) { if (error?.code === 'ENOENT') return false; fail('verification-failed'); }
    try {
      const opened = await handle.stat();
      const named = await this.#fs.lstat(target);
      if (!opened.isFile() || !named.isFile() || named.isSymbolicLink() || !sameFile(opened, named) ||
          opened.size > MAX_INDEX_BYTES || !samePath(await this.#fs.realpath(target), target)) fail('verification-failed');
      const bytes = await readBounded(handle, MAX_INDEX_BYTES);
      const after = await handle.stat();
      const finalName = await this.#fs.lstat(target);
      if (!finalName.isFile() || finalName.isSymbolicLink() || !sameFile(opened, finalName) ||
          after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || bytes.length > MAX_INDEX_BYTES) fail('verification-failed');
      const value = decode(bytes);
      if (value.includes(expectedMarker) && !value.includes(line)) fail('marker-conflict');
      return value.includes(line);
    } finally { await handle.close(); }
  }

  async #run(id, prepared, authorize, reviewed = false) {
    const result = { status: 'not-started', operationId: id, path: relativePath(id), stage: 'preflight' };
    let lock;
    let pagePresent = false;
    let pageCreated = false;
    try {
      await this.#checkRoots();
      result.stage = 'lock';
      lock = await this.#acquire(authorize, id);
      await this.#checkRoots();
      result.stage = 'page';
      if (prepared) await this.#createPage(prepared, authorize, () => { pageCreated = true; });
      let page;
      try { page = await this.#readPage(id); }
      catch (error) {
        if (error?.code === 'ENOENT') fail('page-missing');
        throw error;
      }
      pagePresent = true;
      const duplicate = Boolean(prepared && !pageCreated && ['user-automatic', 'conversation-summary'].includes(prepared.meta.source) &&
        page.meta.source === prepared.meta.source && page.content === prepared.content &&
        (prepared.meta.source !== 'conversation-summary' || (page.meta.title === prepared.meta.title && page.meta.source_session === prepared.meta.source_session)));
      if (prepared && !page.bytes.equals(prepared.bytes) && !duplicate) fail('page-conflict');
      const lines = linesFor(page.meta);
      if (!pageCreated && !reviewed) {
        result.stage = 'recovery';
        const indexPresent = await this.#linePresent('index.md', lines.index, marker(id, 'index'));
        const logPresent = await this.#linePresent('log.md', lines.log, marker(id, 'log'));
        // A missing marker can mean either no append or a partially written line.
        // Do not create duplicate fragments without an explicit human review.
        if (!indexPresent || !logPresent) fail('recovery-review-required');
      } else {
        result.stage = 'index';
        await this.#appendOnce('index.md', lines.index, marker(id, 'index'), authorize, id, 'index');
        result.stage = 'log';
        await this.#appendOnce('log.md', lines.log, marker(id, 'log'), authorize, id, 'log');
      }
      // A concurrent non-cooperating editor may have removed an earlier line.
      // Recheck all three after the writes; append never overwrites that editor.
      result.stage = 'verify';
      const checkedPage = await this.#readPage(id);
      if (!checkedPage.bytes.equals(page.bytes)) fail('page-changed');
      for (const [fileName, line, type] of [['index.md', lines.index, 'index'], ['log.md', lines.log, 'log']]) {
        if (!await this.#linePresent(fileName, line, marker(id, type))) fail('verification-failed');
      }
      result.status = 'committed';
      if (duplicate) result.duplicate = true;
      result.stage = 'complete';
    } catch (error) {
      result.status = error?.uncertain ? 'unknown' : pagePresent || pageCreated || (result.stage === 'page' && error?.code !== 'page-missing' && error?.code !== 'authorization-denied') ? 'partial' : 'not-started';
      if (result.status === 'not-started') result.priorState = 'not-inspected';
      result.code = error instanceof WriteFault ? error.code : 'filesystem-error';
    } finally {
      if (lock) {
        try { await this.#release(lock); }
        catch { result.status = 'unknown'; result.stage = 'lock-release'; result.code = 'lock-release-unknown'; }
      }
    }
    return result;
  }
}
