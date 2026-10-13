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

/** bug-00052 夹具：2 题有锚 + 1 题零锚（evidence 仅回号引用「第73回」，无引号锚 / 回目锚）。 */
function fixtureWithNoAnchor(scorer: RerankScorer | null = null): Fixture {
  const dir = mkdtempSync(path.join(tmpdir(), 'a015-noanchor-'));
  const corpusDir = path.join(dir, 'corpus', 'sanguo-yanyi');
  mkdirSync(corpusDir, { recursive: true });
  const chunks = ['刘备字玄德，涿郡涿县人。', '曹操字孟德，沛国谯人。'].map((text, i) => ({
    id: `sanguo-yanyi:0001:c000${i + 1}`,
    text,
    type: 'narration',
    segFrom: i + 1,
    segTo: i + 1,
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
      '| 3 | 刘备的官职是什么 | 无明确记载 | 第73回 |',
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

test('⑦ bug-00052 零锚题：不参与判分、不进通过率分母；结果标记 noAnchor、不记 miss', async () => {
  const { dir, index, benchmarkFile, resultsDir } = fixtureWithNoAnchor(null);
  try {
    const run = await withEnv({}, () => runBenchmark(index, benchmarkFile, resultsDir, 'feat-A015-2026-09-30-1000'));
    const s = run.summary;
    const na = run.results.find((r) => r.id === '人物#3');
    assert.ok(na, '零锚题在结果中');
    assert.equal(na.noAnchor, true, '零锚题标记 noAnchor');
    assert.equal(na.status, 'noAnchor', '零锚题状态为 noAnchor 而非 miss');
    assert.equal(na.rank, 0, '零锚题不判分 → rank 0');
    assert.equal(s.total, 3, 'total 仍含零锚题');
    assert.equal(s.noAnchorCount, 1, 'noAnchorCount 统计零锚题');
    assert.deepEqual(s.noAnchor, ['人物#3'], 'summary.noAnchor 单列零锚题 id');
    assert.equal(s.judged, 2, 'judged = total - noAnchorCount');
    assert.equal(s.top5 + s.tail + s.miss, s.judged, 'top5+tail+miss 合计 = judged（零锚不进分母）');
    for (const r of run.results) {
      if (r.id !== '人物#3') assert.equal(r.noAnchor, false, '有锚题 noAnchor=false');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * bug-00063 夹具：4 回归档（ch1/ch2/ch3 各 2 段、ch4 1 段）+ 注入打分器按问题指定候选次序，
 * 使 chapterRank（取 entry.chapter 回目）可确定性断言——检索名次由打分器分数决定，不依赖真实召回。
 */
function fixtureChapter(): Fixture {
  const dir = mkdtempSync(path.join(tmpdir(), 'a015-chrank-'));
  const corpusDir = path.join(dir, 'corpus', 'sanguo-yanyi');
  mkdirSync(corpusDir, { recursive: true });
  // 共享前缀：保证每题检索均召回全量候选，回级名次由注入打分器控序决定。
  const PRE = '三国人物 ';
  const chapters: { chapter: number; texts: string[] }[] = [
    { chapter: 1, texts: ['刘备字玄德，涿郡涿县人。', '关羽字云长，河东解良人。'] },
    { chapter: 2, texts: ['曹操字孟德，沛国谯人。', '夏侯惇字元让，沛国谯人。'] },
    { chapter: 3, texts: ['孙权字仲谋，吴郡富春人。', '周瑜字公瑾，庐江舒县人。'] },
    { chapter: 4, texts: ['诸葛亮字孔明，琅琊阳都人。'] },
  ];
  for (const ch of chapters) {
    const chunks = ch.texts.map((text, i) => ({
      id: `sanguo-yanyi:000${ch.chapter}:c000${i + 1}`,
      text: PRE + text,
      type: 'narration',
      segFrom: i + 1,
      segTo: i + 1,
    }));
    writeFileSync(path.join(corpusDir, `00${ch.chapter}.json`), JSON.stringify({ source: 'sanguo-yanyi', chapter: ch.chapter, title: `第${ch.chapter}回 合成`, chunks }), 'utf8');
  }
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
      '| 1 | 三国人物 曹操字孟德 是谁 | 曹操 | 第2回：“曹操字孟德” |',
      '| 2 | 三国人物 关羽字云长 孙权字仲谋 | 孙权 | 第1回：“刘备字玄德”。第3回：“孙权字仲谋” |',
      '| 3 | 三国人物 刘备字玄德 官职 | 刘备 | 第9回：“刘备字玄德” |',
      '| 4 | 三国人物 零锚 | 无明确记载 | 无明确记载 |',
      '',
      '## 二、典故',
      '',
      '| # | 问题 | 标准答案 | 证据 |',
      '|---|---|---|---|',
      '| 5 | 三国人物 回级过五 | 诸葛亮 | 第4回：“诸葛亮字孔明” |',
    ].join('\n'),
    'utf8',
  );
  // 按问题给出期望候选文本次序（未列出者排在其后），控制各题检索名次。
  const ORDER: Record<string, string[]> = {
    '三国人物 曹操字孟德 是谁': [PRE + '曹操字孟德，沛国谯人。'],
    '三国人物 关羽字云长 孙权字仲谋': [PRE + '关羽字云长，河东解良人。', PRE + '孙权字仲谋，吴郡富春人。'],
    '三国人物 回级过五': [PRE + '曹操字孟德，沛国谯人。', PRE + '夏侯惇字元让，沛国谯人。', PRE + '孙权字仲谋，吴郡富春人。', PRE + '周瑜字公瑾，庐江舒县人。', PRE + '关羽字云长，河东解良人。', PRE + '诸葛亮字孔明，琅琊阳都人。'],
  };
  const scorer: RerankScorer = async (query, passages) => {
    const want = ORDER[query] ?? [];
    return passages.map((t) => {
      const i = want.indexOf(t);
      return i < 0 ? -1 : want.length - i;
    });
  };
  const index = new SangoIndex(dir, { rerankScorer: scorer });
  index.load();
  return { dir, index, benchmarkFile, resultsDir: path.join(dir, 'results') };
}

test('⑧ bug-00063 回级维度：单回命中 / 多回取最早 / 回不在池 = 0 / noAnchor = 0', async () => {
  const { dir, index, benchmarkFile, resultsDir } = fixtureChapter();
  try {
    const run = await runBenchmark(index, benchmarkFile, resultsDir, 'feat-A015-2026-10-13-1200');
    const by = (id: string) => run.results.find((r) => r.id === id);
    const q1 = by('人物#1');
    const q2 = by('人物#2');
    const q3 = by('人物#3');
    const q4 = by('人物#4');
    const q5 = by('典故#5');
    assert.ok(q1 && q2 && q3 && q4 && q5, '五题均在结果中');
    assert.equal(q1!.chapterRank, 1, '单回命中：期望回目第 2 回在候选第 1 名 → 1');
    assert.equal(q2!.chapterRank, 1, '多回取最早：期望回目 {1,3} 最早命中在第 1 名 → 1');
    assert.equal(q2!.rank, 2, 'rank 语义不变：证据段（第 3 回）在第 2 名 → rank 2');
    assert.equal(q3!.chapterRank, 0, '回不在池：期望回目第 9 回未出现 → 0');
    assert.equal(q4!.noAnchor, true, '零锚题标记 noAnchor');
    assert.equal(q4!.chapterRank, 0, 'noAnchor 不检索 → chapterRank 0');
    assert.equal(q5!.chapterRank, 6, '期望回目第 4 回在候选第 6 名 → 6');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⑨ bug-00063 回级汇总：chapterTop5 分类与合计口径（chapterRank∈[1,5]，noAnchor 与 >5 剔除）', async () => {
  const { dir, index, benchmarkFile, resultsDir } = fixtureChapter();
  try {
    const run = await runBenchmark(index, benchmarkFile, resultsDir, 'feat-A015-2026-10-13-1201');
    const s = run.summary;
    assert.equal(s.category['人物']!.chapterTop5, 2, '人物类回级命中 = 2（第 1、2 题）');
    assert.equal(s.category['典故']!.chapterTop5, 0, '典故类回级命中 = 0（第 6 名剔除）');
    assert.equal(s.chapterTop5, 2, '顶层回级命中 = 各分类合计 2');
    assert.equal(s.category['人物']!.total, 3, '类别 total 口径不变（noAnchor 不进类别计数）');
    assert.equal(s.top5 + s.tail + s.miss, s.judged, '既有判分口径不变');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
