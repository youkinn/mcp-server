/**
 * sango 公共类型：语料 JSON 结构（schema v2）与检索索引内部结构。
 * 只放被多处引用的类型；单文件内部使用的临时类型就地定义，避免过度设计。
 */

/** 引语冗余表条目：构建期从 chunk 内成对引语抽取，供服务端渲染引用原文（不由模型生成）。 */
export interface Quote {
  /** 引语序号，`Q1` 起，只在 chunk 内唯一（注入期由服务端重编号为全局序号）。 */
  qid: string;
  /** 引语本体（一对 `“…”` 之间的内容，不含引号本身）。 */
  text: string;
  /** 该引语在 chunk `text` 中的起始偏移（开引号位置 + 1，即开引号的 1 基下标）。 */
  offset: number;
  /** 说话人（构建期从 `X曰：“` 捕获）；匹配不到为 null。 */
  speaker: string | null;
}

/**
 * 语料 chunk：schema v2 的最小检索单元（250 字目标 / 400 字硬上限，可跨段）。
 *
 * 字段名与 `docs/sango-corpus-spec.md` §5、接口文档「输出（命中）」逐字一致；
 * 本结构同时就是 `sango_novel_search` 的出参条目——文本与元数据分离，出处由服务端按 id 回溯渲染。
 */
export interface CorpusChunk {
  /** chunk 唯一 ID，规则 `{source}:{回号4位补零}:c{回内序号4位补零}`（回号供服务端回溯渲染出处）。 */
  id: string;
  /** chunk 纯原文；不含出处 / 回目 / 段号 / 类型 / 分数。 */
  text: string;
  /** chunk 类型：叙述 / 诗赞 / 评注。 */
  type: 'narration' | 'verse' | 'comment';
  /** 起始段号（对应构建期 `segments[].index`，从 1 起）。 */
  segFrom: number;
  /** 结束段号；跨段 chunk 时 segFrom != segTo。 */
  segTo: number;
  /** 该 chunk 内引号是否配平（构建期自检产物）。 */
  quoteBalanced: boolean;
  /** 引语冗余表；chunk 内无成对引语时为 []。 */
  quotes: Quote[];
}

/** 章回：对应 data/corpus/<source>/NNN.json 的结构（回级元数据 + chunk 数组）。 */
export interface Chapter {
  /** 语料来源标识（sanguo-yanyi 毛本 / sanguozhi 预留）。 */
  source: string;
  /** 回目序号。 */
  chapter: number;
  /** 回目标题。 */
  title: string;
  /** 该回全部 chunk（构建期中间产物 `segments[]` 不进交付目录）。 */
  chunks: CorpusChunk[];
}

/**
 * `sango_novel_search` 出参条目：chunk 字段 + **逐条展开**的回级字段（`chapter` / `title`）。
 *
 * 语料文件里 `chapter` / `title` 是文档级（按回分文件、不重复），但检索跨全库，单次召回的多条
 * 条目可来自不同回（top5 跨回是常态），编排侧只能逐条渲染出处；且 orchestrator 进程读不到
 * mcp-server 的语料目录，无法「按 id 回溯回文件」。故出参时随每条条目展开。
 * `source` 不在条目级重复（调用方入参已知）。
 * `quotes` 不继承语料的 `Quote`，出参只回 `{ offset, len }`（见 `QuoteRef`，bug-00010）。
 */
export interface SearchEntry extends Omit<CorpusChunk, 'quotes'> {
  /** 回号（回级元数据随条目携带，供服务端渲染出处）。 */
  chapter: number;
  /** 回目（回级元数据随条目携带；出处只到回目）。 */
  title: string;
  /** 引语引用表（只回定位信息，文本由条目 `text` 切片还原）；chunk 内无成对引语时为 []。 */
  quotes: QuoteRef[];
}

/**
 * `sango_novel_search` 出参的引语引用：**只回定位信息，不回引语文本**（bug-00010 契约瘦身）。
 *
 * 引语文本由调用方按切片口径从条目 `text` 还原（含两侧引号）：
 * `text.slice(offset - 1, offset - 1 + len + 2) === "“" + 引语本体 + "”"`。
 * 语料 JSON 仍是 `Quote`（`{ qid, text, offset, speaker }`，不重建），**出参与语料 schema 已分叉**，
 * 故出参类型与语料类型分开定义。
 */
export interface QuoteRef {
  /** 该引语在条目 `text` 中的起始偏移（开引号位置 + 1，即开引号的 1 基下标）。 */
  offset: number;
  /** 引语本体字数（不含两侧引号）。 */
  len: number;
}

/**
 * 索引文档：加载后的 chunk 级检索单元。
 *
 * 除 `chunkId`（语料侧字段名为 `id`，出参按契约名 `id` 输出）与 `quotes`（索引内部按语料原样承载，
 * 出参时才瘦身为 `QuoteRef`）外，其余检索单元字段继承自 `SearchEntry`，保证与契约同源。
 * `tokens` / `tf` / `len` 为索引内部结构，不进条目。
 */
export interface Doc extends Omit<SearchEntry, 'id' | 'quotes'> {
  chunkId: string;
  /** 语料侧引语冗余表（含 `qid` / `text` / `speaker`）；出参时经 `toEntry` 瘦身为 `QuoteRef`。 */
  quotes: Quote[];
  tokens: string[];
  tf: Map<string, number>;
  len: number;
}

/** 检索命中候选：文档下标 + 混合得分，用于排序与截断。 */
export interface SearchHit {
  doc: number;
  score: number;
}

/**
 * 死亡类提问意图：把「XXX之死」标签对应的用户问法归并为有限子类，
 * 供检索侧对命中「人物之死-XXX之死」标签的 chunk 做强命中置顶（见 search/intent.ts、SangoIndex.search）。
 * 子类按问题角度区分：同一死亡事件的不同问法，答案所在 chunk 可能不同（如死因段 vs 死后续事段）。
 */
export type DeathIntent =
  /** 死因/方式：怎么死的、死因、因何而死。 */
  | 'death_manner'
  /** 凶手/经过：被谁杀、死于谁手。 */
  | 'death_agent'
  /** 地点：死在哪、丧命何处。 */
  | 'death_place'
  /** 时间：何时死的。 */
  | 'death_time'
  /** 有无死亡：死了吗、死没死。 */
  | 'death_confirm'
  /** 临终遗言/托孤：死前说了什么、遗言、托孤（答案常在死因段之前的托孤/遗诏段）。 */
  | 'death_last_words'
  /** 死后之事：死后怎样、谁接任（答案常在死因段之后的追述/续事段）。 */
  | 'death_aftermath';

/**
 * 检索诊断：召回可解释载荷（feat-A009，契约 §1.3）。
 * sango 在收到 tools/call params _meta.traceId 时产出，经 result._meta.diagnostics 回传；
 * injected / cited 在产出阶段恒为 null 占位，由总台 agent 收尾回填后落库。
 * 只放结构化小数据（不放 chunk 文本），64 KB 预算由 sango 侧截断保证。
 */

export interface RetrievalQueryDiagnostics {
  /** 工具入参 query 原文。 */
  raw: string;
  /** alias 归一化后文本。 */
  normalized: string;
  /** 分词 tokens。 */
  tokens: string[];
}

export interface RetrievalEnvDiagnostics {
  /** 向量 scheme（BGE-M3 构建头 scheme=1）；向量未参与本次检索（降级）为 null。 */
  vectorScheme: string | null;
  /** true = 本次检索降级纯 BM25（向量缺失 / 编码失败，静默降级）。 */
  degradedBm25Only: boolean;
  /** 语料 chunk 总数。 */
  corpusChunks: number;
  /** alias 条数。 */
  aliasCount: number;
  /** 向量维度；降级为 null。 */
  vectorDim: number | null;
}

export interface RetrievalFunnelDiagnostics {
  /** 语料 chunk 数（漏斗起点，= env.corpusChunks）。 */
  corpusChunks: number;
  /** 词法命中数。 */
  lexicalHits: number;
  /** 向量路 top50 条数；降级为 0。 */
  vectorTop50: number;
  /** 标签命中数。 */
  labelHits: number;
  /** 合并去重后候选数。 */
  mergedCandidates: number;
  /** 最终返回条数（= 工具出参条数，≤ limit）。 */
  topN: number;
  /** 进注入视图条数；sango 产出阶段为 null，总台回填。 */
  injected: number | null;
  /** 被引用条数（去重后 chunk 计数）；同上。 */
  cited: number | null;
}

export interface RetrievalCandidateDiagnostics {
  /** 排名（1 起，按最终返回序）。 */
  rank: number;
  /** chunk 唯一 ID。 */
  chunkId: string;
  /** 回号。 */
  chapter: number;
  /** 回目。 */
  title: string;
  /** BM25 分；词法未命中为 null。 */
  bm25: number | null;
  /** BM25 归一化值（全精度，不 round3）；词法命中集合内 min-max；非词法命中为 null。 */
  bm25Norm: number | null;
  /** 向量余弦相似度（全量回传 / 全精度）；降级纯 BM25 为 null。 */
  cosine: number | null;
  /** 标签是否命中。 */
  labelHit: boolean;
  /** 命中的标签表原始文本（`|` 拆分后的单个标签）；未命中为 []，与 `labelHit` 自洽（非空 ⟺ 命中）。 */
  hitLabels: string[];
  /** 最终分（合并排序分）。 */
  finalScore: number;
  /** 命中来源子集：lexical / vector / label。 */
  sources: string[];
  /** 是否进注入视图；sango 占位 null，总台回填。 */
  injected: boolean | null;
  /** 是否被引用；同上。 */
  cited: boolean | null;
  /** 仅 nextRank：与 top-N 最后一名 finalScore 的分差，≥0。 */
  gapToTopN?: number;
}

export interface RetrievalDeathIntentDiagnostics {
  /** 是否判定死亡意图。 */
  detected: boolean;
  /** 是否触发置顶。 */
  pinned: boolean;
  /** 被置顶的候选 chunkId；未置顶为 []。 */
  chunkIds: string[];
}

/** 检索诊断：召回漏斗 / 候选分数表 / query 处理链 / 环境与降级 / 死亡意图（契约 §1.3）。 */
export interface RetrievalDiagnostics {
  /** 64 KB 预算截断标记。 */
  truncated: boolean;
  /** 被丢弃的候选条数；未截断恒 0。 */
  truncatedCount: number;
  query: RetrievalQueryDiagnostics;
  env: RetrievalEnvDiagnostics;
  funnel: RetrievalFunnelDiagnostics;
  /** 候选分数表，按最终返回序，≤20 条。 */
  candidates: RetrievalCandidateDiagnostics[];
  /** 第 N+1 名（未进 top-N）；候选不足为 null。 */
  nextRank: RetrievalCandidateDiagnostics | null;
  deathIntent: RetrievalDeathIntentDiagnostics;
}

/** feat-A009：search 统一返回 出参条目 + 检索诊断（诊断仅在请求时产出，否则为 null）。 */
export interface SearchResult {
  entries: SearchEntry[];
  diagnostics: RetrievalDiagnostics | null;
}
