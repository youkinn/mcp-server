/**
 * FEAT-A030 重排评测证据脚本（验收 1/4/5/6；零 LLM = 检索侧评测，非 LLM 批量调用）。
 *
 * 只做**定点样例**（华雄 / 刘备，各 2 问）与单次/少量重复验证——**批量跑分（recall-bench 同基线复跑）
 * 待负责人放行后另跑**，本脚本不跑批量。
 *
 * 产出：
 * ① 池覆盖探针（A015 T1-c0 未落档 → 定点人工估值）：事件问法证据段是否在 50 路候选池内、池内名次；
 * ② 定点不倒车：华雄 / 刘备 证据段 top10 名次 有重排 vs 无重排；
 * ③ 延迟实测：重排阶段延迟（有重排检索耗时 − 无重排检索耗时）P50 / P95；
 * ④ 失败样例：重排把证据段排下去 / 排错（非证据段进 top10）。
 *
 * 用法：npm run build && node scripts/verify-rerank.mjs [证据落盘路径]
 * 默认落盘：dev-docs/test/standard-set/results/feat-A030-rerank-fixedpoint.json
 * 前置：data/models/bge-reranker-base 权重（git 忽略，部署侧下发）与 BGE-M3 权重齐备；缺失即如实报错退出。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_DATA_DIR, SangoIndex, createDataRerankScorer } from '../dist/search/sango-index.js';
import { matchEvidence } from '../dist/benchmark/matcher.js';
import { parseBenchmark } from '../dist/benchmark/parser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BENCH_FILE = process.env.SANGO_BENCHMARK_FILE ?? 'D:\\workplace\\dev-docs\\docs\\sango-rag-regression-benchmark_v0.1.md';
const OUT_FILE = process.argv[2] ?? 'D:\\workplace\\dev-docs\\test\\standard-set\\results\\feat-A030-rerank-fixedpoint.json';

/** 定点样例：华雄（典故 / 问法归一）、刘备（死亡 / 事件关系）。 */
const FIXPOINTS = [
  { group: '华雄', id: '典故#1' },
  { group: '华雄', id: '拒答#5' },
  { group: '刘备', id: '问法归一#4' },
  { group: '刘备', id: '事件关系#10' },
];
const POOL = 50;
const LIMIT = 10;
const SAMPLES = 5;

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

const items = parseBenchmark(BENCH_FILE);
const picked = FIXPOINTS.map((fp) => {
  const item = items.find((x) => x.id === fp.id);
  if (!item) throw new Error(`评测集缺少定点题：${fp.id}（${BENCH_FILE}）`);
  return { ...fp, item };
});

const scorer = createDataRerankScorer(DEFAULT_DATA_DIR);
if (!scorer) {
  console.error('[verify-rerank] 重排权重不可用（data/models/bge-reranker-base 缺失或 SANGO_RERANKER=off）；如实退出，不做 mock。');
  process.exit(2);
}
const withRerank = new SangoIndex(DEFAULT_DATA_DIR, { rerankScorer: scorer });
const plain = new SangoIndex(DEFAULT_DATA_DIR, { rerankScorer: null });
withRerank.load();
plain.load();

const probe = [];
const fixedPoint = [];
const failures = [];
const latencies = [];

for (const { group, id, item } of picked) {
  // ① 池覆盖探针：证据段是否入 50 路候选池（无重排口径 = 规则召回池）
  const poolEntries = (await plain.search(item.question, POOL)).entries;
  const poolMatch = matchEvidence(poolEntries, item.textAnchors, item.titleAnchors);
  const probeGroups = (await plain.search(item.question, LIMIT, { diagnostics: true })).diagnostics?.eventHit.groups ?? [];
  probe.push({
    group,
    id,
    question: item.question,
    inPool50: poolMatch.rank > 0,
    rankInPool: poolMatch.rank,
    poolSize: poolEntries.length,
    eventGroups: probeGroups.map((g) => ({ eventId: g.eventId, eventName: g.eventName, type: g.type, groupSize: g.groupSize })),
  });

  // ② 定点不倒车：证据段 top10 名次
  const plainTop = (await plain.search(item.question, LIMIT)).entries;
  const rerankTop = (await withRerank.search(item.question, LIMIT)).entries;
  const plainRank = matchEvidence(plainTop, item.textAnchors, item.titleAnchors).rank;
  const rerankRank = matchEvidence(rerankTop, item.textAnchors, item.titleAnchors).rank;
  const plainIds = plainTop.map((e) => e.id);
  const rerankIds = rerankTop.map((e) => e.id);
  const evidenceId = matchEvidence(rerankTop, item.textAnchors, item.titleAnchors).hit?.id ?? matchEvidence(plainTop, item.textAnchors, item.titleAnchors).hit?.id ?? null;
  fixedPoint.push({
    group,
    id,
    question: item.question,
    evidenceId,
    plainRank,
    rerankRank,
    noWorse: rerankRank > 0 && (plainRank === 0 || rerankRank <= plainRank),
    plainTop10: plainIds,
    rerankTop10: rerankIds,
  });

  // ④ 失败样例
  if (plainRank > 0 && rerankRank === 0) {
    failures.push({ group, id, kind: 'evidence_dropped', detail: `证据段由 top10 rank${plainRank} 跌出 top10` });
  } else if (plainRank > 0 && rerankRank > plainRank) {
    failures.push({ group, id, kind: 'evidence_demoted', detail: `证据段 rank${plainRank} → rank${rerankRank}` });
  }
  if (plainRank === 1 && rerankRank !== 1) {
    failures.push({ group, id, kind: 'wrong_top1', detail: `规则序 rank1 证据段被重排挤下：新 rank1 = ${rerankIds[0]}` });
  }
  for (const prom of rerankIds.filter((x) => !plainIds.includes(x) && x !== evidenceId)) {
    failures.push({ group, id, kind: 'non_evidence_promoted', detail: `非证据段 ${prom} 被重排推进 top10（规则序未进 top10）` });
  }

  // ③ 延迟：重排阶段延迟 = 有重排检索耗时 − 无重排检索耗时（同进程冷热一致，差值即重排段）
  await plain.search(item.question, LIMIT);
  await withRerank.search(item.question, LIMIT);
  for (let s = 0; s < SAMPLES; s++) {
    const t0 = performance.now();
    await withRerank.search(item.question, LIMIT);
    const rerankMs = performance.now() - t0;
    const t1 = performance.now();
    await plain.search(item.question, LIMIT);
    const plainMs = performance.now() - t1;
    latencies.push({ group, id, rerankMs: +rerankMs.toFixed(1), plainMs: +plainMs.toFixed(1), stageMs: +(rerankMs - plainMs).toFixed(1) });
  }
}

const stageAll = latencies.map((x) => x.stageMs);
const latency = {
  samples: latencies.length,
  stageMsP50: +percentile(stageAll, 50).toFixed(1),
  stageMsP95: +percentile(stageAll, 95).toFixed(1),
  stageMsMin: +Math.min(...stageAll).toFixed(1),
  stageMsMax: +Math.max(...stageAll).toFixed(1),
  perGroup: [...new Set(FIXPOINTS.map((f) => f.group))].map((g) => {
    const v = latencies.filter((x) => x.group === g).map((x) => x.stageMs);
    return { group: g, p50: +percentile(v, 50).toFixed(1), p95: +percentile(v, 95).toFixed(1) };
  }),
};

const report = {
  tool: 'verify-rerank',
  feature: 'feat-A030',
  date: new Date().toISOString(),
  benchmark: BENCH_FILE,
  model: 'bge-reranker-base (XLM-R, onnx/model_quantized.onnx int8)',
  batchRunApproved: false,
  note: '定点样例（华雄 / 刘备）与少量重复延迟实测；批量跑分（recall-bench 同基线复跑）待负责人放行后另跑。',
  probe,
  fixedPoint,
  latency,
  failures,
};
mkdirSync(path.dirname(OUT_FILE), { recursive: true });
writeFileSync(OUT_FILE, JSON.stringify(report, null, 2), 'utf8');

console.log('== FEAT-A030 定点评测（批量跑分待放行）==');
console.log('\n[① 池覆盖探针 · 证据段是否入 50 路池]');
for (const p of probe) console.log(`  ${p.group} ${p.id} ${p.question}\n    inPool50=${p.inPool50} rank=${p.rankInPool}/${p.poolSize} 事件组=${p.eventGroups.map((g) => g.eventName + '(' + g.type + ',' + g.groupSize + ')').join('|') || '无'}`);
console.log('\n[② 定点不倒车 · 证据段 top10 名次（无重排 → 有重排）]');
for (const f of fixedPoint) console.log(`  ${f.group} ${f.id} ${f.plainRank} → ${f.rerankRank} noWorse=${f.noWorse} 证据=${f.evidenceId ?? '未命中'}`);
console.log('\n[③ 延迟实测 · 重排阶段（有-无重排检索耗时，ms）]');
console.log(`  样本 ${latency.samples}  P50=${latency.stageMsP50}  P95=${latency.stageMsP95}  min=${latency.stageMsMin}  max=${latency.stageMsMax}`);
for (const g of latency.perGroup) console.log(`  ${g.group}: P50=${g.p50} P95=${g.p95}`);
console.log('\n[④ 失败样例]');
if (failures.length === 0) console.log('  （定点样例未观测到失败）');
for (const f of failures) console.log(`  ${f.group} ${f.id} ${f.kind}: ${f.detail}`);
console.log(`\n落盘：${OUT_FILE}`);
