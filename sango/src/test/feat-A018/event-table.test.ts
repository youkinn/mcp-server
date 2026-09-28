/**
 * FEAT-A018 活文档：事件表加载（V1–V7 校验 / 降级 / 漂移检测）+ 事件名桥匹配。
 * 契约：docs/feat-A018-event-table-interface.md §1 / §2 / §3.2（验证方式）；夹具 fixtures 与集成侧同源。
 * §3.3 并池 / 增强查询重排 / L3 锚点置顶装配与 §3.3③ 池上限直测见 sango-event-bridge.test.ts。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEntityTable } from '../../normalize/entity-table.ts';
import { capMergedPool, SangoIndex } from '../../search/sango-index.ts';
import {
  eventsDegraded,
  eventsNormVersion,
  eventsRowCount,
  loadEventsTable,
  matchEvents,
} from '../../search/event-table.ts';
import type { MatchedEventGroup } from '../../search/event-table.ts';
import type { SearchHit } from '../../types.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, 'fixture');
const REAL_DATA_DIR = path.resolve(__dirname, '..', '..', '..', 'data');

/** 把事件表 JSON 写入 {dir}/corpus/events.json（自动建目录）。 */
function writeEvents(dir: string, content: unknown): void {
  mkdirSync(path.join(dir, 'corpus'), { recursive: true });
  writeFileSync(path.join(dir, 'corpus', 'events.json'), JSON.stringify(content), 'utf8');
}

/** 可复用的临时目录工厂：活动期间保留，测试结束由调用方 rmSync。 */
function tempDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

/** 截获 stderr：返回 [输出, 恢复]。 */
function captureStderr(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.join(' '));
  };
  return { lines, restore: () => (console.error = original) };
}

/** 实体表降级复位：临时目录无 entity-table.json → normalize 恒等、rewriteKeys 空集。
 * 隔离「③ 加载真实实体表后，夹具 alias 被 rewriteKeys 冲突剔除」的跨用例状态影响。 */
function resetEntityDegraded(): void {
  const dir = mkdtempSync(path.join(tmpdir(), 'a018-et-'));
  loadEntityTable(dir);
  rmSync(dir, { recursive: true, force: true });
}

/** 断言缺一不可的匹配组结构（组内 chunkIds 事件内序）。 */
function assertGroup(
  g: MatchedEventGroup,
  expected: { eventId: string; eventName: string; matchedAlias: string; type: 'L1' | 'L2' | 'L3'; chunkIds: string[] },
): void {
  assert.equal(g.eventId, expected.eventId);
  assert.equal(g.eventName, expected.eventName);
  assert.equal(g.matchedAlias, expected.matchedAlias);
  assert.equal(g.type, expected.type);
  assert.equal(g.groupSize, expected.chunkIds.length);
  assert.deepEqual(g.chunkIds, expected.chunkIds, '组内 chunkIds 按事件内序');
}

/** 有效 chunkId 判定（夹具 001/002 共 9 个；9999 号段视为缺失）。 */
function fixtureChunkExists(id: string): boolean {
  return /^sanguo-yanyi:(0001|0002):c\d{4}$/.test(id);
}


test('① 夹具表加载：启动日志行（rows/aliases/chunkRefs/normVersion）+ V3 单字禁入剔 alias + 状态可读', () => {
  // 注意：makeTempEvents 需先建 corpus 子目录；此处直接复用夹具 events.json（含「谜」单字 alias）。
  const dir = tempDir('a018-t1-');
  try {
    resetEntityDegraded();
    cpSync(FIXTURE_DIR, dir, { recursive: true });
    const cap = captureStderr();
    let ok: boolean;
    try {
      ok = loadEventsTable(dir, fixtureChunkExists, 9);
    } finally {
      cap.restore();
    }
    assert.equal(ok, true);
    const log = cap.lines.find((l) => l.includes('event-table loaded'));
    assert.ok(log, '应输出 [sango] event-table loaded 日志行');
    assert.match(
      log,
      /event-table loaded: rows=8 aliases=10 chunkRefs=14 normVersion=a1b2c3d4/,
      'rows=8（含 L3 行 E00199）、aliases=10（剔除单字「谜」）、chunkRefs=14',
    );
    assert.ok(cap.lines.some((l) => l.includes('V3 单字禁入，剔 alias「谜」')), '单字 alias 剔除告警');
    assert.equal(eventsDegraded(), false);
    assert.equal(eventsNormVersion(), 'a1b2c3d4');
    assert.equal(eventsRowCount(), 8);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('② 加载失败降级（接口 §2.2）：文件缺失 / JSON 损坏 / 顶层非法 / rows 非数组 / 有效行数 0 / meta 不完整 → 无事件路由', () => {
  const cases: Array<{ name: string; content: unknown | null; expectLine: RegExp }> = [
    { name: '文件缺失', content: null, expectLine: /文件读取 \/ JSON 解析失败/ },
    { name: 'JSON 损坏', content: 42, expectLine: /文件读取 \/ JSON 解析失败/ }, // 读合法 JSON 但非对象
    { name: '顶层结构非法', content: [1, 2], expectLine: /顶层结构非法/ },
    { name: 'rows 非数组', content: { meta: { normVersion: 'a1b2c3d4', corpusChunkCount: 9 }, rows: 'x' }, expectLine: /rows 非数组/ },
    { name: '有效行数 0（空表）', content: { meta: { normVersion: 'a1b2c3d4', corpusChunkCount: 9 }, rows: [] }, expectLine: /有效行数 0/ },
    {
      name: '有效行数 0（全行违规）',
      content: {
        meta: { normVersion: 'a1b2c3d4', corpusChunkCount: 9 },
        rows: [
          { eventId: '', eventName: '无名', aliases: ['a'], chunkIds: ['sanguo-yanyi:0001:c0001'], type: 'L1' },
          { eventId: 'E1', eventName: '', aliases: ['b'], chunkIds: ['sanguo-yanyi:0001:c0001'], type: 'L1' },
          { eventId: 'E2', eventName: '坏类型', aliases: ['c'], chunkIds: ['sanguo-yanyi:0001:c0001'], type: 'L9' },
        ],
      },
      expectLine: /有效行数 0/,
    },
    { name: 'meta 不完整', content: { meta: { normVersion: 'a1b2c3d4' }, rows: [] }, expectLine: /meta 不完整/ },
  ];
  for (const c of cases) {
    const dir = tempDir('a018-t2-');
    try {
      if (c.content !== null) {
        // 损坏 case：写入非 JSON 文本
        if (c.name === 'JSON 损坏') {
          mkdirSync(path.join(dir, 'corpus'), { recursive: true });
          writeFileSync(path.join(dir, 'corpus', 'events.json'), '{{{ not json', 'utf8');
          c.content = undefined;
        } else {
          writeEvents(dir, c.content);
        }
      }
      const cap = captureStderr();
      let ok: boolean;
      try {
        ok = loadEventsTable(dir, fixtureChunkExists, 9);
      } finally {
        cap.restore();
      }
      assert.equal(ok, false, `${c.name} 应加载失败`);
      assert.equal(eventsDegraded(), true, `${c.name} 应降级为无事件路由`);
      assert.equal(eventsNormVersion(), '', `${c.name} normVersion 置空`);
      assert.ok(cap.lines.some((l) => l.includes('加载失败') && l.includes('降级为无事件路由')), `${c.name} 应有降级告警`);
      assert.ok(cap.lines.some((l) => c.expectLine.test(l)), `${c.name} 应含 ${c.expectLine}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('③ V3 alias 违规单条剔除：行内重复 / 跨行重复 / 与实体表 rewriteKeys 冲突（整表不拒）', () => {
  const dir = tempDir('a018-t3-');
  try {
    // 先加载真实实体表（rewriteKeys 含 孟德），供冲突判定。
    loadEntityTable(REAL_DATA_DIR);
    const content = {
      meta: { normVersion: 'a1b2c3d4', corpusChunkCount: 9 },
      rows: [
        { eventId: 'E1', eventName: '甲', aliases: ['重复词', '重复词', '孟德'], chunkIds: ['sanguo-yanyi:0001:c0001'], type: 'L1' },
        { eventId: 'E2', eventName: '乙', aliases: ['重复词'], chunkIds: ['sanguo-yanyi:0001:c0002'], type: 'L1' },
        { eventId: 'E3', eventName: '丙', aliases: ['合法词'], chunkIds: ['sanguo-yanyi:0001:c0003'], type: 'L1' },
      ],
    };
    writeEvents(dir, content);
    const cap = captureStderr();
    let ok: boolean;
    try {
      ok = loadEventsTable(dir, fixtureChunkExists, 9);
    } finally {
      cap.restore();
    }
    assert.equal(ok, true, '单条 alias 违规不拒整表');
    assert.equal(eventsRowCount(), 3, '三行全保留');
    assert.ok(cap.lines.some((l) => l.includes('V3 行内重复，剔 alias「重复词」')), '行内重复剔除告警');
    assert.ok(cap.lines.some((l) => l.includes('V3 跨行重复，剔 alias「重复词」')), '跨行重复剔除告警');
    assert.ok(cap.lines.some((l) => l.includes('V3 与实体表 rewriteKeys 冲突，剔 alias「孟德」')), '实体表改写键冲突剔除告警');
    const matched = matchEvents('重复词');
    assert.deepEqual(matched.map((g) => g.eventId), ['E1'], '跨行重复 alias 只留首见行 E1');
    assert.deepEqual(matchEvents('孟德'), [], '实体表改写键冲突 alias 不再参与匹配');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('④ 漂移检测（接口 §2.3）：缺失 >5% 整表降级 / ≤5% 剔缺失 chunkId 告警（组空等效无事件路由）/ corpusChunkCount 不一致告警', () => {
  // 4.1 缺失 >5% → 整表降级
  const over = {
    meta: { normVersion: 'a1b2c3d4', corpusChunkCount: 9 },
    rows: [
      { eventId: 'E1', eventName: '甲', aliases: ['甲词'], chunkIds: ['sanguo-yanyi:0001:c0001'], type: 'L1' },
      { eventId: 'E2', eventName: '乙', aliases: ['乙词'], chunkIds: ['sanguo-yanyi:9999:c9999'], type: 'L1' },
    ],
  };
  const dir1 = tempDir('a018-t4a-');
  try {
    writeEvents(dir1, over);
    const cap = captureStderr();
    let ok: boolean;
    try {
      ok = loadEventsTable(dir1, fixtureChunkExists, 9);
    } finally {
      cap.restore();
    }
    assert.equal(ok, false, '50% 缺失 > 5% 整表降级');
    assert.equal(eventsDegraded(), true);
    assert.ok(cap.lines.some((l) => l.includes('缺失 chunkId 1/2（50.0%）> 5%，整表降级为无事件路由')), '整表降级告警含占比');
  } finally {
    rmSync(dir1, { recursive: true, force: true });
  }

  // 4.2 0 < 缺失 ≤ 5% → 剔缺失 chunkId + 告警；组空等效无事件路由
  const refs = Array.from({ length: 20 }, (_, i) => `sanguo-yanyi:0001:c${String((i % 7) + 1).padStart(4, '0')}`);
  const mild = {
    meta: { normVersion: 'a1b2c3d4', corpusChunkCount: 9 },
    rows: [
      { eventId: 'E1', eventName: '甲', aliases: ['甲词'], chunkIds: refs, type: 'L2' },
      { eventId: 'E2', eventName: '乙', aliases: ['乙词'], chunkIds: ['sanguo-yanyi:9999:c0001'], type: 'L2' },
    ],
  };
  const dir2 = tempDir('a018-t4b-');
  try {
    writeEvents(dir2, mild);
    const cap = captureStderr();
    let ok: boolean;
    try {
      ok = loadEventsTable(dir2, fixtureChunkExists, 9);
    } finally {
      cap.restore();
    }
    assert.equal(ok, true, '缺失占比 1/21 ≈ 4.8% ≤ 5% 保留其余引用');
    assert.ok(cap.lines.some((l) => l.includes('剔除缺失 chunkId 1/21')), '剔除告警含缺失计数（20 有效 + 1 缺失）');
    assert.ok(cap.lines.some((l) => l.includes('组剔空（等效无事件路由）')), 'E2 组空告警');
    const keptRefs = matchEvents('甲词')[0].chunkIds;
    assert.equal(keptRefs.length, refs.length, 'E1 引用保留（20 条）');
    assert.deepEqual(new Set(keptRefs), new Set(refs), 'E1 引用集合保留（模块按事件内序重排，不与表序比较）');
    assert.deepEqual(matchEvents('乙词'), [], 'E2 组空不进匹配面');
  } finally {
    rmSync(dir2, { recursive: true, force: true });
  }

  // 4.3 corpusChunkCount ≠ 当前语料数 → 告警（不阻断）
  const dir3 = tempDir('a018-t4c-');
  try {
    resetEntityDegraded();
    cpSync(FIXTURE_DIR, dir3, { recursive: true });
    const cap = captureStderr();
    let ok: boolean;
    try {
      ok = loadEventsTable(dir3, fixtureChunkExists, 99);
    } finally {
      cap.restore();
    }
    assert.equal(ok, true, '重建漂移信号不阻断');
    assert.ok(cap.lines.some((l) => l.includes('meta.corpusChunkCount（9）≠ 当前语料 chunk 数（99），语料重建漂移信号')), '重建漂移告警');
  } finally {
    rmSync(dir3, { recursive: true, force: true });
  }
});

test('⑤ 事件名桥匹配（接口 §3.2）：子串命中 / 最长 alias 选取 / 跨行重名组优先级 / 同长 eventId 升序 / 多组命中 / 单字禁入', () => {
  const dir = tempDir('a018-t5-');
  try {
    resetEntityDegraded();
    cpSync(FIXTURE_DIR, dir, { recursive: true });
    loadEventsTable(dir, fixtureChunkExists, 9);

    // 子串命中 + 组内最长 alias（温酒斩华雄 > 斩华雄）+ 事件内序乱序防御（表内 0002 在前，读后 0001 在前）
    const g1 = matchEvents('温酒斩华雄是怎么斩的');
    assert.equal(g1.length, 1);
    assertGroup(g1[0], {
      eventId: 'E00501',
      eventName: '温酒斩华雄',
      matchedAlias: '温酒斩华雄',
      type: 'L1',
      chunkIds: ['sanguo-yanyi:0001:c0006', 'sanguo-yanyi:0002:c0001'],
    });
    // 短 alias 也可独立命中（长 alias 不命中时）
    assert.equal(matchEvents('斩华雄')[0].matchedAlias, '斩华雄');
    // 跨行重名组优先级：命中 alias 长度降序（虎牢关三英战吕布 8 > 三英战吕布 5）
    const g2 = matchEvents('虎牢关三英战吕布的战况');
    assert.deepEqual(g2.map((g) => g.eventId), ['E00503', 'E00502'], 'E00503（长 alias）优先于 E00502');
    assert.equal(g2[0].matchedAlias, '虎牢关三英战吕布');
    // 同长 eventId 升序：温酒斩华雄（E00501）先于三英战吕布（E00502）
    const g3 = matchEvents('三英战吕布温酒斩华雄');
    assert.deepEqual(g3.map((g) => g.eventId), ['E00501', 'E00502']);
    // 多组命中（3 组：8 > 5 > 4）
    const g4 = matchEvents('桃园结义与虎牢关三英战吕布');
    assert.deepEqual(g4.map((g) => g.eventId), ['E00503', 'E00502', 'E00101']);
    assert.deepEqual(g4.map((g) => g.matchedAlias), ['虎牢关三英战吕布', '三英战吕布', '桃园结义']);
    // 单字禁入：表内「谜」已剔，单字不命中
    assert.deepEqual(matchEvents('谜面谜底'), []);
    // 空 query / 降级恒空
    assert.deepEqual(matchEvents(''), []);
    loadEventsTable(path.join(dir, 'nonexistent'), fixtureChunkExists, 9);
    assert.deepEqual(matchEvents('丙丁'), [], '表缺失降级后匹配恒空');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⑥ 并池硬上限直测（capMergedPool，§3.3③）：超限按重排分降序裁到 120，未超限原样返回', () => {
  const pool: SearchHit[] = Array.from({ length: 130 }, (_, i) => ({ doc: i, score: i }));
  capMergedPool(pool);
  assert.equal(pool.length, 120, '超限裁到硬上限 120');
  assert.deepEqual(
    pool.map((h) => h.doc),
    Array.from({ length: 120 }, (_, i) => 129 - i),
    '保留重排分最高的 120 条（降序）',
  );
  const small: SearchHit[] = [{ doc: 0, score: 1 }, { doc: 1, score: 2 }];
  capMergedPool(small);
  assert.deepEqual(small.map((h) => h.doc), [0, 1], '未超限不重排、不截断');
});

test('⑦ 定点四问（真实表 + 真实语料）：eventHit.groups 非空、placedChunkIds 与事件回区间吻合、L1/L2 按出参序（BM25-only）', async () => {
  const cases: Array<{ query: string; eventId: string }> = [
    { query: '温酒斩华雄', eventId: 'E00501' },
    { query: '三英战吕布', eventId: 'E00502' },
    { query: '草船借箭', eventId: 'E04601' },
    { query: '空城计', eventId: 'E09502' },
  ];
  // 期望 chunkIds / 回区间以落表数据为准（唯一权威）
  const table = JSON.parse(readFileSync(path.join(REAL_DATA_DIR, 'corpus', 'events.json'), 'utf8')) as {
    meta: { normVersion: string };
    rows: Array<{ eventId: string; eventName: string; chunkIds: string[] }>;
  };
  const index = new SangoIndex(REAL_DATA_DIR);
  index.load();
  // 零向量：事件路不依赖向量，定点四问仅验证桥与装配；屏蔽 ONNX 懒加载
  index.vec = new Float32Array(0);
  const innerOrderKey = (id: string): [number, number] => {
    const m = /^[^:]+:(\d{4}):c(\d{4})$/.exec(id);
    return m ? [Number(m[1]), Number(m[2])] : [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER];
  };
  for (const c of cases) {
    const result = await index.search(c.query, 10, { diagnostics: true });
    const eventHit = result.diagnostics?.eventHit;
    assert.ok(eventHit, `${c.query} 应产出 eventHit`);
    assert.equal(eventHit.degraded, false, `${c.query} 事件路正常路由`);
    assert.equal(eventHit.normVersion, String(table.meta.normVersion));
    assert.ok(eventHit.groups.length >= 1, `${c.query} 命中事件组`);
    const group = eventHit.groups.find((g) => g.eventId === c.eventId) ?? eventHit.groups[0];
    assert.equal(group.eventId, c.eventId, `${c.query} 命中 ${c.eventId}`);
    const row = table.rows.find((r) => r.eventId === c.eventId);
    assert.ok(row, `${c.eventId} 表内存在`);
    const expectedSet = new Set(row.chunkIds);
    assert.ok(group.placedChunkIds.length >= 1, `${c.query} placedChunkIds 非空`);
    for (const id of group.placedChunkIds) {
      assert.ok(expectedSet.has(id), `${c.query} placed ${id} 属表内该事件 chunkIds`);
      const [ch] = innerOrderKey(id);
      const [expectedCh] = innerOrderKey(row.chunkIds[0]);
      assert.equal(ch, expectedCh, `${c.query} placed ${id} 回区间吻合（第 ${expectedCh} 回）`);
    }
    // L1/L2 口径（§5.2）：placedChunkIds 按重排后出参序（= 出参中该组 chunk 的子序列）
    const entryIds = result.entries.map((e) => e.id);
    assert.deepEqual(
      group.placedChunkIds,
      entryIds.filter((id) => expectedSet.has(id)),
      `${c.query} L1/L2 placedChunkIds 按出参序`,
    );
    assert.equal(group.placedCount, group.placedChunkIds.length);
    assert.ok(result.entries.length >= 1, `${c.query} 出参非空`);
  }
});

test('⑧ 真实 L3 锚点置顶（§3.3②）：落表「锚点 ±N」小位点组整组进保证区（事件内序）、不参与池重排', async () => {
  const table = JSON.parse(readFileSync(path.join(REAL_DATA_DIR, 'corpus', 'events.json'), 'utf8')) as {
    meta: { normVersion: string };
    rows: Array<{ eventId: string; eventName: string; aliases: string[]; chunkIds: string[]; type: string }>;
  };
  const innerOrderKey = (id: string): [number, number] => {
    const m = /^[^:]+:(\d{4}):c(\d{4})$/.exec(id);
    return m ? [Number(m[1]), Number(m[2])] : [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER];
  };
  const l3row = table.rows.find((r) => r.type === 'L3' && r.aliases.length > 0);
  assert.ok(l3row, '真实表含 L3 行');
  const index = new SangoIndex(REAL_DATA_DIR);
  index.load();
  index.vec = new Float32Array(0);
  const result = await index.search(l3row.aliases[0], 10, { diagnostics: true });
  const group = result.diagnostics?.eventHit.groups.find((g) => g.eventId === l3row.eventId);
  assert.ok(group, `${l3row.eventName} 命中 L3 组`);
  assert.equal(group.type, 'L3');
  assert.deepEqual(
    [...group.placedChunkIds].sort(),
    [...l3row.chunkIds].sort(),
    '落表小位点组整组进窗（运行期不二次扩展、不丢段）',
  );
  for (let i = 1; i < group.placedChunkIds.length; i++) {
    const [a1, a2] = innerOrderKey(group.placedChunkIds[i - 1]);
    const [b1, b2] = innerOrderKey(group.placedChunkIds[i]);
    assert.ok(a1 < b1 || (a1 === b1 && a2 < b2), 'L3 placedChunkIds 按事件内序升序');
  }
  // 保证区：置顶小位点组占据出参最前 rank（不参与池重排，按 pin 通道）
  const head = result.entries.slice(0, group.placedChunkIds.length).map((e) => e.id);
  assert.deepEqual([...head].sort(), [...group.placedChunkIds].sort(), 'L3 小位点组进保证区（rank 1..k）');
});

test('⑨ 真实事件问法「赤壁之战发生在哪里」：增强查询重排使答案段前移（bridge on 优于 off，§3.3④ 读数）', async () => {
  const index = new SangoIndex(REAL_DATA_DIR);
  index.load();
  index.vec = new Float32Array(0);
  const question = '赤壁之战发生在哪里';
  const answer = 'sanguo-yanyi:0049:c0018'; // A015 题库该题证据段（黄盖「望赤壁进发」，第 49 回）
  const on = await index.search(question, 50, { diagnostics: true });
  const rankOn = on.entries.map((e) => e.id).indexOf(answer);
  assert.ok(rankOn >= 0, 'bridge on：答案段在出参内');
  // 事件表降级 → bridge off 基线（同索引 / 同向量状态，仅桥开关不同）
  loadEventsTable(path.join(tmpdir(), 'a018-no-events'), () => false, index.n);
  const off = await index.search(question, 50, { diagnostics: true });
  const rankOff = off.entries.map((e) => e.id).indexOf(answer);
  assert.ok(rankOff >= 0, 'bridge off：答案段亦在出参内');
  assert.ok(rankOn < rankOff, `增强查询重排使答案段前移（on rank ${rankOn + 1} < off rank ${rankOff + 1}）`);
});
