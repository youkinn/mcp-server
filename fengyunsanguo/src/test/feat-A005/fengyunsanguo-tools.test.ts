/**
 * feat-A005 契约测试：fengyunsanguo 三工具的工具名 / 入参 schema / 出参格式。
 * 截获 registerTool 注册的处理函数与入参 schema（不经 stdio），与 A004 检索索引测试同模式。
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  FengyunsanguoService,
  FENGYUNSANGUO_NO_SESSION_PROMPT,
  type FengyunsanguoQuestion,
} from '../../fengyunsanguo-service.ts';
import { registerFengyunsanguoTools } from '../../tools/fengyunsanguo-tools.ts';

const Q1: FengyunsanguoQuestion = {
  question: '夏侯惇的字是什么？',
  options: { A: '元让', B: '妙才', C: '子龙', D: '云长' },
  answer: '元让',
};

const Q2: FengyunsanguoQuestion = {
  question: '吕布的字是什么？',
  options: { A: '奉孝', B: '奉先', C: '公瑾', D: '伯符' },
  answer: '奉先',
};

function writeQuestionFile(entries: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'fengyunsanguo-tools-'));
  const file = join(dir, 'questions.json');
  writeFileSync(file, JSON.stringify(entries), 'utf8');
  return file;
}

function makeService(
  t: TestContext,
  entries: unknown[] = [Q1, Q2]
): FengyunsanguoService {
  const file = writeQuestionFile(entries);
  t.after(() => cleanupQuestionFile(file));
  return new FengyunsanguoService({ questionFile: file });
}

function cleanupQuestionFile(file: string): void {
  rmSync(dirname(file), { recursive: true, force: true });
}

type ToolResult = { content: Array<{ text: string }> };
type ToolInputSchema = { safeParse: (v: unknown) => { success: boolean; data?: unknown } };

/** 截获三工具注册：返回 name → { callTool, inputSchema }，直接调用工具层（不经 stdio）。 */
function captureTools(service: FengyunsanguoService): Record<
  string,
  { callTool: (args: Record<string, unknown>) => Promise<ToolResult>; inputSchema: ToolInputSchema }
> {
  const tools: Record<
    string,
    { callTool: (args: Record<string, unknown>) => Promise<ToolResult>; inputSchema: ToolInputSchema }
  > = {};
  const fakeRegisterTool = ((name: string, config: { inputSchema: unknown }, cb: unknown) => {
    tools[name] = {
      inputSchema: config.inputSchema as ToolInputSchema,
      callTool: cb as (args: Record<string, unknown>) => Promise<ToolResult>,
    };
  }) as unknown as McpServer['registerTool'];
  registerFengyunsanguoTools(fakeRegisterTool, service);
  return tools;
}

test('工具契约: 注册三个工具，工具名与契约一致', (t) => {
  const tools = captureTools(makeService(t));
  assert.deepEqual(Object.keys(tools).sort(), [
    'fengyunsanguo_query',
    'fengyunsanguo_quiz_command',
    'fengyunsanguo_quiz_route',
  ]);
});

test('query 入参：text 必填非空，limit 默认 1 且最小 1，超出上限由工具层截断', (t) => {
  const tools = captureTools(makeService(t));
  const schema = tools['fengyunsanguo_query']!.inputSchema;

  assert.equal(schema.safeParse({ text: '夏侯惇的字是什么？' }).success, true);
  const parsed = schema.safeParse({ text: '夏侯惇的字是什么？' });
  assert.ok(parsed.success);
  assert.equal((parsed.data as { limit: number }).limit, 1, 'limit 缺省默认 1');
  assert.equal(schema.safeParse({}).success, false, 'text 必填');
  assert.equal(schema.safeParse({ text: '' }).success, false, 'text 空串拒绝');
  assert.equal(schema.safeParse({ text: 'x', limit: 0 }).success, false, 'limit 下限 1');
  assert.equal(schema.safeParse({ text: 'x', limit: 1.5 }).success, false, 'limit 必须整数');
  assert.equal(schema.safeParse({ text: 'x', limit: 999 }).success, true, 'limit 不设上限，由工具层截断');
});

test('query 出参：编号列表「题干 → 答案」，未收录固定话术，limit 生效', async (t) => {
  const service = makeService(t);
  const tools = captureTools(service);

  const one = await tools['fengyunsanguo_query']!.callTool({ text: '夏侯惇的字是什么？', limit: 1 });
  assert.equal(one.content[0]!.text, '1. 夏侯惇的字是什么？ → 元让', 'limit 默认 1 只回 top1');

  const two = await tools['fengyunsanguo_query']!.callTool({ text: '夏侯惇的字是什么？', limit: 2 });
  assert.deepEqual(
    two.content[0]!.text.split('\n'),
    ['1. 夏侯惇的字是什么？ → 元让', '2. 吕布的字是什么？ → 奉先'],
    'limit=2 按相关度降序返回编号列表'
  );

  const capped = await tools['fengyunsanguo_query']!.callTool({ text: '的字是什么', limit: 999 });
  assert.ok(capped.content[0]!.text.split('\n').length <= 8, 'limit 超出按 8 截断');

  const none = await tools['fengyunsanguo_query']!.callTool({ text: '完全不存在的问题' });
  assert.equal(none.content[0]!.text, '未召回到任何候选题目');
});

test('quiz_command 入参：message 必填非空，sessionId 可选（缺省 / 空串均视为无会话）', (t) => {
  const tools = captureTools(makeService(t));
  const schema = tools['fengyunsanguo_quiz_command']!.inputSchema;

  assert.equal(schema.safeParse({ message: '随机一题' }).success, true);
  assert.equal(schema.safeParse({ message: '随机一题', sessionId: 'sid-1' }).success, true);
  assert.equal(schema.safeParse({ message: '随机一题', sessionId: '' }).success, true, '空串 sessionId 视为未传');
  assert.equal(schema.safeParse({}).success, false, 'message 必填');
  assert.equal(schema.safeParse({ message: '' }).success, false, 'message 空串拒绝');
});

test('quiz_command 全流程：随机一题 → 判对 / 判错附答案 / 查答案 / 无会话提示', async (t) => {
  const service = makeService(t);
  const tools = captureTools(service);
  const quiz = tools['fengyunsanguo_quiz_command']!;

  const out = await quiz.callTool({ message: '随机一题', sessionId: 'sid-flow' });
  assert.match(out.content[0]!.text, /^题目：.+\nA\. .+\nB\. .+\nC\. .+\nD\. .+$/);
  assert.ok(!out.content[0]!.text.includes('正确答案'), '出题不含答案标注');

  const current = service.getCurrentQuestion('sid-flow');
  assert.ok(current);
  const answer = service.answerOf(current!);

  const right = await quiz.callTool({ message: answer.key, sessionId: 'sid-flow' });
  assert.equal(right.content[0]!.text, `答对了！正确答案：${answer.text}（${answer.key}）`);

  const wrongKey = (['A', 'B', 'C', 'D'] as const).find((key) => key !== answer.key)!;
  const wrong = await quiz.callTool({ message: current!.options[wrongKey], sessionId: 'sid-flow' });
  assert.equal(wrong.content[0]!.text, `答错了，正确答案：${answer.text}（${answer.key}）`);

  const reveal = await quiz.callTool({ message: '这题选什么？', sessionId: 'sid-flow' });
  assert.equal(reveal.content[0]!.text, `正确答案：${answer.text}（${answer.key}）`);

  const noSession = await quiz.callTool({ message: 'A' });
  assert.equal(noSession.content[0]!.text, FENGYUNSANGUO_NO_SESSION_PROMPT);
  const emptySession = await quiz.callTool({ message: 'A', sessionId: '' });
  assert.equal(emptySession.content[0]!.text, FENGYUNSANGUO_NO_SESSION_PROMPT, '空串 sessionId 等价无会话');
});

test('quiz_command 会话隔离：按 sessionId 独立，互相不影响', async (t) => {
  const service = makeService(t);
  const tools = captureTools(service);
  const quiz = tools['fengyunsanguo_quiz_command']!;

  await quiz.callTool({ message: '随机一题', sessionId: 'sid-a' });
  const b = await quiz.callTool({ message: '答案', sessionId: 'sid-b' });
  assert.equal(b.content[0]!.text, FENGYUNSANGUO_NO_SESSION_PROMPT, 'sid-b 未出题，不受 sid-a 会话影响');
  const a = await quiz.callTool({ message: '答案', sessionId: 'sid-a' });
  assert.match(a.content[0]!.text, /^正确答案：.+（[A-D]）$/);
});

test('quiz_route 入参：text 必填非空', (t) => {
  const tools = captureTools(makeService(t));
  const schema = tools['fengyunsanguo_quiz_route']!.inputSchema;

  assert.equal(schema.safeParse({ text: '夏侯惇的字是什么？' }).success, true);
  assert.equal(schema.safeParse({}).success, false);
  assert.equal(schema.safeParse({ text: '' }).success, false);
});

test('quiz_route 识别：题库问句（含换问法）返回 true，无关问句返回 false', async (t) => {
  const tools = captureTools(makeService(t));
  const route = tools['fengyunsanguo_quiz_route']!;

  const hit = await route.callTool({ text: '夏侯惇的字是什么？' });
  assert.equal(hit.content[0]!.text, 'true');
  const rephrase = await route.callTool({ text: '夏侯惇字什么' });
  assert.equal(rephrase.content[0]!.text, 'true', '换问法经词法相似度命中');
  const miss = await route.callTool({ text: '今天天气如何' });
  assert.equal(miss.content[0]!.text, 'false');
});



