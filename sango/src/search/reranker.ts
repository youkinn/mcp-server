/**
 * FEAT-A030：cross-encoder 重排打分器（本地 ONNX 推理，运行期零 LLM API 调用）。
 *
 * - 模型：bge-reranker-base（XLM-RoBERTa for sequence classification）；ONNX 量化档优先（CPU 延迟）。
 *   权重目录 data/models/bge-reranker-base（git 忽略，部署侧下发）：可用 SANGO_RERANKER_DIR 换目录、
 *   SANGO_RERANKER_FILE 指定具体 onnx 文件。
 * - 输入口径：XLM-R pair = `<s> query </s></s> passage </s>`（config.json type_vocab_size=1，无 token_type_ids），
 *   超长按 max 512 token 保留首尾特殊 token 截断（max_position_embeddings=514）。
 * - 输出：logits[0]，越大越相关（与 transformers.js / 离线口径一致，此处不做 sigmoid）。
 * - 懒加载单例 + 失败降级：权重缺失 / 分词器缺失 / 推理失败一律返回 null 并写 stderr 告警，
 *   调用方退回「无重排」规则序（不抛异常、不 mock、不伪造分数）。风格对齐 embed/bge-m3-encoder.ts。
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Tokenizer } from '@huggingface/tokenizers';
import * as ort from 'onnxruntime-node';

/** 重排打分器：返回每条 passage 的相关性分（与 passages 同序）；权重不可用 / 推理失败返回 null。 */
export type RerankScorer = (query: string, passages: string[]) => Promise<number[] | null>;

/** 候选 onnx 权重文件（按序取首个存在者）：量化档优先，退化到 fp32。 */
const MODEL_FILES = ['onnx/model_quantized.onnx', 'onnx/model_fp16.onnx', 'onnx/model.onnx'];
const TOKENIZER_FILE = 'tokenizer.json';
const TOKENIZER_CONFIG_FILE = 'tokenizer_config.json';

/** XLM-R pair 截断上限（config.json max_position_embeddings=514，留特殊 token 余量）。 */
const MAX_TOKENS = 512;

interface CrossEncoder {
  tokenizer: Tokenizer;
  session: ort.InferenceSession;
}

let cache: { dir: string; promise: Promise<CrossEncoder | null> } | null = null;

function warn(message: string): void {
  console.error(`[sango] ${message}`);
}

/** 解析实际存在的 onnx 权重绝对路径；都不存在返回 null。 */
export function resolveRerankModelFile(modelDir: string): string | null {
  const override = process.env.SANGO_RERANKER_FILE;
  for (const file of override ? [override] : MODEL_FILES) {
    const full = path.join(modelDir, file);
    if (existsSync(full)) return full;
  }
  return null;
}

/** 加载分词器与 ONNX session；任何失败返回 null（降级信号，不抛出）。 */
async function loadCrossEncoder(modelDir: string): Promise<CrossEncoder | null> {
  const onnxFile = resolveRerankModelFile(modelDir);
  if (!onnxFile) {
    warn(`重排权重缺失（${modelDir}），本次跳过重排`);
    return null;
  }
  for (const file of [TOKENIZER_FILE, TOKENIZER_CONFIG_FILE]) {
    if (!existsSync(path.join(modelDir, file))) {
      warn(`重排分词器缺失：${path.join(modelDir, file)}，本次跳过重排`);
      return null;
    }
  }
  try {
    const tokenizer = new Tokenizer(
      JSON.parse(readFileSync(path.join(modelDir, TOKENIZER_FILE), 'utf8')),
      JSON.parse(readFileSync(path.join(modelDir, TOKENIZER_CONFIG_FILE), 'utf8')),
    );
    const session = await ort.InferenceSession.create(onnxFile);
    return { tokenizer, session };
  } catch (error) {
    warn(`重排模型加载失败：${(error as Error).message}，本次跳过重排`);
    return null;
  }
}

/** 懒加载单例（按目录缓存；并发调用共享同一次加载）。 */
function getCrossEncoder(modelDir: string): Promise<CrossEncoder | null> {
  if (!cache || cache.dir !== modelDir) {
    cache = { dir: modelDir, promise: loadCrossEncoder(modelDir) };
  }
  return cache.promise;
}

/**
 * XLM-R pair 拼装：`<s> q </s></s> p </s>`；超长保留首尾特殊 token 截断。
 * 注：@huggingface/tokenizers 的 encode 不消费第二参数（静默忽略 pair），故此处手工拼装。
 */
function pairIds(tokenizer: Tokenizer, queryIds: number[], passageIds: number[]): number[] {
  const ids = [
    queryIds[0],
    ...queryIds.slice(1, -1),
    queryIds[queryIds.length - 1],
    queryIds[queryIds.length - 1],
    ...passageIds.slice(1, -1),
    passageIds[passageIds.length - 1],
  ];
  return ids.length > MAX_TOKENS ? [...ids.slice(0, MAX_TOKENS - 1), ids[ids.length - 1]] : ids;
}

/**
 * 构造 cross-encoder 打分器（懒加载；任何失败降级为 null，调用方退回规则序）。
 * 逐条推理（batch=1）以保证与离线口径一致；批量档位由评测期读数决定。
 */
export function createCrossEncoderScorer(modelDir: string): RerankScorer {
  return async (query, passages) => {
    if (passages.length === 0) return [];
    const encoder = await getCrossEncoder(modelDir);
    if (!encoder) return null;
    try {
      const queryIds = encoder.tokenizer.encode(query).ids;
      const scores: number[] = [];
      for (const passage of passages) {
        const ids = pairIds(encoder.tokenizer, queryIds, encoder.tokenizer.encode(passage).ids);
        const len = ids.length;
        const out = await encoder.session.run({
          input_ids: new ort.Tensor('int64', BigInt64Array.from(ids, (v) => BigInt(v)), [1, len]),
          attention_mask: new ort.Tensor('int64', BigInt64Array.from({ length: len }, () => 1n), [1, len]),
        });
        scores.push(Number((out.logits.data as unknown as ArrayLike<number>)[0]));
      }
      return scores;
    } catch (error) {
      warn(`重排推理失败：${(error as Error).message}，本次跳过重排`);
      return null;
    }
  };
}
