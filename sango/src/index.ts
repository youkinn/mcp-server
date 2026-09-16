/**
 * sango — 三国演义检索 MCP（feat-A004）
 *
 * 装配层：加载检索索引 → 注册唯一工具 sango_novel_search → 连接 stdio。
 * 检索核心见 search/sango-index.ts；工具名 / 参数 / 输出格式保持既有契约。
 *
 * 日志只写 stderr；stdout 走 MCP 协议（stdio）。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { NO_HIT_TEXT, SangoIndex } from './search/sango-index.js';

const index = new SangoIndex();
index.load();
console.error(`[sango] corpus 已加载：${index.n} 段`);

const server = new McpServer({ name: 'sango', version: '1.0.0' });

server.registerTool(
  'sango_novel_search',
  {
    description: '检索《三国演义》原文段落：BM25 + 离线向量混合召回，按相关度降序返回文本块。',
    inputSchema: z.object({
      source: z.enum(['sanguo-yanyi', 'sanguozhi']).describe('语料来源：sanguo-yanyi（本期）/ sanguozhi（预留）'),
      query: z.string().min(1).describe('检索关键词或句子'),
      limit: z.number().int().min(1).max(20).optional().default(5).describe('返回条数，默认 5'),
    }),
  },
  async (args) => {
    const { source, query, limit } = args;
    // 按 source 确定语料域：sanguozhi 本期预留无语料，直接返回无命中话术供模型走兜底。
    if (source !== 'sanguo-yanyi') {
      return { content: [{ type: 'text' as const, text: NO_HIT_TEXT }] };
    }
    const text = index.search(query, limit);
    return { content: [{ type: 'text' as const, text }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);