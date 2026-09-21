/**
 * feat-A004 C4 活文档：sango-index 适配 chunks[]（schema v2）+ 出参结构化（去出处头）。
 *
 * 夹具语料 fixture/corpus/sanguo-yanyi/*.json 为 schema v2（chunks[]），字段口径与接口文档
 * 「输出（命中）」及 docs/sango-corpus-spec.md §5 逐字一致；用夹具而非真实语料，是因为磁盘上的
 * 真实语料此刻仍是旧格式（segments[]），待语料重建（C5）后再补跑端到端验证。
 * 夹具另含 corpus/tags/event.json：c0001/c0002 打「人物之死-关羽之死」（c0002 另带
 * 「政治事件-关羽托孤」供遗言类问法测试），c0003 打「人物之死-魏延之死|政治事件-关羽入川」
 * （他人死亡标签 + 提及关羽，验证强命中按人名词典而非文档粒度匹配）。
 * 意图分类见 search/intent.ts。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { NO_HIT_TEXT, SangoIndex } from '../../search/sango-index.ts';
import { matchDeathIntent } from '../../search/intent.ts';
import { registerSangoNovelSearch } from '../../tools/sango-novel-search.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, 'fixture');

/** 夹具索引：4 个 chunk（第 1 回 1 个 / 第 73 回 3 个），无向量文件（降级纯 BM25）。 */
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
  assert.equal(index.n, 4);
  const doc = index.docs.find((d) => d.chunkId === 'sanguo-yanyi:0073:c0002');
  assert.ok(doc, '应加载到第 73 回第 2 个 chunk');
  assert.equal(doc.chapter, 73);
  assert.equal(doc.title, '玄德进位汉中王　云长攻拔襄阳郡');
  assert.equal(doc.segFrom, 5);
  assert.equal(doc.segTo, 5);
});

test('② 出参条目字段与接口文档逐字一致：id / text / chapter / title / type / segFrom / segTo / quoteBalanced / quotes', async () => {
  const index = loadFixtureIndex();
  const { entries } = await index.search('关羽', 5);
  assert.ok(entries.length > 0);
  for (const entry of entries) {
    assert.deepEqual(
      Object.keys(entry).sort(),
      ['chapter', 'id', 'quoteBalanced', 'quotes', 'segFrom', 'segTo', 'text', 'title', 'type'],
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
  assert.equal(all.length, 3, '第 73 回中词法命中 2 个 chunk（云长经别名归一化）+ 标签路命中 1 个（关羽入川）');
  assert.equal(all[0].id, 'sanguo-yanyi:0073:c0001', '相关度更高者在前');
  assert.equal((await index.search('关羽', 1)).entries.length, 1);
});

test('⑤ quotes[] 字段（offset / len）与契约一致，切片口径可从 text 还原引语', async () => {
  const index = loadFixtureIndex();
  const entry = (await index.search('瑾曰', 1)).entries[0];
  assert.equal(entry.id, 'sanguo-yanyi:0073:c0002');
  assert.deepEqual(entry.quotes.map((q) => q.offset), [4, 30]);
  assert.deepEqual(entry.quotes.map((q) => q.len), [16, 12]);
  assert.deepEqual(
    entry.quotes.map((q) => Object.keys(q).sort()),
    [['len', 'offset'], ['len', 'offset']],
    '出参引语只回 offset / len（不含 qid / text / speaker）',
  );
  assert.deepEqual(
    entry.quotes.map((q) => entry.text.slice(q.offset - 1, q.offset - 1 + q.len + 2)),
    ['“特来求结两家之好……请君侯思之。”', '“吾虎女安肯嫁犬子乎！……”'],
    'text.slice(offset - 1, offset - 1 + len + 2) 应等于 “引语本体”',
  );
  for (const quote of entry.quotes) {
    const sliced = entry.text.slice(quote.offset - 1, quote.offset - 1 + quote.len + 2);
    assert.equal(
      sliced.length,
      quote.len + 2,
      '切片长度应为引语本体字数 + 两侧引号',
    );
    assert.ok(sliced.startsWith('“') && sliced.endsWith('”'), `切片应含成对引号：${sliced}`);
  }
});

test('⑥ 跨段 chunk：segFrom != segTo，type / quoteBalanced / quotes 原样承载', async () => {
  const index = loadFixtureIndex();
  const entry = (await index.search('赤壁楼船', 1)).entries[0];
  assert.equal(entry.id, 'sanguo-yanyi:0073:c0003');
  assert.equal(entry.segFrom, 6);
  assert.equal(entry.segTo, 8);
  assert.equal(entry.type, 'verse');
  assert.equal(entry.quoteBalanced, false);
  assert.deepEqual(entry.quotes, []);
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
  assert.equal(entries[0].id, 'sanguo-yanyi:0073:c0002');
  assert.deepEqual(entries[0].quotes, [
    { offset: 4, len: 16 },
    { offset: 30, len: 12 },
  ]);
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
  assert.equal(matchDeathIntent('今天天气如何'), null);
  assert.equal(matchDeathIntent('赤壁之战'), null);
  assert.equal(matchDeathIntent('关羽镇守荆州'), null);
});

test('⑬ 死亡意图强命中：死亡类问法命中死亡标签 chunk 置顶，非死亡问法排序不变', async () => {
  const index = loadFixtureIndex();
  const { entries: death } = await index.search('关羽是怎么死的', 5);
  assert.ok(death.length >= 2);
  assert.deepEqual(
    death.slice(0, 2).map((e) => e.id),
    ['sanguo-yanyi:0073:c0001', 'sanguo-yanyi:0073:c0002'],
    '关羽死亡标签 chunk 置顶且按文档序（死因类取靠前段）',
  );
  assert.ok(
    !death.slice(0, 2).some((e) => e.id === 'sanguo-yanyi:0073:c0003'),
    '他人死亡标签（人物之死-魏延之死）不得混入关羽死亡强命中',
  );
  assert.equal(death[0].id, (await index.search('关羽', 5)).entries[0].id, '死因类强命中不改变非死亡问法的首选（同为 c0001）');
});

test('⑭ 事后类问法同名死亡标签多 chunk：按文档序取靠后段优先（死因段在前、追述/续事段在后）', async () => {
  const index = loadFixtureIndex();
  const { entries } = await index.search('关羽死后怎样', 5);
  assert.ok(entries.length > 0);
  assert.equal(entries[0].id, 'sanguo-yanyi:0073:c0002', '「死后怎样」应优先返回 c0002（更靠后的续事段）');
});

test('⑮ 死亡强命中按人名词典匹配：他人死亡标签（魏延之死）不劫持关羽问法，反之亦然', async () => {
  const index = loadFixtureIndex();
  const { entries: wei } = await index.search('魏延怎么死的', 3);
  assert.equal(wei[0].id, 'sanguo-yanyi:0073:c0003', '魏延死亡问法应命中魏延之死标签 chunk');
  const { entries: guan } = await index.search('关羽是怎么死的', 3);
  assert.ok(!guan.slice(0, 2).some((e) => e.id === 'sanguo-yanyi:0073:c0003'), '关羽问法不应命中魏延之死 chunk');
});

test('⑯ 临终遗言类问法：优先命中该人物的托孤/遗言标签段，无遗言段时退回死亡段', async () => {
  const index = loadFixtureIndex();
  const { entries: guan } = await index.search('关羽临终说了什么', 3);
  assert.equal(guan[0].id, 'sanguo-yanyi:0073:c0002', '遗言问法应命中「关羽托孤」段（c0002）而非纯死亡段（c0001）');
  const { entries: wei } = await index.search('魏延临终说了什么', 3);
  assert.equal(wei[0].id, 'sanguo-yanyi:0073:c0003', '无遗言标签的人物退回死亡段（魏延之死）');
});
