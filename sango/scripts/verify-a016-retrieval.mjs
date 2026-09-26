/**
 * FEAT-A016 检索侧回测证据脚本（验收 3 / 5；零 LLM = 检索侧评测，非批量 LLM 调用）。
 *
 * 验收 3：换说法 query（右目）与规范形 query（右眼）各自 search top10 证据段集合相同。
 * 验收 5：「五关斩六将」与「过五关斩六将」均能在 top10 召回第 27 回同一段落（证据段同一锚）。
 *
 * 用法：node scripts/verify-a016-retrieval.mjs [证据落盘路径]
 * 默认落盘：dev-docs/test/standard-set/results/feat-A016-retrieval-acceptance.json
 * 前置：npm run build（引用 dist 产物；BGE-M3 首次编码加载 ~2.2GB 权重，约数秒到数十秒）。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SangoIndex } from '../dist/search/sango-index.js';
import { normalize, normVersion, rewriteKeyCount, rowsCount } from '../dist/normalize/entity-table.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', 'data');
const OUT_FILE = process.argv[2] ?? 'D:\\\\workplace\\\\dev-docs\\\\test\\\\standard-set\\\\results\\\\feat-A016-retrieval-acceptance.json';

async function top10(index, query) {
  const { entries } = await index.search(query, 10);
  return {
    ids: entries.map((e) => e.id),
    ch27: entries.filter((e) => e.chapter === 27).map((e) => e.id),
    detail: entries.map((e) => ({ id: e.id, chapter: e.chapter, title: e.title })),
  };
}

async function main() {
  const index = new SangoIndex(DATA_DIR);
  index.load();
  console.error(`[a016-acceptance] index loaded: rows=${rowsCount()} keys=${rewriteKeyCount()} normVersion=${normVersion()}`);

  // 验收 3：换说法 query 与规范形 query top10 证据段集合相同（右目 → 右眼）
  const q3a = '夏侯惇的右目是怎么瞎的';
  const q3b = '夏侯惇的右眼是怎么瞎的';
  const r3a = await top10(index, q3a);
  const r3b = await top10(index, q3b);
  const setA = new Set(r3a.ids);
  const setB = new Set(r3b.ids);
  const acc3 = {
    queryA: q3a,
    queryB: q3b,
    normalizedA: normalize(q3a),
    normalizedB: normalize(q3b),
    top10Same: setA.size === setB.size && [...setA].every((x) => setB.has(x)),
    onlyInA: r3a.ids.filter((x) => !setB.has(x)),
    onlyInB: r3b.ids.filter((x) => !setA.has(x)),
    top10A: r3a.ids,
    top10B: r3b.ids,
  };

  // 验收 5：五关斩六将 / 过五关斩六将 top10 均召回第 27 回同一证据段
  const q5a = '五关斩六将';
  const q5b = '过五关斩六将';
  const r5a = await top10(index, q5a);
  const r5b = await top10(index, q5b);
  const sameCh27 = r5a.ch27.filter((x) => r5b.ch27.includes(x));
  const acc5 = {
    queryA: q5a,
    queryB: q5b,
    normalizedA: normalize(q5a),
    normalizedB: normalize(q5b),
    ch27InTop10A: r5a.ch27,
    ch27InTop10B: r5b.ch27,
    sameAnchor: sameCh27,
    top10A: r5a.detail,
    top10B: r5b.detail,
  };

  // 验收6（bug-00037 检索侧回归）：官职/封号类问句须召回事实段——「刘备登基后，张飞被封为什么」
  // 的答案「迁张飞为车骑将军，领司隶校尉，封西乡侯」落在 0081:c0002（人物之封-张飞 标签第三路召回）。
  const q6 = '刘备登基后，张飞被封为什么';
  const r6 = await top10(index, q6);
  const acc6 = {
    query: q6,
    normalized: normalize(q6),
    targetChunk: 'sanguo-yanyi:0081:c0002',
    inTop10: r6.ids.includes('sanguo-yanyi:0081:c0002'),
    top10: r6.detail,
  };

  const ok3 = acc3.top10Same;
  const ok5 = acc5.sameAnchor.length > 0;
  const ok6 = acc6.inTop10;
  const evidence = { normVersion: normVersion(), rows: rowsCount(), rewriteKeys: rewriteKeyCount(), acceptance3: acc3, acceptance5: acc5, acceptance6: acc6 };
  mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(evidence, null, 2), "utf8");
  console.log(`[a016-acceptance] 验收3 top10集合相同=${ok3}（normalized: ${acc3.normalizedA} == ${acc3.normalizedB}）`);
  console.log(`[a016-acceptance] 验收5 第27回同一锚=${JSON.stringify(sameCh27)} ok=${ok5}`);
  console.log(`[a016-acceptance] 验收6 0081:c0002 in top10=${ok6}（bug-00037 回归）`);
  console.log(`[a016-acceptance] 证据落盘：${OUT_FILE}`);
  process.exitCode = ok3 && ok5 && ok6 ? 0 : 1;
}

main().catch((e) => {
  console.error('[a016-acceptance] 失败：', e);
  process.exit(1);
});
