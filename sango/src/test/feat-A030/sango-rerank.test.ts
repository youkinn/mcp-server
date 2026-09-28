/**
 * FEAT-A030 活文档：cross-encoder 重排接入（规则重排后 top50 → 重排 → 返回 limit；保证区置顶段不参与）。
 * 契约：requirements/feat-A030-reranker.md（验收 1-6）、docs/feat-A018-event-table-interface.md §3.3⑤。
 *
 * 本文件用「注入打分器」验证接线与窗口语义（确定性、不依赖 ~266MB 权重，任意环境可跑）；
 * 真实 bge-reranker-base 的定点（华雄 / 刘备）不倒车与延迟 P50/P95 由 scripts/verify-rerank.mjs 出报告。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SangoIndex, resolveRerankScorer } from '../../search/sango-index.ts';
import type { RerankScorer } from '../../search/reranker.ts';
import type { RetrievalDiagnostics } from '../../types.ts';

const CHUNK_COUNT = 60;
const Q_RULE = '战况';
const Q_L3 = '甲甲之死战况';
const PIN_ID = 'sanguo-yanyi:0001:c0006';

/** 合成语料：CHUNK_COUNT 段同题（均含「甲甲」「战况」），「战况」词频随段号递减形成唯一规则序。 */
function writeCorpus(dir: string, withL3 = false): void {
  const corpusDir = path.join(dir, 'corpus', 'sanguo-yanyi');
  mkdirSync(corpusDir, { recursive: true });
  const chunks = [];
  for (let i = 1; i <= CHUNK_COUNT; i++) {
    const repeats = '战况'.repeat(CHUNK_COUNT - i + 1);
    chunks.push({
      id: `sanguo-yanyi:0001:c${String(i).padStart(4, '0')}`,
      text: `第${i}阵甲甲甲甲。${repeats}标记K${i}。`,
      type: 'narration',
      segFrom: i,
      segTo: i,
      quoteBalanced: true,
      quotes: [],
    });
  }
  writeFileSync(
    path.join(corpusDir, '001.json'),
    JSON.stringify({ source: 'sanguo-yanyi', chapter: 1, title: '第一回 合成', chunks }),
    'utf8',
  );
  if (withL3) {
    writeFileSync(
      path.join(dir, 'corpus', 'events.json'),
      JSON.stringify({
        meta: { schemaVersion: 1, normVersion: 'cafe0001', generatedAt: '2026-09-28T00:00:00.000Z', corpusChunkCount: CHUNK_COUNT },
        rows: [{ eventId: 'E90001', eventName: '甲甲之死', aliases: ['甲甲之死'], chunkIds: [PIN_ID], type: 'L3' }],
      }),
      'utf8',
    );
  }
}

function tempDir(withL3 = false): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'a030-ix-'));
  writeCorpus(dir, withL3);
  return dir;
}

function load(dir: string, rerankScorer: RerankScorer | null): SangoIndex {
  const index = new SangoIndex(dir, { rerankScorer });
  index.load();
  return index;
}

/** 规则序（无重排基线）出参 id：limit 给满即可读回整池顺序。 */
async function ruleOrder(dir: string, query: string, limit = CHUNK_COUNT): Promise<string[]> {
  const base = load(dir, null);
  return (await base.search(query, limit)).entries.map((e) => e.id);
}

test('① 50→10（§3.3⑤）：规则序 top50 进 cross-encoder，窗内重排后取 limit 10，窗外候选高分也不进窗', async () => {
  const dir = tempDir();
  try {
    const rule = await ruleOrder(dir, Q_RULE);
    assert.equal(rule.length, CHUNK_COUNT, '规则序 60 段（候选池 = 全部词法命中）');

    // 打分器按「进入窗口的次序」给分：规则序第 3 位给 100、第 50 位给 90（都在 50 路窗内）。
    const scorer: RerankScorer = async (_q, passages) => passages.map((_p, i) => (i === 2 ? 100 : i === 49 ? 90 : 0));
    const index = load(dir, scorer);
    const { entries } = await index.search(Q_RULE, 10);

    assert.equal(entries.length, 10, '返回 limit=10');
    assert.equal(entries[0].id, rule[2], '窗内低规则序候选被重排抬到 rank1');
    assert.equal(entries[1].id, rule[49], '窗口内最后一位（规则序第 50）参与重排');
    assert.equal(entries[2].id, rule[0], '其余候选同分保持规则序（稳定排序）');
    assert.ok(!entries.some((e) => e.id === rule[54]), '规则序第 55 位在 50 路窗外，评分再高也不进窗');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('② 输出顺序与诊断一致（可读证）：出参序 = candidates 池序前 limit，candidates.rank 连续', async () => {
  const dir = tempDir();
  try {
    const rule = await ruleOrder(dir, Q_RULE);
    const scorer: RerankScorer = async (_q, passages) => passages.map((_p, i) => (i % 7) + 1);
    const index = load(dir, scorer);
    const { entries, diagnostics } = await index.search(Q_RULE, 10, { diagnostics: true });
    const d = diagnostics as RetrievalDiagnostics;

    assert.ok(d);
    assert.notEqual(entries[0].id, rule[0], '重排确实改变了规则序首位（否则下面的等式恒真）');
    assert.deepEqual(
      entries.map((e) => e.id),
      d.candidates.slice(0, 10).map((c) => c.chunkId),
      '出参序 = 诊断候选池序前 limit（同序可读证）',
    );
    assert.deepEqual(d.candidates.map((c) => c.rank), d.candidates.map((_c, i) => i + 1), 'candidates.rank 连续 1..N');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('③ 保证区置顶段不参与重排（§3.3②/⑤）：L3 锚点段低分仍占 rank1、不进 cross-encoder 输入', async () => {
  const dir = tempDir(true);
  try {
    const rule = await ruleOrder(dir, Q_L3, 10);
    assert.equal(rule[0], PIN_ID, 'L3 锚点段规则序已在保证区 rank1');

    const seen: string[][] = [];
    const scorer: RerankScorer = async (_q, passages) => {
      seen.push(passages);
      return passages.map(() => -999);
    };
    const index = load(dir, scorer);
    const { entries, diagnostics } = await index.search(Q_L3, 10, { diagnostics: true });

    assert.equal(entries[0].id, PIN_ID, '置顶段即使被打 -999 分仍占 rank1（保证区不参与重排）');
    assert.equal((diagnostics as RetrievalDiagnostics).candidates[0].chunkId, PIN_ID);
    assert.equal(seen.length, 1, '打分器只调用一次');
    assert.ok(!seen[0].some((t) => t.includes('标记K6')), 'L3 锚点段文本不进入 cross-encoder 输入');
    assert.equal(seen[0].length, 49, '窗口 50 路减保证区置顶 1 段 = 49 条参与重排');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('④ 延迟计时：重排在检索关键路径内（注入 40ms 打分器 → 检索总耗时含该段延迟）', async () => {
  const dir = tempDir();
  try {
    const slow: RerankScorer = async (_q, passages) => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return passages.map(() => 0);
    };
    const withRerank = load(dir, slow);
    const noRerank = load(dir, null);
    await noRerank.search(Q_RULE, 10); // 预热（索引 / JIT）
    await withRerank.search(Q_RULE, 10);

    const t0 = performance.now();
    await withRerank.search(Q_RULE, 10);
    const rerankMs = performance.now() - t0;
    const t1 = performance.now();
    await noRerank.search(Q_RULE, 10);
    const plainMs = performance.now() - t1;

    assert.ok(rerankMs - plainMs >= 25, `重排阶段延迟计入检索总耗时（重排 ${rerankMs.toFixed(1)}ms vs 无重排 ${plainMs.toFixed(1)}ms）`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⑤ 重排不可用降级：打分器返回 null 时保持规则序、不抛异常（不 mock、不伪造分数）', async () => {
  const dir = tempDir();
  try {
    const rule = await ruleOrder(dir, Q_RULE, 10);
    const index = load(dir, async () => null);
    const { entries } = await index.search(Q_RULE, 10);
    assert.deepEqual(entries.map((e) => e.id), rule, '重排不可用 → 出参与无重排基线逐条一致');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⑥ 诊断可观测（生效）：applied=true、reason=null、窗口/参与/跳过置顶与 timing.rerank 读数正确', async () => {
  const dir = tempDir();
  try {
    const scorer: RerankScorer = async (_q, passages) => passages.map((_p, i) => i);
    const index = load(dir, scorer);
    const { diagnostics } = await index.search(Q_RULE, 10, { diagnostics: true });
    const d = diagnostics as RetrievalDiagnostics;
    assert.ok(d);
    assert.deepEqual(
      d.rerank,
      {
        enabled: true,
        window: 50,
        considered: 50,
        skippedPinned: 0,
        applied: true,
        reason: null,
      },
      '生效：整窗 50 条非保证区全部参与并改写池序',
    );
    assert.ok(
      typeof d.timing.rerank === 'number' && Number.isFinite(d.timing.rerank) && d.timing.rerank >= 0,
      `接入打分器 → timing.rerank 非负数字（实际 ${String(d.timing.rerank)}）`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⑦ 保证区整窗跳过（§3.3②/⑤）：窗口全为置顶段 → 不调打分器、reason=窗口内无参与候选、skippedPinned=窗口', async () => {
  const dir = tempDir(true);
  const prev = process.env.SANGO_RERANKER_WINDOW;
  process.env.SANGO_RERANKER_WINDOW = '1';
  try {
    const seen: string[][] = [];
    const scorer: RerankScorer = async (_q, passages) => {
      seen.push(passages);
      return passages.map(() => 0);
    };
    const index = load(dir, scorer);
    const { entries, diagnostics } = await index.search(Q_L3, 10, { diagnostics: true });
    const d = diagnostics as RetrievalDiagnostics;
    assert.ok(d);
    assert.deepEqual(
      d.rerank,
      {
        enabled: true,
        window: 1,
        considered: 0,
        skippedPinned: 1,
        applied: false,
        reason: '窗口内无参与候选',
      },
      '窗口 1 全为 L3 保证区 → 跳过重排',
    );
    assert.equal(entries[0].id, PIN_ID, '跳过重排 → 规则序保持（保证区置顶段 rank1）');
    assert.equal(seen.length, 0, '窗口内无参与候选 → 打分器不被调用');
    assert.equal(d.timing.rerank, null, '重排段未执行 → timing.rerank null');
  } finally {
    if (prev === undefined) delete process.env.SANGO_RERANKER_WINDOW;
    else process.env.SANGO_RERANKER_WINDOW = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⑧ 打分器抛错降级：applied=false、reason=重排打分异常、退回规则序、不抛错', async () => {
  const dir = tempDir();
  try {
    const rule = await ruleOrder(dir, Q_RULE, 10);
    const index = load(
      dir,
      async () => {
        throw new Error('boom');
      },
    );
    const { entries, diagnostics } = await index.search(Q_RULE, 10, { diagnostics: true });
    const d = diagnostics as RetrievalDiagnostics;
    assert.deepEqual(entries.map((e) => e.id), rule, '打分异常 → 出参与无重排基线逐条一致');
    assert.ok(d);
    assert.equal(d.rerank.applied, false);
    assert.equal(d.rerank.reason, '重排打分异常');
    assert.equal(d.rerank.considered, 50);
    assert.ok(typeof d.timing.rerank === 'number' && d.timing.rerank >= 0, '打分异常也计入重排段耗时');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⑨ 分数长度非法降级：applied=false、reason=重排分数非法、退回规则序', async () => {
  const dir = tempDir();
  try {
    const rule = await ruleOrder(dir, Q_RULE, 10);
    const index = load(dir, async () => [1, 2, 3]); // 长度 3 ≠ 参与条数 50
    const { entries, diagnostics } = await index.search(Q_RULE, 10, { diagnostics: true });
    const d = diagnostics as RetrievalDiagnostics;
    assert.deepEqual(entries.map((e) => e.id), rule, '分数非法 → 出参与无重排基线逐条一致');
    assert.ok(d);
    assert.equal(d.rerank.applied, false);
    assert.equal(d.rerank.reason, '重排分数非法');
    assert.ok(typeof d.timing.rerank === 'number' && d.timing.rerank >= 0, '分数非法也计入重排段耗时');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⑩ 重排开关（装配层）：未设 / off / on 三态解析', async () => {
  const prevMode = process.env.SANGO_RERANKER;
  const prevDir = process.env.SANGO_RERANKER_DIR;
  try {
    delete process.env.SANGO_RERANKER;
    assert.equal(resolveRerankScorer(), null, '未设 → 不接入（默认行为与现状一致）');

    process.env.SANGO_RERANKER = 'off';
    assert.equal(resolveRerankScorer(), null, 'off → 不接入');

    process.env.SANGO_RERANKER = 'on';
    process.env.SANGO_RERANKER_DIR = path.join(tmpdir(), 'no-such-rerank-dir');
    assert.equal(resolveRerankScorer(), null, 'on + 权重目录不存在 → 权重缺失不接入（不抛错）');
  } finally {
    if (prevMode === undefined) delete process.env.SANGO_RERANKER;
    else process.env.SANGO_RERANKER = prevMode;
    if (prevDir === undefined) delete process.env.SANGO_RERANKER_DIR;
    else process.env.SANGO_RERANKER_DIR = prevDir;
  }
});

test('⑪ 重排开关：on 但权重缺失 → 装配层不接入，检索诊断 reason 如实写明', async () => {
  const dir = tempDir();
  const prevMode = process.env.SANGO_RERANKER;
  const prevDir = process.env.SANGO_RERANKER_DIR;
  try {
    process.env.SANGO_RERANKER = 'on';
    process.env.SANGO_RERANKER_DIR = path.join(tmpdir(), 'no-such-rerank-dir');
    // 模拟装配层（src/index.ts）决策：on → resolveRerankScorer()；null → 不注入
    const scorer = resolveRerankScorer(dir);
    const index = new SangoIndex(dir, scorer ? { rerankScorer: scorer } : {});
    index.load();
    const { diagnostics } = await index.search(Q_RULE, 10, { diagnostics: true });
    const d = diagnostics as RetrievalDiagnostics;
    assert.ok(d);
    assert.equal(d.rerank.enabled, false, 'on 但权重缺失 → 实际未接入打分器');
    assert.equal(d.rerank.reason, '未接入重排打分器', '未接入原因如实写入诊断');
    assert.equal(d.timing.rerank, null, '未接入 → 重排段耗时 null');
  } finally {
    if (prevMode === undefined) delete process.env.SANGO_RERANKER;
    else process.env.SANGO_RERANKER = prevMode;
    if (prevDir === undefined) delete process.env.SANGO_RERANKER_DIR;
    else process.env.SANGO_RERANKER_DIR = prevDir;
  }
});
