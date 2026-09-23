/**
 * feat-A013 §1.7.1 活文档：sango_query_embed 内部工具单测（测试即文档）。
 *
 * 覆盖契约：工具名与 description / inputSchema（query 字符串）/ 成功出参 JSON
 * （dim:1024、encoding:"base64-float32-le"、data = Float32Array(1024) 底层 buffer 的 base64）/
 * 失败统一固定文案（query 超限 / 空串 / 权重缺失 embedFn=null / 推理失败抛错一律 isError 同文案）/
 * 不携带 _meta（不产诊断）。embedFn 注入假实现（真编码依赖 ~2.1GB 权重，失败路径即降级语义）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  registerSangoQueryEmbed,
  SANGO_QUERY_EMBED_ERROR_TEXT,
} from '../../tools/sango-query-embed.ts';

type EmbedFn = (query: string) => Promise<Float32Array | null>;
type ToolResult = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
};
type ToolInputSchema = { safeParse: (v: unknown) => { success: boolean } };

/** 截获 registerTool 注册的处理函数 / 入参 schema / 工具名，直接调用工具层（不经 stdio）。 */
function captureTool(embedFn: EmbedFn): {
  callTool: (args: { query?: unknown }) => Promise<ToolResult>;
  inputSchema: ToolInputSchema;
  registeredName: string;
  registeredConfig: { description: string };
} {
  let handler: unknown;
  let inputSchema: unknown;
  let registeredName = '';
  let registeredConfig: { description: string } = { description: '' };
  const fakeRegisterTool = ((
    name: string,
    config: { description: string; inputSchema: unknown },
    cb: unknown
  ) => {
    registeredName = name;
    registeredConfig = config;
    inputSchema = config.inputSchema;
    handler = cb;
  }) as unknown as McpServer['registerTool'];
  registerSangoQueryEmbed(fakeRegisterTool, embedFn);
  return {
    callTool: handler as (args: { query?: unknown }) => Promise<ToolResult>,
    inputSchema: inputSchema as ToolInputSchema,
    registeredName,
    registeredConfig,
  };
}

/** 确定向量：值 0..1023 的 Float32Array(1024)，便于逐字节对账 base64。 */
function sampleEmbedding(): Float32Array {
  const values = Array.from({ length: 1024 }, (_, i) => i);
  return new Float32Array(values);
}

test('① 工具名 / description / inputSchema 按契约注册（§1.7.1）', () => {
  const { registeredName, registeredConfig, inputSchema } = captureTool(async () => sampleEmbedding());
  assert.equal(registeredName, 'sango_query_embed');
  assert.ok(registeredConfig.description.includes('内部工具'));
  assert.ok(registeredConfig.description.includes('模型不可见'));
  assert.ok(registeredConfig.description.includes('不产诊断'));
  assert.equal(inputSchema.safeParse({ query: 'x' }).success, true);
  assert.equal(inputSchema.safeParse({}).success, false, 'query 必填');
});

test('② 成功出参：JSON 载荷 dim / encoding / data 逐字节对账', async () => {
  const { callTool } = captureTool(async () => sampleEmbedding());
  const result = await callTool({ query: '义释严颜是怎么回事' });
  assert.equal(result.isError, undefined);
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, 'text');
  const payload = JSON.parse(result.content[0].text) as { dim: number; encoding: string; data: string };
  assert.equal(payload.dim, 1024);
  assert.equal(payload.encoding, 'base64-float32-le');
  const expected = Buffer.from(sampleEmbedding().buffer).toString('base64');
  assert.equal(payload.data, expected, 'data = Float32Array(1024) 底层 buffer（little-endian）的 base64');
  assert.equal(Buffer.from(payload.data, 'base64').byteLength, 1024 * 4);
});

test('③ query 超限 / 空串 / 空白：isError 且固定文案（1 ≤ len ≤ 300，超限报 isError）', async () => {
  const { callTool } = captureTool(async () => sampleEmbedding());
  const badQueries = ['', '   ', 'a'.repeat(301)];
  for (const query of badQueries) {
    const result = await callTool({ query });
    assert.equal(result.isError, true, `query=${JSON.stringify(query.slice(0, 8))}… 应 isError`);
    assert.equal(result.content[0].text, SANGO_QUERY_EMBED_ERROR_TEXT, '统一内部错误文案');
  }
});

test('④ 权重缺失（embedFn → null）：isError 固定文案（降级同义，验收 15 权重缺失旁路）', async () => {
  const { callTool } = captureTool(async () => null);
  const result = await callTool({ query: '义释严颜是怎么回事' });
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, SANGO_QUERY_EMBED_ERROR_TEXT);
});

test('⑤ 推理失败（embedFn 抛错）：isError 固定文案（不把内部异常泄漏进出参）', async () => {
  const { callTool } = captureTool(async () => {
    throw new Error('onnx session 崩溃');
  });
  const result = await callTool({ query: '义释严颜是怎么回事' });
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, SANGO_QUERY_EMBED_ERROR_TEXT);
  assert.ok(!result.content[0].text.includes('onnx'), '内部细节不外泄');
});

test('⑥ 不携带 _meta / 诊断（§1.7.1：不产诊断、与 traceId 无关）', async () => {
  const { callTool } = captureTool(async () => sampleEmbedding());
  const success = await callTool({ query: '义释严颜是怎么回事' });
  assert.equal(success._meta, undefined, '成功出参不携带 _meta.diagnostics');
  const failed = await callTool({ query: '' });
  assert.equal(failed._meta, undefined, '失败出参同样不携带 _meta');
});

test('⑦ 成功出参不携带 isError（正常结果与失败形态区分）', async () => {
  const { callTool } = captureTool(async () => sampleEmbedding());
  const result = await callTool({ query: '义释严颜是怎么回事' });
  assert.equal(result.isError, undefined);
});
