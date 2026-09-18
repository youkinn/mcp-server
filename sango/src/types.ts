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
 * 除 `chunkId`（语料侧字段名为 `id`，出参按契约名 `id` 输出）外，其余检索单元字段继承自
 * `SearchEntry`，保证与契约同源。`tokens` / `tf` / `len` 为索引内部结构，不进条目。
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
