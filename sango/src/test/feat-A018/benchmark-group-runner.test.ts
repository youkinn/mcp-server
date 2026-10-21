/**
 * FEAT-A018 story-A018-03 活文档：组判分 runner（benchmark/group-runner.ts）——chunkIds 组判分语义、
 * 汇总 / cover@5、桥命中归因、快照落盘与环比。判分口径与 events-recall-probe.mjs 逐条同口径。
 * 契约：docs/feat-A018-eval-console-api.md §4-§5。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runGroupBenchmark } from '../../benchmark/group-runner.ts';
import { readSnapshot } from '../../benchmark/snapshot.ts';
import { makeRunId } from '../../benchmark/runner.ts';
import type { BenchmarkSet } from '../../benchmark/sets.ts';
import type { SangoIndex } from '../../search/sango-index.ts';

interface StubCase {
  /** 检索出参条目（仅取 id 排名；未出现的 chunkId 视为未进 50 路池）。 */
  entries: { chunk_id: string }[];
  eventHit: number;
  allusionHit: number;
}

/** 桩索引：按题面返回预设 entries + 诊断组命中数，确定性子集验证判分口径（不依赖真实语料 / 事件表）。 */
function stubIndex(cases: Record<string, StubCase>): SangoIndex {
  return {
    n: 10,
    search: async (query: string) => {
      const c = cases[query] ?? { entries: [], eventHit: 0, allusionHit: 0 };
      return {
        entries: c.entries,
        diagnostics: { eventHit: { groupCount: c.eventHit }, allusionHit: { groupCount: c.allusionHit } },
      };
    },
  } as unknown as SangoIndex;
}

/** 合成事件 / 典故组召回评测集 + 注册表条目（events 集）。 */
function fixture(rows: unknown[], cases: Record<string, StubCase>): { dir: string; set: BenchmarkSet; index: SangoIndex } {
  const dir = mkdtempSync(path.join(tmpdir(), 'a018-group-'));
  const evalFile = path.join(dir, 'eval-set.json');
  writeFileSync(
    evalFile,
    JSON.stringify({ meta: { schemaVersion: 1, generatedAt: '2026-10-10T00:00:00.000Z', total: rows.length }, rows }),
    'utf8',
  );
  const set: BenchmarkSet = {
    id: 'events',
    name: '事件 / 典故组召回（组判分）',
    file: evalFile,
    judge: 'group',
    resultsDir: path.join(dir, 'results'),
    runIdPrefix: 'feat-A018',
    withSeconds: true,
  };
  return { dir, set, index: stubIndex(cases) };
}

const row = (id: string, category: string, question: string, chunkIds: string[], segCount = chunkIds.length, crossChapter = false) => ({
  id,
  category,
  question,
  chunkIds,
  segCount,
  crossChapter,
});

/** entries：按 0 基位置放置指定 id（rank = 位置 + 1）；未指定处用无关 id 填充。 */
function entries(placed: { chunk_id: string; rank: number }[], total: number): { chunk_id: string }[] {
  const list: { chunk_id: string }[] = [];
  for (let i = 0; i < total; i++) list.push({ chunk_id: `x${String(i).padStart(3, '0')}` });
  for (const p of placed) list[p.rank - 1] = { chunk_id: p.chunk_id };
  return list;
}

test('① 判分语义：hit5 / hit10 / hit50 / miss + 桥命中归因 + byCategory / byBucket / cover5', async () => {
  const rows = [
    row('L1#E00101', 'L1', 'Q1', ['a:c1', 'a:c2']),
    row('L1#E00102', 'L1', 'Q2', ['a:c3']),
    row('L2#E00201', 'L2', 'Q3', ['a:c4', 'a:c5', 'a:c6', 'a:c7', 'a:c8', 'a:c9', 'a:c10', 'a:c11', 'a:c12', 'a:c13', 'a:c14'], 11, true),
    row('典故#AL0001', '典故', 'Q4', ['a:c15']),
  ];
  const cases: Record<string, StubCase> = {
    Q1: { entries: entries([{ chunk_id: 'a:c2', rank: 1 }], 4), eventHit: 1, allusionHit: 0 },
    Q2: { entries: entries([{ chunk_id: 'a:c3', rank: 8 }], 10), eventHit: 0, allusionHit: 0 },
    Q3: { entries: entries([{ chunk_id: 'a:c6', rank: 12 }], 12), eventHit: 0, allusionHit: 1 },
    Q4: { entries: [], eventHit: 0, allusionHit: 0 },
  };
  const { dir, set, index } = fixture(rows, cases);
  try {
    const run = await runGroupBenchmark(index, set, 'feat-A018-2026-10-10-163000', {});
    const byId = new Map(run.results.map((r) => [r.id, r]));
    const q1 = byId.get('L1#E00101')!;
    assert.equal(q1.status, 'hit5', '组内首段 rank1 → hit5');
    assert.equal(q1.firstRank, 1, 'firstRank = 组内最小排名');
    assert.equal(q1.hits5, 1, 'top5 命中组内段数（c2 rank1；c1 未进池）');
    assert.equal(q1.hits10, 1);
    assert.equal(q1.bridgeHit, true, 'eventHit 组命中 → 桥命中');
    assert.equal(q1.eventBridgeHit, true, 'eventHit 组命中 → 事件桥命中');
    assert.equal(q1.allusionBridgeHit, false, 'allusionHit=0 → 典故桥未命中');
    assert.equal(q1.crossChapter, false);
    assert.deepEqual(q1.poolIds, ['a:c2', 'x001', 'x002', 'x003'], 'poolIds = 池内有序 id（下标 +1 即名次）');
    const q2 = byId.get('L1#E00102')!;
    assert.equal(q2.status, 'hit10', '组内首段 rank8 → hit10');
    assert.equal(q2.bridgeHit, false, 'eventHit=0 → 桥未命中');
    assert.equal(q2.eventBridgeHit, false);
    assert.equal(q2.allusionBridgeHit, false);
    const q3 = byId.get('L2#E00201')!;
    assert.equal(q3.status, 'hit50', '组内首段 rank12 → hit50');
    assert.equal(q3.bridgeHit, true, 'allusionHit 组命中 → 桥命中');
    assert.equal(q3.eventBridgeHit, false, 'eventHit=0 → 事件桥未命中');
    assert.equal(q3.allusionBridgeHit, true, 'allusionHit 组命中 → 典故桥命中');
    assert.equal(q3.crossChapter, true);
    const q4 = byId.get('典故#AL0001')!;
    assert.equal(q4.status, 'miss', '未进池 → miss');
    assert.equal(q4.firstRank, 0, '未进返回窗口 → firstRank 0');
    assert.equal(q4.hit5, false);
    assert.equal(q4.hit10, false);
    assert.equal(q4.hit50, false);
    assert.equal(q4.bridgeHit, false);
    assert.equal(q4.eventBridgeHit, false);
    assert.equal(q4.allusionBridgeHit, false);
    assert.deepEqual(q4.top10Ids, [], '无候选 → top10Ids 空');
    assert.deepEqual(q4.poolIds, [], '无候选 → poolIds 空');

    const s = run.summary;
    assert.equal(s.total, 4);
    assert.equal(s.hit5, 1, 'hit5 = 组内首段 1-5 题数');
    assert.equal(s.hit10, 2, 'hit10 = 组内首段 1-10 题数（Q1+Q2）');
    assert.equal(s.hit50, 3, 'hit50 = 组内首段进 50 池（Q1+Q2+Q3）');
    assert.equal(s.miss, 1, '未进池题数');
    assert.equal(s.eventBridge, 1, '事件桥命中题数（Q1）');
    assert.equal(s.allusionBridge, 1, '典故桥命中题数（Q3）');
    assert.equal(s.noBridge, 2, '桥未命中题数（Q2+Q4）');
    assert.equal(s.missNoBridge, 1, '未进池且桥未命中（Q4）');
    assert.equal(s.dropped, 0, '无桥命中但掉窗');
    assert.equal(s.sumHits5, 1, 'cover@5 分子 = Σhits5');
    assert.equal(s.sumCap5, 9, 'cover@5 分母 = Σmin(5, segCount) = 2+1+5+1');
    assert.equal(s.cover5, 1 / 9, 'cover@5 全口径');
    assert.equal(s.hit10Rate, 2 / 4, 'hit10 通过率');

    assert.equal(s.byCategory['L1'].total, 2, '类别 L1 计数');
    assert.equal(s.byCategory['L1'].cover5, 1 / 3, 'L1 cover@5 = 1/(2+1)');
    assert.equal(s.byCategory['典故'].missNoBridge, 1, '典故 未进池且桥未命中');
    assert.equal(s.byBucket['单段'].total, 2, '单段分档含 Q2 / Q4');
    assert.equal(s.byBucket['大组(>10)'].total, 1, '大组分档含 Q3');
    assert.equal(s.judge, 'group');
    assert.equal(s.setId, 'events');
    assert.equal(s.benchmark, set.file);
    assert.equal(s.runId, 'feat-A018-2026-10-10-163000');
    assert.equal(typeof s.elapsedMs, 'number');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('② cover@5 累计口径 + 并池后掉窗（dropped）归因', async () => {
  const rows = [
    row('L1#E0101', 'L1', 'C1', ['a:c1', 'a:c2', 'a:c3']),
    row('L2#E0201', 'L2', 'C2', ['a:c4', 'a:c5', 'a:c6', 'a:c7', 'a:c8', 'a:c9']),
    row('L2#E0202', 'L2', 'C3', ['a:c7']),
  ];
  const cases: Record<string, StubCase> = {
    C1: { entries: entries([{ chunk_id: 'a:c1', rank: 1 }, { chunk_id: 'a:c2', rank: 2 }, { chunk_id: 'a:c3', rank: 3 }], 3), eventHit: 1, allusionHit: 0 },
    C2: { entries: entries([{ chunk_id: 'a:c4', rank: 1 }, { chunk_id: 'a:c5', rank: 2 }, { chunk_id: 'a:c6', rank: 3 }, { chunk_id: 'a:c7', rank: 4 }], 4), eventHit: 0, allusionHit: 0 },
    C3: { entries: [], eventHit: 1, allusionHit: 0 },
  };
  const { dir, set, index } = fixture(rows, cases);
  try {
    const run = await runGroupBenchmark(index, set, 'feat-A018-2026-10-10-163100', {});
    const byId = new Map(run.results.map((r) => [r.id, r]));
    assert.equal(byId.get('L1#E0101')!.hits5, 3, '组内 3 段全进 top5');
    assert.equal(byId.get('L2#E0201')!.hits5, 4, 'top5 命中 4 段（组 6 段，分母取 5）');
    const c3 = byId.get('L2#E0202')!;
    assert.equal(c3.status, 'miss');
    assert.equal(c3.bridgeHit, true, '桥命中但未进池');
    assert.equal(c3.eventBridgeHit, true, 'C3 事件桥命中');
    assert.equal(c3.allusionBridgeHit, false, 'C3 典故桥未命中');
    const s = run.summary;
    assert.equal(s.sumHits5, 7, 'Σhits5 = 3+4+0');
    assert.equal(s.sumCap5, 9, 'Σmin(5, segCount) = 3+5+1');
    assert.equal(s.cover5, 7 / 9);
    assert.equal(s.dropped, 1, '桥命中但掉窗 1 题');
    assert.equal(s.missNoBridge, 0);
    assert.equal(s.noBridge, 1, '桥未命中但常规三路召回进窗（C2）计入 noBridge');
    assert.equal(s.eventBridge, 2, '事件桥命中题数（C1+C3）');
    assert.equal(s.allusionBridge, 0, '无典故桥命中');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('③ 快照落盘与读回：JSON 顶层 { summary, results }、summary.md、runId 前缀区分评测集', async () => {
  const rows = [row('L1#E0101', 'L1', 'C1', ['a:c1'])];
  const cases: Record<string, StubCase> = { C1: { entries: [{ chunk_id: 'a:c1' }], eventHit: 0, allusionHit: 0 } };
  const { dir, set, index } = fixture(rows, cases);
  try {
    const runId = 'feat-A018-2026-10-10-163200';
    const run = await runGroupBenchmark(index, set, runId, {});
    const json = JSON.parse(readFileSync(path.join(set.resultsDir, `${runId}.json`), 'utf8')) as {
      summary: Record<string, unknown>;
      results: unknown[];
    };
    assert.deepEqual(Object.keys(json).sort(), ['results', 'summary'], '顶层 = { summary, results }（与锚集同信封）');
    assert.equal(json.summary.judge, 'group');
    assert.equal(json.results.length, 1);
    assert.ok(run.summary.compare === null, '首跑无上一份快照 → compare=null');
    assert.ok(readFileSync(path.join(set.resultsDir, `${runId}-summary.md`), 'utf8').includes('# 事件 / 典故组召回评测快照'), '组集 summary.md 落盘');
    const snap = readSnapshot(set.resultsDir, runId);
    assert.ok(snap, 'readSnapshot 可读回组集快照');
    assert.equal(snap!.runId, runId);
    assert.equal((snap!.summary as unknown as { cover5: number }).cover5, run.summary.cover5, '读回与本次返回同构');
    assert.equal(snap!.results.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('④ 环比上一份该集快照：档位降级 = 退化、升级 = 改善（同档位内 firstRank 变化不计）', async () => {
  const rows = [
    row('L1#E0101', 'L1', 'C1', ['a:c1']),
    row('L2#E0201', 'L2', 'C2', ['a:c2']),
    row('典故#AL0001', '典故', 'C3', ['a:c3']),
  ];
  const firstCases: Record<string, StubCase> = {
    C1: { entries: [{ chunk_id: 'a:c1' }], eventHit: 0, allusionHit: 0 },
    C2: { entries: [{ chunk_id: 'a:c2' }], eventHit: 0, allusionHit: 0 },
    C3: { entries: [], eventHit: 0, allusionHit: 0 },
  };
  const { dir, set } = fixture(rows, firstCases);
  try {
    await runGroupBenchmark(stubIndex(firstCases), set, 'feat-A018-2026-10-10-163300', {});
    // 二跑：C1 退化（hit5→miss）、C2 同档位 rank 变化（1→3，不计）、C3 改善（miss→hit5）。
    const secondCases: Record<string, StubCase> = {
      C1: { entries: [], eventHit: 0, allusionHit: 0 },
      C2: { entries: entries([{ chunk_id: 'a:c2', rank: 3 }], 3), eventHit: 0, allusionHit: 0 },
      C3: { entries: [{ chunk_id: 'a:c3' }], eventHit: 0, allusionHit: 0 },
    };
    const run2 = await runGroupBenchmark(stubIndex(secondCases), set, 'feat-A018-2026-10-10-163301', {});
    const c = run2.summary.compare;
    assert.ok(c, '有上一份快照 → compare 非空');
    assert.equal(c!.prevFile, 'feat-A018-2026-10-10-163300');
    assert.deepEqual(c!.regressed, [{ id: 'L1#E0101', question: 'C1', from: 'hit5@1', to: 'miss@0' }], 'C1 档位降级 → 退化');
    assert.deepEqual(c!.improved, [{ id: '典故#AL0001', question: 'C3', from: 'miss@0', to: 'hit5@1' }], 'C3 档位升级 → 改善');
    assert.equal(c!.regressed.some((x) => x.id === 'L2#E0201'), false, '同档位 firstRank 变化不计');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⑤ makeRunId：events 集 runId 带秒（feat-A018-HHMMSS），standard 集沿用 HHMM', () => {
  const d = new Date(2026, 9, 10, 16, 30, 42);
  assert.equal(makeRunId('feat-A018', true, d), 'feat-A018-2026-10-10-163042', '组集 runId 秒级粒度');
  assert.equal(makeRunId('feat-A015', false, d), 'feat-A015-2026-10-10-1630', '锚集 runId 分钟粒度（沿用 A015）');
});
