/**
 * FEAT-A016 验收 6 证据脚本（人名规范形口径切换回测）。零 LLM：检索侧评测，非批量 LLM 调用。
 *
 * 验收 6（requirements/feat-A016-term-normalization.md）：`关羽` / `云长` 两类写法标准集 top≤10 均不回退
 *   + 华雄 / 刘备定点不倒车（recall-bench 同基线复跑）。
 *
 * 口径（回执显式声明）：
 *   - 关羽写法集 = 标准集问句含「关羽」的条目；云长写法集 = 同条目「关羽→云长」替换写法。
 *   - 基线名次取基线 recall-bench 快照（BASELINE_FILE）中同一题目 rank。基线口径下检索侧执行「embed 前
 *     normalize」，normalize('云长…') ≡ '关羽…'（canonical 均为「关羽」），故基线对云长问句的检索文本与关羽
 *     问句相同 → 两写法共用同一基线名次。
 *   - 不倒车判据：top≤10 命中数不下降；逐项回退（基线 ≤10、本次 >10）与 ≤10 内名次下滑分别单列。
 *
 * 用法：npm run build && node scripts/verify-a016-acceptance6.mjs [证据落盘路径]
 * 默认落盘：dev-docs/test/standard-set/results/feat-A016-acceptance6.json
 * 前置：dist 产物 + BGE-M3 权重；重排列需 data/models/bge-reranker-base（缺失则如实标注重排不可用）。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_DATA_DIR, SangoIndex, createDataRerankScorer } from '../dist/search/sango-index.js';
import { matchEvidence } from '../dist/benchmark/matcher.js';
import { parseBenchmark } from '../dist/benchmark/parser.js';
import { normVersion, rewriteKeyCount, rowsCount } from '../dist/normalize/entity-table.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BENCH_FILE = process.env.SANGO_BENCHMARK_FILE ?? 'D:\\workplace\\dev-docs\\docs\\sango-rag-regression-benchmark_v0.1.md';
const BASELINE_FILE = process.env.SANGO_BASELINE_FILE ?? 'D:\\workplace\\dev-docs\\test\\standard-set\\results\\feat-A015-2026-09-28-2318.json';
const OUT_FILE = process.argv[2] ?? 'D:\\workplace\\dev-docs\\test\\standard-set\\results\\feat-A016-acceptance6.json';
const POOL = 50;

/** 定点样例：华雄（典故 / 拒答）、刘备（问法归一 / 事件关系）——与 scripts/verify-rerank.mjs 同批，保证可对照。 */
const FIXPOINTS = [
  { group: '华雄', id: '典故#1' },
  { group: '华雄', id: '拒答#5' },
  { group: '刘备', id: '问法归一#4' },
  { group: '刘备', id: '事件关系#10' },
];

const inTop10 = (r) => r >= 1 && r <= 10;

function rankOf(entries, item) {
  const m = matchEvidence(entries, item.textAnchors, item.titleAnchors);
  return { rank: m.rank, hitId: m.hit ? m.hit.id : null };
}

/** 一类写法（关羽 / 云长）的标准集读数：逐题基线名次 vs 本次名次。 */
async function setReport(index, items, baseRank, toVariant) {
  const rows = [];
  for (const item of items) {
    const question = toVariant ? item.question.replace(/关羽/g, '云长') : item.question;
    const { entries } = await index.search(question, POOL);
    const cur = rankOf(entries, item);
    const base = baseRank.get(item.id) ?? 0;
    rows.push({
      id: item.id,
      question,
      baselineRank: base,
      currentRank: cur.rank,
      hitId: cur.hitId,
      baselineInTop10: inTop10(base),
      currentInTop10: inTop10(cur.rank),
    });
  }
  const b10 = rows.filter((r) => r.baselineInTop10).length;
  const c10 = rows.filter((r) => r.currentInTop10).length;
  const regressions = rows.filter((r) => r.baselineInTop10 && !r.currentInTop10);
  const demotions = rows.filter((r) => r.baselineInTop10 && r.currentInTop10 && r.currentRank > r.baselineRank);
  const rises = rows.filter((r) => !r.baselineInTop10 && r.currentInTop10);
  return {
    total: rows.length,
    top10Baseline: b10,
    top10Current: c10,
    top10Delta: c10 - b10,
    noRegression: c10 >= b10,
    regressions,
    demotions,
    rises,
    rows,
  };
}

async function main() {
  const items = parseBenchmark(BENCH_FILE);
  const baseline = JSON.parse(readFileSync(BASELINE_FILE, 'utf8'));
  const baseRank = new Map(baseline.results.map((r) => [r.id, r.rank]));

  const plain = new SangoIndex(DEFAULT_DATA_DIR, { rerankScorer: null });
  plain.load();
  console.error(`[a016-acc6] index loaded: rows=${rowsCount()} keys=${rewriteKeyCount()} normVersion=${normVersion()}`);

  const gset = items.filter((x) => x.question.includes('关羽'));
  const guanyu = await setReport(plain, gset, baseRank, false);
  const yunchang = await setReport(plain, gset, baseRank, true);

  const scorer = createDataRerankScorer(DEFAULT_DATA_DIR);
  const rerank = scorer ? new SangoIndex(DEFAULT_DATA_DIR, { rerankScorer: scorer }) : null;
  if (rerank) rerank.load();
  const fixpoints = [];
  for (const fp of FIXPOINTS) {
    const item = items.find((x) => x.id === fp.id);
    if (!item) throw new Error(`评测集缺少定点题：${fp.id}`);
    const plainR = rankOf((await plain.search(item.question, POOL)).entries, item);
    const rerankR = rerank ? rankOf((await rerank.search(item.question, POOL)).entries, item) : null;
    const base = baseRank.get(item.id) ?? 0;
    fixpoints.push({
      group: fp.group,
      id: fp.id,
      question: item.question,
      evidenceId: plainR.hitId ?? (rerankR ? rerankR.hitId : null),
      baselineRank: base,
      plainRank: plainR.rank,
      rerankRank: rerankR ? rerankR.rank : null,
      plainWithinTop10: inTop10(plainR.rank),
      rerankWithinTop10: rerankR ? inTop10(rerankR.rank) : null,
      plainRankDelta: base === 0 ? null : base - plainR.rank,
      plainNoWorse: plainR.rank > 0 && (base === 0 || plainR.rank <= base),
      rerankNoWorse: rerankR ? rerankR.rank > 0 && (plainR.rank === 0 || rerankR.rank <= plainR.rank) : null,
    });
  }

  const evidence = {
    generatedAt: new Date().toISOString(),
    normVersion: normVersion(),
    rows: rowsCount(),
    rewriteKeys: rewriteKeyCount(),
    baselineFile: BASELINE_FILE,
    baselineRunId: baseline.summary ? baseline.summary.runId : path.basename(BASELINE_FILE, '.json'),
    benchmarkFile: BENCH_FILE,
    guanyuSet: guanyu,
    yunchangSet: yunchang,
    fixpoints,
    rerankAvailable: Boolean(rerank),
  };
  mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(evidence, null, 2), 'utf8');

  const fmt = (s, label) =>
    `[a016-acc6] ${label} 题数=${s.total} top≤10 基线=${s.top10Baseline} 本次=${s.top10Current} ` +
    `Δ=${s.top10Delta > 0 ? '+' : ''}${s.top10Delta} 不回退=${s.noRegression} 回退项=${JSON.stringify(s.regressions.map((r) => r.id))}`;
  console.log(fmt(guanyu, '关羽写法集'));
  console.log(fmt(yunchang, '云长写法集'));
  for (const f of fixpoints) {
    console.log(
      `[a016-acc6] 定点 ${f.group} ${f.id} 「${f.question}」 证据段=${f.evidenceId} 基线=r${f.baselineRank} ` +
        `重排关=r${f.plainRank} 重排开=${f.rerankRank === null ? 'n/a' : 'r' + f.rerankRank} ` +
        `不倒车(关)=${f.plainNoWorse} 不倒车(开)=${f.rerankNoWorse}`,
    );
  }
  console.log(`[a016-acc6] 证据落盘：${OUT_FILE}`);
  const ok = guanyu.noRegression && yunchang.noRegression && fixpoints.every((f) => f.plainNoWorse && (f.rerankNoWorse ?? true));
  process.exitCode = ok ? 0 : 1;
}

main().catch((e) => {
  console.error('[a016-acc6] 失败：', e);
  process.exit(1);
});
