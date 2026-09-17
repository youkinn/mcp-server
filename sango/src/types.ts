/**
 * sango 公共类型：语料 JSON 结构与检索索引内部结构。
 * 只放被多处引用的类型；单文件内部使用的临时类型就地定义，避免过度设计。
 */

/** 语料段：一个最小检索单元（叙述 / 诗词 / 评注）。 */
export interface CorpusSegment {
  index: number;
  type: 'narration' | 'verse' | 'comment';
  text: string;
}

/** 章回：对应 data/corpus/<source>/NNN.json 的结构。 */
export interface Chapter {
  /** 语料来源标识（sanguo-yanyi 毛本 / sanguozhi 预留）。 */
  source: string;
  /** 回目序号。 */
  chapter: number;
  /** 回目标题。 */
  title: string;
  /** 该回全部段落。 */
  segments: CorpusSegment[];
}

/** 索引文档：加载后的段级检索单元（含分词结果与词频）。 */
export interface Doc {
  chapter: number;
  title: string;
  segIndex: number;
  segType: string;
  text: string;
  tokens: string[];
  tf: Map<string, number>;
  len: number;
}

/** 检索命中候选：文档下标 + 混合得分，用于排序与截断。 */
export interface SearchHit {
  doc: number;
  score: number;
}