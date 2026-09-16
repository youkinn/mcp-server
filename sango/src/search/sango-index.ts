/**
 * SangoIndex：sango_novel_search 的检索核心（BM25 + 离线向量混合召回）。
 *
 * - 语料：data/corpus/sanguo-yanyi/001.json .. 120.json（段级，与 Python 构建脚本同源）
 * - 向量：data/vectors/sanguo-yanyi.bin（与 corpus 段级同序，离线只读）
 * - 检索不做 query 改写 / rerank / 专用向量库。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Chapter, Doc, SearchHit } from '../types.js';
import { embedTokensByHash } from '../utils/hash.js';
import { tokenize } from '../utils/text.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', '..', 'data');
const CORPUS_DIR = path.join(DATA_DIR, 'corpus', 'sanguo-yanyi');
const VECTORS_FILE = path.join(DATA_DIR, 'vectors', 'sanguo-yanyi.bin');

/** 无命中固定话术：检索无结果时返回，供模型走兜底回答。 */
export const NO_HIT_TEXT = '未召回任何原文段落';

// BM25 参数（k1/b 为经典取值）与混合权重
const K1 = 1.5;
const B = 0.75;
const BM25_WEIGHT = 0.5;
const VEC_WEIGHT = 0.5;
const MIN_COSINE = 0.3; // 纯向量兜底时的最低余弦阈值

// 向量构建方案：与 build_vectors.py 写出的 scheme 字段对应
const VEC_SCHEME_HASH = 0; // 0=确定性哈希向量（运行期可对 query 编码）
const VEC_SCHEME_MODEL = 1; // 1=BGE-M3 等模型向量（运行期需模型编码）

/** 段类型 → 中文展示标签。 */
const TYPE_LABEL: Record<string, string> = {
  narration: '叙述',
  verse: '诗词',
  comment: '评注',
};

export class SangoIndex {
  docs: Doc[] = [];
  postings = new Map<string, { doc: number; tf: number }[]>();
  df = new Map<string, number>();
  avgLen = 0;
  n = 0;

  vec: Float32Array = new Float32Array(0);
  vecDim = 0;
  vecCount = 0;
  vecScheme = VEC_SCHEME_MODEL; // 缺省按模型向量处理（query 无法本地编码时退化为 BM25）

  /** 加载语料（段级）并构建倒排索引，随后按段数加载离线向量。
   * 语料缺失 / 读取 / JSON 解析失败时抛错终止启动；向量加载失败仅告警并降级为纯 BM25。 */
  load(): void {
    if (!existsSync(CORPUS_DIR)) {
      const msg = `[sango] corpus 目录不存在：${CORPUS_DIR}（无语料无法检索，终止启动）`;
      console.error(msg);
      throw new Error(msg);
    }
    const files = readdirSync(CORPUS_DIR)
      .filter((f) => /^\d{3}\.json$/.test(f))
      .sort();
    let di = 0;
    for (const f of files) {
      const filePath = path.join(CORPUS_DIR, f);
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
      for (const seg of ch.segments) {
        const tokens = tokenize(seg.text);
        const tf = new Map<string, number>();
        for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
        this.docs.push({
          chapter: ch.chapter,
          title: ch.title,
          segIndex: seg.index,
          segType: seg.type,
          text: seg.text,
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
        di++;
      }
    }
    this.n = this.docs.length;
    if (this.n === 0) {
      const msg = `[sango] corpus 未加载到任何段落：${CORPUS_DIR}（无语料无法检索，终止启动）`;
      console.error(msg);
      throw new Error(msg);
    }
    this.avgLen = this.n > 0 ? this.docs.reduce((s, d) => s + d.len, 0) / this.n : 0;
    this.loadVectors(this.n);
  }

  /**
   * 读取离线向量文件（magic 'SNGV' + dim/count/scheme 各 4 字节 LE，随后为 float32 矩阵，
   * 与 scripts/build_vectors.py 的写出格式一致）。count 与语料段数不一致时忽略向量，仅用 BM25。
   */
  private loadVectors(expectedCount: number): void {
    let buf: Buffer;
    try {
      buf = readFileSync(VECTORS_FILE);
    } catch (e) {
      console.error(`[sango] vectors 读取失败：${VECTORS_FILE}（${(e as Error).message}），忽略向量，本次仅用 BM25`);
      return;
    }
    try {
      if (buf.length < 16 || buf.toString('utf8', 0, 4) !== 'SNGV') {
        console.error(`[sango] vectors 文件头非法：${VECTORS_FILE}，忽略向量，本次仅用 BM25`);
        return;
      }
      const dim = buf.readUInt32LE(4);
      const count = buf.readUInt32LE(8);
      const scheme = buf.readUInt32LE(12);
      if (count !== expectedCount) {
        console.error(`[sango] vectors 数量 ${count} 与 corpus 段数 ${expectedCount} 不一致，忽略向量，本次仅用 BM25`);
        return;
      }
      this.vecDim = dim;
      this.vecCount = count;
      this.vecScheme = scheme;
      this.vec = new Float32Array(buf.buffer, buf.byteOffset + 16, dim * count);
      if (scheme === VEC_SCHEME_HASH) {
        console.error(`[sango] vectors 已加载：${count} x dim=${dim} scheme=hash`);
      } else {
        // scheme=model（BGE-M3 预留）：运行时无模型编码，退化为纯 BM25
        console.error(`[sango] vectors scheme=model（BGE-M3 预留）且运行时无模型编码，本次仅用 BM25`);
      }
    } catch (e) {
      console.error(`[sango] vectors 解析失败：${VECTORS_FILE}（${(e as Error).message}），忽略向量，本次仅用 BM25`);
      this.vecDim = 0;
      this.vecCount = 0;
      this.vecScheme = VEC_SCHEME_MODEL;
      this.vec = new Float32Array(0);
    }
  }

  /** 确定性哈希 query 向量；仅 scheme=hash 时可用，否则返回 null（退化为纯 BM25）。 */
  private embedHashQuery(query: string): Float32Array | null {
    if (this.vecScheme !== VEC_SCHEME_HASH || this.vecDim === 0) return null;
    return embedTokensByHash(tokenize(query), this.vecDim);
  }

  /**
   * 混合召回：词法命中走 BM25 + 向量余弦加权，词法未命中走纯向量兜底
   * （低于 MIN_COSINE 判为无命中）。无命中返回固定话术 NO_HIT_TEXT，由模型侧走兜底。
   */
  search(query: string, limit: number): string {
    if (this.n === 0) return NO_HIT_TEXT;
    const qTokens = tokenize(query);

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

    // ---- 向量余弦 ----
    const qVec = this.embedHashQuery(query);
    const cosine = qVec && this.vec.length > 0 ? this.cosineAll(qVec) : null;

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
      // 纯向量兜底
      if (!cosine) return NO_HIT_TEXT;
      let best = -Infinity;
      for (let d = 0; d < this.n; d++) if (cosine[d] > best) best = cosine[d];
      if (best < MIN_COSINE) return NO_HIT_TEXT;
      for (const d of this.topKByCosine(cosine, Math.max(limit, 20))) {
        combined.push({ doc: d, score: (cosine[d] + 1) / 2 });
      }
    }

    if (combined.length === 0) return NO_HIT_TEXT;
    combined.sort((a, b) => b.score - a.score);
    const hits = combined.slice(0, Math.min(limit, combined.length));
    return hits.map((h) => this.formatDoc(this.docs[h.doc])).join('\n\n');
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

  private formatDoc(d: Doc): string {
    const label = TYPE_LABEL[d.segType] ?? d.segType;
    return `【出处】第${d.chapter}回 ${d.title} · 段${d.segIndex}（${label}）\n${d.text}`;
  }
}