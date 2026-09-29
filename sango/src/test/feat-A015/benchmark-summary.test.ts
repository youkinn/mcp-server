/**
 * FEAT-A015 test-2241 活文档：评测快照 summary 的重排拾取信息（rerank）与服务端计时（elapsedMs）。
 * 契约：dev-docs docs/feat-A015-benchmark-api.md §4。口径：
 * - mode 归一：仅 SANGO_RERANKER='on' 为 on，未设 / 其它值一律 off；
 * - wired：本次 run 是否真的接入 cross-encoder 打分器（权重缺失装配层传 null → false，退回规则序）；
 * - window：sango-index.ts rerankWindowSize() 生效值（非 .env 原文）；
 * - maxTokens / batch / intraThreads：resolveRerankTuning() 生效值（含默认回落）。
 * 用「注入打分器」保证确定性，不依赖 ~266MB 真实权重。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SangoIndex } from '../../search/sango-index.ts';
import type { RerankScorer } from '../../search/reranker.ts';
import { runBenchmark } from '../../benchmark/runner.ts';
import { readSnapshot } from '../../benchmark/snapshot.ts';

/** 与重排相关的 env 键：用例前后统一清空 / 还原，避免串扰。 */
const RERANK_ENVS = [
  'SANGO_RERANKER',
  'SANGO_RERANKER_WINDOW',
  'SANGO_RERANKER_MAX_TOKENS',
  'SANGO_RERANKER_BATCH',
  'SANGO_RERANKER_INTRA_THREADS',
];

interface Fixture {
  dir: string;
  index: SangoIndex;
  benchmarkFile: string;
  resultsDir: string;
}

/** 合成语料（3 段）+ 2 题评测集，够 index.load() 与一次检索判分跑通。 */
function fixture(scorer: RerankScorer | null = null): Fixture {
  const dir = mkdtempSync(path.join(tmpdir(), 'a015-sum-'));
  const corpusDir = path.join(dir, 'corpus', 'sanguo-yanyi');
  mkdirSync(corpusDir, { recursive: true });
  const chunks = ['刘备字玄德，涿郡涿县人。', '曹操字孟德，沛国谯人。', '孙权字仲谋，吴郡富春人。'].map((text, i) => ({
    id: `sanguo-yanyi:0001:c000${i + 1}`,
    text,
    type: 'narration',
    segFrom: i + 1,
    segTo: i + 1,
    quoteBalanced: true,
    quotes: [],
  }));
  writeFileSync(path.join(corpusDir, '001.json'), JSON.stringify({ source: 'sanguo-yanyi', chapter: 1, title: '第一回 合成', chunks }), 'utf8');
  const benchmarkFile = path.join(dir, 'bench.md');
  writeFileSync(
    benchmarkFile,
    [
      '# 合成评测集',
      '',
      '## 一、人物',
      '',
      '| # | 问题 | 标准答案 | 证据 |',
      '|---|---|---|---|',
      '| 1 | 刘备是谁 | 刘备 | “刘备字玄德” |',
      '| 2 | 曹操是谁 | 曹操 | “曹操字孟德” |',
    ].join('\n'),
    'utf8',
  );
  const index = scorer ? new SangoIndex(dir, { rerankScorer: scorer }) : new SangoIndex(dir);
  index.load();
  return { dir, index, benchmarkFile, resultsDir: path.join(dir, 'results') };
}

/** 清空重排 env → 注入 vars → 执行 → 还原（runBenchmark 内 resolveRerankTuning / rerankWindowSize 读 process.env）。 */
async function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved = RERANK_ENVS.map((key) => [key, process.env[key]] as const);
  for (const key of RERANK_ENVS) delete process.env[key];
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('① 默认环境（未开重排、未注入打分器）：mode=off / wired=false，窗口与调参回落默认值且 elapsedMs 为正', async () => {
  const { dir, index, benchmarkFile, resultsDir } = fixture(null);
  try {
    const run = await withEnv({}, () => runBenchmark(index, benchmarkFile, resultsDir, 'feat-A015-2026-09-29-1500'));
    const rr = run.summary.rerank;
    assert.equal(rr.mode, 'off', '未设 SANGO_RERANKER → off');
    assert.equal(rr.wired, false, '未注入打分器 → 未接入');
    assert.equal(rr.window, 50, '窗口回落默认 50');
    assert.equal(rr.maxTokens, 512, 'maxTokens 回落默认 512');
    assert.equal(rr.batch, 1, 'batch 回落默认 1');
    assert.equal(rr.intraThreads, null, 'intra 线程未设 → null');
    assert.equal(typeof run.summary.elapsedMs, 'number', 'elapsedMs 为数字');
    assert.ok(run.summary.elapsedMs > 0, 'elapsedMs 为正数');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('② 开重排 + 注入打分器 + 调参 env：mode=on / wired=true，窗口与调参取生效值', async () => {
  const scorer: RerankScorer = async (_query, passages) => passages.map(() => 0);
  const { dir, index, benchmarkFile, resultsDir } = fixture(scorer);
  try {
    const run = await withEnv(
      {
        SANGO_RERANKER: 'on',
        SANGO_RERANKER_WINDOW: '20',
        SANGO_RERANKER_MAX_TOKENS: '128',
        SANGO_RERANKER_BATCH: '16',
        SANGO_RERANKER_INTRA_THREADS: '8',
      },
      () => runBenchmark(index, benchmarkFile, resultsDir, 'feat-A015-2026-09-29-1501'),
    );
    const rr = run.summary.rerank;
    assert.equal(rr.mode, 'on', 'SANGO_RERANKER=on → on');
    assert.equal(rr.wired, true, '注入打分器 → 真实接入');
    assert.equal(rr.window, 20, '窗口取 SANGO_RERANKER_WINDOW 生效值');
    assert.equal(rr.maxTokens, 128, 'maxTokens 取生效值');
    assert.equal(rr.batch, 16, 'batch 取生效值');
    assert.equal(rr.intraThreads, 8, 'intra 线程取生效值');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('③ 开重排但权重缺失（装配层未注入打分器）：mode=on 但 wired=false（退回规则序），窗口仍如实', async () => {
  const { dir, index, benchmarkFile, resultsDir } = fixture(null);
  try {
    const run = await withEnv({ SANGO_RERANKER: 'on', SANGO_RERANKER_WINDOW: '20' }, () =>
      runBenchmark(index, benchmarkFile, resultsDir, 'feat-A015-2026-09-29-1502'),
    );
    assert.equal(run.summary.rerank.mode, 'on', '开关原始取值归一为 on');
    assert.equal(run.summary.rerank.wired, false, '权重缺失 → 未真正接入');
    assert.equal(run.summary.rerank.window, 20, '窗口仍如实落生效值');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('④ 非法取值归一：SANGO_RERANKER=ON（大写）按 off 处理', async () => {
  const { dir, index, benchmarkFile, resultsDir } = fixture(null);
  try {
    const run = await withEnv({ SANGO_RERANKER: 'ON' }, () =>
      runBenchmark(index, benchmarkFile, resultsDir, 'feat-A015-2026-09-29-1503'),
    );
    assert.equal(run.summary.rerank.mode, 'off', '非精确 on → off');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⑤ 快照落盘同构：JSON 里的 summary.rerank / elapsedMs 与本次返回一致', async () => {
  const scorer: RerankScorer = async (_query, passages) => passages.map(() => 0);
  const { dir, index, benchmarkFile, resultsDir } = fixture(scorer);
  try {
    const run = await withEnv({ SANGO_RERANKER: 'on' }, () =>
      runBenchmark(index, benchmarkFile, resultsDir, 'feat-A015-2026-09-29-1504'),
    );
    const raw = JSON.parse(readFileSync(path.join(resultsDir, `${run.runId}.json`), 'utf8')) as {
      summary: { rerank: unknown; elapsedMs: unknown };
    };
    assert.deepEqual(raw.summary.rerank, run.summary.rerank, '落盘 rerank 与返回一致');
    assert.equal(raw.summary.elapsedMs, run.summary.elapsedMs, '落盘 elapsedMs 与返回一致');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⑥ 老快照兼容（只增字段）：缺 rerank / elapsedMs 的快照仍可读回（前端显示「—」）', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'a015-legacy-'));
  try {
    const runId = 'feat-A015-2026-09-25-1200';
    writeFileSync(path.join(dir, `${runId}.json`), JSON.stringify({ summary: { tool: 'feat-A015-verify.mjs', total: 1 }, results: [] }), 'utf8');
    const snap = readSnapshot(dir, runId);
    assert.ok(snap, '老快照正常读回');
    assert.equal(snap.summary.rerank, undefined, '老快照无 rerank');
    assert.equal(snap.summary.elapsedMs, undefined, '老快照无 elapsedMs');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
