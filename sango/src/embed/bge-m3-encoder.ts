/**
 * BGE-M3 运行期 query 编码器（feat-A004 §4.6 方案 A：onnxruntime-node 内嵌）。
 *
 * 与离线侧 scripts/build_vectors.py 用同一模型、同一口径，保证 scheme=1 时 query
 * 与语料向量处于同一语义空间：
 * - 分词：XLM-RoBERTa SentencePiece（tokenizer.json：Unigram + Metaspace）
 * - 池化：CLS（1_Pooling/config.json：pooling_mode_cls_token=true）
 * - 归一化：L2（2_Normalize）
 * - 截断：max_seq_length=8192（sentence_bert_config.json）
 *
 * 该口径由 model.onnx 的 sentence_embedding 输出直接给出：实测它与
 * normalize(CLS_last_hidden) 的余弦为 1.0000000251（即同一向量），故直接取用，
 * 不在 TS 侧重做池化，避免与离线口径二次漂移。A4 自检脚本见
 * scripts/verify-embed-parity.mjs。
 *
 * 冷启动（A5）：进程内单例 + 懒加载，首次调用才读 ~2.1GB 权重，之后复用同一 session。
 * 降级（A6）：权重缺失或推理失败返回 null 并写 stderr 告警，调用方退 BM25-only，不抛异常。
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Tokenizer } from '@huggingface/tokenizers';
import * as ort from 'onnxruntime-node';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 默认权重目录（git 忽略，部署侧下发）；可用 SANGO_BGE_M3_DIR 覆盖。 */
const MODEL_DIR = process.env.SANGO_BGE_M3_DIR
  ?? path.resolve(__dirname, '..', '..', 'data', 'models', 'bge-m3');
const ONNX_FILE = path.join(MODEL_DIR, 'onnx', 'model.onnx');
const TOKENIZER_FILE = path.join(MODEL_DIR, 'tokenizer.json');
const TOKENIZER_CONFIG_FILE = path.join(MODEL_DIR, 'tokenizer_config.json');

/** 与 sentence_bert_config.json 的 max_seq_length 对齐。 */
const MAX_TOKENS = 8192;

/** BGE-M3 向量维度。 */
export const EMBED_DIM = 1024;

interface Encoder {
  tokenizer: Tokenizer;
  session: ort.InferenceSession;
}

let encoderPromise: Promise<Encoder | null> | null = null;

function warn(message: string): void {
  console.error(`[sango] ${message}`);
}

/** 加载分词器与 ONNX session；任何失败都返回 null（降级信号，不抛出）。 */
async function loadEncoder(): Promise<Encoder | null> {
  for (const file of [ONNX_FILE, TOKENIZER_FILE, TOKENIZER_CONFIG_FILE]) {
    if (!existsSync(file)) {
      warn(`BGE-M3 权重缺失：${file}，本次仅用 BM25`);
      return null;
    }
  }
  try {
    const tokenizer = new Tokenizer(
      JSON.parse(readFileSync(TOKENIZER_FILE, 'utf8')),
      JSON.parse(readFileSync(TOKENIZER_CONFIG_FILE, 'utf8')),
    );
    const session = await ort.InferenceSession.create(ONNX_FILE);
    return { tokenizer, session };
  } catch (error) {
    warn(`BGE-M3 加载失败：${(error as Error).message}，本次仅用 BM25`);
    return null;
  }
}

/** 懒加载单例：并发调用共享同一次加载。 */
function getEncoder(): Promise<Encoder | null> {
  encoderPromise ??= loadEncoder();
  return encoderPromise;
}

/**
 * 把 query 编码为 1024 维 L2 归一化向量（与离线语料同空间）。
 *
 * @returns 权重不可用或推理失败时返回 null，由调用方退 BM25-only。
 */
export async function embedQuery(text: string): Promise<Float32Array | null> {
  const encoder = await getEncoder();
  if (!encoder) return null;
  try {
    const { ids, attention_mask } = encoder.tokenizer.encode(text);
    // 超长时保留首尾特殊 token，与离线侧 max_seq_length 截断口径一致；
    // 超过 max_position_embeddings 会让模型直接报错，故必须截断。
    const kept = ids.length > MAX_TOKENS
      ? [...ids.slice(0, MAX_TOKENS - 1), ids[ids.length - 1]]
      : ids;
    const len = kept.length;
    const out = await encoder.session.run({
      input_ids: new ort.Tensor('int64', BigInt64Array.from(kept.map(BigInt)), [1, len]),
      attention_mask: new ort.Tensor(
        'int64',
        BigInt64Array.from(attention_mask.slice(0, len).map(BigInt)),
        [1, len],
      ),
    });
    const embedding = out.sentence_embedding;
    if (!embedding || embedding.data.length !== EMBED_DIM) {
      warn(`BGE-M3 输出维度异常（期望 ${EMBED_DIM}），本次仅用 BM25`);
      return null;
    }
    // 复制一份，避免复用 session 输出缓冲区。
    return (embedding.data as Float32Array).slice();
  } catch (error) {
    warn(`BGE-M3 编码失败：${(error as Error).message}，本次仅用 BM25`);
    return null;
  }
}
