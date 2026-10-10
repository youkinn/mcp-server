/**
 * 评测集注册表（story-A018-03）：服务端多评测集定义（id / 名称 / 文件 / 判分模式 / 快照目录 / runId 前缀）。
 * 注册表为代码内定义，env 仅覆盖两集的文件与快照目录路径；快照目录按评测集隔离，runId 前缀区分评测集，
 * 避免两集快照互相覆盖或混入同一 history。
 */
import path from 'node:path';

/** 判分模式：anchor = 证据锚判定（A015 标准集）；group = chunkIds 组判分（事件 / 典故组召回）。 */
export type JudgeMode = 'anchor' | 'group';

/** 单个评测集。 */
export interface BenchmarkSet {
  /** 稳定标识（页面下拉与请求参数 setId 用）。 */
  id: string;
  /** 页面展示名。 */
  name: string;
  /** 评测集文件（anchor=md，group=json）。 */
  file: string;
  /** 判分模式。 */
  judge: JudgeMode;
  /** 快照目录（按评测集隔离，服务端内部使用，不随 GET /sets 暴露）。 */
  resultsDir: string;
  /** runId 前缀：快照文件名 / runId 按评测集区分。 */
  runIdPrefix: string;
  /** runId 时间戳是否含秒（组集单次约 17s，秒级粒度避免同分覆盖）。 */
  withSeconds: boolean;
}

/** 标准评测集（证据锚判定）默认路径，沿用 A015。 */
const DEFAULT_BENCHMARK_FILE = 'D:\\workplace\\dev-docs\\docs\\sango-rag-regression-benchmark_v0.1.md';
const DEFAULT_RESULTS_DIR = 'D:\\workplace\\dev-docs\\test\\standard-set\\results';
/** 事件 / 典故组召回评测集默认路径（与 events-recall-probe.mjs 同源）。 */
const DEFAULT_EVENTS_EVAL = 'D:\\workplace\\dev-docs\\test\\standard-set\\events\\eval-set.json';

/** 标准集 id（POST run 缺省 setId = 本集，保持 A015 向后兼容）。 */
export const STANDARD_SET_ID = 'standard';
/** 事件 / 典故组召回集 id。 */
export const EVENTS_SET_ID = 'events';

/** 装配评测集注册表（读 env 覆盖路径；每次启动调用一次）。 */
export function loadBenchmarkSets(): BenchmarkSet[] {
  const eventsFile = process.env.SANGO_EVENTS_EVAL ?? DEFAULT_EVENTS_EVAL;
  return [
    {
      id: STANDARD_SET_ID,
      name: '标准评测集（证据锚判定）',
      file: process.env.SANGO_BENCHMARK_FILE ?? DEFAULT_BENCHMARK_FILE,
      judge: 'anchor',
      resultsDir: process.env.SANGO_BENCHMARK_RESULTS_DIR ?? DEFAULT_RESULTS_DIR,
      runIdPrefix: 'feat-A015',
      withSeconds: false,
    },
    {
      id: EVENTS_SET_ID,
      name: '事件 / 典故组召回（组判分）',
      file: eventsFile,
      judge: 'group',
      resultsDir: process.env.SANGO_EVENTS_RESULTS_DIR ?? path.join(path.dirname(eventsFile), 'results'),
      runIdPrefix: 'feat-A018',
      withSeconds: true,
    },
  ];
}

/** 按 id 查注册表；setId 缺省（null）= 标准集（A015 向后兼容）；未知返回 undefined（server 层映射 404）。 */
export function findSet(sets: BenchmarkSet[], setId: string | null): BenchmarkSet | undefined {
  if (!setId) return sets.find((s) => s.id === STANDARD_SET_ID);
  return sets.find((s) => s.id === setId);
}

/** 按 runId 前缀解析所属评测集（GET snapshot 的 setId 省略时用）；无匹配回退标准集。 */
export function findSetByRunId(sets: BenchmarkSet[], runId: string): BenchmarkSet | undefined {
  return sets.find((s) => runId.startsWith(`${s.runIdPrefix}-`)) ?? sets.find((s) => s.id === STANDARD_SET_ID);
}
