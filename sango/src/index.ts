/**
 * sango — 三国演义检索 MCP（feat-A004）
 *
 * 装配层：加载检索索引 → 注册唯一工具 sango_novel_search → 连接 stdio。
 * 工具定义与处理逻辑见 tools/sango-novel-search.ts；检索核心见 search/sango-index.ts。
 * 工具名 / 参数不变；出参为结构化条目数组（feat-A004 契约，见接口文档「输出（命中）」）。
 *
 * 日志只写 stderr；stdout 走 MCP 协议（stdio）。
 */
import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SangoIndex } from './search/sango-index.ts';
import { registerSangoNovelChapter } from './tools/sango-novel-chapter.ts';
import { registerSangoNovelSearch } from './tools/sango-novel-search.ts';
import { registerSangoQueryEmbed } from './tools/sango-query-embed.ts';

const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };

const index = new SangoIndex();

const server = new McpServer({ name: 'sango', version });

async function main() {
  index.load();
  console.error(`[sango] corpus 已加载：${index.n} chunk`);
  registerSangoNovelSearch(server.registerTool.bind(server), index);
  registerSangoNovelChapter(server.registerTool.bind(server), index);
  // feat-A013：内部工具 sango_query_embed（语义缓存判定用），不依赖 SangoIndex 实例（§1.7.1）
  registerSangoQueryEmbed(server.registerTool.bind(server));
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[sango] MCP Server running on stdio');
}

main().catch((error) => {
  console.error('[sango] 启动失败：', error);
  process.exit(1);
});
