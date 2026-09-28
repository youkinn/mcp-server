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
  const { entries } = await index.search('刘备第一次出场是什么时候', 5);
  assert.equal(
    entries[0].id,
    'sanguo-yanyi:0001:c0007',
    'birthByPerson 置顶「人物之生-刘备登场」标签 chunk（0001:c0007，第 1 回）',
  );
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
