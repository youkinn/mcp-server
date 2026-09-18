#!/usr/bin/env node
/**
 * A4 自检：同一条 query 分别在离线（Python sentence-transformers）与运行期（Node
 * onnxruntime-node）编码，比较余弦是否 ≥ 阈值（默认 0.999）。
 *
 * 用法：
 *   node scripts/verify-embed-parity.mjs [query ...]
 * 环境变量：
 *   SANGO_BGE_M3_DIR  权重目录（默认 sango/data/models/bge-m3）
 *   PARITY_THRESHOLD  通过阈值（默认 0.999）
 *
 * 离线侧口径（Python）由 scripts/parity_reference.py 复刻 build_vectors.py 的
 * SentenceTransformer("BAAI/bge-m3") + normalize_embeddings=True；两边都不改口径。
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { embedQuery } from '../src/embed/bge-m3-encoder.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SANGO_DIR = path.resolve(HERE, '..');
const REFERENCE_SCRIPT = path.join(HERE, 'parity_reference.py');

const THRESHOLD = Number(process.env.PARITY_THRESHOLD ?? 0.999);
const DEFAULT_QUERIES = ['草船借箭', '关羽温酒斩华雄', '七擒孟获', '求亲', '孙权'];
const queries = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_QUERIES;

/** 离线侧：调用 py -3 跑 sentence-transformers，返回 query → 向量。 */
function encodeOffline(texts) {
  const result = spawnSync('py', ['-3', REFERENCE_SCRIPT, ...texts], {
    cwd: SANGO_DIR,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`离线侧编码失败（py -3 exit=${result.status}）：${result.stderr?.trim()}`);
  }
  return JSON.parse(result.stdout);
}

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

const offline = encodeOffline(queries);
let failed = 0;

for (const query of queries) {
  const reference = offline[query];
  if (!reference) {
    console.log(`✗ ${query}：离线侧未返回向量`);
    failed++;
    continue;
  }
  const runtime = await embedQuery(query);
  if (!runtime) {
    console.log(`✗ ${query}：运行期编码返回 null（权重缺失或推理失败）`);
    failed++;
    continue;
  }
  const score = cosine(Float64Array.from(reference), runtime);
  const ok = score >= THRESHOLD;
  if (!ok) failed++;
  console.log(
    `${ok ? '✓' : '✗'} ${query}  dim=${runtime.length}/${reference.length}  cosine=${score.toFixed(6)}`,
  );
}

console.log(`\n阈值 ${THRESHOLD}；${queries.length - failed}/${queries.length} 条通过`);
process.exit(failed === 0 ? 0 : 1);
