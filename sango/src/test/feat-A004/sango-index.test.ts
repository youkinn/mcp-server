/**
 * feat-A004 C4 活文档：sango-index 适配 chunks[]（schema v2）+ 出参结构化（去出处头）。
 *
 * 夹具语料 fixture/corpus/sanguo-yanyi/*.json 为 schema v2（chunks[]），字段口径与接口文档
 * 「输出（命中）」及 docs/sango-corpus-spec.md §5 逐字一致；用夹具而非真实语料，是因为磁盘上的
 * 真实语料此刻仍是旧格式（segments[]），待语料重建（C5）后再补跑端到端验证。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { NO_HIT_TEXT, SangoIndex } from '../../search/sango-index.ts';
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
  const entries = await index.search('关羽', 5);
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
  const entries = await index.search('关羽', 5);
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
  const all = await index.search('关羽', 5);
  assert.equal(all.length, 2, '第 73 回中 2 个 chunk 命中「关羽」（云长经别名归一化命中）');
  assert.equal(all[0].id, 'sanguo-yanyi:0073:c0001', '相关度更高者在前');
  assert.equal((await index.search('关羽', 1)).length, 1);
});

test('⑤ quotes[] 字段（qid / text / offset / speaker）与契约一致，offset 指向 text 内开引号', async () => {
  const index = loadFixtureIndex();
  const entry = (await index.search('瑾曰', 1))[0];
  assert.equal(entry.id, 'sanguo-yanyi:0073:c0002');
  assert.deepEqual(entry.quotes.map((q) => q.qid), ['Q1', 'Q2']);
  assert.deepEqual(entry.quotes.map((q) => q.offset), [4, 30]);
  assert.deepEqual(entry.quotes.map((q) => q.speaker), ['瑾', '云长']);
  assert.equal(entry.quotes[0].text, '特来求结两家之好……请君侯思之。');
  for (const quote of entry.quotes) {
    assert.equal(
      entry.text.slice(quote.offset - 1, quote.offset - 1 + quote.text.length + 2),
      `“${quote.text}”`,
      'offset 应与开引号边界一致（offset-1 处即开引号）',
    );
  }
});

test('⑥ 跨段 chunk：segFrom != segTo，type / quoteBalanced / quotes 原样承载', async () => {
  const index = loadFixtureIndex();
  const entry = (await index.search('赤壁楼船', 1))[0];
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
  assert.deepEqual(await index.search('鹅鹅鹅曲项向天歌', 5), []);
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
    { qid: 'Q1', text: '特来求结两家之好……请君侯思之。', offset: 4, speaker: '瑾' },
    { qid: 'Q2', text: '吾虎女安肯嫁犬子乎！……', offset: 30, speaker: '云长' },
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
  const entries = await index.search('曹操', 5);
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
  assert.equal(entries.length, (await index.search('关羽', 20)).length);
});
