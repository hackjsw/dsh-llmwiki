import { WikiStore } from './wiki.js';
import { resolveConfig, mountWiki } from './runtime.js';
import { MemoryStore } from './memory.js';

export const name = 'dsh-llm-wiki';
export const inject = ['tools', 'systemPrompt', 'llm', 'sessions'];

/** Native DSH lifecycle and tools, bundled Wiki engine, durable background processing. */
export function apply(ctx, rawConfig = {}) {
  const config = resolveConfig(rawConfig);
  if (!config.enabled) return;
  const store = new WikiStore({
    root: config.root,
    profile: config.profile,
    maxResults: config.maxResults,
    maxChars: config.maxChars,
    maxFileBytes: config.maxFileBytes,
    minRecallScore: config.minRecallScore,
  });
  const memory = new MemoryStore({ root: config.root, profile: config.profile });
  return mountWiki(ctx, config, store, memory);
}
