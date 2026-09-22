/**
 * feat-A010 C7 活文档：sango_novel_chapter 整回读取工具（Transport / Server 层，测试即文档）。
 *
 * 覆盖接口文档验收条目：正常回字段口径（chunkId 契约名）/ 第 1 回 prev=null / 第 120 回 next=null /
 * 相邻回标题 / 回号越界 zod 校验 / 合法回号语料缺失抛错（总台映射 404 口径见总台测试）。
 * 夹具 fixture/corpus/sanguo-yanyi/ 为 schema v2（chunks[]），含 001/002/003/119/120 五回，
 * 覆盖边界（1 / 120）、相邻回（prev/next 有值）与缺失回（如 50）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SangoIndex } from '../../search/sango-index.ts';
import { registerSangoNovelChapter } from '../../tools/sango-novel-chapter.ts';
import type { ChapterPayload } from '../../types.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, 'fixture');

/** 夹具索引：5 回 6 chunk（第 2 回 2 个），无向量 / 别名 / 标签文件（加载降级，不影响 getChapter）。 */
function loadFixtureIndex(): SangoIndex {
  const index = new SangoIndex(FIXTURE_DIR);
  index.load();
  return index;
}

type ToolArgs = { chapter: number };
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
  registerSangoNovelChapter(fakeRegisterTool, index);
  return {
    callTool: handler as (args: ToolArgs) => Promise<ToolResult>,
    inputSchema: inputSchema as ToolInputSchema,
  };
}

function parsePayload(result: ToolResult): ChapterPayload {
  return JSON.parse(result.content[0].text) as ChapterPayload;
}

test('① 正常回：chapter / title / prev / next / chunks 字段齐全，chunkId 按契约名输出（语料 id → chunkId）', async () => {
  const index = loadFixtureIndex();
  const { callTool } = captureTool(index);

  const payload = parsePayload(await callTool({ chapter: 2 }));
  assert.equal(payload.chapter, 2);
  assert.equal(payload.title, '张翼德怒鞭督邮 何国舅谋诛宦竖');
  assert.deepEqual(payload.prev, { chapter: 1, title: '宴桃园豪杰三结义 斩黄巾英雄首立功' });
  assert.deepEqual(payload.next, { chapter: 3, title: '议温明董卓叱丁原 馈金珠李肃说吕布' });
  assert.equal(payload.chunks.length, 2);
  const chunk = payload.chunks[0];
  assert.deepEqual(Object.keys(chunk).sort(), ['chunkId', 'segFrom', 'segTo', 'text', 'type']);
  assert.equal(chunk.chunkId, 'sanguo-yanyi:0002:c0001');
  assert.equal(chunk.type, 'narration');
  assert.equal(chunk.segFrom, 1);
  assert.equal(chunk.segTo, 1);
});

test('② 第 1 回 prev=null（上一回按钮禁用口径），next 为第 2 回', async () => {
  const index = loadFixtureIndex();
  const { callTool } = captureTool(index);

  const payload = parsePayload(await callTool({ chapter: 1 }));
  assert.equal(payload.prev, null);
  assert.deepEqual(payload.next, { chapter: 2, title: '张翼德怒鞭督邮 何国舅谋诛宦竖' });
});

test('③ 第 120 回 next=null（下一回按钮禁用口径），prev 为第 119 回', async () => {
  const index = loadFixtureIndex();
  const { callTool } = captureTool(index);

  const payload = parsePayload(await callTool({ chapter: 120 }));
  assert.deepEqual(payload.prev, { chapter: 119, title: '假投降巧计成虚话 再受禅依样画葫芦' });
  assert.equal(payload.next, null);
});

test('④ 回号越界 / 非整数：zod 入参校验失败（0 / 121 / 1.5），不进入 handler', async () => {
  const index = loadFixtureIndex();
  const { inputSchema } = captureTool(index);

  for (const chapter of [0, -1, 121, 1.5, NaN]) {
    const parsed = inputSchema.safeParse({ chapter });
    assert.equal(parsed.success, false, `chapter=${chapter} 应校验失败`);
  }
});

test('⑤ 合法回号但语料缺失：抛错「第 N 回原文不存在」（总台映射 404 口径）', async () => {
  const index = loadFixtureIndex();
  const { callTool } = captureTool(index);

  await assert.rejects(
    () => callTool({ chapter: 50 }),
    (error: Error) => {
      assert.equal(error.message, '第 50 回原文不存在');
      return true;
    },
  );
});

test('⑥ getChapter 直接调用：缺失回与工具层同口径（SangoIndex 层独立验证）', () => {
  const index = loadFixtureIndex();
  assert.throws(() => index.getChapter(50), /第 50 回原文不存在/);
});
