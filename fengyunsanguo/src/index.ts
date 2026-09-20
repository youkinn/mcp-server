/**
 * fengyunsanguo — 风云三国招募题库 MCP（feat-A005）
 *
 * 装配层：加载题库 → 注册三工具（fengyunsanguo_query / fengyunsanguo_quiz_command /
 * fengyunsanguo_quiz_route）→ 连接 stdio。服务逻辑见 fengyunsanguo-service.ts，
 * 工具定义与处理逻辑见 tools/fengyunsanguo-tools.ts。
 * 日志只写 stderr；stdout 走 MCP 协议（stdio）。
 */
import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { FengyunsanguoService } from './fengyunsanguo-service.ts';
import { registerFengyunsanguoTools } from './tools/fengyunsanguo-tools.ts';

const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };

const service = new FengyunsanguoService();

const server = new McpServer({ name: 'fengyunsanguo', version });

async function main() {
  console.error(`[fengyunsanguo] 题库已加载：${service.questionCount} 题`);
  registerFengyunsanguoTools(server.registerTool.bind(server), service);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[fengyunsanguo] MCP Server running on stdio');
}

main().catch((error) => {
  console.error('[fengyunsanguo] 启动失败：', error);
  process.exit(1);
});
