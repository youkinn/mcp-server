/**
 * 快照落盘与读取（story-A015-02 / A018-03）：JSON 快照 + summary.md。
 * 锚判定落盘：{resultsDir}/feat-A015-YYYY-MM-DD-HHMM.json 及同名 -summary.md；
 * 组判分落盘：{resultsDir}/feat-A018-YYYY-MM-DD-HHMMSS.json 及同名 -summary.md。
 * runId 前缀区分评测集（两集快照不互覆盖、不混入同一 history）；老快照与新字段互相兼容，缺字段前端显示「—」。
 * JSON 顶层统一 { summary, results }；summary.md 按判分模式分别沿用 CLI 模板（锚）与探针模板（组）。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { BenchmarkRun, RunResult, RunSummary } from './runner.ts';
import type { GroupBenchmarkRun, GroupCompare, GroupCount } from './group-runner.ts';

/** summary.md 类别显示名：官职 → 官职/爵位（与 CLI CATEGORY_LABEL 同口径，对齐评测集「十三」表）。 */
const CATEGORY_LABEL: Record<string, string> = {
  人物: '人物',
  地名: '地名',
  战役: '战役',
  典故: '典故',
  器物: '器物',
  身体部位: '身体部位',
  问法归一: '问法归一',
  官职: '官职/爵位',
  数字称谓: '数字称谓',
  事件关系: '事件关系',
  出场: '出场',
  死亡: '死亡',
};

/**
 * 快照 runId 合法格式（兼作路径校验，拦截目录穿越）：
 * standard = feat-A015-YYYY-MM-DD-HHMM；events = feat-A018-YYYY-MM-DD-HHMMSS（秒级粒度避免同分覆盖）。
 */
const RUN_ID_RE = /^(feat-A015-\d{4}-\d{2}-\d{2}-\d{4}|feat-A018-\d{4}-\d{2}-\d{2}-\d{6})$/;

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

/** 落盘一次锚判定运行：JSON 快照 + summary.md；目录不存在自动创建。 */
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
  // bug-00052：无锚题不参与判分、不进通过率分母 → 合计总题数 / 通过率分母用 judged。
  const totalRow = `| **合计** | **${s.judged}** | **${s.top5}** | **${s.tail}** | **${s.miss}** | **${((s.judged ? s.top5 / s.judged : 0) * 100).toFixed(1)}%** |`;
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

/** 落盘一次组判分运行：JSON 快照 + 组集 summary.md；目录不存在自动创建。 */
export function writeGroupRun(run: GroupBenchmarkRun, resultsDir: string): void {
  const { jsonPath, summaryPath } = snapshotPaths(resultsDir, run.runId);
  mkdirSync(resultsDir, { recursive: true });
  writeFileSync(jsonPath, JSON.stringify({ summary: run.summary, results: run.results }, null, 2), 'utf8');
  writeFileSync(summaryPath, buildGroupSummaryMd(run, jsonPath), 'utf8');
}

/** 组集 summary.md 内容：沿用探针 summary.md 模板（总分档 / 分类别 / 环比 / 未进池列表），逐段同构。 */
function buildGroupSummaryMd(run: GroupBenchmarkRun, jsonPath: string): string {
  const s = run.summary;
  const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
  const table = (label: string, rows: Record<string, GroupCount>): string =>
    [
      `| ${label} | 题数 | hit@5 | hit@10 | hit@50 | 未进池 | 通过率(hit@10) | cover@5 |`,
      '|---|---:|---:|---:|---:|---:|---:|---:|',
      ...Object.entries(rows).map(
        ([k, v]) => `| ${k} | ${v.total} | ${v.hit5} | ${v.hit10} | ${v.hit50} | ${v.miss} | ${pct(v.hit10Rate)} | ${pct(v.cover5)} |`,
      ),
    ].join('\n');
  const missList = run.results
    .filter((r) => r.status === 'miss')
    .map((r) => `- [${r.category}] ${r.question}（组 ${r.segCount} 段）`);
  const compareLines = (c: GroupCompare): string[] => [
    `对照 ${c.prevFile}（生成 ${c.prevTime}）：退化 ${c.regressed.length} 题 / 改善 ${c.improved.length} 题。`,
    '',
    ...(c.regressed.length ? [`退化 ${c.regressed.length} 题`, ...c.regressed.slice(0, 20).map((r) => `- ${r.question}（${r.from} → ${r.to}）`)] : ['退化 0 题']),
    '',
    ...(c.improved.length ? [`改善 ${c.improved.length} 题`, ...c.improved.slice(0, 20).map((r) => `- ${r.question}（${r.from} → ${r.to}）`)] : ['改善 0 题']),
  ];
  return [
    '# 事件 / 典故组召回评测快照',
    '',
    `> 判分单位 = 事件 / 典故 chunkIds 组：hit@k = top-k 含组内任一段；cover@5 = top5 命中组内段数 / min(5, 组大小)。零 LLM，引擎 SangoIndex（窗口 ${s.engine.inferLimit}）。`,
    `> 评测集 ${s.benchmark}；题数 ${s.total}；生成 ${s.time}；检索耗时 ${s.elapsedMs} ms。`,
    '',
    '## 总分档',
    '',
    table('分档', s.byBucket),
    '',
    `合计 ${s.total} 题：hit@5 ${s.hit5} / hit@10 ${s.hit10} / hit@50 ${s.hit50} / 未进池 ${s.miss}（桥未命中 ${s.missNoBridge}、并池后掉窗 ${s.dropped}），通过率 ${pct(s.hit10Rate)}，cover@5 ${pct(s.cover5)}。`,
    `事件桥 ${s.eventBridge}/${s.total}（${pct(s.eventBridge / s.total)}）。`,
    `典故桥 ${s.allusionBridge}/${s.total}（${pct(s.allusionBridge / s.total)}）；桥未命中的题多由常规三路召回进窗，故桥命中率与召回率须分开读。`,
    '',
    '## 分类别',
    '',
    table('类别', s.byCategory),
    '',
    '## 环比上一份快照',
    '',
    ...(s.compare ? compareLines(s.compare) : ['（本目录暂无上一份快照，首次运行）']),
    '',
    '## 未进 50 路池',
    '',
    ...(missList.length ? missList : ['（无）']),
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
