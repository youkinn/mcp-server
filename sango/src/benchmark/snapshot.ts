/**
 * 快照落盘与读取（story-A015-02）：JSON 快照 + summary.md，格式与 dev-docs CLI 产物同构（禁止另造格式）。
 * 落盘：{resultsDir}/feat-A015-YYYY-MM-DD-HHMM.json 及同名 -summary.md（runId 保证同日多次执行不重名）。
 * JSON 顶层 { summary, results }；summary.md 沿用 CLI 模板（引擎/判分口径头 + 十三段模板 COPY 类别表 +
 * 兜底 6–10 列表 + 未命中（>10 / 未召回）列表）。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { BenchmarkRun, RunResult, RunSummary } from './runner.ts';

/** summary.md 类别显示名：官职 → 官职/爵位（与 CLI CATEGORY_LABEL 同口径，对齐评测集「十三」表）。 */
const CATEGORY_LABEL: Record<string, string> = {
  人物: '人物',
  地名: '地名',
  战役: '战役',
  典故: '典故',
  器物: '器物',
  身体部位: '身体部位',
  官职: '官职/爵位',
  数字称谓: '数字称谓',
  事件关系: '事件关系',
  死亡: '死亡',
  拒答: '拒答',
};

/** 快照 runId 合法格式（兼作路径校验，拦截目录穿越）。 */
const RUN_ID_RE = /^feat-A015-\d{4}-\d{2}-\d{2}-\d{4}$/;

/** 一次快照（GET latest / snapshot 出参 data 结构）。 */
export interface Snapshot {
  runId: string;
  time: string;
  summary: RunSummary;
  results: RunResult[];
}

/** 单次快照的落盘路径（JSON + summary.md）。 */
export function snapshotPaths(resultsDir: string, runId: string): { jsonPath: string; summaryPath: string } {
  return {
    jsonPath: path.join(resultsDir, `${runId}.json`),
    summaryPath: path.join(resultsDir, `${runId}-summary.md`),
  };
}

/** runId 是否合法；非法一律按不存在处理（防目录穿越，与格式化错误一起回 404）。 */
export function isValidRunId(runId: string): boolean {
  return RUN_ID_RE.test(runId);
}

/** 落盘一次运行：JSON 快照 + summary.md；目录不存在自动创建。 */
export function writeRun(run: BenchmarkRun, resultsDir: string): void {
  const { jsonPath, summaryPath } = snapshotPaths(resultsDir, run.runId);
  mkdirSync(resultsDir, { recursive: true });
  writeFileSync(jsonPath, JSON.stringify({ summary: run.summary, results: run.results }, null, 2), 'utf8');
  writeFileSync(summaryPath, buildSummaryMd(run, jsonPath), 'utf8');
}

/** summary.md 内容：沿用 CLI 模板，逐段同构。 */
function buildSummaryMd(run: BenchmarkRun, jsonPath: string): string {
  const s = run.summary;
  const stampStr = s.runId.slice('feat-A015-'.length);
  const catRows = Object.entries(s.category).map(
    ([cat, v]) => `| ${CATEGORY_LABEL[cat] ?? cat} | ${v.total} | ${v.top5} | ${v.tail} | ${v.miss} | ${((v.top5 / v.total) * 100).toFixed(1)}% |`,
  );
  const totalRow = `| **合计** | **${s.total}** | **${s.top5}** | **${s.tail}** | **${s.miss}** | **${((s.top5 / s.total) * 100).toFixed(1)}%** |`;
  const tableBody = ['| 类别 | 总题数 | 通过数(top5) | 兜底数(6–10) | 未命中数 | 通过率 |', '|---|---:|---:|---:|---:|---:|', ...catRows, totalRow].join('\n');
  const tailList = run.results
    .filter((r) => r.status === 'tail')
    .map((r) => `| ${r.id} | ${r.question} | rank=${r.rank} |`)
    .join('\n');
  const missList = run.results
    .filter((r) => r.status === 'miss')
    .map((r) => `| ${r.id} | ${r.question} | ${r.rank >= 1 ? `rank=${r.rank}` : '未召回'} |`)
    .join('\n');
  return [
    `# FEAT-A015 回归测试结果（${stampStr}）`,
    '',
    `> 引擎 SangoIndex（向量+BM25+标签融合，limit=${s.engine.inferLimit}）；零 LLM；判对 = 证据段进 top5，6–10 兜底，其余未命中。`,
    `> JSON 快照：\`${jsonPath}\``,
    '',
    '## 回归测试结果（十三段模板 COPY）',
    '',
    tableBody,
    '',
    '## 兜底问题（rank 6–10）',
    '',
    '| 编号 | 问题 | 结果 |',
    '|---|---|---|',
    tailList || '（无）',
    '',
    '## 未命中问题（rank >10 或未召回）',
    '',
    '| 编号 | 问题 | 结果 |',
    '|---|---|---|',
    missList || '（无）',
    '',
  ].join('\n');
}

/**
 * 读取一次快照；runId 非法或文件不存在返回 null（GET snapshot 据此回 404）。
 * @throws 文件存在但 JSON 损坏时抛错（由 server 层转 500）。
 */
export function readSnapshot(resultsDir: string, runId: string): Snapshot | null {
  if (!isValidRunId(runId)) return null;
  const { jsonPath } = snapshotPaths(resultsDir, runId);
  if (!existsSync(jsonPath)) return null;
  const raw: unknown = JSON.parse(readFileSync(jsonPath, 'utf8'));
  if (!raw || typeof raw !== 'object' || !('summary' in raw) || !('results' in raw)) {
    throw new Error(`快照文件结构异常：${jsonPath}`);
  }
  const { summary, results } = raw as { summary: RunSummary; results: RunResult[] };
  return { runId, time: summary.time, summary, results };
}

/** 全部快照 runId，按时间倒序（文件名即时间戳，倒序即最新在前）。 */
export function listRunIds(resultsDir: string): string[] {
  if (!existsSync(resultsDir)) return [];
  return readdirSync(resultsDir)
    .filter((f) => f.endsWith('.json') && isValidRunId(f.slice(0, -5)))
    .map((f) => f.slice(0, -5))
    .sort()
    .reverse();
}
