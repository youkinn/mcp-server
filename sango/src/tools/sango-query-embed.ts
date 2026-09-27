/**
 * sango_query_embed 工具：定义与处理逻辑（feat-A013 §1.7.1，FEAT-A016 §3 修订）。
 * 内部工具：把 query 编码为 BGE-M3 1024 维 L2 归一化向量（base64-float32-le）。
 * FEAT-A016 §3.2 变更：embed 前先 normalize(query)（entity-table rewriteKeys 替换，与检索侧共用同一
 * 实例模块 sango/src/normalize/entity-table.ts，防 D4 口径分裂）；§3.3 出参新增 normVersion（= 表
 * meta.normVersion，缓存侧识别键空间用；老消费方仅读前三个字段不受影响）。
 * 仅供编排层语义缓存判定调用：模型不可见（总台白名单过滤）、不产诊断（不携带 _meta.diagnostics、与 traceId 无关）。
 * 复用 A004 embedQuery（bge-m3-encoder.ts），判定与检索同一语义空间（同源同维度，零口径漂移）。
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Buffer } from 'node:buffer';
import { z } from 'zod';
import { embedQuery } from '../embed/bge-m3-encoder.ts';
import { normalize as entityNormalize, normVersion as entityNormVersion } from '../normalize/entity-table.ts';

/** query 长度上限（1 ≤ len ≤ 300，超限报 isError；契约 inputSchema 口径）。 */
const MAX_QUERY_LENGTH = 300;
const EMBED_DIM = 1024;
const ENCODING = 'base64-float32-le';

/** 失败统一固定文案（权重缺失 / 推理失败 / query 非法不区分，不外泄内部细节；进总台 stderr 排查）。 */
export const SANGO_QUERY_EMBED_ERROR_TEXT = 'sango_query_embed 编码失败：内部错误';

function isErrorResult(): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  console.error(`[sango] ${SANGO_QUERY_EMBED_ERROR_TEXT}`);
  return { content: [{ type: 'text' as const, text: SANGO_QUERY_EMBED_ERROR_TEXT }], isError: true };
}

/**
 * 注册 sango_query_embed：query → base64-float32-le 的 1024 维向量。
 * @param registerTool - server.registerTool（已 bind(server)，依赖 this）。
 * @param embedFn - 编码函数（默认 A004 embedQuery；测试注入假实现，权重缺失 / 推理失败返回 null）。
 * @param normalizeFn - 归一化函数（默认 entity-table 单例；测试注入假实现，验证「embed 前 normalize」顺序）。
 */
export function registerSangoQueryEmbed(
  registerTool: McpServer['registerTool'],
  embedFn: (query: string) => Promise<Float32Array | null> = embedQuery,
  normalizeFn: (text: string) => string = entityNormalize
): void {
  registerTool(
    'sango_query_embed',
    {
      description:
        '内部工具：把 query 编码为 BGE-M3 1024 维 L2 归一化向量（base64-float32-le）。仅供编排层语义缓存判定调用，模型不可见，不产诊断',
      inputSchema: z.object({
        query: z.string().describe(`用户输入原文，长度 1~${MAX_QUERY_LENGTH}（超限返回 isError）`),
      }),
    },
    async (args) => {
      const query = args.query;
      // FEAT-A016 §3.2：归一化在 embed 之前（改写键 → 规范形）；编排侧传原文、不自行改写。
      const normalized = normalizeFn(query);
      // 超限 / 空串按契约报 isError 固定文案（zod 不设 min/max，避免 SDK 校验器替换固定文案）
      // 空白串视为非法（上游 trim 后才会调用，防御性兜底）
      if (typeof query !== 'string' || query.trim().length < 1 || query.length > MAX_QUERY_LENGTH) {
        return isErrorResult();
      }
      let embedding: Float32Array | null;
      try {
        embedding = await embedFn(normalized);
      } catch {
        // 推理失败：与权重缺失同一降级路径（统一内部错误文案）
        return isErrorResult();
      }
      if (!embedding || embedding.length !== EMBED_DIM) {
        return isErrorResult();
      }
      // data = Float32Array(1024) 底层 buffer 的 base64（little-endian，平台字节序口径）
      const data = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength).toString('base64');
      return {
        content: [
          {
            type: 'text' as const,
            // §3.3 出参扩展：normVersion = 表 meta.normVersion（缓存换代用；表加载失败降级时为空串）
            text: JSON.stringify({ dim: EMBED_DIM, encoding: ENCODING, data, normVersion: entityNormVersion() }),
          },
        ],
      };
    }
  );
}
