/**
 * bug-00046 活文档（FEAT-A016 §2.2 / §2.3 / §2.5 + FEAT-A018 事件桥 alias 原文口径）：
 * 检索侧不改写 query（原文入 BM25/向量/标签/事件桥）+ 索引侧双写扩展（rewriteKeys 与 fragmentOnly 同口径）
 * + 登场类结构路（birthByPerson，照死亡同款：不新增召回路、零 LLM、走既有保证区置顶）。
 *
 * 真索引 + 真语料（sango/data）：读数与 bug-00046「同一问句四组 A/B」的「重排关」列同源、可复现。
 * 为固定读数并省去 BGE-M3 编码，本文件清空向量强制纯 BM25（标签 / 事件 / 结构路照常参与）；
 * 重排开口径单独一例、仅当 bge-reranker-base 权重存在时接入真模型（缺失自动跳过，与 A030 降级口径一致）。
 *
 * 零 LLM：全程只跑检索（索引加载 + 打分），无任何 LLM 调用。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDataRerankScorer, SangoIndex } from '../../search/sango-index.ts';
import { matchEvents } from '../../search/event-table.ts';
import { matchBirthIntent } from '../../search/intent.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REAL_DATA_DIR = path.resolve(__dirname, '..', '..', '..', 'data');

/** 真语料 + 纯 BM25（清空向量）：读数与 bug-00046 四组 A/B 的「重排关」列同源。 */
function loadBm25Only(rerankScorer: ReturnType<typeof createDataRerankScorer> = null): SangoIndex {
  const index = new SangoIndex(REAL_DATA_DIR, { rerankScorer });
  index.load();
  index.vec = new Float32Array(0);
  return index;
}

/** 诊断 candidates 内的名次（candidates 覆盖前 20 名；不在其中返回 null）。 */
function rankOf(candidates: ReadonlyArray<{ chunkId: string; rank: number }>, chunkId: string): number | null {
  return candidates.find((c) => c.chunkId === chunkId)?.rank ?? null;
}

const RERANK_SCORER = createDataRerankScorer(REAL_DATA_DIR);

test('① 检索侧不改写 + 索引侧双写：伏龙 证据段 0035:c0005 重排关回第 1（bug 文档四组 A/B 复验）', async () => {
  const index = loadBm25Only();
  const { entries, diagnostics } = await index.search('“伏龙”指的是谁', 10, { diagnostics: true });
  assert.ok(diagnostics);
  assert.equal(diagnostics.query.raw, '“伏龙”指的是谁');
  assert.equal(diagnostics.query.normalized, diagnostics.query.raw, '检索侧不改写：normalized ≡ raw（接口 §2.2）');
  assert.deepEqual(diagnostics.query.rewrites, [], 'rewrites 恒 []（字段保留，兼容历史消费方）');
  assert.deepEqual(
    diagnostics.query.expansionHits,
    [{ from: '伏龙', to: '诸葛亮' }],
    'expansionHits 报告索引侧已双写覆盖（只报告不改写）',
  );
  assert.equal(
    entries[0].id,
    'sanguo-yanyi:0035:c0005',
    '保原词面：判別性词面 伏龙(df 11) 未被摊薄成 诸葛亮(df 146)，证据段回第 1',
  );
});

test('② 锦马超 证据段 0065:c0006 第 2（同类读数）', async () => {
  const index = loadBm25Only();
  const { entries, diagnostics } = await index.search('“锦马超”指的是谁', 10, { diagnostics: true });
  assert.deepEqual(diagnostics?.query.expansionHits, [{ from: '锦马超', to: '马超' }]);
  assert.equal(entries[1].id, 'sanguo-yanyi:0065:c0006', '「人言锦马超，名不虚传」回到第 2');
});

test('③ 换说法与规范形同召回（同基线不倒车）：规范形「诸葛亮是谁」无扩展，且与「孔明是谁」共享 top10 证据段', async () => {
  const index = loadBm25Only();
  const canon = await index.search('诸葛亮是谁', 10, { diagnostics: true });
  assert.deepEqual(canon.diagnostics?.query.expansionHits, [], '诸葛亮 为规范形、非任何行的键 → 无扩展');
  assert.equal(canon.diagnostics?.query.normalized, '诸葛亮是谁', '规范形 query 原文入检索（口径与改前一致）');
  const alias = await index.search('孔明是谁', 10, { diagnostics: true });
  assert.deepEqual(alias.diagnostics?.query.expansionHits, [{ from: '孔明', to: '诸葛亮' }]);
  const canonIds = new Set(canon.entries.map((e) => e.id));
  const shared = alias.entries.map((e) => e.id).filter((id) => canonIds.has(id));
  assert.ok(shared.length > 0, `换说法与规范形 top10 共享证据段（双写覆盖，召回不倒车）：${shared.join(', ')}`);
});

test('④ 事件桥 alias 原文口径恢复：刘备出场 / 刘备首次登场 均命中 E00105（刘备登场，L3）', () => {
  const index = loadBm25Only(); // 触发事件表加载（与检索同一实例）
  assert.ok(index.n > 1000, '真语料已加载');
  for (const q of ['刘备出场', '刘备首次登场']) {
    const groups = matchEvents(q);
    assert.equal(groups[0]?.eventId, 'E00105', `${q} 命中 E00105`);
    assert.equal(groups[0]?.matchedAlias, q, 'matchedAlias = 原文 alias（桥不二次归一化）');
  }
});

test('⑤ 登场类结构路：问句「刘备第一次出场是什么时候」命中 birthByPerson 并置顶（标签位点段 0001:c0007）', async () => {
  const index = loadBm25Only();
  assert.equal(matchBirthIntent('刘备第一次出场是什么时候'), true, '登场意图问法枚举命中（出场/登场/出世/首次…）');
  assert.equal(matchBirthIntent('刘备第一次回家是什么时候'), false, '非登场问法不误触发');
  const { entries, diagnostics } = await index.search('刘备第一次出场是什么时候', 5, { diagnostics: true });
  assert.equal(
    entries[0].id,
    'sanguo-yanyi:0001:c0007',
    'birthByPerson 置顶「人物之生-刘备登场」标签 chunk（0001:c0007，第 1 回）',
  );
  assert.ok(diagnostics, '请求诊断时应产出');
  assert.equal(diagnostics.birthIntent.detected, true, '登场意图判定命中');
  assert.equal(diagnostics.birthIntent.pinned, true, '登场意图置顶生效');
  assert.ok(diagnostics.birthIntent.chunkIds.includes('sanguo-yanyi:0001:c0007'), '登场置顶候选即标签位点段');
  assert.equal(entries[0].id, diagnostics.birthIntent.chunkIds[0], '置顶段即出参首位');
});

test('⑥ 别名死亡问法不回退：云长是怎么死的 仍按人名词典置顶（人名匹配用原文 ∪ 双写扩展规范形）', async () => {
  const index = loadBm25Only();
  const { entries, diagnostics } = await index.search('云长是怎么死的', 5, { diagnostics: true });
  assert.equal(diagnostics?.deathIntent.detected, true, '死亡意图仍识别');
  assert.equal(diagnostics?.deathIntent.pinned, true, '别名问法仍命中死亡人名词典（云长 → 关羽）');
  assert.equal(entries[0].id, diagnostics?.deathIntent.chunkIds[0], '置顶段即出参首位');
});

test(
  '⑦ 重排开口径：接入真 bge-reranker-base 后 伏龙 证据段仍在前 3（重排不翻转口径收益）',
  { skip: RERANK_SCORER ? false : '重排权重缺失（data/models/bge-reranker-base）' },
  async () => {
    const index = loadBm25Only(RERANK_SCORER);
    const { diagnostics } = await index.search('“伏龙”指的是谁', 10, { diagnostics: true });
    assert.ok(diagnostics?.rerank.applied, '真重排已接入并生效');
    assert.ok(index.n > 1000);
    const rank = rankOf(diagnostics?.candidates ?? [], 'sanguo-yanyi:0035:c0005');
    assert.ok(rank !== null && rank <= 3, `重排开：0035:c0005 名次 ≤ 3（实测 ${rank}）`);
  },
);

/** 锚点段 ±1 相邻段集合（同一回 chunk 序号），供首出段命中断言（±1 容差口径）。 */
function nearChunkIds(anchor: string): Set<string> {
  const m = /^([^:]+):(\d{4}):c(\d{4})$/.exec(anchor);
  if (!m) return new Set([anchor]);
  const num = Number(m[3]);
  const set = new Set<string>();
  for (const off of [-1, 0, 1]) {
    set.add(`${m[1]}:${m[2]}:c${String(num + off).padStart(4, '0')}`);
  }
  return set;
}

test('⑧ 登场词表补「露面/亮相/舞台」（bug-00051 口径）：同义问法均命中；「提及/被提到/被点名」不误触（只认第一次出场语义）', () => {
  // 正例：露面/亮相/舞台 与 出现/现身 同义，进登场意图
  assert.equal(matchBirthIntent('华雄初次露面是在哪一回'), true, '露面 与 出现/现身 同义');
  assert.equal(matchBirthIntent('关羽首次亮相是在哪一回'), true, '亮相 收「首次亮相」');
  assert.equal(matchBirthIntent('司马懿初次登上演义舞台是在哪一回'), true, '舞台 覆盖「登上…舞台」');
  // 反例：提及/被提到/被点名 属另一语义（锁定口径，防后人扩表）
  assert.equal(matchBirthIntent('典韦首次被提及是在哪一回'), false, '被提及 不属登场语义');
  assert.equal(matchBirthIntent('华佗初次被提及是在哪一回'), false, '被提及 不属登场语义');
  assert.equal(matchBirthIntent('祢衡初次被提到是在哪一回'), false, '被提到 不属登场语义');
  assert.equal(matchBirthIntent('诸葛亮最早被点名是在哪一回'), false, '被点名 不属登场语义');
});

test('⑨ 登场标签锚点（bug-00051，基准 §十一 出场族）：13 问 top10 含各自期望段或其 ±1 相邻段', async () => {
  const index = loadBm25Only();
  // 期望段以 docs/sango-rag-regression-benchmark_v0.1.md §十一「出场」为准：
  // 补录/订正：孙权/鲁肃/陆逊/张郃（前次）+ 吕布/许褚/许攸/杨修（位点订正，跨回许攸）
  //   + 曹操/张辽（段差 1 订正：置顶只盖 tags 位点段本身，段差 1 判未命中）；
  // 关羽/姜维/司马懿 为既有标签，验证 亮相/舞台 词表与结构路。
  const cases = [
    { query: '曹操最早出现在哪一回', anchor: 'sanguo-yanyi:0001:c0017' }, // 基准 #4 第1回（段差订正）
    { query: '张辽最早出现在哪一回', anchor: 'sanguo-yanyi:0011:c0017' }, // 基准 #18 第11回（段差订正）
    { query: '孙权初次登场是在哪一回', anchor: 'sanguo-yanyi:0007:c0011' }, // 基准 #7 第7回
    { query: '鲁肃初次登场是在哪一回', anchor: 'sanguo-yanyi:0029:c0017' }, // 基准 #9 第29回
    { query: '陆逊最早出现在哪一回', anchor: 'sanguo-yanyi:0038:c0012' }, // 基准 #15 第38回
    { query: '张郃首次登场是在哪一回', anchor: 'sanguo-yanyi:0030:c0002' }, // 基准 #25 第30回
    { query: '吕布最早登场于哪一回', anchor: 'sanguo-yanyi:0003:c0015' }, // 基准 #5 第3回（位点订正）
    { query: '许褚初次亮相是在哪一回', anchor: 'sanguo-yanyi:0012:c0014' }, // 基准 #19 第12回（位点订正）
    { query: '许攸最早出现在哪一回', anchor: 'sanguo-yanyi:0030:c0009' }, // 基准 #24 第30回（跨回订正）
    { query: '杨修首次出场是在哪一回', anchor: 'sanguo-yanyi:0060:c0003' }, // 基准 #27 第60回（本次补录）
    { query: '关羽首次亮相是在哪一回', anchor: 'sanguo-yanyi:0001:c0009' }, // 基准 #2 第1回
    { query: '姜维首度亮相是在哪一回', anchor: 'sanguo-yanyi:0092:c0019' }, // 基准 #14 第92回
    { query: '司马懿初次登上演义舞台是在哪一回', anchor: 'sanguo-yanyi:0039:c0008' }, // 基准 #11 第39回
  ];
  for (const { query, anchor } of cases) {
    const { entries } = await index.search(query, 10);
    const ids = entries.map((e) => e.id);
    const near = nearChunkIds(anchor);
    const hit = ids.find((id) => near.has(id));
    assert.ok(hit, `${query} top10 含期望段或其 ±1 相邻段（anchor=${anchor}，top10=${ids.join(',')}）`);
  }
});
