/**
 * sango 本地 dev 评测执行接口（story-A015-02）：node:http 原生路由，仅绑定 127.0.0.1，
 * 不注册为 MCP 工具、不经总台（mcp-orchestrator），无新增依赖。
 * 成功信封 { code: 200, message: 'ok', data }（对齐 mcp-web api/client.ts 惯例）；失败 { code, message }。
 * 日志一律走 stderr。
 */
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { SangoIndex } from '../search/sango-index.ts';
import { makeRunId, runBenchmark } from './runner.ts';
import { listRunIds, readSnapshot } from './snapshot.ts';
import type { Snapshot } from './snapshot.ts';

/** 路径配置（env，均有默认值，仅本地 dev）。 */
const DEFAULT_BENCHMARK_FILE = 'D:\\workplace\\dev-docs\\docs\\sango-rag-regression-benchmark_v0.1.md';
const DEFAULT_RESULTS_DIR = 'D:\\workplace\\dev-docs\\test\\standard-set\\results';

/** 启动 dev HTTP 服务（SANGO_DEV_HTTP_PORT 是否设置已由 index.ts 判断，这里只负责绑定）。 */
export function startBenchmarkServer(index: SangoIndex, options: { port: number }): Server {
  const benchmarkFile = process.env.SANGO_BENCHMARK_FILE ?? DEFAULT_BENCHMARK_FILE;
  const resultsDir = process.env.SANGO_BENCHMARK_RESULTS_DIR ?? DEFAULT_RESULTS_DIR;
  /** 正在执行的 runId；执行期间收到新 POST 直接 409。 */
  let runningRunId: string | null = null;

  const server = createServer((req, res) => {
    route(req, res).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[benchmark] 请求处理失败：${message}`);
      sendJson(res, 500, { code: 500, message });
    });
  });

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'POST' && url.pathname === '/dev/benchmark/run') {
      if (runningRunId) {
        sendJson(res, 409, { code: 409, message: 'benchmark already running', data: { runId: runningRunId } });
        return;
      }
      const runId = makeRunId();
      runningRunId = runId;
      console.error(`[benchmark] run 开始：${runId}`);
      try {
        const run = await runBenchmark(index, benchmarkFile, resultsDir, runId);
        console.error(`[benchmark] run 完成：${runId} total=${run.summary.total} top5=${run.summary.top5} tail=${run.summary.tail} miss=${run.summary.miss}`);
        sendJson(res, 200, { code: 200, message: 'ok', data: { runId: run.runId, summary: run.summary, results: run.results } });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[benchmark] run 失败：${message}`);
        sendJson(res, 500, { code: 500, message });
      } finally {
        runningRunId = null;
      }
      return;
    }
    if (req.method === 'GET') {
      if (url.pathname === '/dev/benchmark/latest') {
        const runIds = listRunIds(resultsDir);
        const snap = runIds.length > 0 ? readSnapshot(resultsDir, runIds[0]) : null;
        sendJson(res, 200, { code: 200, message: 'ok', data: snap ? snapshotData(snap) : null });
        return;
      }
      if (url.pathname === '/dev/benchmark/history') {
        const history = listRunIds(resultsDir)
          .map((runId) => readSnapshot(resultsDir, runId))
          .filter((s): s is Snapshot => s !== null)
          .map((s) => ({ runId: s.runId, time: s.time, summary: s.summary }));
        sendJson(res, 200, { code: 200, message: 'ok', data: history });
        return;
      }
      if (url.pathname === '/dev/benchmark/snapshot') {
        const runId = url.searchParams.get('runId') ?? '';
        const snap = readSnapshot(resultsDir, runId);
        if (!snap) {
          sendJson(res, 404, { code: 404, message: `snapshot not found: ${runId}` });
          return;
        }
        sendJson(res, 200, { code: 200, message: 'ok', data: snapshotData(snap) });
        return;
      }
    }
    sendJson(res, 404, { code: 404, message: 'not found' });
  }

  server.listen(options.port, '127.0.0.1');
  server.on('error', (error) => {
    console.error(`[benchmark] dev HTTP 启动失败（port ${options.port}）：`, error);
  });
  console.error(`[benchmark] dev server: http://127.0.0.1:${options.port}（benchmark=${benchmarkFile}，results=${resultsDir}）`);
  return server;
}

/** GET latest / snapshot 的出参 data 结构：快照 + runId/time 展平。 */
function snapshotData(snap: Snapshot): { runId: string; time: string; summary: Snapshot['summary']; results: Snapshot['results'] } {
  return { runId: snap.runId, time: snap.time, summary: snap.summary, results: snap.results };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
