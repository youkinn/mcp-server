/**
 * sango_novel_search 工具：定义与处理逻辑。
 * 独立成文件，避免处理函数堆在 index.ts 装配层；装配层把已 bind(server) 的
 * registerTool 与 SangoIndex 实例作为入参传入。
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { NO_HIT_TEXT, SangoIndex } from '../search/sango-index.ts';

/** limit 上限：超出按上限截断，不报错（契约「输入」表）。 */
const MAX_LIMIT = 20;

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
      description:
        '检索《三国演义》原著原文段落。仅当用户询问《三国演义》原著情节、人物、事件等需要原文依据的问题时调用；回答前必须先调用本工具取得原文，禁止凭记忆作答。与题库工具 sango_query（风云三国游戏武将招募题）不同，本工具只检索原著文本。每次调用返回结构化条目数组（字段见「输出（命中）」），不返回拼接文本块、不含出处头。',
      inputSchema: z.object({
        source: z.enum(['sanguo-yanyi', 'sanguozhi']).describe('语料来源：sanguo-yanyi（本期）/ sanguozhi（预留）'),
        query: z.string().min(1).describe('检索关键词或句子'),
        limit: z.number().int().min(1).optional().default(5).describe(`返回条数，默认 5，最大 ${MAX_LIMIT}（超出按 ${MAX_LIMIT} 截断）`),
      }),
    },
    async (args) => {
      const { source, query, limit } = args;
      // 按 source 确定语料域：sanguozhi 虽在枚举中预留，本期不可用于检索，按未支持处理（同非法 source 报错路径）。
      if (source !== 'sanguo-yanyi') {
        throw new Error(`不支持的 source：${source}，本期仅支持 sanguo-yanyi`);
      }
      // 上限按契约截断而非报错（超出即入参校验失败不符合「超出按 20 截断，不报错」）
      const entries = await index.search(query, Math.min(limit, MAX_LIMIT));
      if (entries.length === 0) {
        return { content: [{ type: 'text' as const, text: NO_HIT_TEXT }] };
      }
      // 出参为结构化条目数组，JSON 序列化进 MCP 文本内容；条目文本内不含出处 / 回目 / 段号 / 类型 / 分数。
      return { content: [{ type: 'text' as const, text: JSON.stringify(entries) }] };
    },
  );
}
