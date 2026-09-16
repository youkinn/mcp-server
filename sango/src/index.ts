/**
 * sango — 三国演义检索 MCP（feat-A004）
 *
 * 唯一工具 sango_novel_search：BM25 + 离线向量混合召回，按相关度降序返回文本块。
 * - 语料：sango/data/corpus/sanguo-yanyi/001.json .. 120.json（段级）
 * - 向量：sango/data/vectors/sanguo-yanyi.bin（与 corpus 段级同序，离线只读）
 * - 不做 query 改写 / rerank / 专用向量库。
 *
 * 日志只写 stderr；stdout 走 MCP 协议（stdio）。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

interface CorpusSegment {
  index: number;
  type: 'narration' | 'verse' | 'comment';
  text: string;
}

interface Chapter {
  source: string;
  chapter: number;
  title: string;
  segments: CorpusSegment[];
}

interface Doc {
  chapter: number;
  title: string;
  segIndex: number;
  segType: string;
  text: string;
  tokens: string[];
  tf: Map<string, number>;
  len: number;
}

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', 'data');
const CORPUS_DIR = path.join(DATA_DIR, 'corpus', 'sanguo-yanyi');
const VECTORS_FILE = path.join(DATA_DIR, 'vectors', 'sanguo-yanyi.bin');

const NO_HIT_TEXT = '未召回任何原文段落';

const K1 = 1.5; // BM25 k1
const B = 0.75; // BM25 b
const BM25_WEIGHT = 0.5;
const VEC_WEIGHT = 0.5;
const MIN_COSINE = 0.3; // 纯向量兜底时的最低余弦阈值
const VEC_SCHEME_HASH = 0; // 0=确定性哈希向量（运行期可对 query 编码）
const VEC_SCHEME_MODEL = 1; // 1=BGE-M3 等模型向量（运行期需模型编码）

const TYPE_LABEL: Record<string, string> = {
  narration: '叙述',
  verse: '诗词',
  comment: '评注',
};

// ---------------------------------------------------------------------------
// 分词 / 哈希（与 sango/scripts/build_vectors.py 完全一致）
// ---------------------------------------------------------------------------

function tokenize(text: string): string[] {
  const chars: string[] = [];
  for (const ch of text) {
    if (/\s/.test(ch)) continue;
    chars.push(ch);
  }
  const tokens: string[] = [];
  for (let i = 0; i < chars.length; i++) tokens.push(chars[i]);
  for (let i = 0; i + 1 < chars.length; i++) tokens.push(chars[i] + chars[i + 1]);
  return tokens;
}

/** FNV-1a 32-bit（返回无符号 uint32）。与 Python 侧实现一致。 */
function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  const buf = Buffer.from(s, 'utf8');
  for (let i = 0; i < buf.length; i++) {
    h = Math.imul(h ^ buf[i], 0x01000193) >>> 0;
  }
  return h;
}

// ---------------------------------------------------------------------------
// 检索索引
// ---------------------------------------------------------------------------

class SangoIndex {
  docs: Doc[] = [];
  postings = new Map<string, { doc: number; tf: number }[]>();
  df = new Map<string, number>();
  avgLen = 0;
  n = 0;

  vec: Float32Array = new Float32Array(0);
  vecDim = 0;
  vecCount = 0;
  vecScheme = VEC_SCHEME_MODEL; // 缺省按模型向量处理（query 无法本地编码时退化为 BM25）

  load(): void {
    if (!existsSync(CORPUS_DIR)) {
      console.error(`[sango] corpus 目录不存在: ${CORPUS_DIR}`);
      return;
    }
    const files = readdirSync(CORPUS_DIR)
      .filter((f) => /^\d{3}\.json$/.test(f))
      .sort();
    let di = 0;
    for (const f of files) {
      const ch: Chapter = JSON.parse(readFileSync(path.join(CORPUS_DIR, f), 'utf8'));
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
    this.avgLen = this.n > 0 ? this.docs.reduce((s, d) => s + d.len, 0) / this.n : 0;
    this.loadVectors(this.n);
  }

  private loadVectors(expectedCount: number): void {
    if (!existsSync(VECTORS_FILE)) {
      console.error(`[sango] vectors 缺失（${VECTORS_FILE}），本次仅用 BM25`);
      return;
    }
    const buf = readFileSync(VECTORS_FILE);
    if (buf.length < 16 || buf.toString('utf8', 0, 4) !== 'SNGV') {
      console.error('[sango] vectors 头非法，忽略向量');
      return;
    }
    const dim = buf.readUInt32LE(4);
    const count = buf.readUInt32LE(8);
    const scheme = buf.readUInt32LE(12);
    if (count !== expectedCount) {
      console.error(`[sango] vectors 数量 ${count} 与 corpus 段数 ${expectedCount} 不一致，忽略向量`);
      return;
    }
    this.vecDim = dim;
    this.vecCount = count;
    this.vecScheme = scheme;
    this.vec = new Float32Array(buf.buffer, buf.byteOffset + 16, dim * count);
    console.error(`[sango] vectors 已加载：${count} x dim=${dim} scheme=${scheme === VEC_SCHEME_HASH ? 'hash' : 'model'}`);
  }

  /** 确定性哈希 query 向量；仅 scheme=hash 时可用，否则返回 null。 */
  private embedHashQuery(query: string): Float32Array | null {
    if (this.vecScheme !== VEC_SCHEME_HASH || this.vecDim === 0) return null;
    const vec = new Float32Array(this.vecDim);
    for (const t of tokenize(query)) {
      const h = fnv1a32(t);
      const idx = (h & 0x7fffffff) % this.vecDim;
      const sign = (h & 0x80000000) === 0 ? 1 : -1;
      vec[idx] += sign;
    }
    let norm = 0;
    for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm);
    if (norm > 0) for (let i = 0; i < vec.length; i++) vec[i] /= norm;
    return vec;
  }

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
    const combined: { doc: number; score: number }[] = [];
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

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

const index = new SangoIndex();
index.load();
console.error(`[sango] corpus 已加载：${index.n} 段`);

const server = new McpServer({ name: 'sango', version: '1.0.0' });

server.tool(
  'sango_novel_search',
  '检索《三国演义》原文段落：BM25 + 离线向量混合召回，按相关度降序返回文本块。',
  {
    source: z.enum(['sanguo-yanyi', 'sanguozhi']).describe('语料来源：sanguo-yanyi（本期）/ sanguozhi（预留）'),
    query: z.string().min(1).describe('检索关键词或句子'),
    limit: z.number().int().min(1).max(20).optional().default(5).describe('返回条数，默认 5'),
  },
  async (args) => {
    const { source, query, limit } = args;
    if (source !== 'sanguo-yanyi') {
      // sanguozhi 本期预留，无语料：按“无命中”处理
      return { content: [{ type: 'text' as const, text: NO_HIT_TEXT }] };
    }
    const text = index.search(query, limit);
    return { content: [{ type: 'text' as const, text }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
