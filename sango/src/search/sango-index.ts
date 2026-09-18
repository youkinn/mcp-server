/**
 * SangoIndex：sango_novel_search 的检索核心（BM25 + 离线向量混合召回）。
 *
 * - 语料：data/corpus/sanguo-yanyi/001.json .. 120.json（chunk 级 schema v2，与 Python 构建脚本同源）
 * - 别名：data/alias.json（别名 → 人物 PID）；索引侧与 query 侧统一归一化到规范名
 * - 向量：data/vectors/sanguo-yanyi.bin（与 corpus chunks[] 同序，离线只读）
 * - 出参：结构化条目数组（SearchEntry，回级 chapter / title 随条目逐条展开）
 *   文本内不含出处 / 回目 / 段号 / 类型 / 分数
 * - 检索不做 query 改写 / rerank / 专用向量库。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { embedQuery } from '../embed/bge-m3-encoder.ts';
import type { Chapter, CorpusChunk, Doc, SearchEntry, SearchHit } from '../types.ts';
import { tokenize } from '../utils/text.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATA_DIR = path.resolve(__dirname, '..', '..', 'data');

/** 无命中固定话术：检索无结果时返回，供模型走兜底回答。 */
export const NO_HIT_TEXT = '未召回任何原文段落';

// BM25 参数（k1/b 为经典取值）与混合权重
const K1 = 1.5;
const B = 0.75;
const BM25_WEIGHT = 0.5;
// 向量权重：运行期 query 编码已接线（Step 2，见 sango-recall-quality.md §4.6），
// 离线向量为 scheme=model 的 BGE-M3 真向量（2344 x 1024），query 与语料同空间。
// 取值按 chunk 级实测择优（24 例基准 + 29 例口语改写集 + 31 例精确子串精度集）：
// 0.5~2.0 为平台期，@1/@3/@5 均不低于纯 BM25 基线（19/24 · 20/24 · 21/24），
// 主案例由 #2 升到 #1，精确子串检索无回归；取平台期居中值 1.0，避免贴边抖动。
// 若后续加权出现回归，回退 0 只保留「词法无命中 → 向量兜底」路径。
const VEC_WEIGHT = 1;
const MIN_COSINE = 0.3; // Step 4 待按真向量分布重定（现值为哈希向量时代的死路值，见 §4.6）

// 向量构建方案：与 build_vectors.py 写出的 scheme 字段对应
const VEC_SCHEME_HASH = 0; // 0=确定性哈希向量（运行期可对 query 编码）
const VEC_SCHEME_MODEL = 1; // 1=BGE-M3 等模型向量（运行期需模型编码）

/** 正则元字符转义：与评测脚本 sango-recall-bench.mjs 的 escapeRe 逐字节一致。 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class SangoIndex {
  private readonly corpusDir: string;
  private readonly vectorsFile: string;
  private readonly aliasFile: string;

  /** dataDir 仅用于夹具测试注入语料目录；生产用默认 data/ 目录。 */
  constructor(dataDir: string = DEFAULT_DATA_DIR) {
    this.corpusDir = path.join(dataDir, 'corpus', 'sanguo-yanyi');
    this.vectorsFile = path.join(dataDir, 'vectors', 'sanguo-yanyi.bin');
    this.aliasFile = path.join(dataDir, 'alias.json');
  }

  docs: Doc[] = [];
  postings = new Map<string, { doc: number; tf: number }[]>();
  df = new Map<string, number>();
  avgLen = 0;
  n = 0;

  /** 别名归一化：alias.json 的「别名 → PID」与「PID → 规范名」，以及别名 alternation 正则。 */
  private pidOf = new Map<string, string>();
  private canonOf = new Map<string, string>();
  private aliasPattern: RegExp | null = null;

  vec: Float32Array = new Float32Array(0);
  vecDim = 0;
  vecCount = 0;
  vecScheme = VEC_SCHEME_MODEL; // 缺省按模型向量处理（query 无法本地编码时退化为 BM25）

  /** 加载语料（chunk 级 schema v2）并构建倒排索引，随后按 chunk 数加载离线向量。
   * 语料缺失 / 读取 / JSON 解析失败时抛错终止启动；向量加载失败仅告警并降级为纯 BM25；
   * 别名加载失败仅告警并降级为「不做归一化」，不影响启动。
   *
   * 两遍构建：先用原始文本算 chunk 级 df → 据此为每个 PID 选定规范名 → 再按归一化文本建索引。
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

    // 规范名选取依据：原始（未归一化）文本的 chunk 级 df，必须与评测脚本口径一致。
    const rawDf = new Map<string, number>();
    for (const c of chunks) {
      for (const t of new Set(tokenize(c.chunk.text))) rawDf.set(t, (rawDf.get(t) ?? 0) + 1);
    }
    this.loadAliases(rawDf);

    for (let di = 0; di < chunks.length; di++) {
      const { chapter, title, chunk } = chunks[di];
      const tokens = tokenize(this.normalize(chunk.text));
      const tf = new Map<string, number>();
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
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
        len: tokens.length,
      });
      for (const [t, fq] of tf) {
        this.df.set(t, (this.df.get(t) ?? 0) + 1);
        const arr = this.postings.get(t) ?? [];
        arr.push({ doc: di, tf: fq });
        this.postings.set(t, arr);
      }
    }
    this.avgLen = this.docs.reduce((s, d) => s + d.len, 0) / this.n;
    this.loadVectors(this.n);
  }

  /**
   * 加载 alias.json（Record<别名, PID>），并按「原始语料 chunk 级 df 最大者」为每个 PID 选规范名
   * （df 相同取 alias.json 文件顺序中先出现者）。加载失败 / 损坏仅告警，降级为不做归一化。
   */
  private loadAliases(rawDf: Map<string, number>): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.aliasFile, 'utf8'));
    } catch (e) {
      console.error(`[sango] alias 加载失败：${this.aliasFile}（${(e as Error).message}），降级为不做别名归一化`);
      return;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.error(`[sango] alias 内容非法（应为 Record<别名, PID>）：${this.aliasFile}，降级为不做别名归一化`);
      return;
    }
    const entries = Object.entries(parsed as Record<string, unknown>).filter(
      (e): e is [string, string] => e[0].length > 0 && typeof e[1] === 'string',
    );
    if (entries.length === 0) {
      console.error(`[sango] alias 未解析出任何有效条目：${this.aliasFile}，降级为不做别名归一化`);
      return;
    }
    const byPid = new Map<string, string[]>();
    for (const [name, pid] of entries) {
      this.pidOf.set(name, pid);
      const names = byPid.get(pid) ?? [];
      names.push(name);
      byPid.set(pid, names);
    }
    for (const [pid, names] of byPid) {
      // Array.sort 稳定：df 相同时保留 alias.json 文件顺序中最先出现者。
      this.canonOf.set(pid, names.slice().sort((a, b) => (rawDf.get(b) ?? 0) - (rawDf.get(a) ?? 0))[0]);
    }
    const aliasNames = [...this.pidOf.keys()].sort((a, b) => b.length - a.length);
    this.aliasPattern = new RegExp(aliasNames.map(escapeRegExp).join('|'), 'g');
    console.error(`[sango] alias 已加载：${entries.length} 个别名 / ${byPid.size} 个 PID`);
  }

  /** 别名归一化：按长度降序的 alternation 正则全局替换为规范名（与评测脚本实现一致）。 */
  private normalize(text: string): string {
    if (!this.aliasPattern) return text;
    return text.replace(this.aliasPattern, (m) => this.canonOf.get(this.pidOf.get(m) ?? '') ?? m);
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
   * 异步：scheme=model 时需运行期编码 query（BGE-M3 ONNX 推理，见 embed/bge-m3-encoder.ts）。
   */
  async search(query: string, limit: number): Promise<SearchEntry[]> {
    if (this.n === 0) return [];
    // query 与语料侧同口径归一化后再分词（alias.json 缺失时 normalize 为恒等）。
    const normalized = this.normalize(query);
    const qTokens = tokenize(normalized);

    // ---- BM25 打分 ----
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

    // ---- 向量余弦（仅 scheme=model 真向量；scheme=hash 无语义，直接不参与）----
    // query 侧与离线语料同空间编码：embedQuery 懒加载 BGE-M3 ONNX 单例（首次较慢）。
    // 权重缺失 / 推理失败时返回 null（并写 stderr 告警），此处退化为纯 BM25，不抛异常（A6）。
    const useVectors = this.vecScheme === VEC_SCHEME_MODEL && this.vec.length > 0;
    const qVec = useVectors ? await embedQuery(normalized) : null;
    const cosine = qVec ? this.cosineAll(qVec) : null;

    // ---- 归一化 BM25（仅对命中集合）----
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

    // ---- 混合候选集 ----
    const combined: SearchHit[] = [];
    if (lexicalHits.size > 0) {
      const cands = new Set(lexicalHits);
      if (cosine) {
        for (const d of this.topKByCosine(cosine, 50)) cands.add(d);
      }
      for (const d of cands) {
        const b = bm25Norm[d];
        const v = cosine ? Math.max(0, (cosine[d] + 1) / 2) : 0;
        combined.push({ doc: d, score: BM25_WEIGHT * b + VEC_WEIGHT * v });
      }
    } else {
      // 纯向量兜底（仅真向量可用时；scheme=hash 无语义，纯 BM25 无词法命中即判无命中）
      if (!cosine) return [];
      let best = -Infinity;
      for (let d = 0; d < this.n; d++) if (cosine[d] > best) best = cosine[d];
      if (best < MIN_COSINE) return [];
      for (const d of this.topKByCosine(cosine, Math.max(limit, 20))) {
        combined.push({ doc: d, score: (cosine[d] + 1) / 2 });
      }
    }

    if (combined.length === 0) return [];
    combined.sort((a, b) => b.score - a.score);
    const hits = combined.slice(0, Math.min(limit, combined.length));
    return hits.map((h) => this.toEntry(this.docs[h.doc]));
  }

  /**
   * 索引文档 → 出参条目：只保留契约字段（`id` / `text` / `chapter` / `title` / `type` /
   * `segFrom` / `segTo` / `quoteBalanced` / `quotes`），丢弃索引内部结构（tokens / tf / len）；
   * `chapter` / `title` 随条目逐条展开（召回可跨回，编排侧只能逐条渲染出处，且跨进程读不到语料目录）。
   * 文本不做任何拼接。
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
      quotes: d.quotes,
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
}
