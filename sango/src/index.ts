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
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { DEFAULT_DATA_DIR, SangoIndex, resolveRerankScorer } from './search/sango-index.ts';
import { registerSangoNovelChapter } from './tools/sango-novel-chapter.ts';
import { registerSangoNovelSearch } from './tools/sango-novel-search.ts';
import { registerSangoQueryEmbed } from './tools/sango-query-embed.ts';
import { startBenchmarkServer } from './benchmark/server.ts';

const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };

// 自助开关唯一加载点：进程内读本地 .env（按脚本位置解析到 sango 根，不依赖调用方 cwd / CLI 参数）；
// .env 缺失（如生产部署）容错跳过，行为保持默认（off）。
const envFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');
try {
  process.loadEnvFile(envFile);
} catch {
  // .env 不存在或不可读 → 忽略，走默认
}

// FEAT-A030：cross-encoder 重排自助开关（sango/.env，--env-file-if-exists 加载）。
// 默认 off：行为与无重排基线逐字节一致；on 才接入（权重缺失自动退回规则序，不抛错）。
// 口径：on 只代表「接入重排」，不等于 A030 验收通过（定点不倒车 / 拒答#5 仍待复评）；改 .env 后需重启生效。
const rerankMode = process.env.SANGO_RERANKER;
let index: SangoIndex;
if (rerankMode === 'on') {
  const rerankScorer = resolveRerankScorer();
  index = new SangoIndex(DEFAULT_DATA_DIR, rerankScorer ? { rerankScorer } : {});
  console.error(
    rerankScorer
      ? '[sango] 重排开关：on，已接入 cross-encoder 重排（窗口/目录/推理档位见 .env 注释与 reranker.ts）'
      : '[sango] 重排开关：on，但权重缺失未接入（onnx / tokenizer 权重不可用，退回规则序）',
  );
} else {
  index = new SangoIndex(DEFAULT_DATA_DIR);
  console.error('[sango] 重排开关：off（未设或非 on），未接入，行为与默认一致');
}

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
