/**
 * 评测 runner（story-A015-02）：解析评测集 → 证据锚整库可定位校验 → 逐题 index.search(question, 50)
 * + 证据锚判定 + 类别汇总 → 快照落盘。判分口径（评测集头部）：判对 = 证据段进检索结果 top5（rank 1–5）；
 * 6–10 为过渡兜底、单列统计；其余为未命中（rank>10 或未召回，rank=0）。
 * 汇总字段与 dev-docs CLI 产物同构（tool/version 沿用 CLI 原值，保证收敛后新旧快照可直接对比）。
 *
 * runId 先由调用方（server 层）在请求开始即生成并传入：执行中的新 POST 需要 409 回显
 * 正在执行的 runId，故不能在执行完成后才生成。
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { SangoIndex } from '../search/sango-index.ts';
import { extractAnchors, matchEvidence, norm } from './matcher.ts';
import { parseBenchmark } from './parser.ts';
import type { BenchmarkItem } from './parser.ts';
import { writeRun } from './snapshot.ts';

/** 检索深度：与 CLI inferLimit 一致（契约 §4 candidates 即该 top50 池）。 */
export const INFER_LIMIT = 50;

export type RunStatus = 'top5' | 'tail' | 'miss';

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
  top5: number;
  tail: number;
  miss: number;
  top3: number;
  top10: number;
  inPool50: number;
  noAnchorCount: number;
  noAnchor: string[];
  category: Record<string, CategoryCount>;
  runId: string;
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
 * 证据锚在整库范围内是否可定位（校验评测集自身质量，不依赖本次检索结果）；返回无法定位的题目 id。
 * 与 verify.mjs 锚有效性校验同口径：正文锚查全库正文 → 回目锚查限定回目 → 正文锚（≥4 字）回退查任意回目。
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
    if (it.textAnchors.length === 0 && it.titleAnchors.length === 0) continue; // 说明型/负例证据
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
        if (ch && ch.title.includes(ta.title)) {
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
export async function runBenchmark(index: SangoIndex, benchmarkFile: string, resultsDir: string, runId: string): Promise<BenchmarkRun> {
  const items = parseBenchmark(benchmarkFile);
  const noAnchor = findNoAnchorItems(index, items);
  const results: RunResult[] = [];
  for (const it of items) {
    const res = await index.search(it.question, INFER_LIMIT);
    const m = matchEvidence(res.entries, it.textAnchors, it.titleAnchors);
    let status: RunStatus = 'miss';
    if (m.rank >= 1 && m.rank <= 5) status = 'top5';
    else if (m.rank >= 6 && m.rank <= 10) status = 'tail';
    results.push({
      id: it.id,
      question: it.question,
      answer: it.answer,
      evidence: it.evidence,
      textAnchors: it.textAnchors,
      titleAnchors: it.titleAnchors,
      chapterRefs: it.chapterRefs,
      rank: m.rank,
      status,
      hit: m.hit ? { id: m.hit.id, chapter: m.hit.chapter, title: m.hit.title, text: m.hit.text.slice(0, 80) } : null,
      candidates: res.entries.map((e) => ({ id: e.id, chapter: e.chapter, title: e.title })),
    });
  }

  const byStatus = { top5: 0, tail: 0, miss: 0 };
  const byCategory: Record<string, CategoryCount> = {};
  for (const r of results) {
    byStatus[r.status]++;
    const catKey = r.id.split('#')[0];
    const c = (byCategory[catKey] ??= { total: 0, top5: 0, tail: 0, miss: 0 });
    c.total++;
    c[r.status]++;
  }
  const top3 = results.filter((r) => r.rank >= 1 && r.rank <= 3).length;
  const top10 = results.filter((r) => r.rank >= 1 && r.rank <= 10).length;
  const inPool50 = results.filter((r) => r.rank > 0).length;

  const summary: RunSummary = {
    tool: 'feat-A015-verify.mjs',
    version: 'v2',
    time: new Date().toISOString(),
    benchmark: benchmarkFile,
    engine: { sango: SANGO_ROOT, indexN: index.n, inferLimit: INFER_LIMIT },
    total: results.length,
    top5: byStatus.top5,
    tail: byStatus.tail,
    miss: byStatus.miss,
    top3,
    top10,
    inPool50,
    noAnchorCount: noAnchor.length,
    noAnchor,
    category: byCategory,
    runId,
  };
  const run: BenchmarkRun = { runId, time: summary.time, summary, results };
  writeRun(run, resultsDir);
  return run;
}
