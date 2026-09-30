/**
 * FEAT-A015 test-2241 活文档：评测「停止」能力（POST /run-abort / run-status 终态 aborted）。
 * 契约：dev-docs docs/feat-A015-benchmark-api.md §3、§9。口径：
 * - POST /dev/benchmark/run-abort 仅在「有在跑」时受理（200 { state: 'aborted' } = 请求已受理）；
 *   未在跑 / 已 done 一律 409 { message: 'no running benchmark', data: { runId: null } }（不幂等 200）。
 * - 停止逐题之间生效：runBenchmark 抛 BenchmarkAbortedError，server 映射终态 aborted（非 failed）。
 * - 停止不落快照：results 目录不产生该 run 的 JSON / summary.md；单飞锁随之释放，可立即再跑。
 * 用「慢速桩索引 + 合成评测集」保证确定性，不依赖真实权重与真实语料。
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { startBenchmarkServer } from '../../benchmark/server.ts';
import { BenchmarkAbortedError, runBenchmark } from '../../benchmark/runner.ts';
import type { SangoIndex } from '../../search/sango-index.ts';

/** 合成评测集题数：每题桩检索 20ms，整体约 1s，足够在中途发出停止请求。 */
const ITEM_COUNT = 50;

/** 慢速桩索引：每题固定 20ms 延迟、空检索结果；只验证停止链路，不打判分。 */
function slowStubIndex(): SangoIndex {
  return {
    docs: [{ chapter: 1, title: '第一回 合成', text: '刘备字玄德。' }],
    n: 1,
    rerankAssembly: () => ({ wired: false, window: 0 }),
    search: async () => {
      await new Promise((r) => setTimeout(r, 20));
      return { entries: [], diagnostics: null };
    },
  } as unknown as SangoIndex;
}

/**
 * 写合成评测集：题面 / 答案非空、证据含可定位引号锚「刘备字玄德」（stub 索引 docs 正文含该锚）。
 * bug-00052 后零锚题不参与判分、不触发检索——本测试验证停止链路，夹具必须有锚才能逐题走 search。
 */
function writeBenchmark(dir: string): string {
  const rows = Array.from({ length: ITEM_COUNT }, (_, i) => `| ${i + 1} | 问题${i + 1} | 答案${i + 1} | “刘备字玄德” |`);
  const file = path.join(dir, 'bench.md');
  writeFileSync(file, ['# 合成评测集', '', '## 一、人物', '', '| # | 问题 | 标准答案 | 证据 |', '|---|---|---|---|', ...rows].join('\n'), 'utf8');
  return file;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function postRun(port: number): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}/dev/benchmark/run`, { method: 'POST' });
  return { status: res.status, body: await res.json() };
}

async function postAbort(port: number): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}/dev/benchmark/run-abort`, { method: 'POST' });
  return { status: res.status, body: await res.json() };
}

async function getStatus(port: number): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${port}/dev/benchmark/run-status`);
  return (await res.json()).data;
}

/** 轮询 run-status 到非 running（超时 5s），返回终态 data。 */
async function waitNotRunning(port: number): Promise<any> {
  for (let i = 0; i < 100; i++) {
    const data = await getStatus(port);
    if (data.state !== 'running') return data;
    await sleep(50);
  }
  throw new Error('等待 run 终态超时');
}

let dir: string;
let resultsDir: string;
let server: Server;
let port: number;
const savedEnv: Record<string, string | undefined> = {};

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'a015-abort-'));
  resultsDir = path.join(dir, 'results');
  mkdirSync(resultsDir, { recursive: true });
  savedEnv.SANGO_BENCHMARK_FILE = process.env.SANGO_BENCHMARK_FILE;
  savedEnv.SANGO_BENCHMARK_RESULTS_DIR = process.env.SANGO_BENCHMARK_RESULTS_DIR;
  process.env.SANGO_BENCHMARK_FILE = writeBenchmark(dir);
  process.env.SANGO_BENCHMARK_RESULTS_DIR = resultsDir;
  server = startBenchmarkServer(slowStubIndex(), { port: 0 });
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  port = (server.address() as AddressInfo).port;
});

after(() => {
  server.close();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

test('无在跑时请求停止：run-abort 回 409，data.runId 为 null', async () => {
  const { status, body } = await postAbort(port);
  assert.equal(status, 409);
  assert.equal(body.code, 409);
  assert.equal(body.message, 'no running benchmark');
  assert.deepEqual(body.data, { runId: null });
});

test('停止生效：run 转终态 aborted、results 目录无新快照、单飞释放可立即再跑', async () => {
  const run1 = await postRun(port);
  assert.equal(run1.status, 202);
  assert.equal(run1.body.data.state, 'running');
  const runId1 = run1.body.data.runId as string;

  await sleep(60); // 让 run 至少跑完 1-2 题，确保停止发生在「逐题之间」

  const abort = await postAbort(port);
  assert.equal(abort.status, 200);
  assert.equal(abort.body.data.state, 'aborted'); // 仅表示「请求已受理」

  const final = await waitNotRunning(port);
  assert.equal(final.state, 'aborted');
  assert.equal(final.runId, runId1);
  assert.equal('elapsedMs' in final, false); // aborted 只带 runId，不带 elapsedMs
  assert.equal('error' in final, false); // 不落成 failed

  // 停止不落快照：results 目录不应出现该 run 的 JSON / summary.md
  assert.deepEqual(readdirSync(resultsDir), []);

  // 已 aborted 的 job 再 abort 一律 409（不幂等 200）
  const again = await postAbort(port);
  assert.equal(again.status, 409);

  // 单飞锁已释放：可立即发起新 run（202），随后同样停止以收尾
  const run2 = await postRun(port);
  assert.equal(run2.status, 202);
  assert.equal(run2.body.data.state, 'running');
  const abort2 = await postAbort(port);
  assert.equal(abort2.status, 200);

  const final2 = await waitNotRunning(port);
  assert.equal(final2.state, 'aborted');
  assert.deepEqual(readdirSync(resultsDir), []); // 两次 run 均未落盘
});

test('runner 契约：shouldStop 命中抛 BenchmarkAbortedError，未落快照', async () => {
  const unitDir = mkdtempSync(path.join(tmpdir(), 'a015-abort-unit-'));
  try {
    const benchFile = writeBenchmark(unitDir);
    const unitResults = path.join(unitDir, 'results');
    mkdirSync(unitResults, { recursive: true });
    let calls = 0;
    const index = {
      docs: [{ chapter: 1, title: '第一回 合成', text: '刘备字玄德。' }],
      n: 1,
      rerankAssembly: () => ({ wired: false, window: 0 }),
      search: async () => {
        calls++;
        return { entries: [], diagnostics: null };
      },
    } as unknown as SangoIndex;

    // 第 1 题跑完后再命中停止：覆盖「当前题结束后中断」
    const runId = 'feat-A015-2026-09-29-1600';
    await assert.rejects(
      () => runBenchmark(index, benchFile, unitResults, runId, { shouldStop: () => calls >= 1 }),
      (err: unknown) => err instanceof BenchmarkAbortedError && err.runId === runId,
    );
    assert.equal(calls, 1);
    assert.deepEqual(readdirSync(unitResults), []);
    assert.equal(existsSync(path.join(unitResults, `${runId}.json`)), false);
  } finally {
    rmSync(unitDir, { recursive: true, force: true });
  }
});
