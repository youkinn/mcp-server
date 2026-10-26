/**
 * sango 本地 dev 评测执行接口（story-A015-02 / A018-03）：node:http 原生路由，仅绑定 127.0.0.1，
 * 不注册为 MCP 工具、不经总台（mcp-orchestrator），无新增依赖。
 * 成功信封 { code: 200, message: 'ok', data }（对齐 mcp-web api/client.ts 惯例）；失败 { code, message }。
 * 日志一律走 stderr。
 */
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { SangoIndex } from '../search/sango-index.ts';
import { BenchmarkAbortedError, makeRunId, runBenchmark } from './runner.ts';
import { runGroupBenchmark } from './group-runner.ts';
import { listRunIds, readSnapshot } from './snapshot.ts';
import type { Snapshot } from './snapshot.ts';
import { findSet, findSetByRunId, loadBenchmarkSets } from './sets.ts';
import type { BenchmarkSet } from './sets.ts';

/** 启动 dev HTTP 服务（SANGO_DEV_HTTP_PORT 是否设置已由 index.ts 判断，这里只负责绑定）。 */
export function startBenchmarkServer(index: SangoIndex, options: { port: number }): Server {
  const sets = loadBenchmarkSets();
  /**
   * bug-00049 B 案：run 已异步化，POST 立即 202，进度由 GET /run-status 轮询。
   * 本变量只保留「最近一次 job」的内存态（单进程 dev 工具，重启即丢；running 期间收到新 POST 直接 409）。
   */
  let lastJob: RunJob | null = null;
  /** 停止请求标志（FEAT-A015 test-2241）：受理后置 true，run 在逐题之间检查并抛 BenchmarkAbortedError。 */
  let abortRequested = false;

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
      if (lastJob?.state === 'running') {
        sendJson(res, 409, { code: 409, message: 'benchmark already running', data: { runId: lastJob.runId } });
        return;
      }
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { code: 400, message: 'invalid json body' });
        return;
      }
      const setId =
        body && typeof body === 'object' && typeof (body as { setId?: unknown }).setId === 'string'
          ? (body as { setId: string }).setId
          : null;
      const set = findSet(sets, setId);
      if (!set) {
        sendJson(res, 404, { code: 404, message: `unknown benchmark set: ${setId}` });
        return;
      }
      const runId = makeRunId(set.runIdPrefix, set.withSeconds);
      abortRequested = false;
      lastJob = { state: 'running', runId, setId: set.id };
      console.error(`[benchmark] run 开始：${runId}（set=${set.id}，judge=${set.judge}）`);
      const task =
        set.judge === 'group'
          ? runGroupBenchmark(index, set, runId, { shouldStop: () => abortRequested })
          : runBenchmark(index, set.file, set.resultsDir, runId, { shouldStop: () => abortRequested });
      // 立即回 202（不再同步等待）；run 结果写入 lastJob，失败只留 error 摘要、不回大段堆栈。
      void task
        .then((run) => {
          lastJob = { state: 'done', runId: run.runId, setId: set.id, elapsedMs: run.summary.elapsedMs };
          console.error(
            `[benchmark] run 完成：${runId}（set=${set.id}）total=${run.summary.total} elapsedMs=${run.summary.elapsedMs}`,
          );
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          if (error instanceof BenchmarkAbortedError) {
            // 停止请求：终态 aborted（非 failed），不落快照（run 中止于 writeRun 之前）。
            lastJob = { state: 'aborted', runId: error.runId, setId: set.id };
            console.error(`[benchmark] run 已中止：${error.runId}`);
            return;
          }
          lastJob = { state: 'failed', runId, setId: set.id, error: message };
          console.error(`[benchmark] run 失败：${message}`);
        });
      sendJson(res, 202, { code: 202, message: 'ok', data: { runId, state: 'running', setId: set.id } });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/dev/benchmark/run-abort') {
      // 停止请求：仅「有在跑」时受理（200），run 在当前题结束后中断；未在跑 / 已 done 一律 409（不幂等）。
      if (lastJob?.state !== 'running') {
        sendJson(res, 409, { code: 409, message: 'no running benchmark', data: { runId: null } });
        return;
      }
      abortRequested = true;
      console.error(`[benchmark] run 中止请求已受理：${lastJob.runId}`);
      sendJson(res, 200, { code: 200, message: 'ok', data: { state: 'aborted' } });
      return;
    }
    if (req.method === 'GET') {
      if (url.pathname === '/dev/benchmark/sets') {
        sendJson(res, 200, {
          code: 200,
          message: 'ok',
          data: sets.map((s) => ({ id: s.id, name: s.name, file: s.file, judge: s.judge })),
        });
        return;
      }
      if (url.pathname === '/dev/benchmark/run-status') {
        sendJson(res, 200, { code: 200, message: 'ok', data: runStatusData(lastJob) });
        return;
      }
      if (url.pathname === '/dev/benchmark/latest') {
        const set = resolveRequestSet(sets, url);
        if (!set) {
          sendJson(res, 404, { code: 404, message: `unknown benchmark set: ${url.searchParams.get('setId')}` });
          return;
        }
        const runIds = listRunIds(set.resultsDir);
        const snap = runIds.length > 0 ? readSnapshot(set.resultsDir, runIds[0]) : null;
        sendJson(res, 200, { code: 200, message: 'ok', data: snap ? snapshotData(snap) : null });
        return;
      }
      if (url.pathname === '/dev/benchmark/history') {
        const set = resolveRequestSet(sets, url);
        if (!set) {
          sendJson(res, 404, { code: 404, message: `unknown benchmark set: ${url.searchParams.get('setId')}` });
          return;
        }
        const history = listRunIds(set.resultsDir)
          .map((runId) => readSnapshot(set.resultsDir, runId))
          .filter((s): s is Snapshot => s !== null)
          .map((s) => ({ runId: s.runId, time: s.time, summary: s.summary }));
        sendJson(res, 200, { code: 200, message: 'ok', data: history });
        return;
      }
      if (url.pathname === '/dev/benchmark/snapshot') {
        const runId = url.searchParams.get('runId') ?? '';
        const setId = url.searchParams.get('setId');
        const set = setId ? findSet(sets, setId) : findSetByRunId(sets, runId);
        if (!set) {
          sendJson(res, 404, { code: 404, message: `unknown benchmark set: ${setId}` });
          return;
        }
        const snap = readSnapshot(set.resultsDir, runId);
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
  console.error(`[benchmark] dev server: http://127.0.0.1:${options.port}（sets=${sets.map((s) => s.id).join(',')}）`);
  return server;
}

/** GET latest / snapshot 的出参 data 结构：快照 + runId/time 展平。 */
function snapshotData(snap: Snapshot): { runId: string; time: string; summary: Snapshot['summary']; results: Snapshot['results'] } {
  return { runId: snap.runId, time: snap.time, summary: snap.summary, results: snap.results };
}

/** 从查询参数解析评测集：setId 缺省 = 标准集（A015 向后兼容）；未知 setId 返回 undefined（server 回 404）。 */
function resolveRequestSet(sets: BenchmarkSet[], url: URL): BenchmarkSet | undefined {
  return findSet(sets, url.searchParams.get('setId'));
}

/** 读取请求体 JSON；空 body 返回 null，非法 JSON / 超限抛错（POST run 据此回 400）。 */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > 64 * 1024) throw new Error('body too large');
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return null;
  return JSON.parse(text);
}

/**
 * bug-00049 B 案：最近一次 run 的内存态（单进程 dev 工具，无持久化，重启即丢）。
 * running 期间收到新 POST → 409；done / failed 记录保留到下次 run 启动。
 */
type RunJob =
  | { state: 'running'; runId: string; setId: string }
  | { state: 'done'; runId: string; setId: string; elapsedMs: number }
  | { state: 'failed'; runId: string; setId: string; error: string }
  | { state: 'aborted'; runId: string; setId: string };

/** GET /run-status 出参 data：无在跑且无最近记录 → idle（runId=null）；elapsedMs 取自 summary.elapsedMs。 */
function runStatusData(job: RunJob | null): { state: string; runId: string | null; setId?: string; elapsedMs?: number; error?: string } {
  if (!job) return { state: 'idle', runId: null };
  if (job.state === 'done') return { state: 'done', runId: job.runId, setId: job.setId, elapsedMs: job.elapsedMs };
  if (job.state === 'failed') return { state: 'failed', runId: job.runId, setId: job.setId, error: job.error };
  if (job.state === 'aborted') return { state: 'aborted', runId: job.runId, setId: job.setId };
  return { state: 'running', runId: job.runId, setId: job.setId };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
