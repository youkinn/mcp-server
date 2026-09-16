/**
 * 文本工具：检索侧（TS）与构建侧（Python）共用的分词逻辑。
 */

/**
 * 字符级分词：去掉空白后产出单字 + 相邻双字 token。
 *
 * 必须与 sango/scripts/build_vectors.py 的 tokenize 逐字节一致：
 * 离线向量按本函数对语料分词构建，运行期 query 也按同一函数分词，
 * 任何不一致都会导致哈希向量无法对齐、检索结果漂移。
 */
export function tokenize(text: string): string[] {
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