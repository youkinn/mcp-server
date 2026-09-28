/**
 * SangoIndex：sango_novel_search 的检索核心（BM25 + 离线向量混合召回）。
 *
 * - 语料：data/corpus/sanguo-yanyi/001.json .. 120.json（chunk 级 schema v2，与 Python 构建脚本同源）
 * - 实体表：data/entity-table.json（改写键 → 规范形 + 片段侧素材，FEAT-A016 单表，alias.json 已退役）；
 *   索引侧 / query 侧 / 标签侧统一归一化（模块 sango/src/normalize/entity-table.ts，检索与工具共用）
 * - 向量：data/vectors/sanguo-yanyi.bin（与 corpus chunks[] 同序，离线只读）
 * - 出参：结构化条目数组（SearchEntry，回级 chapter / title 随条目逐条展开）
 *   文本内不含出处 / 回目 / 段号 / 类型 / 分数
 * - 多路召回（词法 + 向量 + 标签）合并重排：BGE-M3*0.6 + BM25*0.3 + 标签*0.1（2026-09-19 定参，需求变更覆盖原「不做 rerank」）。
 * - 不做 query 改写 / 专用向量库。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { embedQuery } from '../embed/bge-m3-encoder.ts';
import { eventsDegraded, eventsNormVersion, loadEventsTable, matchEvents } from './event-table.ts';
import type { MatchedEventGroup } from './event-table.ts';
import { createCrossEncoderScorer, resolveRerankModelFile } from './reranker.ts';
import type { RerankScorer } from './reranker.ts';
import {
  fragmentKeyToCanon as entityFragmentKeyToCanon,
  loadEntityTable,
  normalize as entityNormalize,
  normalizeDetail as entityNormalizeDetail,
  rewriteKeyCount as entityRewriteKeyCount,
  normVersion as entityNormVersion,
} from '../normalize/entity-table.ts';
import type {
  Chapter,
  ChapterPayload,
  CorpusChunk,
  DeathIntent,
  Doc,
  RetrievalCandidateDiagnostics,
  RetrievalEventHitDiagnostics,
  RetrievalDiagnostics,
  RetrievalDiagnosticsTiming,
  RetrievalRerankDiagnostics,
  RetrievalQueryRewrite,
  SearchEntry,
  SearchHit,
  SearchResult,
} from '../types.ts';
import { tokenize } from '../utils/text.ts';
import { matchDeathIntent } from './intent.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_DATA_DIR = path.resolve(__dirname, '..', '..', 'data');

/** 无命中固定话术：检索无结果时返回，供模型走兜底回答。 */
export const NO_HIT_TEXT = '未召回任何原文段落';

// BM25 参数（k1/b 为经典取值）与混合权重
const K1 = 1.5;
const B = 0.75;
// 重排权重（2026-09-19 定参）：BGE-M3*0.6 + BM25*0.3 + 标签*0.1；语义:词法 = 0.6:0.3 与旧 1:0.5 同比例。
const BM25_WEIGHT = 0.3;
const TAG_WEIGHT = 0.1;
// 向量权重（2026-09-19 定参：BGE-M3*0.6 + BM25*0.3 + 标签*0.1）：
// 离线向量为 scheme=model 的 BGE-M3 真向量（2344 x 1024），query 与语料同空间；
// 语义:词法配比 0.6:0.3 与 Step 2 实测平台期 1:0.5 同比例；标签(TAG)只做第三路召回分量。
// 10 例复刻（dev-docs/test/sango-tag-route-audit.mjs）与该配比逐条一致：无回归、无增益，
// 结论见 sango-recall-quality.md §14（扁平 0.1 标签分量提不动排名，需定向/query 扩展才有增益）。
const VEC_WEIGHT = 0.6;
const MIN_COSINE = 0.3; // Step 4 待按真向量分布重定（现值为哈希向量时代的死路值，见 §4.6）

/** FEAT-A018 §3.3③：L1/L2 并池后合并候选池硬上限兜底（超限按重排分裁；正常场景触不到）。 */
const EVENT_MERGE_POOL_CAP = 120;

/** FEAT-A030：规则重排后进入 cross-encoder 的候选窗口默认值（池 50 路 → 重排 → 返回 limit ≤ 10）。 */
const RERANK_WINDOW_DEFAULT = 50;

/** 重排窗口档位：SANGO_RERANKER_WINDOW 覆盖（评测期 20 / 50 对照），非法值回落默认。 */
function rerankWindowSize(): number {
  const raw = Number(process.env.SANGO_RERANKER_WINDOW);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : RERANK_WINDOW_DEFAULT;
}

// 遗言类标签关键词：标签文本含这些词即视为某人的临终嘱托/遗诏段（数据口径：0085:c0008-0011
// 刘备托孤、0029:c0014 孙策托孤、0040:c0005 刘表托孤）。
const LAST_WORDS_TAG = /(托孤|遗诏|遗令|遗言|遗嘱|遗书|遗表|临终)/;

// 向量构建方案：与 build_vectors.py 写出的 scheme 字段对应
const VEC_SCHEME_HASH = 0; // 0=确定性哈希向量（运行期可对 query 编码）
const VEC_SCHEME_MODEL = 1; // 1=BGE-M3 等模型向量（运行期需模型编码）

/** 正则元字符转义：与评测脚本 sango-recall-bench.mjs 的 escapeRe 逐字节一致。 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 保留 3 位小数的分数展示（诊断载荷瘦身，契约 §1.3 示例三位小数）。
 * bug-00013：仅 bm25 / finalScore 维持 3 位小数；cosine / bm25Norm 全精度（供复算恒等式）。
 */
function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * 保留 6 位小数的分差展示（契约 §1.3 `gapToTopN` 精度口径）：真实分差常 < 0.0005，
 * 用 round3 会被四舍五入成 0（trace 60aa5476：rank10 final=0.651 / rank11 final=0.65 →
 * 页面显示「差 0 分未进 top-N」）。故分差单独放宽到 6 位；bm25 / finalScore 维持 3 位小数，
 * cosine / bm25Norm 全精度（bug-00013）。
 */
export function roundGap(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * FEAT-A018 §3.3③：合并候选池硬上限兜底截断——超限按重排分降序裁到 cap（正常场景触不到：
 * 三路 ≤50 + 最大组 59）。导出仅供 feat-A018 池上限单测直测；检索入口经 SangoIndex.search 调用。
 */
export function capMergedPool(pool: SearchHit[], cap: number = EVENT_MERGE_POOL_CAP): void {
  if (pool.length <= cap) return;
  pool.sort((a, b) => b.score - a.score);
  pool.length = cap;
}

/** 候选分数表条数上限（契约 §1.3：candidates ≤ 20 条）。 */
const MAX_DIAGNOSTIC_CANDIDATES = 20;
/** 诊断 JSON 序列化后 UTF-8 字节数预算（硬约束 3：64 KB，远低于 stdio 10 MB 上限）。 */
const DIAGNOSTICS_BUDGET_BYTES = 64 * 1024;

/** feat-A009 诊断构建上下文：search 各中间量的引用（只读），供 buildDiagnostics 取数。 */
interface DiagnosticsBuildContext {
  raw: string;
  normalized: string;
  /** query 侧实际改写命中明细（entityNormalizeDetail().hits，接口 §5 query.rewrites）。 */
  rewrites: RetrievalQueryRewrite[];
  tokens: string[];
  bm25: Float64Array;
  bm25Norm: Float64Array;
  /**
   * FEAT-A018 §3.3④：事件命中请求下并池重排后的 bm25Norm 覆盖（doc → 增强查询归一值）。
   * 供 candidates 诊断复算恒等式（finalScore 可由接口字段复算，bug-00013）；非事件请求恒 null。
   */
  bm25NormOverride: Map<number, number> | null;
  lexicalHits: Set<number>;
  tagHits: Set<number>;
  deathIntent: DeathIntent | null;
  deathHits: Set<number>;
  combined: SearchHit[];
  hits: SearchHit[];
  /** FEAT-A018 §4：三路合并候选数（不含事件并池 / 置顶），funnel.mergedCandidates 口径（漏斗只描述三路召回）。 */
  threeWayCandidates: number;
  cosine: Float64Array | null;
  vectorTop: number[];
  /** feat-A013：分阶段耗时（search 内实测毫秒）。 */
  timing: RetrievalDiagnosticsTiming;
  /** FEAT-A018：事件名桥命中诊断（未命中时 degraded / normVersion 仍可读、groups 空）。 */
  eventHit: RetrievalEventHitDiagnostics;
  /** FEAT-A018：命中事件组全部有效 chunk 的文档下标集合（candidates[].sources 'event' 判定）。 */
  eventDocSet: Set<number>;
  /** FEAT-A030：检索重排诊断（rerankWindow 产出；空结果早退路径用默认值）。 */
  rerank: RetrievalRerankDiagnostics;
}

/**
 * 64 KB 预算截断（硬约束 3）：按优先级从后往前丢——① candidates 尾部（保头部名次）② nextRank
 * ③ deathIntent.chunkIds（保留 detected / pinned）；query / env / funnel / timing 恒保留
 * （timing 是低位固定 5 字段，截断不丢——检索耗时展示依赖它）。
 * 截断后 truncated=true、truncatedCount=被丢弃的候选条数；正常载荷远低于预算，不触发。
 */
export function enforceDiagnosticsBudget(diagnostics: RetrievalDiagnostics): RetrievalDiagnostics {
  const fits = (d: RetrievalDiagnostics): boolean =>
    Buffer.byteLength(JSON.stringify(d), 'utf8') <= DIAGNOSTICS_BUDGET_BYTES;
  if (fits(diagnostics)) {
    return diagnostics;
  }
  const total = diagnostics.candidates.length;
  const truncatedBase: RetrievalDiagnostics = { ...diagnostics, truncated: true, truncatedCount: total };
  for (let kept = total; kept > 0; kept--) {
    const candidate: RetrievalDiagnostics = {
      ...truncatedBase,
      candidates: diagnostics.candidates.slice(0, kept),
      truncatedCount: total - kept,
    };
    if (fits(candidate)) {
      return candidate;
    }
  }
  // candidates 全丢仍超限 → 丢 nextRank；仍超限 → 丢 deathIntent.chunkIds
  let slim: RetrievalDiagnostics = { ...truncatedBase, candidates: [], truncatedCount: total };
  if (!fits(slim)) {
    slim = { ...slim, nextRank: null };
  }
  if (!fits(slim)) {
    slim = { ...slim, deathIntent: { ...slim.deathIntent, chunkIds: [] } };
  }
  return slim;
}
/**
 * FEAT-A030：SangoIndex 可选注入项。rerankScorer 显式指定重排打分器（null / 省略 = 不重排）。
 * 库层默认不启用（保持确定性、不依赖 ~266MB 权重）；由装配层 / 评测显式接入 createDataRerankScorer()。
 */
export interface SangoIndexOptions {
  rerankScorer?: RerankScorer | null;
}

/**
 * FEAT-A030：按 dataDir/models/bge-reranker-base 解析生产重排打分器（装配层显式接入用）。
 * 权重缺失返回 null（自动跳过、退回规则序）；SANGO_RERANKER=off 关闭、SANGO_RERANKER_DIR 换目录。
 */
export function createDataRerankScorer(dataDir: string = DEFAULT_DATA_DIR): RerankScorer | null {
  if (process.env.SANGO_RERANKER === 'off') return null;
  const modelDir = process.env.SANGO_RERANKER_DIR ?? path.join(dataDir, 'models', 'bge-reranker-base');
  return resolveRerankModelFile(modelDir) ? createCrossEncoderScorer(modelDir) : null;
}

/**
 * FEAT-A030 装配开关：SANGO_RERANKER=on 才尝试接入生产重排打分器（权重缺失返回 null、走既有降级，不抛错）；
 * 未设 / off / 其他值一律不接入（默认行为与现状逐字节一致，不触发权重解析）。装配层（src/index.ts）经此接入。
 */
export function resolveRerankScorer(dataDir: string = DEFAULT_DATA_DIR): RerankScorer | null {
  return process.env.SANGO_RERANKER === 'on' ? createDataRerankScorer(dataDir) : null;
}

export class SangoIndex {
  private readonly dataDir: string;
  private readonly corpusDir: string;
  private readonly vectorsFile: string;
  private readonly tagsDir: string;

  /**
   * FEAT-A030：cross-encoder 重排打分器（null = 不重排）。库层默认不启用（保持确定性、不依赖模型权重），
   * 由装配层（src/index.ts / 评测脚本）经 createDataRerankScorer() 显式接入；测试可注入。
   */
  private readonly rerankScorer: RerankScorer | null;

  /** dataDir 仅用于夹具测试注入语料目录；生产用默认 data/ 目录。 */
  constructor(dataDir: string = DEFAULT_DATA_DIR, options: SangoIndexOptions = {}) {
    this.dataDir = dataDir;
    this.corpusDir = path.join(dataDir, 'corpus', 'sanguo-yanyi');
    this.vectorsFile = path.join(dataDir, 'vectors', 'sanguo-yanyi.bin');
    this.tagsDir = path.join(dataDir, 'corpus', 'tags');
    this.rerankScorer = options.rerankScorer ?? null;
  }

  docs: Doc[] = [];
  postings = new Map<string, { doc: number; tf: number }[]>();
  df = new Map<string, number>();
  avgLen = 0;
  n = 0;

  /** fragmentOnly 键 → 规范形（表设计 §6 / 接口 §2.3：索引侧双写扩展，加载时从实体表模块取快照）。 */
  private fragmentKeyToCanon: ReadonlyMap<string, string> = new Map();

  vec: Float32Array = new Float32Array(0);
  vecDim = 0;
  vecCount = 0;
  vecScheme = VEC_SCHEME_MODEL; // 缺省按模型向量处理（query 无法本地编码时退化为 BM25）

  /** 标签表（tags/*.json：chunkId → 标签文本，多标签以 | 分隔），仅用于多路召回第三路（TAG 分量）。 */
  private tagsByDoc: string[] = [];
  /** 每个 doc 的标签原始文本数组（tagsByDoc[d] 按 | 拆分、trim、去空、保序），供诊断回传命中的标签文本。 */
  private tagTextsByDoc: string[][] = [];
  private tagPostings = new Map<string, number[]>();
  /**
   * 死亡标签人名词典（标签「人物之死-XXX之死」中的 XXX，归一化后）→ 该人死亡 chunk 下标。
   * 死亡意图强命中必须按人匹配，不能只按「文档带死亡标签」匹配：
   * 同一 chunk 可同时含他人死亡标签与目标人名（如「陶谦之死|刘备领徐州」），会误伤他人死亡段。
   */
  private deathByPerson = new Map<string, number[]>();
  /**
   * 遗言段人名词典（归一化标签文本含遗言类关键词且出现死亡人名的 chunk → 该人名）：
   * 临终遗言/托孤类问法命中用（如「刘备托孤」段先于「刘备之死」段，答案在托孤段）。
   */
  private deathSpeechByPerson = new Map<string, number[]>();
  /** chunkId → 文档下标：标签键校验与死键跳过。 */
  private docIndexOf = new Map<string, number>();

  /** 加载语料（chunk 级 schema v2）并构建倒排索引，随后按 chunk 数加载离线向量。
   * 语料缺失 / 读取 / JSON 解析失败时抛错终止启动；向量加载失败仅告警并降级为纯 BM25；
   * 实体表加载失败仅告警并降级为「不做归一化」（normalize 恒等），不影响启动（接口 §1.6）。
   *
   * 一遍构建（FEAT-A016 §1.3 取消 df 选名）：规范形由表直接指定（canonical 列），对归一化文本直接建
   * postings / df；fragmentOnly 片段侧素材在索引侧双写扩展（原文 token 保留、dl 不重算，接口 §2.3）。
   * docs[].text 始终保留原始文本（出参与评测答案正则都依赖原文），只归一化索引侧 token。 */
  load(): void {
    if (!existsSync(this.corpusDir)) {
      const msg = `[sango] corpus 目录不存在：${this.corpusDir}（无语料无法检索，终止启动）`;
      console.error(msg);
      throw new Error(msg);
    }
    const files = readdirSync(this.corpusDir)
      .filter((f) => /^\d{3}\.json$/.test(f))
      .sort();
    // 回级字段（chapter / title）随 chunk 一起带上，供服务端按 id 回溯渲染出处。
    const chunks: Array<{ chapter: number; title: string; chunk: CorpusChunk }> = [];
    for (const f of files) {
      const filePath = path.join(this.corpusDir, f);
      let raw: string;
      try {
        raw = readFileSync(filePath, 'utf8');
      } catch (e) {
        const msg = `[sango] corpus 章节文件读取失败：${filePath}（${(e as Error).message}），终止启动`;
        console.error(msg);
        throw new Error(msg);
      }
      let ch: Chapter;
      try {
        ch = JSON.parse(raw) as Chapter;
      } catch (e) {
        const msg = `[sango] corpus 章节 JSON 解析失败：${filePath}（${(e as Error).message}），终止启动`;
        console.error(msg);
        throw new Error(msg);
      }
      // 语料必须为 schema v2（chunks[]）；旧格式（segments[]）属未重建，明确报错而非静默降级。
      if (!Array.isArray(ch.chunks)) {
        const msg = `[sango] corpus 格式非法（应为 schema v2 的 chunks[]）：${filePath}，终止启动`;
        console.error(msg);
        throw new Error(msg);
      }
      for (const chunk of ch.chunks) {
        chunks.push({ chapter: ch.chapter, title: ch.title, chunk });
      }
    }
    this.n = chunks.length;
    if (this.n === 0) {
      const msg = `[sango] corpus 未加载到任何 chunk：${this.corpusDir}（无语料无法检索，终止启动）`;
      console.error(msg);
      throw new Error(msg);
    }

    // 实体表加载：成功则 rewriteKeys 替换生效（铲除两遍构建的 df 选名）；失败则 normalize 退化为恒等。
    loadEntityTable(this.dataDir);
    this.fragmentKeyToCanon = entityFragmentKeyToCanon();

    for (let di = 0; di < chunks.length; di++) {
      const { chapter, title, chunk } = chunks[di];
      const normText = entityNormalize(chunk.text);
      const tokens = tokenize(normText);
      const tf = new Map<string, number>();
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      // fragmentOnly 双写扩展（接口 §2.3）：片段短语命中「处」逐一追加写入其规范形 token——
      // tf 按命中处数计（如 0076:c0014「关公」x6 → 关羽 tf +6，等价于旧 alias 逐处折算的 tf 贡献）。
      // 只增倒排条目；docs[].len 仍取原文 token 数（dl 不重算），双写引致的 df 略升为已知可接受偏差。
      const len = tokens.length;
      if (this.fragmentKeyToCanon.size > 0) {
        for (const [fragment, canonical] of this.fragmentKeyToCanon) {
          if (!normText.includes(fragment)) continue;
          const count = normText.split(fragment).length - 1;
          for (const t of new Set(tokenize(canonical))) tf.set(t, (tf.get(t) ?? 0) + count);
        }
      }
      this.docs.push({
        chunkId: chunk.id,
        chapter,
        title,
        type: chunk.type,
        segFrom: chunk.segFrom,
        segTo: chunk.segTo,
        quoteBalanced: chunk.quoteBalanced,
        quotes: chunk.quotes,
        text: chunk.text,
        tokens,
        tf,
        len,
      });
      this.docIndexOf.set(chunk.id, di);
      for (const [t, fq] of tf) {
        this.df.set(t, (this.df.get(t) ?? 0) + 1);
        const arr = this.postings.get(t) ?? [];
        arr.push({ doc: di, tf: fq });
        this.postings.set(t, arr);
      }
    }
    this.avgLen = this.docs.reduce((s, d) => s + d.len, 0) / this.n;
    this.loadVectors(this.n);
    this.loadTags();
    this.loadEvents();
  }

  /**
   * FEAT-A018：事件表加载（事件名桥 + 组内闭环装配的数据源，接口 §2.1）。
   * 漂移检测需要 chunkId → 文档下标反查（docIndexOf 现成成员）与当前语料 chunk 数，
   * 必须在 docs 构建完成之后执行（与标签同阶段）。事件表失败仅告警降级为「无事件路由」，
   * 不阻断启动（核心语料失败仍终止，现状不变）。
   */
  private loadEvents(): void {
    loadEventsTable(this.dataDir, (chunkId) => this.docIndexOf.has(chunkId), this.n);
  }

  /**
   * 加载标签表（data/corpus/tags/{duel,event,story}.json：chunkId → 标签文本，多标签以 | 分隔），
   * 建「标签 token → 文档」倒排供第三路召回。标签文本与 query 侧同口径归一化（entity-table 在前），
   * 保证「人物之死-关羽之死」标签与「云长怎么死的」问法互相命中。
   * 入倒排前按 stripTagType 剥离标签类型信息（feat-A014 索引剥壳），类型词不进候选面；
   * 死亡 / 遗言解析与 hitLabels 判定基于原始标签文本，剥壳不作用于这些路径。
   * 加载失败 / 内容非法仅告警并降级为「无标签路由」，不影响启动；死键（chunkId 不在语料）跳过。
   * 标签只进 TAG 分量，不改 chunk / 向量。
   */
  private loadTags(): void {
    for (const file of ['duel.json', 'event.json', 'story.json']) {
      const tagFile = path.join(this.tagsDir, file);
      if (!existsSync(tagFile)) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(tagFile, 'utf8'));
      } catch (e) {
        console.error(`[sango] 标签加载失败：${tagFile}（${(e as Error).message}），降级为无标签路由`);
        continue;
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        console.error(`[sango] 标签内容非法（应为 Record<chunkId, 标签文本>）：${tagFile}，降级为无标签路由`);
        continue;
      }
      for (const [chunkId, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value !== 'string' || value.length === 0) continue;
        const di = this.docIndexOf.get(chunkId);
        if (di === undefined) continue; // 死键：键不在语料，跳过
        this.tagsByDoc[di] = this.tagsByDoc[di] ? `${this.tagsByDoc[di]}|${value}` : value;
      }
    }
    let taggedCount = 0;
    for (let di = 0; di < this.n; di++) {
      const text = this.tagsByDoc[di];
      if (!text) continue;
      taggedCount++;
      // 诊断用：保留标签原始文本（未归一化），供 hitLabels 回传可读标签（与倒排同一 `|` 拆分口径）。
      this.tagTextsByDoc[di] = text
        .split('|')
        .map((tag) => tag.trim())
        .filter((tag) => tag.length > 0);
      // 死亡 / 遗言人名词典与 hitLabels 判定均基于原始标签文本（仅同口径归一化人名），剥壳不作用于这些路径。
      const normTags = this.multiHangTags(this.tagTextsByDoc[di].map((tag) => entityNormalize(tag)));
      for (const tag of normTags) {
        if (tag.startsWith('人物之死-')) {
          let person = tag.slice('人物之死-'.length);
          if (person.endsWith('之死')) person = person.slice(0, -2);
          const arr = this.deathByPerson.get(person) ?? [];
          arr.push(di);
          this.deathByPerson.set(person, arr);
        }
      }
      // 索引剥壳（feat-A014）：tagPostings 只入库剥离类型信息后的文本，类型词不再进第三路候选面。
      const strippedTags = normTags.map((tag) => this.stripTagType(tag));
      for (const t of new Set(tokenize(strippedTags.join('|')))) {
        const arr = this.tagPostings.get(t) ?? [];
        arr.push(di);
        this.tagPostings.set(t, arr);
      }
    }
    // 遗言段人名词典（第二遍）：标签文本含遗言类关键词且出现死亡人名的 chunk 归到该人名。
    // 必须单独一遍：第一遍结束时 deathByPerson 才收齐——0085:c0008-0010 的托孤段本身没打死亡标签。
    for (let di = 0; di < this.n; di++) {
      const text = this.tagsByDoc[di];
      if (!text) continue;
      const normText = entityNormalize(text);
      if (!LAST_WORDS_TAG.test(normText)) continue;
      for (const person of this.deathByPerson.keys()) {
        if (normText.includes(person)) {
          const arr = this.deathSpeechByPerson.get(person) ?? [];
          arr.push(di);
          this.deathSpeechByPerson.set(person, arr);
        }
      }
    }
    console.error(`[sango] 标签已加载：${taggedCount}/${this.n} chunk 有标签（${this.tagPostings.size} 个标签 token）`);
  }

  /**
   * 索引剥壳（feat-A014）：剥离标签中的类型信息，返回仅供 tagPostings 入库的文本 ——
   *   - 人物之生-XX登场 / 人物之死-XX之死 → XX（纯人物名）
   *   - 武将单挑-A-B → A-B（保留对阵双方）
   *   - event 其余类型前缀（战役- / 政治事件- / 谋略/计策- / 结盟/外交- / 典故事件-）剥离前缀、保留内容
   *   - story 标签无类型前缀，原文即终型
   * 死亡 / 登场语义由结构承载（deathByPerson 人名词典 / 事件内容），类型词（人物 / 物之 / 之生 /
   * 之死 / 登场 等）不再进第三路候选面；原始标签文本仍由 tagTextsByDoc 保留供 hitLabels 回读。
   * 入参为单个标签（| 拆分后）的归一化文本。
   */
  private stripTagType(normTag: string): string {
    if (normTag.startsWith('人物之生-')) return normTag.slice('人物之生-'.length).replace(/登场$/, '');
    if (normTag.startsWith('人物之死-')) return normTag.slice('人物之死-'.length).replace(/之死$/, '');
    if (normTag.startsWith('武将单挑-')) return normTag.slice('武将单挑-'.length);
    for (const prefix of ['战役-', '政治事件-', '谋略/计策-', '结盟/外交-', '典故事件-']) {
      if (normTag.startsWith(prefix)) return normTag.slice(prefix.length);
    }
    return normTag;
  }

  /**
   * 共享实体标签多挂的机制入口（接口 §2.4 / 表设计 §6 消费矩阵：标签侧）：
   * 跨主条目词（fragmentOnly，如 文帝 / 陈留王 / 魏王）不进改写键，但按 referentVerdicts 的
   * dist/topPid 做「共享实体标签多挂」——同一标签词挂在多个候选主条目上，经 tagPostings
   * 第三路召回与原文直配双轨并行。
   * 当前实现 = 恒等（标签内容清单交由标签建设轮细化，本契约只承诺机制入口与数据依据）；实现多挂时
   * 在此返回「原始标签 + 多挂目标标签」并沿用先天 tagPostings 去重；hitLabels 仍以原始标签文本判定。
   */
  private multiHangTags(normTags: string[]): string[] {
    return normTags;
  }

  /**
   * 读取离线向量文件（magic 'SNGV' + dim/count/scheme 各 4 字节 LE，随后为 float32 矩阵，
   * 与 scripts/build_vectors.py 的写出格式一致）。count 与语料 chunk 数不一致时忽略向量，仅用 BM25。
   */
  private loadVectors(expectedCount: number): void {
    let buf: Buffer;
    try {
      buf = readFileSync(this.vectorsFile);
    } catch (e) {
      console.error(`[sango] vectors 读取失败：${this.vectorsFile}（${(e as Error).message}），忽略向量，本次仅用 BM25`);
      return;
    }
    try {
      if (buf.length < 16 || buf.toString('utf8', 0, 4) !== 'SNGV') {
        console.error(`[sango] vectors 文件头非法：${this.vectorsFile}，忽略向量，本次仅用 BM25`);
        return;
      }
      const dim = buf.readUInt32LE(4);
      const count = buf.readUInt32LE(8);
      const scheme = buf.readUInt32LE(12);
      if (count !== expectedCount) {
        console.error(`[sango] vectors 数量 ${count} 与 corpus chunk 数 ${expectedCount} 不一致，忽略向量，本次仅用 BM25`);
        return;
      }
      this.vecDim = dim;
      this.vecCount = count;
      this.vecScheme = scheme;
      this.vec = new Float32Array(buf.buffer, buf.byteOffset + 16, dim * count);
      if (scheme === VEC_SCHEME_HASH) {
        console.error(`[sango] vectors 已加载：${count} x dim=${dim} scheme=hash`);
      } else {
        // scheme=model（BGE-M3）：query 侧由 embed/bge-m3-encoder.ts 运行期编码，首次检索懒加载权重
        console.error(`[sango] vectors 已加载：${count} x dim=${dim} scheme=model（BGE-M3，query 侧运行期编码）`);
      }
    } catch (e) {
      console.error(`[sango] vectors 解析失败：${this.vectorsFile}（${(e as Error).message}），忽略向量，本次仅用 BM25`);
      this.vecDim = 0;
      this.vecCount = 0;
      this.vecScheme = VEC_SCHEME_MODEL;
      this.vec = new Float32Array(0);
    }
  }

  /**
   * 混合召回：词法命中走 BM25（+ 真向量余弦加权），词法未命中走真向量兜底
   * （低于 MIN_COSINE 判为无命中）。按相关度降序返回最多 limit 条结构化条目；
   * 无命中返回空数组，由工具层转成 NO_HIT_TEXT 话术供模型走兜底。
   *
   * 仅 scheme=model 的真向量参与检索：scheme=hash 的哈希向量无语义，完全不参与加权也不参与兜底，
   * 此时退化为纯 BM25；纯 BM25 且词法无命中时直接判无命中。
   *
   * 死亡类问法（怎么死的/被谁杀/死了吗…，见 search/intent.ts）按归一化人名匹配死亡标签人名词典
   * （「人物之死-XXX之死」），命中 chunk 在排序阶段置顶为高置信候选（分数仍为 [0,1] 的三路加权，
   * 不加分）；该人物死亡多 chunk 时，死因/凶手/地点/时间/确认类问法取靠前段（死因段），
   * 事后类取靠后段（追述/续事段）。临终遗言/托孤类问法优先命中该人物的托孤/遗诏段
   * （deathSpeechByPerson，如 0085:c0009-0010 白帝城托孤），无遗言段时退回死亡段。
   * 死亡年龄类问法（死的时候多少岁/享年/卒年/去世时多大…）取靠前段，且死亡段与遗言/遗诏段一并置顶
   * （年龄事实段常落在遗言/遗诏段）。
   *
   * 异步：scheme=model 时需运行期编码 query（BGE-M3 ONNX 推理，见 embed/bge-m3-encoder.ts）。
   */
  async search(
    query: string,
    limit: number,
    options?: { diagnostics?: boolean },
  ): Promise<SearchResult> {
    const wantDiag = options?.diagnostics === true;
    if (this.n === 0) return { entries: [], diagnostics: null };
    // §2.2 硬约束（FEAT-A016）：query 改写必须在 embed 之前 —— normalized 恒为 embed 输入。
    // query 与语料侧 / 标签侧同口径归一化（entity-table rewriteKeys 替换；表缺失时退化为恒等）。
    const normDetail = entityNormalizeDetail(query);
    const normalized = normDetail.text;
    const qTokens = tokenize(normalized);
    // feat-A013：检索分阶段耗时（毫秒）。各段按「---- 阶段 ----」分界独立计时；
    // 空结果早退路径下未执行的段保持 null（语义见 RetrievalDiagnosticsTiming）。
    const timing: RetrievalDiagnosticsTiming = { bm25: null, vector: null, label: null, merge: null, rerank: null };

    // ---- BM25 打分 ----
    const bm25T0 = performance.now();
    const bm25 = new Float64Array(this.n);
    const lexicalHits = new Set<number>();
    for (const t of qTokens) {
      const posts = this.postings.get(t);
      if (!posts) continue;
      const df = this.df.get(t) ?? 0;
      const idf = Math.log(1 + (this.n - df + 0.5) / (df + 0.5));
      for (const p of posts) {
        const dl = this.docs[p.doc].len;
        bm25[p.doc] += idf * ((p.tf * (K1 + 1)) / (p.tf + K1 * (1 - B + B * (dl / this.avgLen))));
        lexicalHits.add(p.doc);
      }
    }
    const bm25LoopMs = performance.now() - bm25T0;

    // ---- 向量余弦（仅 scheme=model 真向量；scheme=hash 无语义，直接不参与）----
    // query 侧与离线语料同空间编码：embedQuery 懒加载 BGE-M3 ONNX 单例（首次较慢）。
    // 权重缺失 / 推理失败时返回 null（并写 stderr 告警），此处退化为纯 BM25，不抛异常（A6）。
    const useVectors = this.vecScheme === VEC_SCHEME_MODEL && this.vec.length > 0;
    const vectorT0 = performance.now();
    const qVec = useVectors ? await embedQuery(normalized) : null;
    const cosine = qVec ? this.cosineAll(qVec) : null;
    // useVectors=false（scheme=hash / 无向量文件）→ 该段未执行：null；编码失败也计入耗时
    // （实际等待时间，降级状态由 env.degradedBm25Only 表达）
    timing.vector = useVectors ? performance.now() - vectorT0 : null;

    // ---- 归一化 BM25（仅对命中集合）----（归一化归入 BM25 段计时）
    const bm25NormT0 = performance.now();
    const bm25Norm = new Float64Array(this.n);
    if (lexicalHits.size > 0) {
      let min = Infinity;
      let max = -Infinity;
      for (const d of lexicalHits) {
        if (bm25[d] < min) min = bm25[d];
        if (bm25[d] > max) max = bm25[d];
      }
      for (const d of lexicalHits) {
        bm25Norm[d] = max > min ? (bm25[d] - min) / (max - min) : 1;
      }
    }
    timing.bm25 = bm25LoopMs + (performance.now() - bm25NormT0);

    // ---- 标签路由（第三路召回）：query 与标签文本同口径分词求交，命中 chunk 进候选集 ----
    const labelT0 = performance.now();
    const tagHits = new Set<number>();
    if (this.tagPostings.size > 0) {
      for (const t of qTokens) {
        if (t.length < 2) continue; // 单字词元（死/之/战…）误命中面太广，标签路由只认双字词元（人名/事件名）
        const posts = this.tagPostings.get(t);
        if (!posts) continue;
        for (const d of posts) tagHits.add(d);
      }
    }
    timing.label = performance.now() - labelT0;

    // ---- 死亡意图强命中（不新增召回）：死亡类问法 + 归一化 query 含死亡人名 → 该人相关 chunk 置顶 ----
    const deathIntent: DeathIntent | null = matchDeathIntent(query);
    const deathHits = new Set<number>();
    if (deathIntent && this.deathByPerson.size > 0) {
      for (const [person, docs] of this.deathByPerson) {
        if (!normalized.includes(person)) continue;
        // 临终遗言类问法优先取该人物遗言段（托孤/遗诏…），无遗言段时退回死亡段，保证行为不劣化；
        // 死亡年龄类问法取「死亡段 ∪ 遗言/遗诏段」一并置顶（年龄事实段常落在遗言/遗诏段）。
        const picked =
          deathIntent === 'death_last_words'
            ? (this.deathSpeechByPerson.get(person) ?? docs)
            : deathIntent === 'death_age'
              ? [...new Set([...(this.deathSpeechByPerson.get(person) ?? []), ...docs])]
              : docs;
        for (const d of picked) deathHits.add(d);
      }
    }

    // ---- 多路候选合并 + 重排（BGE-M3*0.6 + BM25*0.3 + TAG*0.1）----
    const mergeT0 = performance.now();
    const combined: SearchHit[] = [];
    // 向量路 topK（复用为诊断 funnel.vectorTop50 的中间量，不重复计算）
    let vectorTop: number[] = [];
    if (lexicalHits.size > 0 || tagHits.size > 0) {
      const cands = new Set(lexicalHits);
      if (cosine) {
        vectorTop = this.topKByCosine(cosine, 50);
        for (const d of vectorTop) cands.add(d);
      }
      for (const d of tagHits) cands.add(d);
      for (const d of cands) {
        const b = bm25Norm[d];
        const v = cosine ? Math.max(0, (cosine[d] + 1) / 2) : 0;
        const t = tagHits.has(d) ? 1 : 0;
        combined.push({ doc: d, score: BM25_WEIGHT * b + VEC_WEIGHT * v + TAG_WEIGHT * t });
      }
    } else if (cosine) {
      // 纯向量兜底（仅真向量可用时；scheme=hash 无语义 / 无向量 → 无词法命中即判无命中）。
      // 此处不再早退：空三路池仍要进事件名桥——并池后 combined 恒含命中组 chunk（§3.3 第二路召回由此吸收）。
      let best = -Infinity;
      for (let d = 0; d < this.n; d++) if (cosine[d] > best) best = cosine[d];
      if (best >= MIN_COSINE) {
        vectorTop = this.topKByCosine(cosine, Math.max(limit, 20));
        for (const d of vectorTop) {
          // bug-00013：纯向量兜底也按统一加权公式计分（0.6*cosine 映射），保证 finalScore 可由接口字段复算；
          // 此路径余弦 > MIN_COSINE(0.3) > 0 → (cosine+1)/2 恒正，无需再套 max(0,·)。
          combined.push({ doc: d, score: VEC_WEIGHT * ((cosine[d] + 1) / 2) });
        }
      }
      // best < MIN_COSINE：向量存在但全部低于阈值 → 无命中（combined 保持空，走空结果 / 事件路）。
    }
    // ---- FEAT-A018 事件名桥（§3.1 / §3.3）：L1/L2 并池 + 增强查询重排 + L3 锚点置顶 ----
    // 桥只读 normalized、零 LLM、不重编码向量、不改权重（§3.4）；非事件命中请求（groups 空）此段零改动
    // （pinDocs ≡ deathHits、无并池 / 无重排），出参与其余诊断与现状逐字节一致。
    const threeWayCandidates = combined.length; // funnel.mergedCandidates 口径：漏斗只描述三路召回（§4）
    const eventGroups = matchEvents(normalized);
    const l1l2Groups = eventGroups.filter((g) => g.type !== 'L3');
    const l3Groups = eventGroups.filter((g) => g.type === 'L3');
    const inPool = new Set(combined.map((h) => h.doc));
    /** 增强查询重排后的 bm25Norm 覆盖（诊断复算恒等式用）；未并池重排（无 L1/L2 命中）恒 null。 */
    let enhancedBm25Norm: Map<number, number> | null = null;

    // ③ L1/L2 并池：命中组全部有效 chunk 并入候选池——cands 按 doc 下标并集去重、无来源配额；
    // 组 chunk 用全语料预计算的 bm25Norm / cosine 按同一公式出初始分（零新增计算）。
    for (const g of l1l2Groups) {
      for (const chunkId of g.chunkIds) {
        const d = this.docIndexOf.get(chunkId);
        if (d === undefined || inPool.has(d)) continue;
        inPool.add(d);
        combined.push({ doc: d, score: this.unifiedScore(d, bm25Norm, cosine, tagHits) });
      }
    }

    // ④ 池内重排（与三路同公式）：增强查询 = normalized + canonical 事件名（多组命中取优先级最高组）
    // + 命中 alias；按增强查询重算全池 bm25Norm 分量，按原公式 0.6·cos + 0.3·bm25 + 0.1·tag 全池重排
    // ——唯一变化 = bm25Norm，cosine / tag 分量不变（cosine 不重编码，红线 §7）；事件组无独立加分项。
    if (l1l2Groups.length > 0) {
      enhancedBm25Norm = this.rescorePoolWithEnhancedQuery(
        combined,
        l1l2Groups[0],
        normalized,
        inPool,
        cosine,
        tagHits,
      );
      // ③ 合并池硬上限 120 兜底：超限按重排分裁（正常场景触不到：三路 ≤50 + 最大组 59）。
      capMergedPool(combined);
    }

    // ② L3 锚点置顶：组 chunkIds 即落表口径的「标签位点段 ±N」小位点组（2-5 段，按事件内序），并入
    // 死亡意图置顶通道（保证区），不参与池重排（在 ③④ 之后补入，分数为未增强三路公式初始分）。
    const l3Segments = new Map<string, number[]>();
    const l3AnchorDocs = new Set<number>();
    for (const g of l3Groups) {
      const segs = this.l3PositionSegments(g);
      l3Segments.set(g.eventId, segs);
      for (const d of segs) {
        l3AnchorDocs.add(d);
        if (inPool.has(d)) continue;
        inPool.add(d);
        combined.push({ doc: d, score: this.unifiedScore(d, bm25Norm, cosine, tagHits) });
      }
    }

    // 空结果早退：无三路候选且事件路未命中（表降级 / 未命中）→ 与现状实现逐字节一致
    // （timing.merge 保持未执行 = null；eventHit 仅 degraded / normVersion 可读、groups 空）。
    if (combined.length === 0) {
      return {
        entries: [],
        diagnostics: wantDiag
          ? this.safeDiagnostics(() =>
              this.emptySearchDiagnostics(
                query,
                normalized,
                normDetail.hits,
                qTokens,
                cosine,
                deathIntent,
                timing,
                this.emptyEventHit(),
              ),
            )
          : null,
      };
    }

    // 死亡强命中不改分数（三路加权恒在 [0,1]），改为排序两级：保证区（死亡意图命中 ∪ L3 锚点段）整体
    // 置顶，组内按意图选段（死因/凶手/地点/时间/年龄/确认类取靠前段，事后类取靠后段，遗言类不打段序按
    // 加权分），其余候选仍按加权分降序。非事件请求 pinDocs ≡ deathHits，排序与现状一致。
    const pinDocs = l3AnchorDocs.size > 0 ? new Set([...deathHits, ...l3AnchorDocs]) : deathHits;
    const segPick: 'earlier' | 'later' | 'none' =
      deathIntent === 'death_aftermath' ? 'later' : deathIntent === 'death_last_words' ? 'none' : 'earlier';
    combined.sort((a, b) => {
      const ad = pinDocs.has(a.doc) ? 1 : 0;
      const bd = pinDocs.has(b.doc) ? 1 : 0;
      if (ad !== bd) return bd - ad;
      if (ad === 1 && pinDocs.size > 1 && a.doc !== b.doc && segPick !== 'none') {
        return segPick === 'later' ? b.doc - a.doc : a.doc - b.doc;
      }
      return b.score - a.score;
    });

    timing.merge = performance.now() - mergeT0;
    // ---- FEAT-A030 cross-encoder 重排：规则重排后 top50 → 重排（保证区置顶段不参与）----
    const rerankDiag = await this.rerankWindow(combined, pinDocs, normalized, timing);

    // ⑤ 取窗：cross-encoder 重排后 combined[0..limit)（重排不可用时退回规则重排序）。
    const hits = combined.slice(0, limit);
    const eventHit = this.buildEventHit(eventGroups, hits, l3Segments);
    const eventDocSet = this.eventDocSetOf(eventGroups, l3Segments);
    const entries = hits.map((h) => this.toEntry(this.docs[h.doc]));
    return {
      entries,
      diagnostics: wantDiag
        ? this.safeDiagnostics(() =>
            this.buildDiagnostics({
              raw: query,
              normalized,
              rewrites: normDetail.hits,
              tokens: qTokens,
              bm25,
              bm25Norm,
              bm25NormOverride: enhancedBm25Norm,
              lexicalHits,
              tagHits,
              deathIntent,
              deathHits,
              combined,
              hits,
              threeWayCandidates,
              cosine,
              vectorTop,
              timing,
              eventHit,
              eventDocSet,
              rerank: rerankDiag,
            }),
          )
        : null,
    };
  }

  /** feat-A009：诊断构建统一 trySafe 包裹（旁路原则——产出失败不影响检索与 content）。 */
  private safeDiagnostics(build: () => RetrievalDiagnostics): RetrievalDiagnostics | null {
    try {
      return enforceDiagnosticsBudget(build());
    } catch (error) {
      console.error('[sango] 检索诊断产出失败（旁路，不影响检索）:', error);
      return null;
    }
  }

  /** 空结果路径的最小诊断：funnel 全 0、candidates 空、nextRank null（仍可读环境与降级 / query 处理链）。 */
  private emptySearchDiagnostics(
    query: string,
    normalized: string,
    rewrites: RetrievalQueryRewrite[],
    tokens: string[],
    cosine: Float64Array | null,
    deathIntent: DeathIntent | null,
    timing: RetrievalDiagnosticsTiming,
    eventHit: RetrievalEventHitDiagnostics,
  ): RetrievalDiagnostics {
    return this.buildDiagnostics({
      raw: query,
      normalized,
      rewrites,
      tokens,
      bm25: new Float64Array(0),
      bm25Norm: new Float64Array(0),
      bm25NormOverride: null,
      lexicalHits: new Set(),
      tagHits: new Set(),
      deathIntent,
      deathHits: new Set(),
      combined: [],
      hits: [],
      threeWayCandidates: 0,
      cosine,
      vectorTop: [],
      timing,
      eventHit,
      eventDocSet: new Set(),
      rerank: this.emptyRerankDiagnostics(),
    });
  }

  /**
   * FEAT-A018 §3.3：统一加权公式计分（0.6·cos + 0.3·bm25 + 0.1·tag），三路合并与并池初始分共用。
   * bm25 分量取全语料预计算 bm25Norm（未命中词法恒 0），零新增计算。
   */
  private unifiedScore(
    d: number,
    bm25Norm: Float64Array,
    cosine: Float64Array | null,
    tagHits: Set<number>,
  ): number {
    const b = bm25Norm[d] ?? 0;
    const v = cosine ? Math.max(0, (cosine[d] + 1) / 2) : 0;
    const t = tagHits.has(d) ? 1 : 0;
    return BM25_WEIGHT * b + VEC_WEIGHT * v + TAG_WEIGHT * t;
  }

  /**
   * FEAT-A018 §3.3②：L3 锚点小位点组的文档下标（按事件内序）。
   * 落表口径（Coco 数据侧零 LLM 脚本产出）= 标签位点段 ±N（v1 N=1，2-5 段）：组 chunkIds 即已是
   * 锚点 ±N 小位点组，运行期不再二次扩展，只按事件内序（加载期已按 (回号, 回内 c) 重排）取段。
   */
  private l3PositionSegments(group: MatchedEventGroup): number[] {
    const segs: number[] = [];
    for (const chunkId of group.chunkIds) {
      const d = this.docIndexOf.get(chunkId);
      if (d !== undefined) segs.push(d);
    }
    return segs;
  }

  /**
   * FEAT-A018 §3.3④：增强查询 = normalized + 命中组 canonical 事件名（多组命中取优先级最高组）
   * + matchedAlias；按增强查询重算全池 bm25Norm 分量（min-max 归一到池内命中），按原公式
   * 0.6·cos + 0.3·bm25 + 0.1·tag 全池重排——唯一变化 = bm25Norm，cosine / tag 分量逐项不变
   * （cosine 不重编码）。零新增 LLM。
   */
  private rescorePoolWithEnhancedQuery(
    pool: SearchHit[],
    topGroup: MatchedEventGroup,
    normalized: string,
    inPool: Set<number>,
    cosine: Float64Array | null,
    tagHits: Set<number>,
  ): Map<number, number> {
    const enhancedTokens = new Set(tokenize(`${normalized}${topGroup.eventName}${topGroup.matchedAlias}`));
    const raw = new Map<number, number>();
    for (const t of enhancedTokens) {
      const posts = this.postings.get(t);
      if (!posts) continue;
      const df = this.df.get(t) ?? 0;
      const idf = Math.log(1 + (this.n - df + 0.5) / (df + 0.5));
      for (const p of posts) {
        if (!inPool.has(p.doc)) continue;
        const dl = this.docs[p.doc].len;
        const contrib = idf * ((p.tf * (K1 + 1)) / (p.tf + K1 * (1 - B + B * (dl / this.avgLen))));
        raw.set(p.doc, (raw.get(p.doc) ?? 0) + contrib);
      }
    }
    let min = Infinity;
    let max = -Infinity;
    for (const v of raw.values()) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const normBm25 = (d: number): number => {
      const v = raw.get(d);
      if (v === undefined) return 0;
      return max > min ? (v - min) / (max - min) : 1;
    };
    const bm25NormOverride = new Map<number, number>();
    for (const h of pool) {
      const v = cosine ? Math.max(0, (cosine[h.doc] + 1) / 2) : 0;
      const t = tagHits.has(h.doc) ? 1 : 0;
      const b = normBm25(h.doc);
      h.score = BM25_WEIGHT * b + VEC_WEIGHT * v + TAG_WEIGHT * t;
      bm25NormOverride.set(h.doc, b);
    }
    return bm25NormOverride;
  }

  /**
   * FEAT-A030：规则重排后取 top50 作 cross-encoder 输入，对**非保证区**候选按 query 相关性重排，
   * 原地改写 combined 前段顺序（出参与诊断 candidates 同序，可读证）；保证区置顶段（死亡意图 ∪ L3 锚点）
   * 保持 A018 §3.3② 承诺「进保证区、不参与池重排」，不参与重排。
   *
   * 重排不可用（未接 / 权重缺失 / 推理失败）时保持规则序、不抛异常（不 mock、不伪造分数）。
   * 返回检索重排诊断（test-2031 提测反馈补可观测），并按契约输出一行中文日志。
   */
  private async rerankWindow(
    pool: SearchHit[],
    pinDocs: Set<number>,
    query: string,
    timing: RetrievalDiagnosticsTiming,
  ): Promise<RetrievalRerankDiagnostics> {
    const t0 = performance.now();
    const windowSize = rerankWindowSize();
    const window = pool.slice(0, windowSize);
    const head = window.filter((h) => pinDocs.has(h.doc));
    const tail = window.filter((h) => !pinDocs.has(h.doc));
    const diag: RetrievalRerankDiagnostics = {
      enabled: this.rerankScorer !== null,
      window: windowSize,
      considered: tail.length,
      skippedPinned: head.length,
      applied: false,
      reason: null,
    };
    if (!this.rerankScorer || pool.length === 0 || tail.length === 0) {
      diag.reason = !this.rerankScorer ? '未接入重排打分器' : '窗口内无参与候选';
      timing.rerank = null;
      this.logRerank(diag, null);
      return diag;
    }
    let scores: number[] | null;
    try {
      scores = await this.rerankScorer(query, tail.map((h) => this.docs[h.doc].text));
    } catch (error) {
      console.error('[sango] 重排打分异常（旁路，退回规则序）:', error);
      diag.reason = '重排打分异常';
      timing.rerank = performance.now() - t0;
      this.logRerank(diag, timing.rerank);
      return diag;
    }
    if (!scores || scores.length !== tail.length) {
      diag.reason = '重排分数非法';
      timing.rerank = performance.now() - t0;
      this.logRerank(diag, timing.rerank);
      return diag;
    }
    const list = scores;
    const ranked = tail
      .map((h, i) => ({ h, s: list[i] }))
      .sort((a, b) => b.s - a.s) // 稳定排序：同分保持规则序
      .map((x) => x.h);
    const merged = [...head, ...ranked, ...pool.slice(windowSize)];
    for (let i = 0; i < merged.length; i++) pool[i] = merged[i];
    diag.applied = true;
    timing.rerank = performance.now() - t0;
    this.logRerank(diag, timing.rerank);
    return diag;
  }

  /** 每请求一行中文日志（可观测：重排阶段 / 窗口 / 参与 / 降级原因；耗时=— 表示重排段未执行）。 */
  private logRerank(diag: RetrievalRerankDiagnostics, elapsedMs: number | null): void {
    const elapsed = elapsedMs === null ? '—' : `${elapsedMs.toFixed(1)}ms`;
    const result = diag.applied ? '已按重排分改写池序' : `跳过（原因：${diag.reason}）`;
    console.error(
      `[sango] 检索重排（阶段：规则序并池之后、保证区不参与）：窗口=${diag.window} 参与=${diag.considered} 跳过置顶=${diag.skippedPinned} 耗时=${elapsed} 结果=${result}`,
    );
  }

  /** 空结果早退 / 无命中路径的重排诊断默认值（重排段未执行：considered=0 / skippedPinned=0 / applied=false）。 */
  private emptyRerankDiagnostics(): RetrievalRerankDiagnostics {
    const enabled = this.rerankScorer !== null;
    return {
      enabled,
      window: rerankWindowSize(),
      considered: 0,
      skippedPinned: 0,
      applied: false,
      reason: enabled ? '窗口内无参与候选' : '未接入重排打分器',
    };
  }

  /** FEAT-A018：空事件路（表降级 / 未命中）时的最小 eventHit（degraded / normVersion 仍可读，groups 空）。 */
  private emptyEventHit(): RetrievalEventHitDiagnostics {
    return { degraded: eventsDegraded(), normVersion: eventsNormVersion(), groupCount: 0, groups: [] };
  }

  /**
   * FEAT-A018 §5.2：命中事件组 → eventHit 明细。
   * placedChunkIds = 实际进出参条目的事件组 chunk：L3 锚点小位点组按事件内序（语料序）；L1/L2 按重排后出参序
   * （placedCount = placedChunkIds.length）。
   */
  private buildEventHit(
    groups: MatchedEventGroup[],
    hits: SearchHit[],
    l3Segments: Map<string, number[]>,
  ): RetrievalEventHitDiagnostics {
    const rankOf = new Map<number, number>();
    for (let i = 0; i < hits.length; i++) {
      if (!rankOf.has(hits[i].doc)) rankOf.set(hits[i].doc, i);
    }
    return {
      degraded: eventsDegraded(),
      normVersion: eventsNormVersion(),
      groupCount: groups.length,
      groups: groups.map((g) => {
        let placedDocs: number[];
        if (g.type === 'L3') {
          // L3 锚点组按事件内序（l3Segments 已按语料序）；仅保留进了出参的段
          placedDocs = (l3Segments.get(g.eventId) ?? []).filter((d) => rankOf.has(d));
        } else {
          // L1/L2 按重排后出参序
          placedDocs = g.chunkIds
            .map((chunkId) => this.docIndexOf.get(chunkId))
            .filter((d): d is number => d !== undefined && rankOf.has(d))
            .sort((a, b) => (rankOf.get(a) as number) - (rankOf.get(b) as number));
        }
        const placedChunkIds = placedDocs.map((d) => this.docs[d].chunkId);
        return {
          eventId: g.eventId,
          eventName: g.eventName,
          matchedAlias: g.matchedAlias,
          type: g.type,
          groupSize: g.groupSize,
          placedCount: placedChunkIds.length,
          placedChunkIds,
        };
      }),
    };
  }

  /**
   * FEAT-A018 §5.3：命中事件组相关 chunk 的文档下标集合（candidates[].sources 'event' 判定用）：
   * L1/L2 = 组 chunk 引用；L3 = 锚点 ±N 小位点组（实际置顶段）。
   */
  private eventDocSetOf(groups: MatchedEventGroup[], l3Segments: Map<string, number[]>): Set<number> {
    const docs = new Set<number>();
    for (const g of groups) {
      for (const chunkId of g.chunkIds) {
        const di = this.docIndexOf.get(chunkId);
        if (di !== undefined) docs.add(di);
      }
      if (g.type === 'L3') {
        for (const d of l3Segments.get(g.eventId) ?? []) docs.add(d);
      }
    }
    return docs;
  }

  /** 从 search 各中间量组装诊断（契约 §1.3）；注入 / 被引用占位 null，由总台回填。 */
  private buildDiagnostics(ctx: DiagnosticsBuildContext): RetrievalDiagnostics {
    const degraded = ctx.cosine === null;
    const vectorTopSet = new Set(ctx.vectorTop);
    const candidates = ctx.combined
      .slice(0, MAX_DIAGNOSTIC_CANDIDATES)
      .map((h, i) => this.buildDiagnosticCandidate(h, i + 1, ctx, vectorTopSet));
    const nextHit = ctx.combined[ctx.hits.length];
    const nextRank: RetrievalCandidateDiagnostics | null = nextHit
      ? {
          ...this.buildDiagnosticCandidate(nextHit, ctx.hits.length + 1, ctx, vectorTopSet),
          gapToTopN: Math.max(0, roundGap(ctx.hits[ctx.hits.length - 1].score - nextHit.score)),
        }
      : null;
    const combinedDocs = new Set(ctx.combined.map((h) => h.doc));
    const pinnedChunkIds = [...ctx.deathHits]
      .filter((d) => combinedDocs.has(d))
      .map((d) => this.docs[d].chunkId);
    return {
      truncated: false,
      truncatedCount: 0,
      query: { raw: ctx.raw, normalized: ctx.normalized, rewrites: ctx.rewrites, tokens: ctx.tokens },
      env: {
        vectorScheme: degraded ? null : this.vecScheme === VEC_SCHEME_MODEL ? 'bge-m3' : null,
        degradedBm25Only: degraded,
        corpusChunks: this.n,
        aliasCount: entityRewriteKeyCount(),
        normVersion: entityNormVersion(),
        vectorDim: degraded ? null : this.vecDim,
      },
      funnel: {
        corpusChunks: this.n,
        lexicalHits: ctx.lexicalHits.size,
        vectorTop50: ctx.vectorTop.length,
        labelHits: ctx.tagHits.size,
        mergedCandidates: ctx.threeWayCandidates,
        topN: ctx.hits.length,
        injected: null,
        cited: null,
      },
      timing: { ...ctx.timing },
      rerank: ctx.rerank,
      candidates,
      nextRank,
      deathIntent: {
        detected: ctx.deathIntent !== null,
        pinned: pinnedChunkIds.length > 0,
        chunkIds: pinnedChunkIds,
      },
      eventHit: ctx.eventHit,
    };
  }

  /** 单条候选诊断：chunkId + 回目 + 三路分 + 来源；注入 / 被引用占位 null。 */
  private buildDiagnosticCandidate(
    h: SearchHit,
    rank: number,
    ctx: DiagnosticsBuildContext,
    vectorTopSet: Set<number>,
  ): RetrievalCandidateDiagnostics {
    const d = h.doc;
    const doc = this.docs[d];
    const sources: string[] = [];
    if (ctx.lexicalHits.has(d)) sources.push('lexical');
    if (vectorTopSet.has(d)) sources.push('vector');
    if (ctx.tagHits.has(d)) sources.push('label');
    // FEAT-A018 §5.3：可选来源 'event' = 候选同时属某命中事件组（便于漏斗核对；非事件命中请求恒不加，与现状逐字节一致）。
    if (ctx.eventDocSet.has(d)) sources.push('event');
    // hitLabels：命中该 chunk 的标签原始文本（保序、去重）。判定口径与 tagPostings 构建 / tagHits 严格一致：
    // 标签经同口径 normalize + tokenize，与 query 词元中长度 ≥ 2 的词元求交（单字词元不参与，同标签路由）。
    // 跨主条目词经共享实体标签多挂命中后，同一标签词可能出现在多个主条目标签命中里，判定仍以原始标签文本为准。
    const hitLabels: string[] = [];
    if (ctx.tagHits.has(d)) {
      const qTokens = new Set(ctx.tokens.filter((t) => t.length >= 2));
      for (const tag of this.tagTextsByDoc[d] ?? []) {
        const tagTokens = new Set(tokenize(entityNormalize(tag)));
        let hit = false;
        for (const t of tagTokens) {
          if (qTokens.has(t)) {
            hit = true;
            break;
          }
        }
        if (hit && !hitLabels.includes(tag)) hitLabels.push(tag);
      }
    }
    return {
      rank,
      chunkId: doc.chunkId,
      chapter: doc.chapter,
      title: doc.title,
      bm25: ctx.lexicalHits.has(d) ? round3(ctx.bm25[d]) : null,
      // 事件命中请求下并池重排的候选回传增强查询归一值（复算恒等式）；其余维持三路口径（未命中词法为 null）。
      bm25Norm: ctx.bm25NormOverride?.get(d) ?? (ctx.lexicalHits.has(d) ? ctx.bm25Norm[d] : null),
      cosine: ctx.cosine ? ctx.cosine[d] : null,
      labelHit: ctx.tagHits.has(d),
      hitLabels,
      finalScore: round3(h.score),
      sources,
      injected: null,
      cited: null,
    };
  }
  /**
   * 索引文档 → 出参条目：只保留契约字段（`id` / `text` / `chapter` / `title` / `type` /
   * `segFrom` / `segTo` / `quoteBalanced` / `quotes`），丢弃索引内部结构（tokens / tf / len）；
   * `chapter` / `title` 随条目逐条展开（召回可跨回，编排侧只能逐条渲染出处，且跨进程读不到语料目录）。
   * `quotes` 按 bug-00010 契约瘦身：只回 `{ offset, len }`，引语文本由调用方按
   * `text.slice(offset - 1, offset - 1 + len + 2)` 还原（= “ + 引语本体 + ”）。文本不做任何拼接。
   */
  private toEntry(d: Doc): SearchEntry {
    return {
      id: d.chunkId,
      text: d.text,
      chapter: d.chapter,
      title: d.title,
      type: d.type,
      segFrom: d.segFrom,
      segTo: d.segTo,
      quoteBalanced: d.quoteBalanced,
      quotes: d.quotes.map((q) => ({ offset: q.offset, len: q.text.length })),
    };
  }

  private cosineAll(qVec: Float32Array): Float64Array {
    const out = new Float64Array(this.n);
    const dim = this.vecDim;
    let qn = 0;
    for (let j = 0; j < dim; j++) qn += qVec[j] * qVec[j];
    qn = Math.sqrt(qn);
    if (qn === 0) return out;
    for (let d = 0; d < this.n; d++) {
      const off = d * dim;
      let dot = 0;
      let dn = 0;
      for (let j = 0; j < dim; j++) {
        const a = this.vec[off + j];
        dot += a * qVec[j];
        dn += a * a;
      }
      dn = Math.sqrt(dn);
      out[d] = dn > 0 ? dot / (dn * qn) : 0;
    }
    return out;
  }

  private topKByCosine(cosine: Float64Array, k: number): number[] {
    const idx = Array.from({ length: this.n }, (_, i) => i);
    idx.sort((a, b) => cosine[b] - cosine[a]);
    return idx.slice(0, k);
  }

  /**
   * feat-A010：按回取整回原文（复用 load() 已加载语料，不新建索引、不改语料）。
   * 回号合法但该回语料缺失时抛错（`第 N 回原文不存在`），由总台映射为 404。
   * 相邻回目标题取自已加载回目（docs 按语料文件序展开，chapter/title 逐 doc 携带）。
   */
  getChapter(chapter: number): ChapterPayload {
    const chapterDocs = this.docs.filter((d) => d.chapter === chapter);
    if (chapterDocs.length === 0) {
      throw new Error(`第 ${chapter} 回原文不存在`);
    }
    const title = chapterDocs[0].title;
    return {
      chapter,
      title,
      prev: this.adjacentChapter(chapter - 1),
      next: this.adjacentChapter(chapter + 1),
      chunks: chapterDocs.map((d) => ({
        chunkId: d.chunkId,
        text: d.text,
        type: d.type,
        segFrom: d.segFrom,
        segTo: d.segTo,
      })),
    };
  }

  /** 相邻回目标题：越界（<1 / >120）或该回语料缺失 → null。 */
  private adjacentChapter(chapter: number): { chapter: number; title: string } | null {
    if (chapter < 1 || chapter > 120) return null;
    const doc = this.docs.find((d) => d.chapter === chapter);
    return doc ? { chapter, title: doc.title } : null;
  }
}
