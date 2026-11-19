import path from 'node:path';
import { WikiStore } from '../lib/wiki.js';

const root = process.argv[2];
if (!root || !path.isAbsolute(root)) throw new Error('usage: node scripts/smoke-local.js ABSOLUTE_WIKI_ROOT');
const wiki = new WikiStore({ root });
const status = await wiki.status();
const source = await wiki.readSource('CURRENT_STATE.md');
const search = await wiki.search('Wiki 当前状态', { recall: true });
console.log(JSON.stringify({
  status,
  read: { success: source.success, authority: source.authority, issues: source.issues },
  recall: { count: search.results.length, paths: search.results.map(item => item.path) },
}, null, 2));
