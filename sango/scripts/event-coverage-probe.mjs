// event-coverage-probe.mjs —— 事件类问法覆盖率探针（验收 #3）
// 用法：cd D:\workplace\mcp-server\sango && node scripts/event-coverage-probe.mjs
// 分母 = data/event-question-pool.json（真实问法原样入库：线上问题 + 题库全集 + 画像事件类，按月累计）
// 命中 = 问法经实体表改写（A016 同口径简要实现）后，与 events.json aliases 子串匹配命中事件组
// 报告落盘 data/event-coverage-{YYYY-MM}.json；终端只打汇总与未命中清单

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SANGANGO_ROOT = path.resolve(__dirname, '..');
const EVENTS = path.join(SANGANGO_ROOT, 'data/corpus/events.json');
const POOL = path.join(SANGANGO_ROOT, 'data/event-question-pool.json');
const ENTITY = path.join(SANGANGO_ROOT, 'data/entity-table.json');

const now = new Date();
const ym = now.toISOString().slice(0, 7);

const events = JSON.parse(fs.readFileSync(EVENTS, 'utf8')).rows || [];
const pool = JSON.parse(fs.readFileSync(POOL, 'utf8'));
if (!Array.isArray(pool)) { console.error('问法池格式非法（应为数组）'); process.exit(1); }

// A016 同口径改写：实体表 rewriteKeys 按长度降序最长替换为 canonical（仅改写键，命中问法用）
const entity = JSON.parse(fs.readFileSync(ENTITY, 'utf8'));
const keyMap = [];
for (const r of entity.rows || []) {
  for (const k of r.rewriteKeys || []) if (k.length >= 2) keyMap.push({ k, v: r.canonical });
}
keyMap.sort((a, b) => b.k.length - a.k.length);
function normalize(q) {
  let s = q;
  for (const { k, v } of keyMap) s = s.split(k).join(v);
  return s;
}

// alias 索引：按长度降序（与桥同口径），组按 eventId 升序
const groups = [];
for (const r of events) {
  for (const a of r.aliases || []) if (a.length >= 2) groups.push({ alias: a, eventId: r.eventId, eventName: r.eventName, type: r.type });
}
groups.sort((a, b) => b.alias.length - a.alias.length || (a.eventId < b.eventId ? -1 : 1));

const bySource = {};
const missList = [];
let hit = 0;
for (const q of pool) {
  const src = q.source || 'other';
  const norm = normalize(q.question || '');
  const m = groups.find((g) => norm.includes(g.alias));
  const ok = Boolean(m);
  if (ok) hit++;
  else missList.push({ question: q.question, source: src });
  bySource[src] = bySource[src] || { total: 0, hit: 0 };
  bySource[src].total++;
  if (ok) bySource[src].hit++;
}

const report = {
  month: ym,
  normVersion: events.length ? JSON.parse(fs.readFileSync(EVENTS, 'utf8')).meta?.normVersion : '',
  total: pool.length,
  hit,
  rate: pool.length ? (hit / pool.length) : 0,
  bySource,
  missed: missList.length,
};

fs.writeFileSync(path.join(SANGANGO_ROOT, `data/event-coverage-${ym}.json`), JSON.stringify(report, null, 1) + '\n', 'utf8');

console.log(`覆盖率 ${ym}：${hit}/${pool.length}（${(report.rate * 100).toFixed(1)}%）`);
for (const [k, v] of Object.entries(bySource)) console.log(`  ${k}: ${v.hit}/${v.total}`);
console.log('未命中:', report.missed);
for (const m of missList.slice(0, 30)) console.log('  ✗', `[${m.source}]`, m.question);
if (missList.length > 30) console.log('  … 其余', missList.length - 30, '条（见落盘报告）');