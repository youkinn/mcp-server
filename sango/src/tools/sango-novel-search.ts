/**
 * sango_novel_search 工具：定义与处理逻辑。
 * 独立成文件，避免处理函数堆在 index.ts 装配层；装配层把已 bind(server) 的
 * registerTool 与 SangoIndex 实例作为入参传入。
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { NO_HIT_TEXT, SangoIndex } from '../search/sango-index.ts';

/**
 * 注册 sango_novel_search：BM25 + 离线向量混合召回，按相关度降序返回原文段落。
 * @param registerTool - server.registerTool（已 bind(server)，依赖 this）。
 * @param index - 已加载的检索索引实例。
 */
export function registerSangoNovelSearch(
  registerTool: McpServer['registerTool'],
  index: SangoIndex,
): void {
  registerTool(
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
}
