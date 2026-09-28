/**
 * FEAT-A018 活文档：检索主链路事件名桥接入（§3.1 管线位点 / §3.3 并池重排 + L3 锚点置顶 /
 * §5 eventHit 与 candidates.sources 'event'）。夹具与模块层 self-check 同源（event-table.test.ts）。
 * 契约：docs/feat-A018-event-table-interface.md（口径唯一来源 requirements/feat-A018-event-table.md）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

/**
 * 合成重排夹具（10 chunk，单回）：c0001=答案段 A（含事件名「赤壁之战」）、c0002=次组 chunk B
 * （含「火攻之计」）、c0003-c0010=干扰段（高重叠 query 词元）——用于验证「增强查询重排把答案段提进窗」
 * 与「多组命中取优先级最高组」。withEvents=false 剔除 events.json 作降级基线。
 */
function writeRerankCorpus(dir: string, withEvents: boolean): void {
  const corpusDir = path.join(dir, 'corpus', 'sanguo-yanyi');
  mkdirSync(corpusDir, { recursive: true });
  const texts = ['赤壁之战大破曹军。', '火攻之计甚是精妙。'];
  for (let i = 0; i < 8; i++) texts.push('周郎火攻，战况如何？战况如何？');
  const chunks = texts.map((text, i) => ({
    id: `sanguo-yanyi:0001:c${String(i + 1).padStart(4, '0')}`,
    text,
    type: 'narration',
    segFrom: 1,
    segTo: 1,
    quoteBalanced: true,
    quotes: [],
  }));
  writeFileSync(
    path.join(corpusDir, '001.json'),
    JSON.stringify({ source: 'sanguo-yanyi', chapter: 1, title: '第一回 合成', chunks }),
    'utf8',
  );
  if (withEvents) {
    writeFileSync(
      path.join(dir, 'corpus', 'events.json'),
      JSON.stringify({
        meta: { schemaVersion: 1, normVersion: 'feed0001', generatedAt: '2026-09-28T00:00:00.000Z', corpusChunkCount: 10 },
        rows: [
          { eventId: 'E1', eventName: '赤壁之战', aliases: ['周郎火攻'], chunkIds: ['sanguo-yanyi:0001:c0001'], type: 'L1' },
          { eventId: 'E2', eventName: '火攻之计', aliases: ['火攻'], chunkIds: ['sanguo-yanyi:0001:c0002'], type: 'L1' },
        ],
      }),
      'utf8',
    );
  }
}

const RERANK_QUERY = '周郎火攻的战况如何';
const ANSWER_ID = 'sanguo-yanyi:0001:c0001';

test('① 并池（§3.3③）：三路 combined 空 + L1 事件命中 → 组 chunk 并池构成出参（事件内序）', async () => {
  const dir = tempFixture();
  try {
    const index = loadFixture(dir);
    // 表内该行 chunkIds 书序为 [0002:c0001, 0001:c0006]（乱序），事件内序应为 [0001:c0006, 0002:c0001]。
    const result = await index.search('温酒斩华雄是怎么斩的', 5, { diagnostics: true });
    assert.deepEqual(
      result.entries.map((e) => e.id),
      ['sanguo-yanyi:0001:c0006', 'sanguo-yanyi:0002:c0001'],
      '三路空时由并池构成出参，事件内序',
    );
    const d = result.diagnostics;
    assert.ok(d);
    assert.equal(d.env.degradedBm25Only, true, '夹具无向量 → 纯 BM25');
    assert.equal(d.funnel.mergedCandidates, 0, '漏斗只描述三路召回：并池不进 mergedCandidates（§4）');
    assert.equal(d.funnel.topN, 2);
    assert.deepEqual(
      d.candidates.map((c) => c.chunkId),
      ['sanguo-yanyi:0001:c0006', 'sanguo-yanyi:0002:c0001'],
      'candidates 按重排后池序（并池构成）',
    );
    assert.ok(d.candidates.every((c) => c.sources.includes('event')), '并池候选带 event 来源');
    assert.ok(d.timing.merge !== null && d.timing.merge >= 0, '桥耗时并入 merge 段');
    const hit = d.eventHit;
    assert.equal(hit.degraded, false);
    assert.equal(hit.normVersion, 'a1b2c3d4');
    assert.equal(hit.groupCount, 1);
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

test('② 并池去重（§3.3③）：组 chunk 已在三路池内 → doc 下标并集去重、无来源配额、无重复候选', async () => {
  const dir = tempFixture();
  try {
    const index = loadFixture(dir);
    // 三路词法命中 0001:c0001..c0005（含「丙丁」）；组 E00506 chunk 0001:c0001 已在池内（去重），
    // 组 E00505 chunk 0002:c0001/c0002 池内缺席（并入）→ 合并池共 7 条。
    const result = await index.search('丙丁新篇', 5, { diagnostics: true });
    const d = result.diagnostics;
    assert.ok(d);
    assert.equal(d.funnel.mergedCandidates, 5, '三路词法命中 5 条（漏斗口径不变）');
    assert.equal(d.candidates.length, 7, '并池后 7 条（并集去重）');
    const ids = d.candidates.map((c) => c.chunkId);
    assert.equal(new Set(ids).size, ids.length, '无重复候选（doc 下标并集去重）');
    assert.ok(ids.includes('sanguo-yanyi:0001:c0001'), '与三路重叠的组 chunk 只出现一次');
    assert.equal(ids.filter((id) => id === 'sanguo-yanyi:0001:c0001').length, 1);
    assert.ok(ids.includes('sanguo-yanyi:0002:c0001') && ids.includes('sanguo-yanyi:0002:c0002'), '池内缺席的组 chunk 并入');
    assert.deepEqual(d.eventHit.groups.map((g) => g.eventId), ['E00506', 'E00505'], '多组命中按组优先级（长 alias 先行）');
    assert.equal(d.eventHit.groupCount, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('③ 增强查询重排（§3.3④）：「赤壁之战」答案段借增强查询 BM25 进 top5（对照无事件表基线）', async () => {
  const base = mkdtempSync(path.join(tmpdir(), 'a018-rr-b-'));
  const dir = mkdtempSync(path.join(tmpdir(), 'a018-rr-'));
  try {
    writeRerankCorpus(base, false);
    writeRerankCorpus(dir, true);
    const idxB = loadFixture(base); // 无事件表：无并池 / 无增强重排
    const b = await idxB.search(RERANK_QUERY, 5, { diagnostics: true });
    assert.ok(!b.entries.some((e) => e.id === ANSWER_ID), '基线：答案段（仅含事件名词元）不在 top5');
    const idxA = loadFixture(dir);
    const a = await idxA.search(RERANK_QUERY, 5, { diagnostics: true });
    assert.equal(a.entries[0].id, ANSWER_ID, '增强查询重排后答案段进 top5（第 1 名）');
    const d = a.diagnostics;
    assert.ok(d);
    const group = d.eventHit.groups.find((g) => g.eventId === 'E1');
    assert.ok(group && group.placedChunkIds.includes(ANSWER_ID), 'eventHit 记为已放置');
    // 复算恒等式（bug-00013）：增强重排后 candidates 仍可由 bm25Norm/cosine/labelHit 复算 finalScore
    for (const c of d.candidates) {
      const recomputed = Math.round((0.3 * (c.bm25Norm ?? 0) + 0.6 * (((c.cosine ?? -1) + 1) / 2) + 0.1 * (c.labelHit ? 1 : 0)) * 1000) / 1000;
      assert.equal(recomputed, c.finalScore, `rank${c.rank} 增强重排后复算恒等式成立`);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('④ 多组命中（§3.3④）：全部命中组并池、诊断按组优先级，增强查询取优先级最高组引导答案段', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'a018-mg-'));
  try {
    writeRerankCorpus(dir, true);
    const index = loadFixture(dir);
    const result = await index.search(RERANK_QUERY, 5, { diagnostics: true });
    const d = result.diagnostics;
    assert.ok(d);
    assert.equal(d.eventHit.groupCount, 2, '两组命中');
    assert.deepEqual(
      d.eventHit.groups.map((g) => [g.eventId, g.matchedAlias]),
      [['E1', '周郎火攻'], ['E2', '火攻']],
      '组优先级：命中 alias 长度降序（周郎火攻 4 > 火攻 2）',
    );
    const ids = d.candidates.map((c) => c.chunkId);
    assert.ok(ids.includes('sanguo-yanyi:0001:c0001') && ids.includes('sanguo-yanyi:0001:c0002'), '两组 chunk 全部并池');
    assert.equal(result.entries[0].id, ANSWER_ID, '增强查询取最高优先组（赤壁之战）→ 答案段进 top5');
    assert.ok(!result.entries.some((e) => e.id === 'sanguo-yanyi:0001:c0002'), '次组 chunk 不因增强查询进窗（增强只取最高组）');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⑤ L3 锚点置顶（§3.3②）：锚点段 ±N 小位点组进保证区、不参与池重排（低分仍置顶），placedChunkIds 事件内序', async () => {
  const dir = tempFixture();
  try {
    const index = loadFixture(dir);
    // E00199 落表口径 = 锚点 ±1 小位点组 0001:c0003/c0004/c0005；query 同时命中 L1 组 E00505（丙丁）。
    const result = await index.search('丙丁刘备之死', 5, { diagnostics: true });
    assert.deepEqual(
      result.entries.slice(0, 3).map((e) => e.id),
      ['sanguo-yanyi:0001:c0003', 'sanguo-yanyi:0001:c0004', 'sanguo-yanyi:0001:c0005'],
      'L3 锚点小位点组置顶保证区（事件内序）',
    );
    const d = result.diagnostics;
    assert.ok(d);
    const group = d.eventHit.groups.find((g) => g.eventId === 'E00199');
    assert.ok(group);
    assert.equal(group.type, 'L3');
    assert.equal(group.groupSize, 3, '组 chunkIds = 落表口径「锚点 ±1」小位点组（3 段，运行期不二次扩展）');
    assert.equal(group.matchedAlias, '刘备之死');
    assert.equal(group.placedCount, 3);
    assert.deepEqual(group.placedChunkIds, ['sanguo-yanyi:0001:c0003', 'sanguo-yanyi:0001:c0004', 'sanguo-yanyi:0001:c0005']);
    // 不参与池重排：置顶段分数低于后续候选但仍占 rank 1-3（保证区按 pin 通道，不按重排分）
    assert.ok(
      d.candidates[3].finalScore > d.candidates[0].finalScore,
      `置顶不按分：rank4 finalScore(${d.candidates[3].finalScore}) > rank1(${d.candidates[0].finalScore})`,
    );
    assert.ok(group.placedChunkIds.every((id) => {
      const c = d.candidates.find((x) => x.chunkId === id);
      return c?.sources.includes('event');
    }), 'L3 锚点段候选带 event 来源');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⑥ 删除插槽后非事件请求输出与现状逐字节一致（有事件表 vs 事件表降级，§4 强回归性质）', async () => {
  const base = tempFixture(true);
  const dir = tempFixture(false);
  try {
    // 事件表为进程内单例：先基线（降级）检索，再加载正常事件路索引。
    const idxB = loadFixture(base);
    const b = await idxB.search('壬癸', 5, { diagnostics: true });
    const idxA = loadFixture(dir);
    const a = await idxA.search('壬癸', 5, { diagnostics: true });
    assert.ok(b.entries.length >= 1);
    assert.deepEqual(a.entries, b.entries, '非事件请求出参逐字节一致');
    assert.ok(a.diagnostics && b.diagnostics);
    assert.deepEqual(comparableDiagnostics(a.diagnostics), comparableDiagnostics(b.diagnostics), '非事件请求其余诊断逐字节一致');
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⑦ 未命中事件路（§5.2）：eventHit 空组（degraded/normVersion 仍可读），出参不变', async () => {
  const base = tempFixture(true);
  const dir = tempFixture(false);
  try {
    const idxB = loadFixture(base);
    const b = await idxB.search('壬癸', 5, { diagnostics: true });
    const idxA = loadFixture(dir);
    const a = await idxA.search('壬癸', 5, { diagnostics: true });
    assert.deepEqual(a.entries.map((e) => e.id), b.entries.map((e) => e.id));
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

test('⑧ candidates.sources 可选增 event（§5.3）：候选同时属命中事件组时标记；非事件候选不标记', async () => {
  const dir = tempFixture();
  try {
    const index = loadFixture(dir);
    const result = await index.search('丙丁新篇', 6, { diagnostics: true });
    const d = result.diagnostics;
    assert.ok(d);
    const hitGroup = d.eventHit.groups.find((g) => g.eventId === 'E00506');
    assert.ok(hitGroup, '长 alias 组（丙丁新篇）命中');
    assert.equal(d.eventHit.groupCount, 2, '丙丁新篇 与 丙丁 两组命中');
    const eventCandidate = d.candidates.find((c) => c.chunkId === 'sanguo-yanyi:0001:c0001');
    assert.ok(eventCandidate, '0001:c0001 在合并池内（词法命中 + 组 chunk）');
    assert.ok(eventCandidate.sources.includes('event'), '候选属命中事件组 → sources 增 event');
    const plainCandidate = d.candidates.find((c) => c.chunkId === 'sanguo-yanyi:0001:c0004');
    assert.ok(plainCandidate && !plainCandidate.sources.includes('event'), '非事件组成员候选不带 event 来源');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⑨ 空表降级端到端（§2.2）：无 events.json 时检索与工具行为不变，eventHit.degraded=true 可读', async () => {
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
