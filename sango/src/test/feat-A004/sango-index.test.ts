/**
 * feat-A004 C4 活文档：sango-index 按 schema v2 语料加载（chunks[]）+ 出参直出语料字段（去出处头）。
 *
 * 夹具：fixture/entity-table.json（FEAT-A016 单表小样本：曹操 P001 改写键 孟德 / 片段侧 阿瞒，
 * 关羽 P002 改写键 云长 / 片段侧 关公；bannedRewriteKeys=[关公]）；fixture/corpus/sanguo-yanyi/*.json
 * 为 schema v2（chunks[]，5 块：第 1 回 1 块 / 第 73 回 4 块，含 1 个引题块），字段口径与
 * data/corpus/README.md「检索出参」逐字一致；用夹具而非真实语料，是为固定块序与标签位点，
 * 端到端验证走真实语料。
 * 夹具另含 corpus/tags/event.json：p0001:c01 / p0005:c01 打「人物之死-关羽之死」（p0005:c01 另带
 * 「政治事件-关羽托孤」供遗言类问法测试），p0006:c02 打「人物之死-魏延之死|政治事件-关羽入川」
 * （他人死亡标签 + 提及关羽，验证强命中按人名词典而非文档粒度匹配）。
 * 意图分类见 search/intent.ts。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHUNK_ROLES, CHUNK_TYPES, assertChunkKind } from '../../chunk-kind.ts';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { NO_HIT_TEXT, SangoIndex } from '../../search/sango-index.ts';
import { matchDeathIntent } from '../../search/intent.ts';
import { registerSangoNovelSearch } from '../../tools/sango-novel-search.ts';
import { tokenize } from '../../utils/text.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, 'fixture');

/** 夹具索引：5 个 chunk（第 1 回 1 个 / 第 73 回 4 个，含 1 个引题块），无向量文件（降级纯 BM25）。 */
function loadFixtureIndex(): SangoIndex {
  const index = new SangoIndex(FIXTURE_DIR);
  index.load();
  return index;
}

type ToolArgs = { source: 'sanguo-yanyi' | 'sanguozhi'; query: string; limit: number };
type ToolResult = { content: Array<{ text: string }> };
type ToolInputSchema = { safeParse: (v: unknown) => { success: boolean } };

/** 截获 registerTool 注册的处理函数与入参 schema，直接调用工具层（不经 stdio）。 */
function captureTool(index: SangoIndex): {
  callTool: (args: ToolArgs) => Promise<ToolResult>;
  inputSchema: ToolInputSchema;
} {
  let handler: unknown;
  let inputSchema: unknown;
  const fakeRegisterTool = ((_name: string, config: { inputSchema: unknown }, cb: unknown) => {
    inputSchema = config.inputSchema;
    handler = cb;
  }) as unknown as McpServer['registerTool'];
  registerSangoNovelSearch(fakeRegisterTool, index);
  return {
    callTool: handler as (args: ToolArgs) => Promise<ToolResult>,
    inputSchema: inputSchema as ToolInputSchema,
  };
}

test('① 语料按 chunks[] 加载：chunk 数与回级字段（chapter / title）可供服务端渲染出处', () => {
  const index = loadFixtureIndex();
  assert.equal(index.n, 5);
  const doc = index.docs.find((d) => d.chunk_id === 'sanguo-yanyi:0073:p0005:c01');
  assert.ok(doc, '应加载到第 73 回 p0005 段的块');
  assert.equal(doc.chapter, 73);
  assert.equal(doc.title, '玄德进位汉中王　云长攻拔襄阳郡');
  assert.equal(doc.parent_id, 'sanguo-yanyi:0073:p0005');
  assert.equal(doc.seq_in_parent, 1);
});

test('② 出参条目字段与接口文档逐字一致：chunk_id / parent_id / seq_in_parent / type / role / char_count / text + 回级 chapter / title（字段全集）', async () => {
  const index = loadFixtureIndex();
  const { entries } = await index.search('关羽', 5);
  assert.ok(entries.length > 0);
  for (const entry of entries) {
    assert.deepEqual(
      Object.keys(entry).sort(),
      ['chapter', 'char_count', 'chunk_id', 'parent_id', 'role', 'seq_in_parent', 'text', 'title', 'type'],
    );
  }
});

test('③ 条目文本内无出处头、无回目、无段号、无类型、无分数（文本与元数据分离）', async () => {
  const index = loadFixtureIndex();
  const { entries } = await index.search('关羽', 5);
  assert.ok(entries.length > 0);
  for (const entry of entries) {
    assert.ok(!entry.text.includes('【出处】'), `不应含出处头：${entry.text}`);
    assert.ok(!entry.text.includes('第73回'), `不应含回号：${entry.text}`);
    assert.ok(!entry.text.includes('玄德进位汉中王'), `不应含回目：${entry.text}`);
    assert.ok(!entry.text.includes('段'), `不应含段号：${entry.text}`);
    assert.ok(!entry.text.includes('叙述') && !entry.text.includes('诗词'), `不应含类型标签：${entry.text}`);
    assert.ok(!entry.text.includes('分数'), `不应含分数：${entry.text}`);
    assert.ok(!/\d+\.\d{4}/.test(entry.text), `不应含四位小数分数：${entry.text}`);
  }
});

test('④ 按相关度降序返回，limit 生效', async () => {
  const index = loadFixtureIndex();
  const { entries: all } = await index.search('关羽', 5);
  assert.equal(all.length, 3, '第 73 回中词法命中 2 个 chunk（云长经索引侧双写覆盖出 关羽 token）+ 标签路命中 1 个（关羽入川）');
  assert.equal(all[0].chunk_id, 'sanguo-yanyi:0073:p0001:c01', '相关度更高者在前');
  assert.equal((await index.search('关羽', 1)).entries.length, 1);
});

test('⑤ 出参字段全集恒定：仅为检索条目七字段，无冗余字段', async () => {
  const index = loadFixtureIndex();
  const entry = (await index.search('瑾曰', 1)).entries[0];
  assert.equal(entry.chunk_id, 'sanguo-yanyi:0073:p0005:c01');
  assert.deepEqual(Object.keys(entry).sort(), ['chapter', 'char_count', 'chunk_id', 'parent_id', 'role', 'seq_in_parent', 'text', 'title', 'type']);
});

test('⑥ 引题块不进检索候选 + 同段内块序 seq_in_parent：verse 正文块直出类型 / 块序（字段全集恒定）', async () => {
  const index = loadFixtureIndex();
  const entry = (await index.search('赤壁楼船', 1)).entries[0];
  assert.equal(entry.chunk_id, 'sanguo-yanyi:0073:p0006:c02', '命中同段内第 2 块');
  assert.equal(entry.parent_id, 'sanguo-yanyi:0073:p0006');
  assert.equal(entry.seq_in_parent, 2);
  assert.equal(entry.type, 'verse');
  assert.deepEqual(Object.keys(entry).sort(), ['chapter', 'char_count', 'chunk_id', 'parent_id', 'role', 'seq_in_parent', 'text', 'title', 'type']);
  // 同段引题块（p0006:c01「后人有诗赞曰：」role=lead）照常出块加载进 docs，但不进检索候选（README 口径）
  const lead = index.docs.find((d) => d.chunk_id === 'sanguo-yanyi:0073:p0006:c01');
  assert.ok(lead, '引题块应加载进 docs（照常出块）');
  assert.equal(lead.role, 'lead');
  const hits = (await index.search('后人有诗赞曰', 5)).entries;
  assert.ok(!hits.some((e) => e.chunk_id === 'sanguo-yanyi:0073:p0006:c01'), '引题块不得进检索候选');
});

test('⑦ 无命中：检索层返回空数组，由工具层转固定话术「未召回任何原文段落」', async () => {
  const index = loadFixtureIndex();
  // 夹具语料中不存在的字（词法零命中，且无真向量兜底）→ 无命中
  assert.deepEqual((await index.search('鹅鹅鹅曲项向天歌', 5)).entries, []);
  assert.equal(NO_HIT_TEXT, '未召回任何原文段落');
});

test('⑧ 工具出参：命中为 JSON 序列化条目数组，无命中为固定话术', async () => {
  const index = loadFixtureIndex();
  const { callTool } = captureTool(index);
  const hit = await callTool({ source: 'sanguo-yanyi', query: '瑾曰', limit: 1 });
  const entries = JSON.parse(hit.content[0].text) as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(entries), '命中应为结构化条目数组');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].chunk_id, 'sanguo-yanyi:0073:p0005:c01');
  assert.deepEqual(Object.keys(entries[0]).sort(), ['chapter', 'char_count', 'chunk_id', 'parent_id', 'role', 'seq_in_parent', 'text', 'title', 'type']);
  const miss = await callTool({ source: 'sanguo-yanyi', query: '鹅鹅鹅曲项向天歌', limit: 5 });
  assert.equal(miss.content[0].text, NO_HIT_TEXT);
});

test('⑨ 非法 source：sanguozhi（枚举内但本期未开放）报错，消息与接口文档逐字一致', async () => {
  const index = loadFixtureIndex();
  const { callTool } = captureTool(index);
  await assert.rejects(
    () => callTool({ source: 'sanguozhi', query: '关羽', limit: 1 }),
    { message: '不支持的 source：sanguozhi，本期仅支持 sanguo-yanyi' },
  );
});

test('⑩ chapter / title 随每条条目展开：跨回召回时逐条对应，source 不在条目级重复', async () => {
  const index = loadFixtureIndex();
  // 「曹操」在第 1 回与第 73 回均有 chunk → 单次召回跨回，出处必须逐条对应渲染
  const { entries } = await index.search('曹操', 5);
  assert.deepEqual(entries.map((e) => e.chapter).sort(), [1, 73], '召回应跨回（第 1 回与第 73 回）');
  for (const entry of entries) {
    assert.ok(entry.title.length > 0, '每条条目都应带自己的回目');
    if (entry.chapter === 73) assert.equal(entry.title, '玄德进位汉中王　云长攻拔襄阳郡');
    if (entry.chapter === 1) assert.equal(entry.title, '宴桃园豪杰三结义 斩黄巾英雄首立功');
    assert.ok(!Object.keys(entry).includes('source'), 'source 不在条目级重复');
  }
});

test('⑪ limit 超出上限按 20 截断、不报错（契约「输入」表：默认 5，最大 20）', async () => {
  const index = loadFixtureIndex();
  const { callTool, inputSchema } = captureTool(index);
  // 入参 schema 不设上限：limit=999 校验通过（不报错），由工具层截断到 20
  assert.equal(inputSchema.safeParse({ source: 'sanguo-yanyi', query: '关羽', limit: 999 }).success, true);
  assert.equal(inputSchema.safeParse({ source: 'sanguo-yanyi', query: '关羽', limit: 0 }).success, false, 'limit 下限 1 仍生效');
  const result = await callTool({ source: 'sanguo-yanyi', query: '关羽', limit: 999 });
  const entries = JSON.parse(result.content[0].text) as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(entries));
  assert.equal(entries.length, (await index.search('关羽', 20)).entries.length);
});

test('⑫ 死亡意图分类：主流问法归并到正确子类，非死亡问法返回 null', () => {
  assert.equal(matchDeathIntent('华雄是怎么死的'), 'death_manner');
  assert.equal(matchDeathIntent('华雄的死因是什么'), 'death_manner');
  assert.equal(matchDeathIntent('华雄之死'), 'death_manner');
  assert.equal(matchDeathIntent('华雄被谁杀的'), 'death_agent');
  assert.equal(matchDeathIntent('吕布是谁斩的'), 'death_agent');
  assert.equal(matchDeathIntent('赵云死在哪里'), 'death_place');
  assert.equal(matchDeathIntent('关羽是什么时候死的'), 'death_time');
  assert.equal(matchDeathIntent('吕布死了吗？'), 'death_confirm');
  assert.equal(matchDeathIntent('周瑜死后谁接任大都督'), 'death_aftermath');
  assert.equal(matchDeathIntent('关羽死后怎样'), 'death_aftermath');
  assert.equal(matchDeathIntent('刘备死时对诸葛亮说了什么'), 'death_last_words');
  assert.equal(matchDeathIntent('白帝城托孤'), 'death_last_words');
  assert.equal(matchDeathIntent('关羽的遗言是什么'), 'death_last_words');
  // death_age（死亡年龄）：问法须先归死亡年龄而非临终遗言（death_age 模式在 death_last_words 之前）
  assert.equal(matchDeathIntent('刘备死的时候多少岁'), 'death_age');
  assert.equal(matchDeathIntent('关羽死时几岁'), 'death_age');
  assert.equal(matchDeathIntent('曹操享年多少'), 'death_age');
  assert.equal(matchDeathIntent('周瑜卒年几何'), 'death_age');
  assert.equal(matchDeathIntent('刘备去世时多大'), 'death_age');
  assert.equal(matchDeathIntent('关羽活了多少岁'), 'death_age');
  // death_age 顺序守卫：无年龄问法时不得抢占临终遗言类；非死亡问法不得误触发
  assert.equal(matchDeathIntent('关羽死时说了什么'), 'death_last_words');
  assert.equal(matchDeathIntent('诸葛亮出山时多少岁'), null);
  assert.equal(matchDeathIntent('今天天气如何'), null);
  assert.equal(matchDeathIntent('赤壁之战'), null);
  assert.equal(matchDeathIntent('关羽镇守荆州'), null);
});

test('⑬ 死亡意图强命中：死亡类问法命中死亡标签 chunk 置顶，非死亡问法排序不变', async () => {
  const index = loadFixtureIndex();
  const { entries: death } = await index.search('关羽是怎么死的', 5);
  assert.ok(death.length >= 2);
  assert.deepEqual(
    death.slice(0, 2).map((e) => e.chunk_id),
    ['sanguo-yanyi:0073:p0001:c01', 'sanguo-yanyi:0073:p0005:c01'],
    '关羽死亡标签 chunk 置顶且按文档序（死因类取靠前段）',
  );
  assert.ok(
    !death.slice(0, 2).some((e) => e.chunk_id === 'sanguo-yanyi:0073:p0006:c02'),
    '他人死亡标签（人物之死-魏延之死）不得混入关羽死亡强命中',
  );
  assert.equal(death[0].chunk_id, (await index.search('关羽', 5)).entries[0].chunk_id, '死因类强命中不改变非死亡问法的首选（同为 0073:p0001:c01）');
});

test('⑭ 事后类问法同名死亡标签多 chunk：按文档序取靠后段优先（死因段在前、追述/续事段在后）', async () => {
  const index = loadFixtureIndex();
  const { entries } = await index.search('关羽死后怎样', 5);
  assert.ok(entries.length > 0);
  assert.equal(entries[0].chunk_id, 'sanguo-yanyi:0073:p0005:c01', '「死后怎样」应优先返回 0073:p0005:c01（更靠后的续事段）');
});

test('⑮ 死亡强命中按人名词典匹配：他人死亡标签（魏延之死）不劫持关羽问法，反之亦然', async () => {
  const index = loadFixtureIndex();
  const { entries: wei } = await index.search('魏延怎么死的', 3);
  assert.equal(wei[0].chunk_id, 'sanguo-yanyi:0073:p0006:c02', '魏延死亡问法应命中魏延之死标签 chunk');
  const { entries: guan } = await index.search('关羽是怎么死的', 3);
  assert.ok(!guan.slice(0, 2).some((e) => e.chunk_id === 'sanguo-yanyi:0073:p0006:c02'), '关羽问法不应命中魏延之死 chunk');
});

test('⑯ 临终遗言类问法：优先命中该人物的托孤/遗言标签段，无遗言段时退回死亡段', async () => {
  const index = loadFixtureIndex();
  const { entries: guan } = await index.search('关羽临终说了什么', 3);
  assert.equal(guan[0].chunk_id, 'sanguo-yanyi:0073:p0005:c01', '遗言问法应命中「关羽托孤」段（0073:p0005:c01）而非纯死亡段（0073:p0001:c01）');
  const { entries: wei } = await index.search('魏延临终说了什么', 3);
  assert.equal(wei[0].chunk_id, 'sanguo-yanyi:0073:p0006:c02', '无遗言标签的人物退回死亡段（魏延之死）');
});

test('⑰ 索引剥壳（feat-A014）：tagPostings 只入库剥离类型信息后的文本（人物之死-关羽之死 → 关羽，政治事件-关羽托孤 → 关羽托孤）', () => {
  const index = loadFixtureIndex();
  // 直接读倒排结构（private 字段经类型断言访问，测试即剥壳验收的活文档）
  const internals = index as unknown as {
    tagPostings: Map<string, number[]>;
    tagTextsByDoc: string[][];
  };
  // 类型信息 bigram 一律不进 tagPostings：人物 / 物之 / 之死 / 之生 / 登场 / 政治 / 治事 / 事件
  const docOfTest = new Map(index.docs.map((d, i) => [d.chunk_id, i]));
  for (const bigram of ['人物', '物之', '之死', '之生', '登场', '政治', '治事', '事件']) {
    assert.equal(internals.tagPostings.get(bigram) ?? 0, 0, `类型 bigram「${bigram}」不应进 tagPostings`);
  }
  // 剥壳后内容词元完整保留：纯人物名（关羽/魏延）、事件内容（托孤/入川）
  for (const token of ['关羽', '魏延', '托孤', '入川']) {
    assert.ok((internals.tagPostings.get(token) ?? []).length > 0, `剥壳后应保留内容词元「${token}」`);
  }
  // 「关羽」来自 c0001 关羽之死 / c0002 关羽之死+关羽托孤 / c0003 关羽入川 → 3 个文档
  assert.equal(internals.tagPostings.get('关羽')?.length, 3, '剥壳后「关羽」应命中 3 个标签文档');
  // 原始标签文本原样保留（hitLabels 回读基础，剥壳只作用于倒排）
  const c0002 = docOfTest.get('sanguo-yanyi:0073:p0005:c01') as number;
  assert.deepEqual(
    internals.tagTextsByDoc[c0002],
    ['人物之死-关羽之死', '政治事件-关羽托孤'],
    'tagTextsByDoc 保留原始标签文本（未剥壳）',
  );
});

test('⑱ 剥壳后 hitLabels 仍回读原始标签文本（含类型信息原文），labelHit 标签路命中不因剥壳变化', async () => {
  const index = loadFixtureIndex();
  const { diagnostics } = await index.search('关羽', 5, { diagnostics: true });
  const cand = diagnostics?.candidates.find((c: { chunkId: string }) => c.chunkId === 'sanguo-yanyi:0073:p0005:c01');
  assert.ok(cand, 'c0002 应在候选诊断中');
  assert.equal(cand.labelHit, true, 'c0002 标签路命中（关羽托孤）');
  assert.deepEqual(
    cand.hitLabels,
    ['人物之死-关羽之死', '政治事件-关羽托孤'],
    'hitLabels 回读的是原始标签文本而非剥壳文本',
  );
});

test('⑲ 死亡年龄类问法（death_age）：死亡段与遗言/托孤段一并置顶，limit=10 内均可及', async () => {
  const index = loadFixtureIndex();
  // fixture 同口径映射真实语料：死亡段（人物之死-关羽之死）+ 遗言/托孤段（关羽托孤）一并置顶，
  // 死亡年龄类问法（真实语料如「刘备死的时候多少岁」对应 0085 回）两段均须进 top10，此处以夹具验证同口径。
  const { entries } = await index.search('关羽死的时候多少岁', 10);
  assert.equal(entries[0].chunk_id, 'sanguo-yanyi:0073:p0001:c01', '死亡段 0073:p0001:c01 置顶第一');
  assert.equal(entries[1].chunk_id, 'sanguo-yanyi:0073:p0005:c01', '遗言/托孤段 0073:p0005:c01 同组置顶（年龄事实段与死亡段一并可及）');
  assert.ok(entries.slice(0, 10).some((e) => e.chunk_id === 'sanguo-yanyi:0073:p0001:c01'), 'limit=10 内死亡段可及');
});

test('⑳ A016 检索侧不改写 + 索引侧双写：孟德 原文入检索、expansionHits 报告 孟德→曹操；fragmentOnly 同样只双写不改写', async () => {
  const index = loadFixtureIndex();
  const { diagnostics } = await index.search('孟德', 5, { diagnostics: true });
  assert.ok(diagnostics);
  assert.equal(diagnostics.query.raw, '孟德');
  assert.equal(diagnostics.query.normalized, '孟德', '检索侧不改写：query 原文入检索（接口 §2.2）');
  assert.deepEqual(diagnostics.query.rewrites, [], 'rewrites 恒 []');
  assert.deepEqual(
    diagnostics.query.expansionHits,
    [{ from: '孟德', to: '曹操' }],
    'expansionHits = 原文命中 rewriteKeys → 规范形（索引侧已双写覆盖）',
  );
  const noDiag = await index.search('关公', 5);
  assert.ok(noDiag.entries.length > 0, 'fragmentOnly 词（关公）原文检索仍可命中 073:p0005:c01（命中来自词法共现/标签路）');
  const identity = await index.search('阿瞒', 5, { diagnostics: true });
  assert.equal(identity.diagnostics?.query.normalized, '阿瞒', '检索侧不改写：fragmentOnly 原文照入');
  assert.deepEqual(
    identity.diagnostics?.query.expansionHits,
    [{ from: '阿瞒', to: '曹操' }],
    'fragmentOnly 也进 expansionHits 报告（只报告不改写）',
  );
});

test('㉑ A016 索引侧双写（rewriteKeys 与 fragmentOnly 同口径）：原文命中追加规范形 token，df 略升、dl 不重算', async () => {
  const index = loadFixtureIndex();
  const internals = index as unknown as { postings: Map<string, Array<{ doc: number; tf: number }>> };
  const doc0 = index.docs.find((d) => d.chunk_id === 'sanguo-yanyi:0001:p0004:c01');
  assert.ok(doc0, '第 1 回 p0004:c01 已加载');
  // 001 原文「曹操字孟德，小字阿瞒。曹操少有才名，曹操任侠放荡。阿瞒者，操之小字也。」：
  // 原文 曹操 x3 + 孟德（rewriteKey）双写 1 处 + 阿瞒（fragmentOnly）双写 2 处 = tf 6（接口 §2.3 逐处；
  // once-per-doc 则为 5）。规范形 曹操 的 df 因双写略升。
  // doc.len 仍为原文 token 数（双写只增倒排条目、不改 dl，接口 §2.3）。
  const c001 = internals.postings.get('曹操')?.find((p) => p.doc === index.docs.indexOf(doc0));
  assert.ok(c001, '\u201c曹操\u201d 应在 p0004:c01 的 postings 中');
  assert.equal(c001.tf, 6, '原文 曹操 x3 + 孟德双写 1 + 阿瞒双写 2 = 6（逐处双写生效；once-per-doc 则为 5）');
  const rawText = '曹操字孟德，小字阿瞒。曹操少有才名，曹操任侠放荡。阿瞒者，操之小字也。';
  assert.equal(doc0.len, tokenize(rawText).length, 'doc.len = 原文 token 数（双写不重算 dl）');
  const { entries } = await index.search('曹操', 5);
  assert.deepEqual(entries.map((e) => e.chapter).sort(), [1, 73], '曹操 跨回召回不受双写影响（第 1 回 + 第 73 回）');
});

test('㉒ 取值单一来源：出参 type / role 只落在 CHUNK_TYPES / CHUNK_ROLES 内（枚举源 src/chunk-kind.ts）', async () => {
  const index = loadFixtureIndex();
  const { entries } = await index.search('关羽', 5);
  assert.ok(entries.length > 0);
  for (const entry of entries) {
    assert.ok((CHUNK_TYPES as readonly string[]).includes(entry.type), `type 应落枚举内：${entry.type}`);
    assert.ok((CHUNK_ROLES as readonly string[]).includes(entry.role), `role 应落枚举内：${entry.role}`);
  }
});

test('㉓ 表外取值终止启动：语料 type 不在枚举内时 load() 抛错（契约变化不静默透传）', () => {
  assert.throws(() => assertChunkKind('小说', 'body', 'sanguo-yanyi:0001:p0001:c01'), /取值非法/);
  assert.throws(() => assertChunkKind('prose', '旁白', 'sanguo-yanyi:0001:p0001:c01'), /取值非法/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sango-bad-kind-'));
  try {
    fs.mkdirSync(path.join(dir, 'corpus', 'sanguo-yanyi'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'corpus', 'sanguo-yanyi', '001.json'),
      JSON.stringify({
        source: 'sanguo-yanyi',
        chapter: 1,
        title: '宴桃园豪杰三结义 斩黄巾英雄首立功',
        chunks: [
          { chunk_id: 'sanguo-yanyi:0001:p0001:c01', parent_id: 'sanguo-yanyi:0001:p0001', seq_in_parent: 1, type: '小说', role: 'body', text: '甲', char_count: 1 },
        ],
      }),
      'utf8',
    );
    const bad = new SangoIndex(dir);
    assert.throws(() => bad.load(), /取值非法/, '表外取值须终止启动');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
