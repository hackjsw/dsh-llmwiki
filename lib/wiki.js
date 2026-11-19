import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import yaml from 'js-yaml';

const CANONICAL_DIRS = new Set(['entities', 'concepts', 'comparisons', 'queries']);
const HISTORICAL_DIRS = new Set(['raw', 'archive', '_archive']);
const NAVIGATION_FILES = new Set(['SCHEMA.md', 'index.md', 'log.md']);
const CURRENT = 'CURRENT_STATE.md';
const SCOPE_RE = /^profile:[a-z0-9_-]{1,64}$/;
const DEVICE_RE = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY = 24 * 60 * 60 * 1000;
const decoder = new TextDecoder('utf-8', { fatal: true });

// Check the complete source, including frontmatter. Pattern matching is a defense-in-depth
// filter, not a guarantee that all private information is detected.
const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  /\b(?:sk-|ghp_|github_pat_|xox[baprs]-|AIza|hf_|npm_|pypi-|gsk_|xai-)[A-Za-z0-9_.=-]{10,}\b/i,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret|credential)\s*["']?\s*[:=]\s*["']?[^\s"']+/i,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/i,
  /(?:^|\n)\s*(?:(?:>\s*)|(?:(?:[-+*]|\d+[.)])\s+)|(?:\[[ xX]\]\s+))*(?:cookie|set-cookie|authorization)\s*:/im,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/i,
];
const INJECTION_PATTERNS = [
  /\b(?:ignore|disregard|override|forget)\b.{0,80}\b(?:instructions?|rules?|prompts?)\b/i,
  /\b(?:reveal|show|print|exfiltrate|leak)\b.{0,80}\b(?:system|developer|hidden|internal)\s+(?:prompts?|instructions?|rules?)\b/i,
  /(?:忽略|无视|覆盖|绕过|泄露|输出|打印|透露).{0,40}(?:系统|开发者|上级|之前|先前).{0,20}(?:指令|提示|规则|提示词)/,
];
const PRIVATE_IP = /(?<!\d)(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|127\.\d{1,3}\.\d{1,3}\.\d{1,3})(?!\d)/;
const CONNECTION_STRING = /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s"'<>]*[:@][^\s"'<>]{3,}/i;
const PRIVATE_PORT = /(?:\b(?:port|listen|bind)\b|端口|监听)[^\n]{0,20}?(?<!\d)\d{1,5}(?!\d)/i;
const STOPWORDS = new Set([
  '今天', '明天', '昨天', '现在', '什么', '怎么', '么样', '怎样', '为何',
  '一下', '一个', '这个', '那个', '这样', '那样', '可以', '我们', '你们',
  '帮我', '给我', '是不是', '是否', '没有', '如何', '哪里', '哪个', '然后',
  '因为', '所以', '如果', '就是', '已经', '需要', '应该', '请问', '问题',
  '情况', '看看', '知道', '觉得', '时候', '我的', '你的', '的是', '了吗',
  'the', 'and', 'for', 'with', 'what', 'how', 'this', 'that', 'you', 'are',
  'can', 'please', 'help', 'is', 'it', 'to', 'of', 'in', 'on', 'me', 'my',
]);

function unavailable() {
  // Deliberately identical for missing, unreadable, invalid and out-of-scope paths.
  return new Error('Wiki source unavailable');
}

function boundedInteger(value, fallback, min, max) {
  const parsed = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.max(min, Math.min(max, parsed));
}

function normalized(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase();
}

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function validateRelative(relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\\') || relative.startsWith('/')) {
    throw unavailable();
  }
  const parts = relative.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || part.startsWith('.') ||
      /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part) || DEVICE_RE.test(part))) {
    throw unavailable();
  }
  if (!parts.at(-1).toLowerCase().endsWith('.md')) throw unavailable();
  return parts;
}

function frontmatter(text) {
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) return { metadata: {}, body: text };
  const lines = text.split(/(?<=\n)/);
  let end = -1;
  let bytes = Buffer.byteLength(lines[0], 'utf8');
  for (let index = 1; index < lines.length && index <= 200; index++) {
    bytes += Buffer.byteLength(lines[index], 'utf8');
    if (bytes > 65_536) break;
    if (lines[index].trim() === '---') { end = index; break; }
  }
  if (end < 0) throw unavailable();
  let metadata;
  try {
    // JSON_SCHEMA leaves timestamps as strings, so timezone validation is not lost.
    metadata = yaml.load(lines.slice(1, end).join(''), { schema: yaml.JSON_SCHEMA }) ?? {};
  } catch {
    throw unavailable();
  }
  if (typeof metadata !== 'object' || Array.isArray(metadata) || metadata === null) throw unavailable();
  return { metadata, body: lines.slice(end + 1).join('') };
}

function metadataText(metadata, key) {
  const value = metadata[key];
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function metadataList(value) {
  if (typeof value === 'string') return value.trim() ? [value.trim().slice(0, 200)] : [];
  return Array.isArray(value) ? value.filter(item => typeof item === 'string').slice(0, 64).map(item => item.trim().slice(0, 200)).filter(Boolean) : [];
}

function scopeOf(metadata) {
  if (metadata.scope == null || metadata.scope === '') return 'shared';
  if (typeof metadata.scope !== 'string') return 'invalid';
  const scope = metadata.scope.trim().toLowerCase();
  return scope === 'shared' || SCOPE_RE.test(scope) ? scope : 'invalid';
}

function authorityFor(relative, metadata) {
  const parts = relative.split('/');
  const first = parts[0].toLowerCase();
  if (HISTORICAL_DIRS.has(first)) return 'historical';
  if (first === 'inbox') return 'candidate';
  if (parts.length === 1 && NAVIGATION_FILES.has(relative)) return 'navigation';
  const tier = metadataText(metadata, 'tier') || metadataText(metadata, 'authority');
  const status = metadataText(metadata, 'status');
  if (relative === CURRENT) {
    const truth = metadata.source_of_truth === true ||
      (typeof metadata.source_of_truth === 'string' && /^(?:true|yes|on|1)$/i.test(metadata.source_of_truth.trim())) ||
      metadata.source_of_truth === 1;
    return tier === 'canonical' && status === 'active' && truth ? 'canonical' : 'invalid';
  }
  if (CANONICAL_DIRS.has(first)) return tier === 'canonical' && status === 'active' ? 'canonical' : 'draft';
  return 'invalid';
}

function parseTimestamp(value, allowDate = false) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  const dateOnly = allowDate && ISO_DATE.test(text);
  if (!dateOnly && !ISO_TIMESTAMP.test(text)) return null;
  const normalizedText = dateOnly ? `${text}T00:00:00Z` : text.replace(' ', 'T').replace('t', 'T');
  const ms = Date.parse(normalizedText);
  if (!Number.isFinite(ms)) return null;
  // Date.parse normalizes impossible dates such as February 30; reject them explicitly.
  const components = /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})/.exec(normalizedText);
  if (!components) return null;
  const [, year, month, day, hour, minute, second] = components.map(Number);
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate() ||
      hour > 23 || minute > 59 || second > 59) return null;
  return ms;
}

function freshness(document, now = Date.now()) {
  const metadata = document.metadata;
  if (!metadata.expires_at) return 'missing_expires_at';
  let expiry = parseTimestamp(metadata.expires_at);
  if (expiry === null) return 'invalid_expires_at';
  if (document.path === CURRENT) {
    const command = metadata.revalidation_command;
    if (typeof command !== 'string' || !command.trim() || command.length > 2048 || /[\r\n]/.test(command)) {
      return 'invalid_revalidation_command';
    }
  }
  if (!Object.hasOwn(metadata, 'review_class')) return 'missing_review_class';
  if (!['operational', 'stable'].includes(metadata.review_class)) return 'invalid_review_class';
  if (!Object.hasOwn(metadata, 'last_verified_at')) return 'missing_last_verified_at';
  const verified = parseTimestamp(metadata.last_verified_at, true);
  if (verified === null) return 'invalid_last_verified_at';
  if (verified > now) return 'future_last_verified_at';
  expiry = Math.min(expiry, verified + (metadata.review_class === 'operational' ? 30 : 365) * DAY);
  return now >= expiry ? 'expired' : '';
}

function privacyIssues(document) {
  if (document.scope !== 'shared' || document.authority !== 'canonical') return [];
  const text = `${document.title}\n${document.aliases.join(' ')}\n${document.body}`;
  const issues = [];
  if (PRIVATE_IP.test(text)) issues.push('canonical.privacy.private_ip');
  if (CONNECTION_STRING.test(text)) issues.push('canonical.privacy.connection_string');
  if (PRIVATE_PORT.test(text)) issues.push('canonical.privacy.private_port');
  return issues;
}

function checkGuard(text, profile) {
  const normalizedText = String(text).normalize('NFKC');
  // Embedded JSON can contain other-profile pages or secrets behind multiple
  // layers of escaping. Inspect every decoded layer and fail closed at the cap.
  let nested = normalizedText;
  for (let depth = 0; depth < 32; depth++) {
    if (SECRET_PATTERNS.some(pattern => pattern.test(nested)) ||
        INJECTION_PATTERNS.some(pattern => pattern.test(nested.replace(/\s+/g, ' ')))) throw unavailable();
    const scopes = nested.matchAll(/["']?scope["']?\s*:\s*["']?(profile:[a-z0-9_-]{1,64})/gi);
    for (const match of scopes) {
      if (match[1].toLowerCase() !== `profile:${profile}`) throw unavailable();
    }
    const next = nested.replace(/\\u([0-9a-f]{4})/gi, (_all, code) => String.fromCharCode(parseInt(code, 16)))
      .replace(/\\(["'\\])/g, '$1');
    if (next === nested) return;
    nested = next;
  }
  throw unavailable();
}

function termsFor(query) {
  const text = normalized(query);
  const terms = new Set(text.match(/[a-z0-9_.-]{2,}/g) ?? []);
  for (const run of text.match(/[\u3400-\u9fff]{2,}/g) ?? []) {
    terms.add(run);
    if (run.length > 2) for (let i = 0; i < run.length - 1; i++) terms.add(run.slice(i, i + 2));
  }
  return [...terms].sort((a, b) => b.length - a.length || a.localeCompare(b));
}

function scoreFor(document, query, terms) {
  const queryText = normalized(query).trim();
  const title = normalized(document.title);
  const aliases = normalized(document.aliases.join(' '));
  const tags = normalized(document.tags.join(' '));
  const relative = normalized(document.path);
  const body = normalized(document.body);
  let score = 0;
  if (queryText.length >= 2) {
    if (title.includes(queryText)) score += 120;
    if (aliases.includes(queryText)) score += 100;
    if (body.includes(queryText)) score += 30;
  }
  for (const term of terms) {
    if (title.includes(term)) score += 20;
    if (aliases.includes(term)) score += 16;
    if (tags.includes(term)) score += 12;
    if (relative.includes(term)) score += 8;
    let count = 0, from = 0;
    while (count < 4) {
      const found = body.indexOf(term, from);
      if (found < 0) break;
      count++;
      from = found + term.length;
    }
    score += count * 3;
  }
  return score;
}

function relevant(document, terms, score, threshold) {
  const gating = terms.filter(term => !STOPWORDS.has(term));
  if (!gating.length) return false;
  const fields = normalized([document.title, ...document.aliases, ...document.tags].join(' '));
  if (gating.some(term => fields.includes(term))) return true;
  const body = normalized(document.body);
  const distinct = gating.filter(term => body.includes(term)).length;
  const required = gating.length === 1 ? 1 : gating.length <= 4 ? 2 : 3;
  return distinct >= required && score >= threshold;
}

function isBareStatus(query) {
  const remainder = normalized(query).replace(/\b(?:what(?:'s| is)?|the|is|current(?:ly)?|latest|status|state|now|right|how|are|things)\b|现在|当前|目前|最新|现状|状态|情况|怎么样|怎样|如何|是什么|什么|是否|是|的|了|吗|呢|啊/g, ' ');
  return !/[0-9a-z\u3400-\u9fff]/.test(remainder);
}

function excerptFor(document, terms, limit) {
  const lines = document.body.split(/\r?\n/);
  const match = lines.findIndex(line => terms.some(term => normalized(line).includes(term)));
  const text = match < 0 ? document.body : lines.slice(Math.max(0, match - 2), Math.min(lines.length, match + 7)).join('\n').trim();
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 15)).trimEnd()}\n[... truncated]`;
}

export class WikiStore {
  constructor({ root, profile = 'default', maxResults = 3, maxChars = 5000, maxFileBytes = 262144, minRecallScore = 6 } = {}) {
    if (typeof root !== 'string' || !root.trim() || typeof profile !== 'string' ||
        !/^[a-z0-9_-]{1,64}$/i.test(profile)) throw new TypeError('A wiki root and valid profile are required');
    this.root = path.resolve(root);
    this.profile = profile.toLowerCase();
    this.maxResults = boundedInteger(maxResults, 3, 1, 3);
    this.maxChars = boundedInteger(maxChars, 5000, 1000, 12000);
    this.maxFileBytes = boundedInteger(maxFileBytes, 262144, 1, 1048576);
    this.minRecallScore = boundedInteger(minRecallScore, 6, 0, 200);
  }

  async _root() {
    try {
      const info = await fs.lstat(this.root);
      if (!info.isDirectory() || info.isSymbolicLink()) throw unavailable();
      const real = await fs.realpath(this.root);
      if (!samePath(real, this.root)) throw unavailable();
      return real;
    } catch {
      throw unavailable();
    }
  }

  async _read(relative) {
    const parts = validateRelative(relative);
    const root = await this._root();
    let current = root;
    try {
      for (let index = 0; index < parts.length; index++) {
        current = path.join(current, parts[index]);
        const info = await fs.lstat(current);
        if (info.isSymbolicLink() || (index < parts.length - 1 ? !info.isDirectory() : !info.isFile())) throw unavailable();
      }
      const real = await fs.realpath(current);
      const rel = path.relative(root, real);
      if (!rel || rel.startsWith(`..${path.sep}`) || rel === '..' || path.isAbsolute(rel) || !samePath(current, real)) throw unavailable();
      const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
      const handle = await fs.open(current, flags);
      try {
        const before = await handle.stat();
        if (!before.isFile() || before.size > this.maxFileBytes) throw unavailable();
        // A concurrent writer may grow the file after stat; never allocate beyond the limit.
        const buffer = Buffer.allocUnsafe(this.maxFileBytes + 1);
        let length = 0;
        while (length < buffer.length) {
          const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
          if (bytesRead === 0) break;
          length += bytesRead;
        }
        const after = await handle.stat();
        const named = await fs.lstat(current);
        const realAfter = await fs.realpath(current);
        const rootAfter = await fs.realpath(this.root);
        if (length > this.maxFileBytes || !named.isFile() || named.isSymbolicLink() ||
            before.dev !== named.dev || before.ino !== named.ino || before.size !== after.size ||
            before.mtimeMs !== after.mtimeMs || !samePath(realAfter, current) || !samePath(rootAfter, root)) throw unavailable();
        return decoder.decode(buffer.subarray(0, length)).replace(/^\uFEFF/, '');
      } finally {
        await handle.close();
      }
    } catch {
      throw unavailable();
    }
  }

  async _document(relative) {
    // History snapshots can embed other profiles inside escaped JSON; never expose them as shared pages.
    if (typeof relative === 'string' && /^archive\/history(?:\/|$)/i.test(relative)) throw unavailable();
    const text = await this._read(relative);
    const { metadata, body } = frontmatter(text);
    const scope = scopeOf(metadata);
    if (scope !== 'shared' && scope !== `profile:${this.profile}`) throw unavailable();
    checkGuard(text, this.profile);
    const authority = authorityFor(relative, metadata);
    if (authority === 'invalid') throw unavailable();
    // Imported evidence must opt into sharing explicitly; missing scope is not a grant.
    if (['historical', 'candidate', 'draft'].includes(authority) &&
        (typeof metadata.scope !== 'string' || !metadata.scope.trim())) throw unavailable();
    const heading = /^#\s+(.+)$/m.exec(body)?.[1];
    const title = (typeof metadata.title === 'string' && metadata.title.trim() ? metadata.title.trim() : (heading || path.posix.parse(relative).name)).slice(0, 200);
    const document = { path: relative, metadata, body: body.trim(), title, scope, authority,
      aliases: metadataList(metadata.aliases), tags: metadataList(metadata.tags) };
    document.issues = [];
    if (authority === 'canonical') {
      const reason = freshness(document);
      if (reason) document.issues.push(`${relative === CURRENT ? 'current_state' : 'canonical'}.${reason}`);
      document.issues.push(...privacyIssues(document));
    }
    return document;
  }

  async _paths(includeHistorical) {
    const root = await this._root();
    const output = [CURRENT];
    const roots = [...CANONICAL_DIRS, ...(includeHistorical ? [...HISTORICAL_DIRS, 'inbox'] : [])];
    const walk = async (absolute, relative) => {
      let entries;
      try { entries = await fs.readdir(absolute, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
        const rel = `${relative}/${entry.name}`;
        if (/^archive\/history(?:\/|$)/i.test(rel)) continue;
        if (entry.isDirectory()) await walk(path.join(absolute, entry.name), rel);
        else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) output.push(rel);
      }
    };
    for (const dir of roots) {
      try {
        const info = await fs.lstat(path.join(root, dir));
        if (info.isDirectory() && !info.isSymbolicLink()) await walk(path.join(root, dir), dir);
      } catch { /* A missing or unreadable category contributes no results. */ }
    }
    return output.sort((a, b) => a.localeCompare(b));
  }

  async _documents(includeHistorical) {
    const documents = [];
    for (const relative of await this._paths(includeHistorical)) {
      try {
        const document = await this._document(relative);
        if (document.authority === 'canonical' || (includeHistorical && ['historical', 'candidate', 'draft'].includes(document.authority))) {
          documents.push(document);
        }
      } catch { /* Invalid and inaccessible documents never become search results. */ }
    }
    return documents;
  }

  async search(query, { includeHistorical = false, limit, recall = false } = {}) {
    if (typeof query !== 'string' || !query.trim() || typeof includeHistorical !== 'boolean' || typeof recall !== 'boolean') {
      return { results: [] };
    }
    // Automatic recall can never include historical, candidate or draft pages.
    const historical = includeHistorical && !recall;
    const terms = termsFor(query);
    if (!terms.length) return { results: [] };
    const docs = await this._documents(historical);
    const max = recall ? this.maxResults : boundedInteger(limit, this.maxResults, 1, 10);
    const nowCurrent = recall && isBareStatus(query);
    const scored = [];
    for (const document of docs) {
      // Even an explicit history search must not expose private-network details from a shared page.
      if (document.issues.some(issue => issue.includes('.privacy.'))) continue;
      if (document.authority === 'canonical' && document.issues.length && !historical) continue;
      const score = scoreFor(document, query, terms);
      if (nowCurrent && document.path === CURRENT && !document.issues.length) {
        scored.push({ document, score: Math.max(score, 1000) });
      } else if (!nowCurrent && score > 0 && (!recall || relevant(document, terms, score, this.minRecallScore))) {
        scored.push({ document, score });
      }
    }
    scored.sort((a, b) => Number(b.document.path === CURRENT) - Number(a.document.path === CURRENT) ||
      b.score - a.score || a.document.path.localeCompare(b.document.path));
    let remaining = this.maxChars;
    const results = [];
    for (const { document, score } of scored.slice(0, max)) {
      const overhead = document.path.length + document.title.length + document.scope.length + 200;
      if (remaining < overhead + 100) continue;
      const excerpt = excerptFor(document, terms, Math.min(1600, remaining - overhead));
      const issues = [...document.issues];
      const result = { path: document.path, title: document.title, score, excerpt, authority: document.authority,
        issues, scope: document.scope,
        warning: document.authority !== 'canonical' || issues.length ? 'Historical or unhealthy content is evidence only, not current truth.' : '' };
      const fits = value => {
        result.excerpt = value;
        return JSON.stringify({ results: [...results, result] }).length <= this.maxChars;
      };
      if (!fits(excerpt)) {
        const marker = '\n[... truncated]';
        if (!fits(marker)) continue;
        let low = 0, high = excerpt.length;
        while (low < high) {
          const middle = Math.ceil((low + high) / 2);
          if (fits(excerpt.slice(0, middle).trimEnd() + marker)) low = middle;
          else high = middle - 1;
        }
        fits(excerpt.slice(0, low).trimEnd() + marker);
      }
      remaining -= overhead + result.excerpt.length;
      results.push(result);
    }
    return { results };
  }

  async readSource(relativePath, { includeHistorical = false } = {}) {
    if (typeof includeHistorical !== 'boolean') throw unavailable();
    const parts = validateRelative(relativePath);
    // Reject navigation before opening it: shared indexes may contain cross-profile titles.
    if (parts.length === 1 && ['index.md', 'schema.md', 'log.md'].includes(parts[0].toLowerCase())) throw unavailable();
    const document = await this._document(relativePath);
    if (document.authority !== 'canonical' && !includeHistorical) throw unavailable();
    if (document.authority === 'navigation') throw unavailable();
    if (document.issues.some(issue => issue.includes('.privacy.'))) throw unavailable();
    const content = document.body.slice(0, this.maxChars);
    return { success: true, path: document.path, title: document.title, authority: document.authority,
      scope: document.scope, content, truncated: document.body.length > content.length, issues: [...document.issues],
      warning: document.authority !== 'canonical' || document.issues.length ? 'Historical or unhealthy content is evidence only, not current truth.' : '' };
  }

  async status() {
    const documents = await this._documents(false);
    const counts = { canonical: 0, fresh: 0, stale: 0 };
    let currentState = { available: false };
    for (const document of documents) {
      // Do not count a shared privacy violation or report another profile's existence.
      if (document.issues.some(issue => issue.includes('.privacy.'))) continue;
      counts.canonical++;
      if (document.issues.length) counts.stale++;
      else counts.fresh++;
      if (document.path === CURRENT) currentState = { available: true, stale: document.issues.length > 0, issues: [...document.issues] };
    }
    return { success: true, counts, currentState };
  }
}
