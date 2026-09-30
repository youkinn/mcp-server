/**
 * 评测 runner（story-A015-02）：解析评测集 → 证据锚整库可定位校验 → 逐题 index.search(question, 50)
 * + 证据锚判定 + 类别汇总 → 快照落盘。判分口径（评测集头部）：判对 = 证据段进检索结果 top5（rank 1–5）；
 * 6–10 为过渡兜底、单列统计；其余为未命中（rank>10 或未召回，rank=0）。
 * 无有效证据锚题（bug-00052）不参与判分：单列进 summary.noAnchor、不进通过率分母
 * （judged = total - noAnchorCount）。
 * 汇总字段与 dev-docs CLI 产物同构（tool/version 沿用 CLI 原值，保证收敛后新旧快照可直接对比）。
 *
 * runId 先由调用方（server 层）在请求开始即生成并传入：执行中的新 POST 需要 409 回显
 * 正在执行的 runId，故不能在执行完成后才生成。
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { resolveRerankMode, SangoIndex } from '../search/sango-index.ts';
import { resolveRerankTuning } from '../search/reranker.ts';
import { extractAnchors, matchEvidence, norm } from './matcher.ts';
import { parseBenchmark } from './parser.ts';
import type { BenchmarkItem } from './parser.ts';
import { writeRun } from './snapshot.ts';

/** 检索深度：与 CLI inferLimit 一致（契约 §4 candidates 即该 top50 池）。 */
export const INFER_LIMIT = 50;

/**
 * 停止能力（FEAT-A015 test-2241 追加）：调用方传入 shouldStop，runner 在逐题之间检查；
 * 命中即抛本错误中止，不打快照、不算 failed（server 层据此映射终态 aborted）。
 */
export class BenchmarkAbortedError extends Error {
  readonly runId: string;
  constructor(runId: string) {
    super(`benchmark aborted: ${runId}`);
    this.name = 'BenchmarkAbortedError';
    this.runId = runId;
  }
}

/** runBenchmark 可选行为：shouldStop 为「停止请求已受理」的查询回调（逐题之间检查）。 */
export interface RunOptions {
  shouldStop?: () => boolean;
}

/** 单题判分状态：top5 判对 / tail 兜底 / miss 未命中；noAnchor（bug-00052）= 无有效证据锚，不参与判分、单列。 */
export type RunStatus = 'top5' | 'tail' | 'miss' | 'noAnchor';

/** 命中证据段：text 截 80 字（与 CLI 产物一致，页面核对原文走 candidates 的 chunkId）。 */
export interface HitInfo {
  id: string;
  chapter: number;
  title: string;
  text: string;
}

/** 候选条目（top50 检索池；页面列候选、点 chunkId 看原文）。 */
export interface CandidateInfo {
  id: string;
  chapter: number;
  title: string;
}

/** 单题结果（字段与 CLI 产物逐一同构）。 */
export interface RunResult {
  id: string;
  question: string;
  answer: string;
  evidence: string;
  textAnchors: string[];
  titleAnchors: { chapter: number; title: string }[];
  chapterRefs: number[];
  rank: number;
  status: RunStatus;
  /** bug-00052：无有效证据锚（零锚 / 锚不可定位）→ 不参与判分、单列（页面据此与 summary.noAnchor 展示）。 */
  noAnchor: boolean;
  hit: HitInfo | null;
  candidates: CandidateInfo[];
}

/** 单类别计数。 */
export interface CategoryCount {
  total: number;
  top5: number;
  tail: number;
  miss: number;
}

/** 汇总（字段与 CLI 产物逐一同构）。 */
export interface RunSummary {
  tool: string;
  version: string;
  time: string;
  benchmark: string;
  engine: { sango: string; indexN: number; inferLimit: number };
  total: number;
  /** bug-00052：参与判分题数 = total - noAnchorCount；无锚题单列、不进通过率分母。 */
  judged: number;
  top5: number;
  tail: number;
  miss: number;
  top3: number;
  top10: number;
  inPool50: number;
  noAnchorCount: number;
  noAnchor: string[];
  category: Record<string, CategoryCount>;
  /**
   * FEAT-A015 test-2241：重排拾取信息（历史快照「是否开启重排」列；dev server 扩展字段，老快照无此键）。
   * mode / wired / window 反映本次 run 实际装配（含降级）；maxTokens / batch / intraThreads 为调参生效值。
   */
  rerank: RunRerankSummary;
  /**
   * FEAT-A015 test-2241：本次 run 服务端计时（毫秒；run 开始 → 逐题检索判分结束，不含落盘与 HTTP 传输）。
   */
  elapsedMs: number;
  runId: string;
}

/** FEAT-A015 test-2241：重排拾取汇总（只增字段；老快照无 rerank → 前端显示「—」）。 */
export interface RunRerankSummary {
  /** SANGO_RERANKER 原始取值归一：仅 'on' 为 on，未设 / 其它值一律 off。 */
  mode: 'on' | 'off';
  /** 本次 run 是否真的接入 cross-encoder 打分器（权重缺失退回规则序时为 false）。 */
  wired: boolean;
  /** 实际生效重排窗口（sango-index.ts rerankWindowSize() 口径，非 .env 原文）。 */
  window: number;
  /** resolveRerankTuning() 生效值（含默认回落）：pair 截断上限。 */
  maxTokens: number;
  /** resolveRerankTuning() 生效值（含默认回落）：桶内批量。 */
  batch: number;
  /** ORT intra-op 线程数；未设 → null。 */
  intraThreads: number | null;
}

/** 一次完整执行。 */
export interface BenchmarkRun {
  runId: string;
  time: string;
  summary: RunSummary;
  results: RunResult[];
}

/** sango 包根目录（src/benchmark 或 dist/benchmark 上溯两级），engine.sango 取值。 */
const SANGO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** runId 生成：feat-A015-YYYY-MM-DD-HHMM（同日多次执行不重名）。 */
export function makeRunId(date: Date = new Date()): string {
  return `feat-A015-${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}-${pad2(date.getHours())}${pad2(date.getMinutes())}`;
}

/**
 * 无有效证据锚（零锚 / 锚在语料中不可定位）的题目 id（校验评测集自身质量，不依赖本次检索结果）；
 * 供 summary.noAnchor 单列——这些题不参与判分、不进通过率分母（bug-00052）。
 * 与 verify.mjs 锚有效性校验同口径：正文锚查全库正文 → 回目锚查限定回目 → 正文锚（≥4 字）回退查任意回目；
 * 零锚题（textAnchors 与 titleAnchors 均为空）直接计入返回。
 */
export function findNoAnchorItems(index: SangoIndex, items: BenchmarkItem[]): string[] {
  const byChapter = new Map<number, { title: string; texts: string[] }>();
  for (const d of index.docs) {
    let ch = byChapter.get(d.chapter);
    if (!ch) {
      ch = { title: norm(d.title), texts: [] };
      byChapter.set(d.chapter, ch);
    }
    ch.texts.push(norm(d.text));
  }
  const titles = [...byChapter.values()].map((c) => c.title);
  const allTexts = [...byChapter.values()].map((c) => c.texts.join('\n'));
  const noAnchor: string[] = [];
  for (const it of items) {
    // bug-00052：零锚题原被 continue 豁免——不进 noAnchor 列表却仍判分记 miss，静默失分无人可见；
    // 现纳入返回：单列、不参与判分、不进通过率分母。
    if (it.textAnchors.length === 0 && it.titleAnchors.length === 0) {
      noAnchor.push(it.id);
      continue;
    }
    let ok = false;
    for (const a of it.textAnchors) {
      if (allTexts.some((t) => t.includes(a))) {
        ok = true;
        break;
      }
    }
    if (!ok) {
      for (const ta of it.titleAnchors) {
        const ch = byChapter.get(ta.chapter);
        // bug-00052：回目锚原文带标点（如「陆逊营烧七百里，孔明巧布八阵图」），与归一回目比较前统一 norm
        // （与 matcher.matchEvidence 同一比较口径）。
        if (ch && ch.title.includes(norm(ta.title))) {
          ok = true;
          break;
        }
      }
    }
    if (!ok) {
      for (const a of it.textAnchors) {
        if (a.length >= 4 && titles.some((t) => t.includes(a))) {
          ok = true;
          break;
        }
      }
    }
    if (!ok) noAnchor.push(it.id);
  }
  return noAnchor;
}

/** 执行完整回归：解析评测集 → 锚校验 → 逐题检索判分 → 汇总 → 快照落盘，返回本次运行。 */
export async function runBenchmark(index: SangoIndex, benchmarkFile: string, resultsDir: string, runId: string, options: RunOptions = {}): Promise<BenchmarkRun> {
  const t0 = performance.now();
  const items = parseBenchmark(benchmarkFile);
  const noAnchor = findNoAnchorItems(index, items);
  const noAnchorSet = new Set(noAnchor);
  const results: RunResult[] = [];
  for (const it of items) {
    // 停止请求在逐题之间检查：当前题照常跑完，命中则抛专用中止错误（不落快照、不落 failed）。
    if (options.shouldStop?.()) throw new BenchmarkAbortedError(runId);
    // bug-00052：无有效证据锚题不参与判分——不检索、不判分、不记 miss，单列进 summary.noAnchor。
    const isNoAnchor = noAnchorSet.has(it.id);
    let status: RunStatus = isNoAnchor ? 'noAnchor' : 'miss';
    let rank = 0;
    let hit: HitInfo | null = null;
    let candidates: CandidateInfo[] = [];
    if (!isNoAnchor) {
      const res = await index.search(it.question, INFER_LIMIT);
      const m = matchEvidence(res.entries, it.textAnchors, it.titleAnchors);
      rank = m.rank;
      if (m.rank >= 1 && m.rank <= 5) status = 'top5';
      else if (m.rank >= 6 && m.rank <= 10) status = 'tail';
      hit = m.hit ? { id: m.hit.id, chapter: m.hit.chapter, title: m.hit.title, text: m.hit.text.slice(0, 80) } : null;
      candidates = res.entries.map((e) => ({ id: e.id, chapter: e.chapter, title: e.title }));
    }
    results.push({
      id: it.id,
      question: it.question,
      answer: it.answer,
      evidence: it.evidence,
      textAnchors: it.textAnchors,
      titleAnchors: it.titleAnchors,
      chapterRefs: it.chapterRefs,
      rank,
      status,
      noAnchor: isNoAnchor,
      hit,
      candidates,
    });
  }

  const byStatus = { top5: 0, tail: 0, miss: 0 };
  const byCategory: Record<string, CategoryCount> = {};
  for (const r of results) {
    // bug-00052：无锚题不参与判分——不进 top5/tail/miss 与类别计数（不进通过率分母）。
    if (r.status === 'noAnchor') continue;
    byStatus[r.status]++;
    const catKey = r.id.split('#')[0];
    const c = (byCategory[catKey] ??= { total: 0, top5: 0, tail: 0, miss: 0 });
    c.total++;
    c[r.status]++;
  }
  const top3 = results.filter((r) => r.rank >= 1 && r.rank <= 3).length;
  const top10 = results.filter((r) => r.rank >= 1 && r.rank <= 10).length;
  const inPool50 = results.filter((r) => r.rank > 0).length;

  // FEAT-A015 test-2241 计时口径：run 开始 → 逐题检索判分结束；落盘（writeRun）与 HTTP 传输不计入。
  // 保留 0.1ms 精度：避免极小样本（单测合成语料）被四舍五入成 0，读数恒为正。
  const elapsedMs = Math.round((performance.now() - t0) * 10) / 10;
  // FEAT-A015 test-2241：重排拾取信息（只读装配口径，不另造 env 解析）。
  const tuning = resolveRerankTuning();
  const assembly = index.rerankAssembly();

  const summary: RunSummary = {
    tool: 'feat-A015-verify.mjs',
    version: 'v2',
    time: new Date().toISOString(),
    benchmark: benchmarkFile,
    engine: { sango: SANGO_ROOT, indexN: index.n, inferLimit: INFER_LIMIT },
    total: results.length,
    judged: results.length - noAnchor.length,
    top5: byStatus.top5,
    tail: byStatus.tail,
    miss: byStatus.miss,
    top3,
    top10,
    inPool50,
    noAnchorCount: noAnchor.length,
    noAnchor,
    category: byCategory,
    rerank: {
      mode: resolveRerankMode(),
      wired: assembly.wired,
      window: assembly.window,
      maxTokens: tuning.maxTokens,
      batch: tuning.batch,
      intraThreads: tuning.intraOpThreads ?? null,
    },
    elapsedMs,
    runId,
  };
  const run: BenchmarkRun = { runId, time: summary.time, summary, results };
  writeRun(run, resultsDir);
  return run;
}
