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
import { DEFAULT_DATA_DIR, SangoIndex } from './search/sango-index.ts';
import { registerSangoNovelChapter } from './tools/sango-novel-chapter.ts';
import { registerSangoNovelSearch } from './tools/sango-novel-search.ts';
import { registerSangoQueryEmbed } from './tools/sango-query-embed.ts';
import { startBenchmarkServer } from './benchmark/server.ts';

const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };

// FEAT-A030：cross-encoder 重排已实现并可一行接入（createDataRerankScorer），但定点评测结论为「本期不启用」：
// int8 bge-reranker-base 50 路重排 P50 ≈ 4.1s / P95 ≈ 4.7s（远超检索预算），且定点华雄「拒答#5」证据段
// 由 rank6 跌出 top10（不倒车未达标）；评测证据见 scripts/verify-rerank.mjs 产出。
// 启用方式：new SangoIndex(DEFAULT_DATA_DIR, { rerankScorer: createDataRerankScorer() })（需重建/下发权重）。
const index = new SangoIndex(DEFAULT_DATA_DIR);

const server = new McpServer({ name: 'sango', version });

async function main() {
  index.load();
  console.error(`[sango] corpus 已加载：${index.n} chunk`);
  // story-A015-02：本地 dev 评测执行接口；仅当显式设置 SANGO_DEV_HTTP_PORT 时启动（生产 stdio 零影响）
  const devPortRaw = process.env.SANGO_DEV_HTTP_PORT;
  if (devPortRaw !== undefined && devPortRaw !== '') {
    const port = Number(devPortRaw) || 8787;
    startBenchmarkServer(index, { port });
  }
  registerSangoNovelSearch(server.registerTool.bind(server), index);
  registerSangoNovelChapter(server.registerTool.bind(server), index);
  // feat-A013：内部工具 sango_query_embed（语义缓存判定用），不依赖 SangoIndex 实例（§1.7.1）；
  // FEAT-A016 §3.2：工具内部经 entity-table 单例 normalize（index.load() 已加载同表，口径同源）
  registerSangoQueryEmbed(server.registerTool.bind(server));
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[sango] MCP Server running on stdio');
}

main().catch((error) => {
  console.error('[sango] 启动失败：', error);
  process.exit(1);
});
