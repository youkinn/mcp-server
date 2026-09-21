/**
 * feat-A009 活文档：检索诊断（召回可解释）产出。
 * 覆盖：search 返回 { entries, diagnostics } / 未请求不产诊断 / 诊断结构齐全（query/env/funnel/candidates/
 * nextRank/deathIntent）/ 漏斗管道约束 / 降级环境 / 死亡意图置顶 / 64KB 预算截断 / 工具层 traceId 透传回传
 * result._meta.diagnostics（content 契约零改动）/ 旁路（产出失败不影响 content）。
 * 夹具与 feat-A004 同源：4 chunk（第 1 回 1 个 / 第 73 回 3 个）、无向量文件（降级纯 BM25）、alias 5 条 / 2 PID。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { NO_HIT_TEXT, SangoIndex, enforceDiagnosticsBudget } from '../../search/sango-index.ts';
import type { RetrievalDiagnostics } from '../../types.ts';
import { registerSangoNovelSearch } from '../../tools/sango-novel-search.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, '..', 'feat-A004', 'fixture');

function loadFixtureIndex(): SangoIndex {
  const index = new SangoIndex(FIXTURE_DIR);
  index.load();
  return index;
}

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
  diagnostics.candidates.forEach((c, i) => {
    assert.equal(c.rank, i + 1);
    assert.deepEqual(
      Object.keys(c).sort(),
      ['bm25', 'chapter', 'chunkId', 'cited', 'cosine', 'finalScore', 'injected', 'labelHit', 'rank', 'sources', 'title'],
    );
  });
  assert.equal(diagnostics.candidates[0].chunkId, entries[0].id, '候选表 rank=1 对应出参首条');
  assert.equal(diagnostics.candidates[0].rank, 1);
  for (let i = 1; i < diagnostics.candidates.length; i++) {
    assert.ok(diagnostics.candidates[i - 1].finalScore >= diagnostics.candidates[i].finalScore, '普通问法按 finalScore 降序');
  }
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
    cosine: 0.812,
    labelHit: true,
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
