/**
 * sango 公共类型：语料 JSON 结构（schema v2）与检索索引内部结构。
 * 只放被多处引用的类型；单文件内部使用的临时类型就地定义，避免过度设计。
 */

/**
 * 语料 chunk：schema v2 的最小检索单元（250 字目标 / 400 字硬上限，可跨段）。
 *
 * 字段名与 `docs/sango-corpus-spec.md`、语料 JSON 逐字一致；出参条目的字段集见 `SearchEntry`。
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
 */
export interface SearchEntry extends CorpusChunk {
  /** 回号（回级元数据随条目携带，供服务端渲染出处）。 */
  chapter: number;
  /** 回目（回级元数据随条目携带；出处只到回目）。 */
  title: string;
}

/**
 * 索引文档：加载后的 chunk 级检索单元。
 *
 * 出参字段继承自 `SearchEntry`，保证与契约同源；`chunkId` 为语料侧 `id` 的索引内命名。
 * `tokens` / `tf` / `len` 为索引内部结构，不进条目。
 */
export interface Doc extends Omit<SearchEntry, 'id'> {
  chunkId: string;
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
  /** 死亡年龄：死的时候多少岁、死时几岁、享年、卒年、去世时多大。 */
  | 'death_age'
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
  /** 检索用文本：检索侧不改写 => 恒等于 raw（09-29 定案，接口 §2.2）。 */
  normalized: string;
  /** 检索侧不再改写：恒 []（字段保留，兼容历史消费方；接口 §5）。 */
  rewrites: RetrievalQueryRewrite[];
  /** 索引侧双写扩展命中（接口 §5）：query 原文命中可双写键 → 规范形，[{from,to}]；
   *  语义 = 该词在语料 / 标签侧已按等价写法双写覆盖，不改写检索输入；无命中为 []。 */
  expansionHits: RetrievalQueryRewrite[];
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
  /** 表内 rewriteKeys 总数（含人物与非人物）；表加载失败为 0（接口 §5 env.aliasCount 新语义）。 */
  aliasCount: number;
  /** 表 meta.normVersion（8 位内容 hash）；表加载失败降级为空串（与 aliasCount=0 同口径，接口 §5）。 */
  normVersion: string;
  /** 向量维度；降级为 null。 */
  vectorDim: number | null;
}

/** 一条 query 扩展 / 改写明细（接口 §5 query.rewrites / query.expansionHits 元素）：from=原文片段、to=规范形。 */
export interface RetrievalQueryRewrite {
  from: string;
  to: string;
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
  /** 排名（1 起，三路合并候选池序 = topK 装配前；FEAT-A018 §4：事件命中时与最终出参序可能错位，最终序可由 candidates + eventHit.placedChunkIds 重建）。 */
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
  /** 命中来源子集：lexical / vector / label；FEAT-A018 可选增 event / allusion（该候选同时属某命中事件组 / 典故组）。 */
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

/** 上场意图诊断（人物首次登场类问法；与死亡意图同构，供前端同款展示）。 */
export interface RetrievalBirthIntentDiagnostics {
  /** 是否判定登场意图。 */
  detected: boolean;
  /** 是否触发置顶。 */
  pinned: boolean;
  /** 被置顶的候选 chunkId；未置顶为 []。 */
  chunkIds: string[];
}

/** FEAT-A018 §5.2：事件名桥命中诊断（事件路是否生效 / norm 版本 / 命中组明细）。 */
export interface RetrievalEventHitDiagnostics {
  /** 事件路是否生效；false = 表加载失败或整表漂移降级（此时 groups 恒 []）。 */
  degraded: boolean;
  /** 事件表 meta.normVersion；未加载 / 降级为空串（对齐 env.normVersion 降级口径）。 */
  normVersion: string;
  /** 命中事件组数；0 = 未命中事件路。 */
  groupCount: number;
  /** 命中组明细，按组优先级（命中 alias 长度降序，同长 eventId 升序）。 */
  groups: RetrievalEventHitGroup[];
}

/** FEAT-A018 §5.2：单命中事件组诊断。 */
export interface RetrievalEventHitGroup {
  eventId: string;
  eventName: string;
  /** 本组命中的 alias（归一化后 query 中子串命中者，组内最长）。 */
  matchedAlias: string;
  type: 'L1' | 'L2' | 'L3';
  /** 组内有效 chunk 引用总数（漂移剔除后）。 */
  groupSize: number;
  /** 实际进出参条目的事件组 chunk 数（事件内序前缀；= placedChunkIds.length）。 */
  placedCount: number;
  /** 进出参条目的事件组 chunkId（事件内序）。 */
  placedChunkIds: string[];
}

/** FEAT-A018 §5.6：典故名桥命中诊断（镜像 eventHit；典故路是否生效 / norm 版本 / 命中组明细）。 */
export interface RetrievalAllusionHitDiagnostics {
  /** 典故路是否生效；true = 典故表缺失 / 加载失败 / 整表漂移降级（此时 groups 恒 []）。事件路不受影响。 */
  degraded: boolean;
  /** 典故表 meta.normVersion；未加载 / 降级为空串（对齐 eventHit 降级口径）。 */
  normVersion: string;
  /** 命中典故组数；0 = 未命中典故路。 */
  groupCount: number;
  /** 命中组明细，按组优先级（命中 alias 长度降序，同长 allusionId 升序）。 */
  groups: RetrievalAllusionHitGroup[];
}

/** FEAT-A018 §5.6：单命中典故组诊断（典故无 L3；字段镜像事件组、去 type）。 */
export interface RetrievalAllusionHitGroup {
  allusionId: string;
  allusionName: string;
  /** 本组命中的 alias（归一化后 query 中子串命中者，组内最长）。 */
  matchedAlias: string;
  /** 组内有效 chunk 引用总数（漂移剔除后）。 */
  groupSize: number;
  /** 实际进出参条目的典故组 chunk 数（重排后自然进窗，= placedChunkIds.length）。 */
  placedCount: number;
  /** 进出参条目的典故组 chunkId（按重排后出参序）。 */
  placedChunkIds: string[];
}

/** 检索分阶段耗时（毫秒，feat-A013 验收修正；检索耗时展示支撑）。null = 该段未执行：
 * - bm25 = BM25 打分循环 + 归一化（该段覆盖两处代码块）；
 * - vector = 向量编码（embedQuery）+ cosineAll 段；useVectors=false 降级（scheme=hash / 无向量文件）时为 null，
 *   编码失败也计入耗时（降级状态由 env.degradedBm25Only 表达）；
 * - label = 标签路由循环段；
 * - merge = 多路候选合并 + 事件路并池增强查询重排 + 规则排序（到规则序定型为止），不含 cross-encoder 重排；
 *   空结果早退路径未执行到产出时为 null；
 * - rerank = cross-encoder 池内重排段耗时（毫秒，test-2031 提测反馈补独立分段）；未接入打分器 / 窗口内无参与
 *   候选 / 跳过时为 null（原因见 RetrievalRerankDiagnostics.reason）。 */
export interface RetrievalDiagnosticsTiming {
  bm25: number | null;
  vector: number | null;
  label: number | null;
  merge: number | null;
  rerank: number | null;
}

/** FEAT-A030：检索重排诊断（test-2031 提测反馈补可观测：重排阶段 / 窗口 / 参与 / 降级原因）。 */
export interface RetrievalRerankDiagnostics {
  /** 本请求是否接入重排打分器（装配层注入且权重可用）。 */
  enabled: boolean;
  /** 重排窗口（规则序后前 N 名进重排；SANGO_RERANKER_WINDOW 覆盖，默认 50）。 */
  window: number;
  /** 实际参与重排条数（窗口内非保证区）。 */
  considered: number;
  /** 因在保证区置顶（死亡意图 ∪ L3 锚点）而跳过重排条数。 */
  skippedPinned: number;
  /** 是否按重排分实际改写池序。 */
  applied: boolean;
  /** 未重排的中文原因；applied=true 时为 null。取值：未接入重排打分器 / 窗口内无参与候选 / 重排打分异常 / 重排分数非法。 */
  reason: string | null;
}

/** 检索诊断：召回漏斗 / 候选分数表 / query 处理链 / 环境与降级 / 死亡意图 / 分阶段耗时（契约 §1.3）。 */
export interface RetrievalDiagnostics {
  /** 64 KB 预算截断标记。 */
  truncated: boolean;
  /** 被丢弃的候选条数；未截断恒 0。 */
  truncatedCount: number;
  query: RetrievalQueryDiagnostics;
  env: RetrievalEnvDiagnostics;
  funnel: RetrievalFunnelDiagnostics;
  /** 分阶段耗时（毫秒，检索耗时展示支撑）；null = 该段未执行（语义见 RetrievalDiagnosticsTiming）。 */
  timing: RetrievalDiagnosticsTiming;
  /** FEAT-A030：检索重排诊断（新增顶层字段，老字段不动；未接入 / 空结果早退路径也产出默认值）。 */
  rerank: RetrievalRerankDiagnostics;
  /** 候选分数表，按最终返回序，≤20 条。 */
  candidates: RetrievalCandidateDiagnostics[];
  /** 第 N+1 名（未进 top-N）；候选不足为 null。 */
  nextRank: RetrievalCandidateDiagnostics | null;
  deathIntent: RetrievalDeathIntentDiagnostics;
  /** 登场意图诊断（人物首次登场类问法；历史诊断无该字段，前端容错不展示）。 */
  birthIntent: RetrievalBirthIntentDiagnostics;
  /** FEAT-A018：事件名桥命中诊断（新增顶层字段，老字段不动；非事件命中时 groups 空、degraded / normVersion 仍可读）。 */
  eventHit: RetrievalEventHitDiagnostics;
  /** FEAT-A018：典故名桥命中诊断（镜像 eventHit；非典故命中时 groups 空、degraded / normVersion 仍可读）。 */
  allusionHit: RetrievalAllusionHitDiagnostics;
}

/** feat-A009：search 统一返回 出参条目 + 检索诊断（诊断仅在请求时产出，否则为 null）。 */
export interface SearchResult {
  entries: SearchEntry[];
  diagnostics: RetrievalDiagnostics | null;
}

/**
 * `sango_novel_chapter` 出参（feat-A010）：整回原文 + 相邻回目。
 * chunk 字段按契约名 `chunkId` 输出（语料 schema 字段名为 `id`，出参转换，见接口文档 §3.1）。
 */
export interface ChapterChunk {
  /** chunk 唯一 ID（= 语料 `id`，`{source}:{回号4位补零}:c{回内序号4位补零}`）。 */
  chunkId: string;
  /** chunk 纯原文；不含出处 / 回目 / 段号 / 类型 / 分数。 */
  text: string;
  /** chunk 类型：叙述 / 诗赞 / 评注。 */
  type: 'narration' | 'verse' | 'comment';
  /** 起始段号（1 起）。 */
  segFrom: number;
  /** 结束段号；跨段 chunk 时 segFrom != segTo。 */
  segTo: number;
}

/** `sango_novel_chapter` 出参整体：整回 + 相邻回目标题（供前端按钮显示，避免多拉一次全文）。 */
export interface ChapterPayload {
  chapter: number;
  title: string;
  /** 上一回 `{chapter, title}`；第 1 回 / 相邻回缺失为 null。 */
  prev: { chapter: number; title: string } | null;
  /** 下一回 `{chapter, title}`；第 120 回 / 相邻回缺失为 null。 */
  next: { chapter: number; title: string } | null;
  /** 本回全部 chunk（语料文件内顺序）。 */
  chunks: ChapterChunk[];
}
