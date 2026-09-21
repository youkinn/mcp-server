/**
 * feat-A009 活文档：检索诊断（召回可解释）产出。
 * 覆盖：search 返回 { entries, diagnostics } / 未请求不产诊断 / 诊断结构齐全（query/env/funnel/candidates/
 * nextRank/deathIntent）/ 漏斗管道约束 / 降级环境 / 死亡意图置顶 / 64KB 预算截断 / 工具层 traceId 透传回传
 * result._meta.diagnostics（content 契约零改动）/ 旁路（产出失败不影响 content）/ 候选命中的标签文本
 * （hitLabels：与 labelHit 自洽、标签表成员、双字词元求交，另用真实语料 data/corpus 核对一次）。
 * 夹具与 feat-A004 同源：4 chunk（第 1 回 1 个 / 第 73 回 3 个）、无向量文件（降级纯 BM25）、alias 5 条 / 2 PID。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { NO_HIT_TEXT, SangoIndex, enforceDiagnosticsBudget, roundGap } from '../../search/sango-index.ts';
import type { RetrievalDiagnostics } from '../../types.ts';
import { registerSangoNovelSearch } from '../../tools/sango-novel-search.ts';
import { tokenize } from '../../utils/text.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, '..', 'feat-A004', 'fixture');

function loadFixtureIndex(): SangoIndex {
  const index = new SangoIndex(FIXTURE_DIR);
  index.load();
  return index;
}

/** 标签表（chunkId → `|` 拆分后的原始标签数组，保序）：核对 hitLabels 必须是该 chunk 标签表成员。 */
function loadTagTable(tagsDir: string): Map<string, string[]> {
  const byChunk = new Map<string, string[]>();
  for (const file of ['duel.json', 'event.json', 'story.json']) {
    const filePath = path.join(tagsDir, file);
    if (!existsSync(filePath)) continue;
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, string>;
    for (const [chunkId, text] of Object.entries(parsed)) {
      const tags = text
        .split('|')
        .map((tag) => tag.trim())
        .filter((tag) => tag.length > 0);
      byChunk.set(chunkId, [...(byChunk.get(chunkId) ?? []), ...tags]);
    }
  }
  return byChunk;
}

/** 真实语料 / 标签目录（sango/data）：hitLabels 核对用，与夹具同一套判定口径。 */
const DATA_DIR = path.resolve(__dirname, '..', '..', '..', 'data');

type ToolArgs = { source: 'sanguo-yanyi' | 'sanguozhi'; query: string; limit: number };
type ToolResult = {
  content: Array<{ type: string; text: string }>;
  _meta?: { diagnostics?: RetrievalDiagnostics };
};
type ToolExtra = { _meta?: { traceId?: string } };

/** 截获 registerTool 注册的处理函数，直接调用工具层（不经 stdio）；extra 用于注入 _meta.traceId。 */
function captureTool(index: SangoIndex): {
  callTool: (args: ToolArgs, extra?: ToolExtra) => Promise<ToolResult>;
} {
  let handler: unknown;
  const fakeRegisterTool = ((_name: string, _config: unknown, cb: unknown) => {
    handler = cb;
  }) as unknown as McpServer['registerTool'];
  registerSangoNovelSearch(fakeRegisterTool, index);
  return { callTool: handler as (args: ToolArgs, extra?: ToolExtra) => Promise<ToolResult> };
}

test('① 未请求诊断（无 traceId / diagnostics 未开启）：search 返回 diagnostics=null，出参行为与 A004 一致', async () => {
  const index = loadFixtureIndex();
  const result = await index.search('关羽', 5);
  assert.equal(result.diagnostics, null);
  assert.ok(result.entries.length > 0);
  assert.deepEqual(
    Object.keys(result.entries[0]).sort(),
    ['chapter', 'id', 'quoteBalanced', 'quotes', 'segFrom', 'segTo', 'text', 'title', 'type'],
    'content 契约零改动（结构化条目字段不变）',
  );
});

test('② 请求诊断：结构字段齐全（truncated/truncatedCount/query/env/funnel/candidates/nextRank/deathIntent）', async () => {
  const index = loadFixtureIndex();
  const { diagnostics } = await index.search('关羽', 5, { diagnostics: true });
  assert.ok(diagnostics, '请求诊断时应产出');
  assert.equal(diagnostics.truncated, false);
  assert.equal(diagnostics.truncatedCount, 0);
  assert.deepEqual(Object.keys(diagnostics.query).sort(), ['normalized', 'raw', 'tokens']);
  assert.deepEqual(
    Object.keys(diagnostics.env).sort(),
    ['aliasCount', 'corpusChunks', 'degradedBm25Only', 'vectorDim', 'vectorScheme'],
  );
  assert.deepEqual(
    Object.keys(diagnostics.funnel).sort(),
    ['cited', 'corpusChunks', 'injected', 'labelHits', 'lexicalHits', 'mergedCandidates', 'topN', 'vectorTop50'],
  );
  assert.ok(Array.isArray(diagnostics.candidates));
  assert.deepEqual(
    Object.keys(diagnostics.deathIntent).sort(),
    ['chunkIds', 'detected', 'pinned'],
  );
  assert.deepEqual(Object.keys(diagnostics).sort(), ['candidates', 'deathIntent', 'env', 'funnel', 'nextRank', 'query', 'truncated', 'truncatedCount'], '诊断顶层字段齐全');
});

test('③ query 处理链：raw=入参、normalized=alias 归一化结果、tokens 非空（验收 9）', async () => {
  const index = loadFixtureIndex();
  const { diagnostics } = await index.search('云长', 5, { diagnostics: true });
  assert.ok(diagnostics);
  assert.equal(diagnostics.query.raw, '云长');
  assert.equal(diagnostics.query.normalized, '关羽', '云长 经别名归一化为规范名 关羽');
  assert.ok(Array.isArray(diagnostics.query.tokens) && diagnostics.query.tokens.length > 0);
});

test('④ 环境与降级：夹具无向量 → degradedBm25Only=true、vectorScheme/vectorDim 为 null、语料/alias 计数正确（验收 10）', async () => {
  const index = loadFixtureIndex();
  const { diagnostics } = await index.search('关羽', 5, { diagnostics: true });
  assert.ok(diagnostics);
  assert.equal(diagnostics.env.degradedBm25Only, true);
  assert.equal(diagnostics.env.vectorScheme, null);
  assert.equal(diagnostics.env.vectorDim, null);
  assert.equal(diagnostics.env.corpusChunks, 4);
  assert.equal(diagnostics.env.aliasCount, 5);
  assert.equal(diagnostics.funnel.corpusChunks, 4);
  assert.equal(diagnostics.funnel.vectorTop50, 0, '降级时向量路为 0');
});

test('⑤ 漏斗数字可核：mergedCandidates ≤ lexicalHits+vectorTop50+labelHits、topN ≤ mergedCandidates、topN=出参条数（验收 6）', async () => {
  const index = loadFixtureIndex();
  const { entries, diagnostics } = await index.search('关羽', 5, { diagnostics: true });
  assert.ok(diagnostics);
  assert.equal(diagnostics.funnel.topN, entries.length, 'topN=工具出参条数');
  assert.equal(diagnostics.funnel.mergedCandidates, 3, '关羽：词法 2 + 标签 1（关羽入川）合并去重 = 3');
  assert.ok(diagnostics.funnel.lexicalHits >= 1);
  assert.ok(diagnostics.funnel.mergedCandidates <= diagnostics.funnel.lexicalHits + diagnostics.funnel.vectorTop50 + diagnostics.funnel.labelHits);
  assert.ok(diagnostics.funnel.topN <= diagnostics.funnel.mergedCandidates);
  assert.equal(diagnostics.funnel.injected, null, '产出阶段占位 null');
  assert.equal(diagnostics.funnel.cited, null);
});

test('⑥ 候选分数表：字段齐全、按最终返回序、≤20 条、rank=1 与出参首条同 id（验收 7）', async () => {
  const index = loadFixtureIndex();
  const { entries, diagnostics } = await index.search('关羽', 5, { diagnostics: true });
  assert.ok(diagnostics);
  assert.ok(diagnostics.candidates.length <= 20);
  assert.ok(diagnostics.candidates.length > 0);
  const round3 = (v: number) => Math.round(v * 1000) / 1000;
  const tagsByChunk = loadTagTable(path.join(FIXTURE_DIR, 'corpus', 'tags'));
  diagnostics.candidates.forEach((c, i) => {
    assert.equal(c.rank, i + 1);
    assert.deepEqual(
      Object.keys(c).sort(),
      ['bm25', 'bm25Norm', 'chapter', 'chunkId', 'cited', 'cosine', 'finalScore', 'hitLabels', 'injected', 'labelHit', 'rank', 'sources', 'title'],
    );
    // bug-00013：cosine / bm25Norm 全精度，finalScore 可由接口字段逐条复算
    const recomputed = round3(0.3 * (c.bm25Norm ?? 0) + 0.6 * ((c.cosine ?? -1) + 1) / 2 + 0.1 * (c.labelHit ? 1 : 0));
    assert.equal(recomputed, c.finalScore, 'rank' + c.rank + ' 复算恒等式成立');
    // hitLabels 与 labelHit 自洽：命中 ⟺ 至少一个标签命中；未命中恒 []
    assert.equal(c.labelHit, c.hitLabels.length > 0, 'rank' + c.rank + ' hitLabels 与 labelHit 自洽');
    if (!c.labelHit) {
      assert.deepEqual(c.hitLabels, [], 'rank' + c.rank + ' 未命中标签的候选 hitLabels=[]');
    }
    // hitLabels 必须是该 chunk 标签表成员（原始文本，未被归一化改写），且不重复
    const chunkTags = tagsByChunk.get(c.chunkId) ?? [];
    assert.deepEqual([...new Set(c.hitLabels)], c.hitLabels, 'rank' + c.rank + ' hitLabels 无重复');
    for (const label of c.hitLabels) {
      assert.ok(chunkTags.includes(label), 'rank' + c.rank + ' hitLabels 项「' + label + '」必在该 chunk 标签表内');
    }
  });
  assert.equal(diagnostics.candidates[0].chunkId, entries[0].id, '候选表 rank=1 对应出参首条');
  assert.equal(diagnostics.candidates[0].rank, 1);
  for (let i = 1; i < diagnostics.candidates.length; i++) {
    assert.ok(diagnostics.candidates[i - 1].finalScore >= diagnostics.candidates[i].finalScore, '普通问法按 finalScore 降序');
  }
  // 夹具核对（tag: event.json）：query「关羽」→ 标签路由命中 3/3 chunk，hitLabels 逐条等于该 chunk 标签表中
  // 与 query 双字词元（关羽）相交的标签；c0003 带两条标签但只有「政治事件-关羽入川」命中（保序、只回命中项）。
  assert.deepEqual(
    diagnostics.candidates.map((c) => [c.chunkId, c.hitLabels]),
    [
      ['sanguo-yanyi:0073:c0001', ['人物之死-关羽之死']],
      ['sanguo-yanyi:0073:c0002', ['人物之死-关羽之死', '政治事件-关羽托孤']],
      ['sanguo-yanyi:0073:c0003', ['政治事件-关羽入川']],
    ],
    '命中标签逐条可读（夹具标签表 event.json 三条 chunk）',
  );
});

test('⑦ 第 N+1 名：limit=1 时 nextRank=rank2 且 gapToTopN≥0；候选不足（limit≥候选数）时 nextRank=null（验收 4/8）', async () => {
  const index = loadFixtureIndex();
  const r1 = await index.search('关羽', 1, { diagnostics: true });
  assert.ok(r1.diagnostics);
  assert.equal(r1.entries.length, 1);
  assert.ok(r1.diagnostics.nextRank, 'limit=1 候选 3 条 → 有第 2 名');
  assert.equal(r1.diagnostics.nextRank!.rank, 2);
  assert.ok(r1.diagnostics.nextRank!.gapToTopN! >= 0);
  const r5 = await index.search('关羽', 5, { diagnostics: true });
  assert.ok(r5.diagnostics);
  assert.equal(r5.diagnostics.nextRank, null, '候选 3 条 ≤ limit 5 → 无第 4 名');
});

test('⑧ 死亡意图：非死亡问法 detected=false；死亡问法 detected=true、chunkIds=置顶候选、pinned=true（验收 10）', async () => {
  const index = loadFixtureIndex();
  const normal = await index.search('关羽镇守荆州', 5, { diagnostics: true });
  assert.ok(normal.diagnostics);
  assert.equal(normal.diagnostics.deathIntent.detected, false);
  assert.equal(normal.diagnostics.deathIntent.pinned, false);
  assert.deepEqual(normal.diagnostics.deathIntent.chunkIds, []);

  const death = await index.search('关羽是怎么死的', 5, { diagnostics: true });
  assert.ok(death.diagnostics);
  assert.equal(death.diagnostics.deathIntent.detected, true);
  assert.equal(death.diagnostics.deathIntent.pinned, true);
  assert.ok(death.diagnostics.deathIntent.chunkIds.includes('sanguo-yanyi:0073:c0001'));
  assert.ok(death.diagnostics.deathIntent.chunkIds.includes('sanguo-yanyi:0073:c0002'));
  assert.deepEqual(death.entries.slice(0, 2).map((e) => e.id), death.diagnostics.deathIntent.chunkIds.slice(0, 2).sort(), '置顶候选与出参首位一致');
});

test('⑨ 64KB 预算截断（硬约束 3）：超限诊断 truncated=true、truncatedCount>0、头部名次保留、JSON 合法', () => {
  const bigText = 'x'.repeat(120);
  const candidate = {
    rank: 1,
    chunkId: 'sanguo-yanyi:0073:c0001',
    chapter: 73,
    title: bigText,
    bm25: 12.34,
    bm25Norm: 0.9,
    cosine: 0.812,
    labelHit: true,
    hitLabels: ['人物之死-关羽之死'], // 与 labelHit 自洽（本用例只关心预算截断，字段随候选一起截断）
    finalScore: 0.92,
    sources: ['lexical', 'vector'],
    injected: null,
    cited: null,
  };
  const overBudget: RetrievalDiagnostics = {
    truncated: false,
    truncatedCount: 0,
    query: { raw: 'q', normalized: 'q', tokens: ['q'] },
    env: { vectorScheme: null, degradedBm25Only: true, corpusChunks: 4, aliasCount: 5, vectorDim: null },
    funnel: { corpusChunks: 4, lexicalHits: 1, vectorTop50: 0, labelHits: 0, mergedCandidates: 1000, topN: 10, injected: null, cited: null },
    candidates: Array.from({ length: 1000 }, (_, i) => ({ ...candidate, rank: i + 1 })),
    nextRank: { ...candidate, rank: 11, gapToTopN: 0.1 },
    deathIntent: { detected: false, pinned: false, chunkIds: [] },
  };
  const trimmed = enforceDiagnosticsBudget(overBudget);
  assert.equal(trimmed.truncated, true);
  assert.ok(trimmed.truncatedCount > 0, '有候选被丢弃');
  assert.ok(trimmed.candidates.length < 1000);
  assert.equal(trimmed.candidates[0].rank, 1, '头部名次保留');
  assert.ok(trimmed.candidates.length + trimmed.truncatedCount === 1000, 'truncatedCount=被丢弃候选条数');
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(trimmed)), '截断后 JSON 合法');
  assert.ok(Buffer.byteLength(JSON.stringify(trimmed), 'utf8') <= 64 * 1024, '截断后 ≤ 64KB');

  const tiny: RetrievalDiagnostics = {
    truncated: false,
    truncatedCount: 0,
    query: { raw: 'q', normalized: 'q', tokens: ['q'] },
    env: { vectorScheme: null, degradedBm25Only: true, corpusChunks: 4, aliasCount: 5, vectorDim: null },
    funnel: { corpusChunks: 4, lexicalHits: 1, vectorTop50: 0, labelHits: 0, mergedCandidates: 1, topN: 1, injected: null, cited: null },
    candidates: [candidate],
    nextRank: null,
    deathIntent: { detected: false, pinned: false, chunkIds: [] },
  };
  const kept = enforceDiagnosticsBudget(tiny);
  assert.equal(kept.truncated, false, '未超限不截断');
  assert.equal(kept.truncatedCount, 0);
});

test('⑩ 工具层：收到 traceId 才回传 result._meta.diagnostics；content 契约零改动（验收 11/12）', async () => {
  const index = loadFixtureIndex();
  const { callTool } = captureTool(index);
  const args: ToolArgs = { source: 'sanguo-yanyi', query: '关羽', limit: 5 };

  const withTrace = await callTool(args, { _meta: { traceId: 'trace-abc' } });
  assert.ok(withTrace._meta?.diagnostics, '带 traceId → 回传诊断');
  assert.equal(withTrace._meta!.diagnostics!.truncated, false);
  const parsed = JSON.parse(withTrace.content[0].text) as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(parsed), 'content 仍是结构化条目数组 JSON');
  assert.equal(parsed.length, 3, 'content 与 A004 契约一致');

  const noTrace = await callTool(args);
  assert.equal(noTrace._meta, undefined, '无 traceId → 不产诊断、不带 _meta');
  const parsed2 = JSON.parse(noTrace.content[0].text) as Array<Record<string, unknown>>;
  assert.deepEqual(parsed2, parsed, 'content 与带诊断时完全一致（诊断不进模型上下文）');
});

test('⑪ 无命中路径：content=NO_HIT_TEXT 且带 traceId 仍回传最小诊断（funnel topN=0 / candidates 空）', async () => {
  const index = loadFixtureIndex();
  const { callTool } = captureTool(index);
  const result = await callTool(
    { source: 'sanguo-yanyi', query: '鹅鹅鹅曲项向天歌', limit: 5 },
    { _meta: { traceId: 'trace-no-hit' } },
  );
  assert.equal(result.content[0].text, NO_HIT_TEXT);
  assert.ok(result._meta?.diagnostics, '无命中也是成功路径，带 traceId 仍回传诊断');
  assert.equal(result._meta!.diagnostics!.funnel.topN, 0);
  assert.deepEqual(result._meta!.diagnostics!.candidates, []);
  assert.equal(result._meta!.diagnostics!.nextRank, null);
  assert.equal(result._meta!.diagnostics!.env.degradedBm25Only, true, '降级场景诊断照常产出');
});

test('⑫ 非法 source 照常抛错（诊断不影响既有错误路径）', async () => {
  const index = loadFixtureIndex();
  const { callTool } = captureTool(index);
  await assert.rejects(
    () => callTool({ source: 'sanguozhi', query: '关羽', limit: 5 }, { _meta: { traceId: 'trace-x' } }),
    /不支持的 source/,
  );
});

test('⑬ 分差精度（验收打回）：roundGap 6 位小数不吞小数，gapToTopN 用 6 位；其余分数仍 3 位', async () => {
  const round3 = (v: number) => Math.round(v * 1000) / 1000;
  assert.equal(round3(0.0004), 0, '旧 3 位口径：0.0004 → 0（本用例的修复点）');
  assert.equal(roundGap(0.0004), 0.0004, '新 6 位口径：0.0004 原样保留，不再显示「差 0 分」');
  assert.equal(roundGap(0.19), 0.19, '常规分差不因放宽位数而变形');

  const index = loadFixtureIndex();
  const r1 = await index.search('关羽', 1, { diagnostics: true });
  assert.ok(r1.diagnostics);
  assert.ok(r1.diagnostics.nextRank, 'limit=1 候选 3 条 → 有第 2 名');
  assert.equal(r1.diagnostics.nextRank!.rank, 2);
  const gap = r1.diagnostics.nextRank!.gapToTopN!;
  assert.ok(gap >= 0, 'gapToTopN ≥ 0');
  assert.equal(gap, roundGap(gap), 'gapToTopN 按 6 位小数口径产出');
  for (const c of r1.diagnostics.candidates) {
    assert.equal(c.finalScore, round3(c.finalScore), `rank${c.rank} finalScore 仍为 3 位小数口径`);
  }
});

test('⑭ 复算恒等式（bug-00013）：cosine / bm25Norm 全精度、bm25Norm min-max 口径、降级 cosine 全 null', async () => {
  const round3 = (v: number) => Math.round(v * 1000) / 1000;
  const index = loadFixtureIndex();
  const { diagnostics } = await index.search('关羽', 5, { diagnostics: true });
  assert.ok(diagnostics);
  assert.equal(diagnostics.env.degradedBm25Only, true, '夹具无向量 → 降级纯 BM25');
  // 降级夹具：向量路不可用 → cosine 全 null，复算按向量项=0
  for (const c of diagnostics.candidates) {
    assert.equal(c.cosine, null, 'rank' + c.rank + ' 降级场景 cosine=null');
    const recomputed = round3(0.3 * (c.bm25Norm ?? 0) + 0.6 * ((c.cosine ?? -1) + 1) / 2 + 0.1 * (c.labelHit ? 1 : 0));
    assert.equal(recomputed, c.finalScore, 'rank' + c.rank + ' 降级按向量项=0 复算成立');
  }
  // bm25Norm：词法命中集合内 min-max 归一化（集合内应出现 1 与 0），全精度不 round3
  const norms: number[] = [];
  for (const c of diagnostics.candidates) {
    if (c.bm25Norm !== null) norms.push(c.bm25Norm);
  }
  assert.ok(norms.length >= 2, '词法命中候选 ≥2 条均有 bm25Norm');
  assert.ok(norms.includes(1), '词法命中集合 max → bm25Norm=1');
  assert.ok(norms.includes(0), '词法命中集合 min → bm25Norm=0');
  assert.ok(norms.every((v) => v >= 0 && v <= 1), 'bm25Norm 落在 [0,1]');
  // 非词法命中（仅标签路命中）→ bm25Norm=null
  const labelOnly = diagnostics.candidates.find((c) => c.sources.includes('label') && !c.sources.includes('lexical'));
  if (labelOnly) {
    assert.equal(labelOnly.bm25Norm, null, '非词法命中候选 bm25Norm=null');
  }
  // 注（bug-00013）：纯向量兜底路径（词法/标签均无命中、仅向量）已按统一公式计分（VEC_WEIGHT*(cosine+1)/2），
  // finalScore 同样可由接口字段复算；夹具为降级无向量，该路径不被本套件触达（按公式统一、排序不变可证）。
});

/**
 * 真实语料核对（hitLabels 口径，非夹具）：用 sango/data 的真实语料 + 真实标签表跑两轮 query，逐条核对 ——
 * （1）与 labelHit 自洽、未命中为 []；（2）每一项都是该 chunk 标签表成员
 * （回传标签原始文本，不是归一化后的文本）；（3）严格复算：标签表 ∩ query 双字词元同口径分词求交、保序去重。
 * 实测结论（本次核对）：
 *   - query「关羽」：真实语料里经 alias 归一化为规范名「云长」（规范名按语料内 df 选定），候选 20 条全部
 *     labelHit=true、hitLabels 非空；其中 3 条标签原文（「政治事件-美髯公」/「美髯公」/「关云长义释曹操」）
 *     并不含「关羽」二字，是经 alias 归一化（关羽 / 美髯公 / 关云长 → 云长）才命中的 —— 即 hitLabels 回传
 *     标签表原文（保留「美髯公」等可读写法），判定走归一化文本，两者口径不同但各自正确。此轮只核
 *     「自洽 + 表成员 + 保序去重」，严格复算留给恒等归一化的 query（否则要在测试里复刻 alias 规范名选取规则）。
 *   - query「白门楼」：alias 归一化为恒等（normalized === raw，alias 表里没有含「白门楼」的条目），
 *     标签侧判定与测试侧直接 tokenize 标签原文完全等价，故可做严格复算：候选 20 条中 labelHit=true 的
 *     hitLabels 恒为 ['白门楼']（第 19 回四处 chunk 带该标签），labelHit=false 的恒为 []。
 * 向量对标签路无影响（tagHits 只由 tagPostings 决定），故默认构造后本地清空 vec 即为确定的降级纯 BM25 场景。
 */
test('⑮ hitLabels 真实语料核对（data/corpus）：自洽 / 表成员 / 保序去重，恒等归一化 query 严格复算', async () => {
  const index = new SangoIndex(DATA_DIR);
  index.load();
  index.vec = new Float32Array(0); // 降级纯 BM25，避免真向量编码拖慢测试，且不影响标签路判定
  const tagsByChunk = loadTagTable(path.join(DATA_DIR, 'corpus', 'tags'));

  // 轮 1（alias 归一化 query）：自洽 + 表成员 + 保序去重；含「关羽」与不含「关羽」的标签都要能被回传。
  const aliased = await index.search('关羽', 5, { diagnostics: true });
  assert.ok(aliased.diagnostics);
  assert.ok(aliased.diagnostics.env.corpusChunks > 1000, '真实语料已加载');
  assert.equal(aliased.diagnostics.env.degradedBm25Only, true);
  assert.ok(aliased.diagnostics.funnel.labelHits > 0);
  assert.notEqual(aliased.diagnostics.query.normalized, aliased.diagnostics.query.raw, '真实语料下 query 经 alias 归一化为规范名');
  let aliasedLabelHit = 0;
  const allLabels: string[] = [];
  for (const c of aliased.diagnostics.candidates) {
    assert.equal(c.labelHit, c.hitLabels.length > 0, 'rank' + c.rank + ' hitLabels 与 labelHit 自洽');
    if (!c.labelHit) assert.deepEqual(c.hitLabels, [], 'rank' + c.rank + ' 未命中标签的候选 hitLabels=[]');
    if (c.labelHit) aliasedLabelHit++;
    const chunkTags = tagsByChunk.get(c.chunkId) ?? [];
    assert.deepEqual([...new Set(c.hitLabels)], c.hitLabels, 'rank' + c.rank + ' hitLabels 保序去重（无重复项）');
    for (const label of c.hitLabels) {
      assert.ok(chunkTags.includes(label), 'rank' + c.rank + ' hitLabels 项「' + label + '」必在该 chunk 标签表内');
      allLabels.push(label);
    }
  }
  assert.ok(aliasedLabelHit > 0, 'query「关羽」标签路有命中');
  // 归一化后才命中的证据：回传的标签原文里存在不含「关羽」二字者（别名写法「美髯公」/「关云长」）
  assert.ok(
    allLabels.some((label) => !label.includes('关羽')),
    'hitLabels 回传标签原文（保留别名写法），不做归一化改写',
  );

  // 轮 2（恒等归一化 query「白门楼」）：标签侧判定 == 测试侧直接 tokenize 标签原文，允许严格复算。
  const plain = await index.search('白门楼', 5, { diagnostics: true });
  assert.ok(plain.diagnostics);
  assert.equal(plain.diagnostics.query.normalized, plain.diagnostics.query.raw, 'alias 表无「白门楼」条目 → 归一化为恒等');
  assert.ok(plain.diagnostics.candidates.length > 0);
  const tokens2 = new Set(plain.diagnostics.query.tokens.filter((t) => t.length >= 2));
  let plainLabelHit = 0;
  for (const c of plain.diagnostics.candidates) {
    const chunkTags = tagsByChunk.get(c.chunkId) ?? [];
    const expected = [...new Set(chunkTags)].filter((tag) => tokenize(tag).some((t) => tokens2.has(t)));
    assert.deepEqual(c.hitLabels, expected, 'rank' + c.rank + ' hitLabels = 标签表 ∩ query 双字词元（独立复算一致）');
    assert.equal(c.labelHit, expected.length > 0, 'rank' + c.rank + ' labelHit 与复算一致');
    if (c.labelHit) plainLabelHit++;
  }
  assert.ok(plainLabelHit > 0, 'query「白门楼」标签路有命中');
});
