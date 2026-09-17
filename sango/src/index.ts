/**
 * sango — 三国演义检索 MCP（feat-A004）
 *
 * 装配层：加载检索索引 → 注册唯一工具 sango_novel_search → 连接 stdio。
 * 工具定义与处理逻辑见 tools/sango-novel-search.ts；检索核心见 search/sango-index.ts。
 * 工具名 / 参数 / 输出格式保持既有契约。
 *
 * 日志只写 stderr；stdout 走 MCP 协议（stdio）。
 */
import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SangoIndex } from './search/sango-index.js';
import { registerSangoNovelSearch } from './tools/sango-novel-search.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };

const index = new SangoIndex();

const server = new McpServer({ name: 'sango', version });

async function main() {
  index.load();
  console.error(`[sango] corpus 已加载：${index.n} 段`);
  registerSangoNovelSearch(server.registerTool.bind(server), index);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[sango] MCP Server running on stdio');
}

main().catch((error) => {
  console.error('[sango] 启动失败：', error);
  process.exit(1);
});