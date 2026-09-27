/**
 * FEAT-A018 活文档：检索主链路事件名桥接入（§3.1 管线位点 / §3.3 topK 装配 / §4 与多路合并的交互 /
 * §5 eventHit 与 candidates.sources 'event'）。夹具与模块层 self-check 同源（event-table.test.ts）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SangoIndex } from '../../search/sango-index.ts';
import type { RetrievalDiagnostics } from '../../types.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, 'fixture');

function loadFixture(dir: string): SangoIndex {
  const index = new SangoIndex(dir);
  index.load();
  return index;
}

/** 诊断可比拷贝：事件表与实体表为进程内单例，跨索引实例比较时踢掉 eventHit（状态随最后加载者）与墙钟 timing。 */
function comparableDiagnostics(d: RetrievalDiagnostics): unknown {
  return { ...d, eventHit: null, timing: { ...d.timing, bm25: 0, label: 0, merge: 0 } };
}

/** 夹具临摹目录；removedEvents=true 时剔除 events.json（事件路降级基线）。 */
function tempFixture(removedEvents = false): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'a018-ix-'));
  cpSync(FIXTURE_DIR, dir, { recursive: true });
  if (removedEvents) {
    rmSync(path.join(dir, 'corpus', 'events.json'), { force: true });
  }
  return dir;
}

test('① 第二路召回兜底（§3.3）：三路 combined 空 + 事件命中 → final 自 rank 1 由事件组构成（事件内序，乱序防御）', async () => {
  const dir = tempFixture();
  try {
    const index = loadFixture(dir);
    // 表内该行 chunkIds 书序为 [0002:c0001, 0001:c0006]（乱序），事件内序应为 [0001:c0006, 0002:c0001]。
    const result = await index.search('温酒斩华雄是怎么斩的', 5, { diagnostics: true });
    assert.deepEqual(
      result.entries.map((e) => e.id),
      ['sanguo-yanyi:0001:c0006', 'sanguo-yanyi:0002:c0001'],
      'combined 空时由事件组兜底，事件内序',
    );
    const d = result.diagnostics;
    assert.ok(d);
    assert.equal(d.env.degradedBm25Only, true, '夹具无向量 → 纯 BM25');
    assert.equal(d.funnel.mergedCandidates, 0, '兜底不虚构三路候选');
    assert.equal(d.funnel.topN, 2);
    assert.deepEqual(d.candidates, [], 'candidates 仍按 combined 计算');
    assert.ok(d.timing.merge !== null && d.timing.merge >= 0, '桥耗时并入 merge 段');
    const hit = d.eventHit;
    assert.equal(hit.degraded, false);
    assert.equal(hit.normVersion, 'a1b2c3d4');
    assert.equal(hit.groupCount, 1);
    assert.equal(hit.groups.length, 1);
    assert.equal(hit.groups[0].eventId, 'E00501');
    assert.equal(hit.groups[0].eventName, '温酒斩华雄');
    assert.equal(hit.groups[0].matchedAlias, '温酒斩华雄');
    assert.equal(hit.groups[0].type, 'L1');
    assert.equal(hit.groups[0].groupSize, 2);
    assert.equal(hit.groups[0].placedCount, 2);
    assert.deepEqual(hit.groups[0].placedChunkIds, ['sanguo-yanyi:0001:c0006', 'sanguo-yanyi:0002:c0001']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('② 装配（§3.3）：top5 原序原分不变 + 事件组占 rank 6+ 插槽 + candidates 不随桥变化（§4）', async () => {
  const base = tempFixture(true);
  const dir = tempFixture(false);
  try {
    // 事件表为进程内单例：必须先完成基线（降级）检索，再加载正常事件路索引，避免后者状态污染前者。
    const indexB = loadFixture(base); // 事件路降级基线
    const b = await indexB.search('丙丁', 7, { diagnostics: true });
    const indexA = loadFixture(dir); // 正常事件路
    const a = await indexA.search('丙丁', 7, { diagnostics: true });
    assert.equal(b.entries.length, 5, '基线：5 个词法候选');
    assert.equal(a.entries.length, 7, '事件组补足 2 个插槽');
    const baseIds = b.entries.map((e) => e.id);
    const finalIds = a.entries.map((e) => e.id);
    assert.deepEqual(finalIds.slice(0, 5), baseIds, 'top5 原序原分保底（事件命中不走样）');
    assert.deepEqual(finalIds.slice(5), ['sanguo-yanyi:0002:c0001', 'sanguo-yanyi:0002:c0002'], 'rank 6+ 事件组（事件内序）');
    assert.deepEqual(a.diagnostics?.candidates, b.diagnostics?.candidates, 'candidates 仍按三路合并候选池计算，不随桥插入变化');
    const hit = a.diagnostics?.eventHit;
    assert.ok(hit && hit.groupCount === 1);
    assert.equal(hit.groups[0].eventId, 'E00505');
    assert.equal(hit.groups[0].matchedAlias, '丙丁');
    assert.equal(hit.groups[0].placedCount, 2, '整组进插槽');
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('③ limit=5 插槽容量 0（§11）：事件命中仅诊断匹配、出参不变（与现状逐字节一致）', async () => {
  const base = tempFixture(true);
  const dir = tempFixture(false);
  try {
    const indexB = loadFixture(base); // 先基线检索，再加载正常索引（单例顺序依赖，见 ②）
    const b = await indexB.search('丙丁', 5, { diagnostics: true });
    const indexA = loadFixture(dir);
    const a = await indexA.search('丙丁', 5, { diagnostics: true });
    assert.deepEqual(a.entries.map((e) => e.id), b.entries.map((e) => e.id), 'limit=5 自然候选占满前 5，出参与无事件路一致');
    assert.deepEqual(a.diagnostics?.candidates, b.diagnostics?.candidates);
    const hit = a.diagnostics?.eventHit;
    assert.ok(hit && hit.groupCount === 1);
    assert.equal(hit.groups[0].placedCount, 0, '插槽容量 0，组 chunk 不进 final');
    assert.deepEqual(hit.groups[0].placedChunkIds, []);
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('④ 未命中事件路（§5.2）：eventHit 空组（degraded/normVersion 仍可读），其余诊断与现状逐字节一致', async () => {
  const base = tempFixture(true);
  const dir = tempFixture(false);
  try {
    const indexB = loadFixture(base); // 先基线检索，再加载正常索引（单例顺序依赖，见 ②）
    const b = await indexB.search('壬癸', 5, { diagnostics: true });
    const indexA = loadFixture(dir);
    const a = await indexA.search('壬癸', 5, { diagnostics: true });
    assert.deepEqual(a.entries.map((e) => e.id), b.entries.map((e) => e.id));
    assert.ok(a.diagnostics && b.diagnostics);
    assert.deepEqual(comparableDiagnostics(a.diagnostics), comparableDiagnostics(b.diagnostics), '未命中事件路时其余诊断与现状逐字节一致（timing 为墙钟值不进比较）');
    const hit = a.diagnostics?.eventHit;
    assert.ok(hit);
    assert.equal(hit.degraded, false, '表正常路由，未命中事件');
    assert.equal(hit.normVersion, 'a1b2c3d4');
    assert.equal(hit.groupCount, 0);
    assert.deepEqual(hit.groups, []);
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⑤ candidates.sources 可选增 event（§5.3）：候选同时属命中事件组时标记；非事件候选不标记', async () => {
  const dir = tempFixture();
  try {
    const index = loadFixture(dir);
    const result = await index.search('丙丁新篇', 5, { diagnostics: true });
    const d = result.diagnostics;
    assert.ok(d);
    const hitGroup = d.eventHit.groups.find((g) => g.eventId === 'E00506');
    assert.ok(hitGroup, '长 alias 组（丙丁新篇）命中');
    assert.equal(d.eventHit.groupCount, 2, '丙丁新篇 与 丙丁 两组命中');
    assert.equal(hitGroup.placedCount, 1, '组 chunk 0001:c0001 已在 natural top5（头保底），计 placedCount 1');
    const eventCandidate = d.candidates.find((c) => c.chunkId === 'sanguo-yanyi:0001:c0001');
    assert.ok(eventCandidate, '0001:c0001 在三路候选池内（词法命中）');
    assert.ok(eventCandidate.sources.includes('event'), '候选同时属命中事件组 → sources 增 event');
    const plainCandidate = d.candidates.find((c) => c.chunkId === 'sanguo-yanyi:0001:c0002');
    assert.ok(plainCandidate && !plainCandidate.sources.includes('event'), '非事件组成员候选不带 event 来源');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⑥ 空表降级端到端（§2.2）：无 events.json 时检索与工具行为不变，eventHit.degraded=true 可读', async () => {
  const dir = tempFixture(true);
  try {
    const index = loadFixture(dir);
    const result = await index.search('丙丁', 5, { diagnostics: true });
    assert.ok(result.entries.length >= 1, '无事件表不阻断检索');
    const hit = result.diagnostics?.eventHit;
    assert.ok(hit && hit.degraded === true && hit.normVersion === '' && hit.groupCount === 0, '降级可观测');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
