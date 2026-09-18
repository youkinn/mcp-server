#!/usr/bin/env node
/**
 * feat-A004 Step 2 兜底证据脚本：证明「词法无命中 → 真向量兜底」这条路径真的活着。
 *
 * 构造的 query 全部用繁体字（语料为简体），其 unigram / bigram token 与语料 postings
 * 零交集 —— 脚本先自行断言 BM25 命中文档数为 0，再调用真实 search()，验证：
 *   1. 词法零命中时仍能召回正确段落（纯向量兜底生效，非词法侥幸）；
 *   2. 打印命中 cosine，确认其高于 MIN_COSINE（0.3）—— Step 4 重定阈值的输入。
 *
 * 运行：node --experimental-strip-types scripts/verify-vector-fallback.mjs（或 npm run fallback）
 * 需要 BGE-M3 权重（data/models/bge-m3/，不入库）；首次运行懒加载 ~2.1GB，较慢属预期。
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SANGO_DIR = resolve(import.meta.dirname, '..');
const load = (p) => import(pathToFileURL(resolve(SANGO_DIR, p)).href);
const { SangoIndex } = await load('src/search/sango-index.ts');
const { embedQuery } = await load('src/embed/bge-m3-encoder.ts');
const { tokenize } = await load('src/utils/text.ts');

/** [query, 期望召回段落的正则（简体，同 search() 出参 text 口径）] */
const CASES = [
  ['張飛', /张飞/],
  ['趙雲', /赵云/],
  ['劉備', /刘备/],
];

const index = new SangoIndex(resolve(SANGO_DIR, 'data'));
index.load();

// 与 search() 同口径：query 先别名归一化再分词。normalize 为 TS private，仅类型期可见，
// 运行期可访问；取不到时退回恒等（本例繁体 query 本就不在别名表内，结果一致）。
const normalize = (q) => (typeof index.normalize === 'function' ? index.normalize(q) : q);

/** 与 search() 的 lexicalHits 同口径：query token 命中的文档集合。 */
function lexicalHits(query) {
  const hits = new Set();
  for (const t of tokenize(normalize(query))) {
    for (const p of index.postings.get(t) ?? []) hits.add(p.doc);
  }
  return hits;
}

function cosineOf(qVec) {
  const { n, vecDim: dim, vec } = index;
  let qn = 0;
  for (let j = 0; j < dim; j++) qn += qVec[j] * qVec[j];
  qn = Math.sqrt(qn);
  const out = new Float64Array(n);
  for (let d = 0; d < n; d++) {
    const off = d * dim;
    let dot = 0;
    let dn = 0;
    for (let j = 0; j < dim; j++) {
      const a = vec[off + j];
      dot += a * qVec[j];
      dn += a * a;
    }
    out[d] = dn > 0 ? dot / (Math.sqrt(dn) * qn) : 0;
  }
  return out;
}

let failed = 0;
for (const [query, expect] of CASES) {
  const hits = lexicalHits(query);
  const entries = await index.search(query, 3);
  const top = entries[0];
  const cosine = cosineOf(await embedQuery(normalize(query)));
  const topCos = top ? cosine[index.docs.findIndex((d) => d.chunkId === top.id)] : null;

  const okLexical = hits.size === 0;
  const okRecall = Boolean(top) && expect.test(top.text);
  if (!okLexical || !okRecall) failed++;

  console.log(`\nquery「${query}」`);
  console.log(`  词法命中 BM25 文档数：${hits.size}（要求 0）${okLexical ? ' ✅' : ' ❌'}`);
  console.log(`  召回 top1：${top ? `${top.id}（第 ${top.chapter} 回）` : '(无命中)'} ${okRecall ? '✅' : '❌'}`);
  if (topCos !== null) {
    console.log(`  top1 cosine：${topCos.toFixed(4)}（MIN_COSINE=0.3，须 ≥ 该值才能触发兜底）`);
  }
  if (top) console.log(`  摘录：${top.text.slice(0, 40).replace(/\s+/g, '')}…`);
}

console.log(`\n兜底路径 ${CASES.length - failed}/${CASES.length} 通过`);
process.exit(failed === 0 ? 0 : 1);
