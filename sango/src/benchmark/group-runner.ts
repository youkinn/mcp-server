/**
 * 组判分 runner（story-A018-03）：解析事件 / 典故组召回评测集（JSON meta + rows[]）→
 * 逐题 index.search(question, 50, { diagnostics: true }) + chunkIds 组判分 + 类别 / 分档汇总 → 快照落盘。
 * 判分口径与 dev-docs 离线探针（test/events/events-recall-probe.mjs，story-A018-02）逐条一致，禁止分叉：
 * 判分单位 = 该题 chunkIds 组；hit@k = top-k 含组内任一段；firstRank = 组内段最小排名（0 = 未进 50 路池）；
 * status = hit5（1-5）/ hit10（6-10）/ hit50（11-50）/ miss（0）；cover@5 = top5 命中组内段数 / min(5, 组大小)；
 * bridgeHit = 并集（eventHit.groupCount + allusionHit.groupCount > 0）；桥命中拆「事件桥 / 典故桥」两列；未进池按桥命中与否分「桥未命中 / 并池后掉窗」。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SangoIndex } from '../search/sango-index.ts';
import { BenchmarkAbortedError, INFER_LIMIT } from './runner.ts';
import type { RunOptions } from './runner.ts';
import { listRunIds, readSnapshot, writeGroupRun } from './snapshot.ts';
import type { BenchmarkSet } from './sets.ts';

/** sango 包根目录（src/benchmark 或 dist/benchmark 上溯两级），engine.sango 取值（与 runner 同口径）。 */
const SANGO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 单题组判分状态：组内首段进 1-5 / 6-10 / 11-50 / 未进池。 */
export type GroupStatus = 'hit5' | 'hit10' | 'hit50' | 'miss';

/** 评测集行：判分所需字段（其余字段如 eventId / eventName / chapters 供页面溯源，不消费）。 */
export interface GroupEvalRow {
  id: string;
  category: string;
  question: string;
  chunkIds: string[];
  segCount: number;
  crossChapter: boolean;
}

/** 评测集加载结果：meta（溯源 norm 版本）+ 行。 */
export interface GroupEvalSet {
  meta: Record<string, unknown>;
  rows: GroupEvalRow[];
}

/** 单题结果（与探针行字段同构；chunkIds 供页面展示组内段）。 */
export interface GroupRunResult {
  id: string;
  question: string;
  category: string;
  segCount: number;
  crossChapter: boolean;
  status: GroupStatus;
  firstRank: number;
  hits5: number;
  hits10: number;
  hit5: boolean;
  hit10: boolean;
  hit50: boolean;
  bridgeGroups: number;
  bridgeHit: boolean;
  eventBridgeHit: boolean;
  allusionBridgeHit: boolean;
  chunkIds: string[];
  top10Ids: string[];
  /** 50 路池有序 chunkId（下标 +1 = 池内名次；供页面查看组内段在池中的位置） */
  poolIds: string[];
}

/** 一组题汇总（与探针 summarize 同口径）。 */
export interface GroupCount {
  total: number;
  hit5: number;
  hit10: number;
  hit50: number;
  miss: number;
  eventBridge: number;
  allusionBridge: number;
  noBridge: number;
  missNoBridge: number;
  dropped: number;
  sumHits5: number;
  sumCap5: number;
  hit10Rate: number;
  cover5: number;
}

/** 环比上一份该集快照：档位降级 = 退化、升级 = 改善（同档位内 firstRank 变化不计；与探针 compareWithPrev 同口径）。 */
export interface GroupCompare {
  prevFile: string;
  prevTime: string;
  regressed: { id: string; question: string; from: string; to: string }[];
  improved: { id: string; question: string; from: string; to: string }[];
}

/** 组集汇总（summary；字段契约见 docs/feat-A018-eval-console-api.md §4）。 */
export interface GroupSummary extends GroupCount {
  runId: string;
  time: string;
  setId: string;
  setName: string;
  judge: 'group';
  benchmark: string;
  evalSetMeta: Record<string, unknown>;
  engine: { sango: string; indexN: number; inferLimit: number };
  byCategory: Record<string, GroupCount>;
  byBucket: Record<string, GroupCount>;
  compare: GroupCompare | null;
  elapsedMs: number;
}

/** 一次组判分完整执行。 */
export interface GroupBenchmarkRun {
  runId: string;
  time: string;
  summary: GroupSummary;
  results: GroupRunResult[];
}

/** 解析事件 / 典故组召回评测集（JSON：meta + rows[]）；读取失败或结构异常抛错（server 层转 failed）。 */
export function loadGroupEvalSet(evalFile: string): GroupEvalSet {
  const raw: unknown = JSON.parse(readFileSync(evalFile, 'utf8'));
  if (!raw || typeof raw !== 'object' || !('rows' in raw) || !Array.isArray((raw as { rows: unknown }).rows)) {
    throw new Error(`评测集结构异常：${evalFile}`);
  }
  const meta =
    'meta' in raw && raw.meta && typeof raw.meta === 'object' ? (raw.meta as Record<string, unknown>) : {};
  const rows = ((raw as { rows: unknown[] }).rows as unknown[]).map((row) => {
    const r = row as {
      id?: unknown;
      category?: unknown;
      question?: unknown;
      chunkIds?: unknown;
      segCount?: unknown;
      crossChapter?: unknown;
    };
    if (
      typeof r.id !== 'string' ||
      typeof r.category !== 'string' ||
      typeof r.question !== 'string' ||
      !Array.isArray(r.chunkIds) ||
      typeof r.segCount !== 'number' ||
      typeof r.crossChapter !== 'boolean'
    ) {
      throw new Error(`评测集行字段缺失：${evalFile} ${String(r.id)}`);
    }
    return {
      id: r.id,
      category: r.category,
      question: r.question,
      chunkIds: r.chunkIds as string[],
      segCount: r.segCount,
      crossChapter: r.crossChapter,
    };
  });
  return { meta, rows };
}

/** 组大小分档（与探针同口径）。 */
function bucketOf(segCount: number): string {
  return segCount === 1 ? '单段' : segCount <= 10 ? '多段(2-10)' : '大组(>10)';
}

/** 汇总一组题：hit@k 为累计口径（组内首段进 top-k 即计）；cover@5 = top5 命中组内段数 / min(5, 组大小)。 */
export function summarizeGroup(list: GroupRunResult[]): GroupCount {
  const s = {
    total: 0,
    hit5: 0,
    hit10: 0,
    hit50: 0,
    miss: 0,
    eventBridge: 0,
    allusionBridge: 0,
    noBridge: 0,
    missNoBridge: 0,
    dropped: 0,
    sumHits5: 0,
    sumCap5: 0,
  };
  for (const r of list) {
    s.total++;
    if (r.firstRank >= 1 && r.firstRank <= 5) s.hit5++;
    if (r.firstRank >= 1 && r.firstRank <= 10) s.hit10++;
    if (r.firstRank >= 1) s.hit50++;
    else s.miss++;
    if (!r.bridgeHit) s.noBridge++;
    if (r.eventBridgeHit) s.eventBridge++;
    if (r.allusionBridgeHit) s.allusionBridge++;
    if (r.firstRank === 0) {
      if (r.bridgeHit) s.dropped++;
      else s.missNoBridge++;
    }
    s.sumHits5 += r.hits5;
    s.sumCap5 += Math.min(5, r.segCount);
  }
  return { ...s, hit10Rate: s.total ? s.hit10 / s.total : 0, cover5: s.sumCap5 ? s.sumHits5 / s.sumCap5 : 0 };
}

/** 档位序：用于环比判退化 / 改善（与探针 STATUS_ORDER 同口径）。 */
const STATUS_ORDER: Record<GroupStatus, number> = { miss: 0, hit50: 1, hit10: 2, hit5: 3 };

/** 逐题比环比：档位降级 = 退化，升级 = 改善（同档位内 firstRank 变化不计）；与探针 compareWithPrev 同口径。 */
export function compareGroupWithPrev(
  prev: { runId: string; time: string; results: Array<{ id: string; question: string; status: GroupStatus; firstRank: number }> },
  results: GroupRunResult[],
): GroupCompare {
  const prevMap = new Map(prev.results.map((r) => [r.id, r]));
  const regressed: GroupCompare['regressed'] = [];
  const improved: GroupCompare['improved'] = [];
  for (const r of results) {
    const p = prevMap.get(r.id);
    if (!p) continue;
    if (STATUS_ORDER[r.status] < STATUS_ORDER[p.status]) {
      regressed.push({ id: r.id, question: r.question, from: `${p.status}@${p.firstRank}`, to: `${r.status}@${r.firstRank}` });
    } else if (STATUS_ORDER[r.status] > STATUS_ORDER[p.status]) {
      improved.push({ id: r.id, question: r.question, from: `${p.status}@${p.firstRank}`, to: `${r.status}@${r.firstRank}` });
    }
  }
  return { prevFile: prev.runId, prevTime: prev.time, regressed, improved };
}

/** 执行完整组判分：解析评测集 → 逐题检索判分 → 汇总 → 环比 → 快照落盘，返回本次运行。 */
export async function runGroupBenchmark(
  index: SangoIndex,
  set: BenchmarkSet,
  runId: string,
  options: RunOptions = {},
): Promise<GroupBenchmarkRun> {
  const t0 = performance.now();
  const evalSet = loadGroupEvalSet(set.file);
  const results: GroupRunResult[] = [];
  for (const row of evalSet.rows) {
    // 停止请求在逐题之间检查：当前题照常跑完，命中则抛专用中止错误（不落快照、不落 failed）。
    if (options.shouldStop?.()) throw new BenchmarkAbortedError(runId);
    const { entries, diagnostics } = await index.search(row.question, INFER_LIMIT, { diagnostics: true });
    const bridgeGroups = (diagnostics?.eventHit?.groupCount ?? 0) + (diagnostics?.allusionHit?.groupCount ?? 0);
    const rankOf = new Map<string, number>();
    entries.forEach((e, i) => {
      if (!rankOf.has(e.id)) rankOf.set(e.id, i + 1);
    });
    const ranks = row.chunkIds.map((c) => rankOf.get(c) ?? 0).filter((x) => x > 0);
    const hits5 = ranks.filter((x) => x <= 5).length;
    const hits10 = ranks.filter((x) => x <= 10).length;
    const firstRank = ranks.length ? Math.min(...ranks) : 0;
    const status: GroupStatus =
      firstRank >= 1 && firstRank <= 5 ? 'hit5' : firstRank >= 6 && firstRank <= 10 ? 'hit10' : firstRank > 10 ? 'hit50' : 'miss';
    results.push({
      id: row.id,
      question: row.question,
      category: row.category,
      segCount: row.segCount,
      crossChapter: row.crossChapter,
      status,
      firstRank,
      hits5,
      hits10,
      hit5: firstRank >= 1 && firstRank <= 5,
      hit10: firstRank >= 1 && firstRank <= 10,
      hit50: firstRank >= 1,
      bridgeGroups,
      bridgeHit: bridgeGroups > 0,
      eventBridgeHit: (diagnostics?.eventHit?.groupCount ?? 0) > 0,
      allusionBridgeHit: (diagnostics?.allusionHit?.groupCount ?? 0) > 0,
      chunkIds: row.chunkIds,
      top10Ids: entries.slice(0, 10).map((e) => e.id),
      poolIds: entries.map((e) => e.id),
    });
  }
  const elapsedMs = Math.round((performance.now() - t0) * 10) / 10;

  const groupBy = (keyFn: (r: GroupRunResult) => string): Record<string, GroupRunResult[]> => {
    const acc: Record<string, GroupRunResult[]> = {};
    for (const r of results) (acc[keyFn(r)] ??= []).push(r);
    return acc;
  };
  const byCategory = Object.fromEntries(
    Object.entries(groupBy((r) => r.category)).map(([k, v]) => [k, summarizeGroup(v)]),
  );
  const byBucket = Object.fromEntries(
    Object.entries(groupBy((r) => bucketOf(r.segCount))).map(([k, v]) => [k, summarizeGroup(v)]),
  );

  // 环比取该集最近上一份快照（listRunIds 倒序、排除本次）；无上一份 → compare=null（首次运行）。
  const prevRunId = listRunIds(set.resultsDir).find((id) => id !== runId);
  const prev = prevRunId ? readSnapshot(set.resultsDir, prevRunId) : null;
  const compare: GroupCompare | null = prev
    ? compareGroupWithPrev(
        { runId: prev.runId, time: prev.time, results: prev.results as unknown as GroupRunResult[] },
        results,
      )
    : null;

  const summary: GroupSummary = {
    runId,
    time: new Date().toISOString(),
    setId: set.id,
    setName: set.name,
    judge: 'group',
    benchmark: set.file,
    evalSetMeta: evalSet.meta,
    engine: { sango: SANGO_ROOT, indexN: index.n, inferLimit: INFER_LIMIT },
    ...summarizeGroup(results),
    byCategory,
    byBucket,
    compare,
    elapsedMs,
  };
  const run: GroupBenchmarkRun = { runId, time: summary.time, summary, results };
  writeGroupRun(run, set.resultsDir);
  return run;
}
