/**
 * FEAT-A030：cross-encoder 重排打分器（本地 ONNX 推理，运行期零 LLM API 调用）。
 *
 * - 模型：bge-reranker-base（XLM-RoBERTa for sequence classification）；ONNX 量化档优先（CPU 延迟）。
 *   权重目录 data/models/bge-reranker-base（git 忽略，部署侧下发）：可用 SANGO_RERANKER_DIR 换目录、
 *   SANGO_RERANKER_FILE 指定具体 onnx 文件。
 * - 输入口径：XLM-R pair = `<s> query </s></s> passage </s>`（config.json type_vocab_size=1，无 token_type_ids），
 *   超长按 max token 保留首尾特殊 token 截断（max_position_embeddings=514；档位见 RerankTuning.maxTokens）。
 * - 输出：logits[0]，越大越相关（与 transformers.js / 离线口径一致，此处不做 sigmoid）。
 * - 延迟调参（FEAT-A030 归因矩阵，全可选，默认 = 历史逐条口径）：SANGO_RERANKER_MAX_TOKENS（截断档位）
 *   / SANGO_RERANKER_BATCH（桶内批量）/ SANGO_RERANKER_INTRA_THREADS / SANGO_RERANKER_INTER_THREADS
 *   / SANGO_RERANKER_GRAPH_OPT（default|disabled|basic|extended|layout|all）；评测期也可由调用方传入 tuning 覆盖。
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

/** XLM-R 默认 pair 截断上限（config.json max_position_embeddings=514，留特殊 token 余量）。 */
const MAX_TOKENS_DEFAULT = 512;
/** XLM-R pad_token_id=1（config.json）；仅用于桶内对齐，attention_mask 置 0 不参与注意力。 */
const PAD_TOKEN_ID = 1n;

/** FEAT-A030 重排推理调参（默认值 = 历史口径：逐条、512 截断、ORT 默认线程与图优化）。 */
export interface RerankTuning {
  /** pair 截断上限（评测档位 128 / 256 / 512）。 */
  maxTokens: number;
  /** 桶内批量（1 = 逐条；>1 按长度分桶、桶内对齐到桶内最长，不统一 pad 到 maxTokens）。 */
  batch: number;
  /** ORT intra-op 线程数；缺省 = ORT 默认（本机默认 = 物理核数）。 */
  intraOpThreads?: number;
  /** ORT inter-op 线程数；缺省 = ORT 默认。 */
  interOpThreads?: number;
  /** ORT 图优化级别；'default' = 不显式传参（onnxruntime-node 自身默认即 all）。 */
  graphOptimizationLevel?: 'default' | 'disabled' | 'basic' | 'extended' | 'layout' | 'all';
}

const MAX_TOKENS_TIERS = [128, 256, 512];
const BATCH_TIERS = [1, 2, 4, 8, 16];
const GRAPH_OPT_LEVELS = ['default', 'disabled', 'basic', 'extended', 'layout', 'all'] as const;
type SessionOptions = NonNullable<Parameters<typeof ort.InferenceSession.create>[1]>;

/** 环境变量正整数解析；缺失 / 非正数返回 null（由调用方决定回落值）。 */
function parsePositiveInt(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

/** 档位读取：非白名单值回落默认并告警（不静默改变口径）。 */
function pickTier(name: string, raw: string | undefined, fallback: number, allowed: readonly number[]): number {
  const value = parsePositiveInt(raw);
  if (value === null) return fallback;
  if (!allowed.includes(value)) {
    warn(`${name}=${raw} 非法（可选 ${allowed.join('/')}），回落 ${fallback}`);
    return fallback;
  }
  return value;
}

/** 从环境变量解析推理档位（默认 = 历史逐条口径，即不改行为）。 */
export function resolveRerankTuning(env: NodeJS.ProcessEnv = process.env): RerankTuning {
  const raw = env.SANGO_RERANKER_GRAPH_OPT?.trim();
  let graphOptimizationLevel: RerankTuning['graphOptimizationLevel'] = 'default';
  if (raw) {
    if ((GRAPH_OPT_LEVELS as readonly string[]).includes(raw)) {
      graphOptimizationLevel = raw as RerankTuning['graphOptimizationLevel'];
    } else {
      warn(`SANGO_RERANKER_GRAPH_OPT=${raw} 非法（可选 ${GRAPH_OPT_LEVELS.join('/')}），回落 default`);
    }
  }
  return {
    maxTokens: pickTier('SANGO_RERANKER_MAX_TOKENS', env.SANGO_RERANKER_MAX_TOKENS, MAX_TOKENS_DEFAULT, MAX_TOKENS_TIERS),
    batch: pickTier('SANGO_RERANKER_BATCH', env.SANGO_RERANKER_BATCH, 1, BATCH_TIERS),
    intraOpThreads: parsePositiveInt(env.SANGO_RERANKER_INTRA_THREADS) ?? undefined,
    interOpThreads: parsePositiveInt(env.SANGO_RERANKER_INTER_THREADS) ?? undefined,
    graphOptimizationLevel,
  };
}

/** ORT session 选项：仅传显式档位（缺省全部留空 = ORT 默认）。 */
function sessionOptionsOf(tuning: RerankTuning): SessionOptions | undefined {
  const options: SessionOptions = {};
  if (tuning.intraOpThreads) options.intraOpNumThreads = tuning.intraOpThreads;
  if (tuning.interOpThreads) options.interOpNumThreads = tuning.interOpThreads;
  if (tuning.graphOptimizationLevel && tuning.graphOptimizationLevel !== 'default') {
    options.graphOptimizationLevel = tuning.graphOptimizationLevel;
  }
  return Object.keys(options).length > 0 ? options : undefined;
}

/** 调参缓存键：目录 + 推理档位（同进程内不同档位各建一次 session）。 */
function tuningKey(tuning: RerankTuning): string {
  return [
    tuning.maxTokens,
    tuning.batch,
    tuning.intraOpThreads ?? 'd',
    tuning.interOpThreads ?? 'd',
    tuning.graphOptimizationLevel ?? 'default',
  ].join('/');
}

interface CrossEncoder {
  tokenizer: Tokenizer;
  session: ort.InferenceSession;
}

let cache: { key: string; promise: Promise<CrossEncoder | null> } | null = null;

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
async function loadCrossEncoder(modelDir: string, tuning: RerankTuning): Promise<CrossEncoder | null> {
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
    const session = await ort.InferenceSession.create(onnxFile, sessionOptionsOf(tuning));
    return { tokenizer, session };
  } catch (error) {
    warn(`重排模型加载失败：${(error as Error).message}，本次跳过重排`);
    return null;
  }
}

/** 懒加载单例（按「目录 + 档位」缓存；并发调用共享同一次加载）。 */
function getCrossEncoder(modelDir: string, tuning: RerankTuning): Promise<CrossEncoder | null> {
  const key = `${modelDir}|${tuningKey(tuning)}`;
  if (!cache || cache.key !== key) {
    cache = { key, promise: loadCrossEncoder(modelDir, tuning) };
  }
  return cache.promise;
}

/**
 * XLM-R pair 拼装：`<s> q </s></s> p </s>`；超长保留首尾特殊 token 截断。
 * 注：@huggingface/tokenizers 的 encode 不消费第二参数（静默忽略 pair），故此处手工拼装。
 */
function pairIds(tokenizer: Tokenizer, queryIds: number[], passageIds: number[], maxTokens: number): number[] {
  const ids = [
    queryIds[0],
    ...queryIds.slice(1, -1),
    queryIds[queryIds.length - 1],
    queryIds[queryIds.length - 1],
    ...passageIds.slice(1, -1),
    passageIds[passageIds.length - 1],
  ];
  return ids.length > maxTokens ? [...ids.slice(0, maxTokens - 1), ids[ids.length - 1]] : ids;
}

/**
 * 桶内打分：passages 按 token 长度升序分桶（每桶 ≤ tuning.batch 条），桶内对齐到**桶内最长**（不做全池 pad，
 * 避免长短混排被 512 拖满），一次 session.run 出整桶分数；返回与入参同序。
 */
async function scoreBuckets(encoder: CrossEncoder, queryIds: number[], passages: string[], tuning: RerankTuning): Promise<number[]> {
  const items = passages.map((text, index) => ({
    index,
    ids: pairIds(encoder.tokenizer, queryIds, encoder.tokenizer.encode(text).ids, tuning.maxTokens),
  }));
  items.sort((a, b) => a.ids.length - b.ids.length);
  const scores = new Array<number>(passages.length).fill(Number.NaN);
  const bucketSize = Math.max(1, tuning.batch);
  for (let start = 0; start < items.length; start += bucketSize) {
    const bucket = items.slice(start, start + bucketSize);
    const cols = bucket[bucket.length - 1].ids.length; // 桶内最长（items 已按长度升序，末位即最长）
    const rows = bucket.length;
    const inputIds = new BigInt64Array(rows * cols);
    const attentionMask = new BigInt64Array(rows * cols);
    bucket.forEach((item, row) => {
      const offset = row * cols;
      for (let col = 0; col < cols; col++) {
        if (col < item.ids.length) {
          inputIds[offset + col] = BigInt(item.ids[col]);
          attentionMask[offset + col] = 1n;
        } else {
          inputIds[offset + col] = PAD_TOKEN_ID;
        }
      }
    });
    const out = await encoder.session.run({
      input_ids: new ort.Tensor('int64', inputIds, [rows, cols]),
      attention_mask: new ort.Tensor('int64', attentionMask, [rows, cols]),
    });
    const logits = out.logits.data as unknown as ArrayLike<number>;
    bucket.forEach((item, row) => {
      scores[item.index] = Number(logits[row]);
    });
  }
  return scores;
}

/**
 * 构造 cross-encoder 打分器（懒加载；任何失败降级为 null，调用方退回规则序）。
 * 推理档位（截断 / 批量 / 线程 / 图优化）默认取环境变量；评测期可显式传入 tuning 覆盖。
 */
export function createCrossEncoderScorer(modelDir: string, tuning: RerankTuning = resolveRerankTuning()): RerankScorer {
  return async (query, passages) => {
    if (passages.length === 0) return [];
    const encoder = await getCrossEncoder(modelDir, tuning);
    if (!encoder) return null;
    try {
      const queryIds = encoder.tokenizer.encode(query).ids;
      return await scoreBuckets(encoder, queryIds, passages, tuning);
    } catch (error) {
      warn(`重排推理失败：${(error as Error).message}，本次跳过重排`);
      return null;
    }
  };
}
