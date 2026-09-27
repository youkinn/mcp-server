/**
 * feat-A004 C4 活文档：sango-index 适配 chunks[]（schema v2）+ 出参结构化（去出处头）。
 *
 * 夹具：fixture/entity-table.json（FEAT-A016 单表小样本：曹操 P001 改写键 孟德 / 片段侧 阿瞒，
 * 关羽 P002 改写键 云长 / 片段侧 关公；bannedRewriteKeys=[关公]）；fixture/corpus/sanguo-yanyi/*.json
 * 为 schema v2（chunks[]），字段口径与接口文档
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
import { tokenize } from '../../utils/text.ts';

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

test('⑰ 索引剥壳（feat-A014）：tagPostings 只入库剥离类型信息后的文本（人物之死-关羽之死 → 关羽，政治事件-关羽托孤 → 关羽托孤）', () => {
  const index = loadFixtureIndex();
  // 直接读倒排结构（private 字段经类型断言访问，测试即剥壳验收的活文档）
  const internals = index as unknown as {
    tagPostings: Map<string, number[]>;
    tagTextsByDoc: string[][];
  };
  // 类型信息 bigram 一律不进 tagPostings：人物 / 物之 / 之死 / 之生 / 登场 / 政治 / 治事 / 事件
  const docOfTest = new Map(index.docs.map((d, i) => [d.chunkId, i]));
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
  const c0002 = docOfTest.get('sanguo-yanyi:0073:c0002') as number;
  assert.deepEqual(
    internals.tagTextsByDoc[c0002],
    ['人物之死-关羽之死', '政治事件-关羽托孤'],
    'tagTextsByDoc 保留原始标签文本（未剥壳）',
  );
});

test('⑱ 剥壳后 hitLabels 仍回读原始标签文本（含类型信息原文），labelHit 标签路命中不因剥壳变化', async () => {
  const index = loadFixtureIndex();
  const { diagnostics } = await index.search('关羽', 5, { diagnostics: true });
  const cand = diagnostics?.candidates.find((c: { chunkId: string }) => c.chunkId === 'sanguo-yanyi:0073:c0002');
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
  // fixture 等价 0085:c0011（死亡段，人物之死-关羽之死）+ 0085:c0013（遗言/遗诏段，关羽托孤）：
  // 问句「刘备死的时候多少岁」在真实语料中死亡段 0085:c0011 须进 top10，此处以夹具的关羽死亡段验证同口径。
  const { entries } = await index.search('关羽死的时候多少岁', 10);
  assert.equal(entries[0].id, 'sanguo-yanyi:0073:c0001', '死亡段 0073:c0001 置顶第一');
  assert.equal(entries[1].id, 'sanguo-yanyi:0073:c0002', '遗言/托孤段 0073:c0002 同组置顶（年龄事实段与死亡段一并可及）');
  assert.ok(entries.slice(0, 10).some((e) => e.id === 'sanguo-yanyi:0073:c0001'), 'limit=10 内死亡段可及');
});

test('⑳ A016 双侧替换：rewriteKeys 在 query 侧 embed 前生效（孟德 → 曹操），fragmentOnly 不参与 query 改写（关公 保持原文）', async () => {
  const index = loadFixtureIndex();
  const { diagnostics } = await index.search('孟德', 5, { diagnostics: true });
  assert.ok(diagnostics);
  assert.equal(diagnostics.query.raw, '孟德');
  assert.equal(diagnostics.query.normalized, '曹操', 'rewriteKeys 替换：孟德 → 曹操（人物行级）');
  const noDiag = await index.search('关公', 5);
  assert.ok(noDiag.entries.length > 0, 'fragmentOnly 词（关公）原文检索仍可命中 073:c0002（云长段原文无 关公，命中来自词法共现/标签路）');
  const identity = await index.search('阿瞒', 5, { diagnostics: true });
  assert.equal(identity.diagnostics?.query.normalized, '阿瞒', 'fragmentOnly（阿瞒）不参与 query 改写');
});

test('㉑ A016 片段侧双写（fragmentOnly）：原文命中追加写入规范形 token，df 略升、dl 不重算', async () => {
  const index = loadFixtureIndex();
  const internals = index as unknown as { postings: Map<string, Array<{ doc: number; tf: number }>> };
  const doc0 = index.docs.find((d) => d.chunkId === 'sanguo-yanyi:0001:c0001');
  assert.ok(doc0, '第 1 回 c0001 已加载');
  // 001 文本「曹操字孟德，小字阿瞒。曹操少有才名，曹操任侠放荡。阿瞒者，操之小字也。」归一化后：
  // 原文 曹操 x3 + 孟德替换 1 = 4，阿瞒 2 处逐处双写追加 2 = tf 6（接口 §2.3 逐处；once-per-doc 则为 5）。
  // doc.len 仍为原文归一化 token 数（含双写前），双写只增倒排、不改 dl（接口 §2.3）。
  const c001 = internals.postings.get('曹操')?.find((p) => p.doc === index.docs.indexOf(doc0));
  assert.ok(c001, '\u201c曹操\u201d 应在 c0001 的 postings 中');
  assert.equal(c001.tf, 6, '原文 3 + 孟德替换 1 + 阿瞒双写 2 处 = 6（逐处双写生效；once-per-doc 则为 5）');
  const normText = '曹操字曹操，小字阿瞒。曹操少有才名，曹操任侠放荡。阿瞒者，操之小字也。';
  assert.equal(doc0.len, tokenize(normText).length, 'doc.len = 原文归一化 token 数（双写不重算 dl）');
  const { entries } = await index.search('曹操', 5);
  assert.deepEqual(entries.map((e) => e.chapter).sort(), [1, 73], '曹操 跨回召回不受双写影响（第 1 回 + 第 73 回）');
});
