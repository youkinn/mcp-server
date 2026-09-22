/**
 * sango_novel_chapter 工具：定义与处理逻辑（feat-A010）。
 * 按回取整回原文，复用 SangoIndex 已加载语料（getChapter），不新建索引、不改语料。
 * 本工具仅供后台 HTTP 通道直调，总台白名单过滤后模型不可见（见接口文档 §四）。
 * 独立成文件，处理函数与装配分离，同 registerSangoNovelSearch 模式。
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { SangoIndex } from '../search/sango-index.ts';

/**
 * 注册 sango_novel_chapter：入参回号，返回整回原文 + 相邻回目。
 * @param registerTool - server.registerTool（已 bind(server)，依赖 this）。
 * @param index - 已加载的检索索引实例。
 */
export function registerSangoNovelChapter(
  registerTool: McpServer['registerTool'],
  index: SangoIndex,
): void {
  registerTool(
    'sango_novel_chapter',
    {
      description:
        '按回返回《三国演义》原著整回原文（后台服务直调专用，模型不可调用）：入参 chapter（回号 1~120），返回 { chapter, title, prev, next, chunks[] }，chunks[] 条目字段为 chunkId / text / type / segFrom / segTo，prev/next 为相邻回 {chapter, title} 或 null。',
      inputSchema: z.object({
        chapter: z.number().int().min(1).max(120).describe('回号，1~120'),
      }),
    },
    async (args) => {
      const payload = index.getChapter(args.chapter);
      // 出参为结构化对象，JSON 序列化进 MCP 文本内容（与 sango_novel_search 同模式）。
      return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
    },
  );
}
