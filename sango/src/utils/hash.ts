/**
 * 哈希工具：确定性哈希向量编码，供 scheme=hash 的离线向量在运行期对 query 编码。
 */

/**
 * FNV-1a 32-bit（返回无符号 uint32）。
 *
 * 对 UTF-8 字节逐字节执行，与 sango/scripts/build_vectors.py 的 Python 实现一致；
 * 结果用于哈希向量定位（取模）与符号位（最高位）。
 */
export function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  const buf = Buffer.from(s, 'utf8');
  for (let i = 0; i < buf.length; i++) {
    h = Math.imul(h ^ buf[i], 0x01000193) >>> 0;
  }
  return h;
}

/**
 * 将 token 集合编码为 dim 维 L2 归一化向量（符号哈希）。
 *
 * 每个 token 的 FNV-1a 哈希决定落入的维度与正负号，累加后归一化；
 * 算法与 Python 构建侧 build_vectors.py 逐字节对齐，保证 query 向量与语料向量同分布。
 */
export function embedTokensByHash(tokens: string[], dim: number): Float32Array {
  const vec = new Float32Array(dim);
  for (const t of tokens) {
    const h = fnv1a32(t);
    const idx = (h & 0x7fffffff) % dim;
    const sign = (h & 0x80000000) === 0 ? 1 : -1;
    vec[idx] += sign;
  }
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  return vec;
}