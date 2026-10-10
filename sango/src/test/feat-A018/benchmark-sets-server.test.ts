/**
 * FEAT-A018 story-A018-03 活文档：评测控制台多集接口（GET /sets、POST run 带 setId、latest / history /
 * snapshot 按集隔离、run-status 带 setId、A015 向后兼容）。契约：docs/feat-A018-eval-console-api.md §2-§3。
 * 用「桩索引 + 合成两集评测集」保证确定性，不依赖真实权重与真实语料。
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { startBenchmarkServer } from '../../benchmark/server.ts';
import type { SangoIndex } from '../../search/sango-index.ts';

/** 桩索引：空检索结果；只验证多集路由 / 落盘隔离，不打判分。 */
function stubIndex(): SangoIndex {
  return {
    docs: [{ chapter: 1, title: '第一回 合成', text: '刘备字玄德。' }],
    n: 1,
    rerankAssembly: () => ({ wired: false, window: 0 }),
    search: async () => ({ entries: [], diagnostics: null }),
  } as unknown as SangoIndex;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function getJson(port: number, pathname: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`);
  return { status: res.status, body: await res.json() };
}

async function postRun(port: number, setId?: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}/dev/benchmark/run`, {
    method: 'POST',
    headers: setId ? { 'content-type': 'application/json' } : undefined,
    body: setId ? JSON.stringify({ setId }) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

/** 轮询 run-status 到该 run 终态（超时 5s），返回 data。 */
async function waitDone(port: number, runId: string): Promise<any> {
  for (let i = 0; i < 100; i++) {
    const { body } = await getJson(port, '/dev/benchmark/run-status');
    const d = body.data;
    if (d.state === 'done' && d.runId === runId) return d;
    if (d.state === 'failed') throw new Error(`run failed: ${d.error}`);
    await sleep(50);
  }
  throw new Error('等待 run done 超时');
}

let dir: string;
let stdResults: string;
let evResults: string;
let server: Server;
let port: number;
const savedEnv: Record<string, string | undefined> = {};

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'a018-sets-'));
  stdResults = path.join(dir, 'std-results');
  evResults = path.join(dir, 'ev-results');
  mkdirSync(stdResults, { recursive: true });
  mkdirSync(evResults, { recursive: true });
  const benchFile = path.join(dir, 'bench.md');
  writeFileSync(
    benchFile,
    ['# 合成评测集', '', '## 一、人物', '', '| # | 问题 | 标准答案 | 证据 |', '|---|---|---|---|', '| 1 | 刘备是谁 | 刘备 | “刘备字玄德” |'].join('\n'),
    'utf8',
  );
  const evalFile = path.join(dir, 'eval-set.json');
  writeFileSync(
    evalFile,
    JSON.stringify({
      meta: { schemaVersion: 1, total: 2 },
      rows: [
        { id: 'L1#E00101', category: 'L1', question: '桃园三结义是哪一回', chunkIds: ['a:c1'], segCount: 1, crossChapter: false },
        { id: '典故#AL0001', category: '典故', question: '「上方谷」出自哪一回', chunkIds: ['a:c2'], segCount: 1, crossChapter: false },
      ],
    }),
    'utf8',
  );
  for (const key of ['SANGO_BENCHMARK_FILE', 'SANGO_BENCHMARK_RESULTS_DIR', 'SANGO_EVENTS_EVAL', 'SANGO_EVENTS_RESULTS_DIR']) {
    savedEnv[key] = process.env[key];
  }
  process.env.SANGO_BENCHMARK_FILE = benchFile;
  process.env.SANGO_BENCHMARK_RESULTS_DIR = stdResults;
  process.env.SANGO_EVENTS_EVAL = evalFile;
  process.env.SANGO_EVENTS_RESULTS_DIR = evResults;
  server = startBenchmarkServer(stubIndex(), { port: 0 });
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

test('① GET /sets：注册表两集（standard=anchor / events=group），含 id / name / file / judge', async () => {
  const { status, body } = await getJson(port, '/dev/benchmark/sets');
  assert.equal(status, 200);
  assert.equal(body.code, 200);
  const ids = body.data.map((s: any) => s.id);
  assert.deepEqual(ids, ['standard', 'events'], '注册顺序：标准集在前');
  const standard = body.data.find((s: any) => s.id === 'standard');
  const events = body.data.find((s: any) => s.id === 'events');
  assert.equal(standard.judge, 'anchor');
  assert.equal(events.judge, 'group');
  assert.equal(typeof standard.name, 'string');
  assert.equal(typeof events.name, 'string');
  assert.equal(typeof events.file, 'string');
});

test('② POST run 带 setId=events：202 + runId 前缀 feat-A018；latest/history/snapshot 按集隔离', async () => {
  const run = await postRun(port, 'events');
  assert.equal(run.status, 202);
  assert.equal(run.body.data.state, 'running');
  assert.equal(run.body.data.setId, 'events');
  assert.match(run.body.data.runId, /^feat-A018-\d{4}-\d{2}-\d{2}-\d{6}$/, '组集 runId 带秒');
  const done = await waitDone(port, run.body.data.runId);
  assert.equal(done.setId, 'events', 'run-status 带 setId');
  assert.equal(typeof done.elapsedMs, 'number');

  const latest = await getJson(port, '/dev/benchmark/latest?setId=events');
  assert.equal(latest.body.data.summary.judge, 'group', '组集快照 summary.judge');
  assert.equal(latest.body.data.summary.setId, 'events');
  assert.equal(latest.body.data.summary.total, 2);
  assert.equal(latest.body.data.results.length, 2, '组集 2 题全 miss（桩检索空）');
  assert.equal(latest.body.data.results[0].status, 'miss');

  const history = await getJson(port, '/dev/benchmark/history?setId=events');
  assert.equal(history.body.data.length, 1, 'events history 只含本集快照');

  const snap = await getJson(port, `/dev/benchmark/snapshot?runId=${run.body.data.runId}`);
  assert.equal(snap.status, 200, 'snapshot 省略 setId → 按 runId 前缀解析到 events 集');
  assert.equal(snap.body.data.summary.judge, 'group');
});

test('③ POST run 缺省 setId（A015 向后兼容）：runId 前缀 feat-A015、latest/history 走标准集', async () => {
  const run = await postRun(port);
  assert.equal(run.status, 202);
  assert.equal(run.body.data.setId, 'standard');
  assert.match(run.body.data.runId, /^feat-A015-\d{4}-\d{2}-\d{2}-\d{4}$/, '锚集 runId 沿用 HHMM');
  await waitDone(port, run.body.data.runId);

  const latest = await getJson(port, '/dev/benchmark/latest');
  assert.equal(latest.body.data.summary.judge, undefined, '锚集 summary 无 judge（缺字段前端显示「—」）');
  assert.equal(latest.body.data.summary.runId, run.body.data.runId, 'latest 缺省 = 标准集');

  const history = await getJson(port, '/dev/benchmark/history');
  assert.equal(history.body.data.length, 1, '标准集 history 只含本集快照');
  assert.equal(history.body.data[0].runId, run.body.data.runId, 'events 快照未混入标准集 history');
});

test('④ 未知 setId：POST run / latest / history / snapshot 均 404', async () => {
  const run = await postRun(port, 'nope');
  assert.equal(run.status, 404);
  assert.equal(run.body.code, 404);
  const latest = await getJson(port, '/dev/benchmark/latest?setId=nope');
  assert.equal(latest.status, 404);
  const history = await getJson(port, '/dev/benchmark/history?setId=nope');
  assert.equal(history.status, 404);
  const snap = await getJson(port, '/dev/benchmark/snapshot?runId=feat-A018-2026-10-10-160000&setId=nope');
  assert.equal(snap.status, 404);
});

test('⑤ POST run 非法 JSON body → 400', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/dev/benchmark/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.code, 400);
});
