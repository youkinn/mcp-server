/**
 * 语料 chunk 取值**唯一来源**（bug-00068 契约）：枚举值、类型、启动校验都在这里。
 *
 * - 取值用稳定英文标识：`type ∈ prose|verse`（正文 / 诗词）、`role ∈ body|lead`（主体 / 引题）。
 * - 代码里一律引用本文件的 `CHUNK_TYPES` / `CHUNK_ROLES` 与派生类型，**不要另写字面量**。
 * - 展示层若要中文文案，在展示模块按取值做局部映射，不反向影响语料取值。
 * - 语料出现表外取值时 `assertChunkKind` 抛错终止启动（契约变化不静默透传）。
 */
export const CHUNK_TYPES = ['prose', 'verse'] as const;
export const CHUNK_ROLES = ['body', 'lead'] as const;

/** 语料 chunk 类型：prose = 正文，verse = 诗词。 */
export type CorpusChunkType = (typeof CHUNK_TYPES)[number];

/** 语料 chunk 角色：body = 主体（进检索索引），lead = 引题（照常出块、不进检索索引）。 */
export type CorpusChunkRole = (typeof CHUNK_ROLES)[number];

/** 角色语义别名（自 CHUNK_ROLES 派生）：主体块进检索索引，引题块不进。 */
export const CHUNK_ROLE_BODY: CorpusChunkRole = CHUNK_ROLES[0];
export const CHUNK_ROLE_LEAD: CorpusChunkRole = CHUNK_ROLES[1];

/** 语料取值校验：表外取值（语料契约变化）抛错终止启动。 */
export function assertChunkKind(type: string, role: string, chunkId: string): void {
  if (!CHUNK_TYPES.includes(type as CorpusChunkType) || !CHUNK_ROLES.includes(role as CorpusChunkRole)) {
    throw new Error(
      `[sango] 语料 chunk 取值非法：${chunkId} 的 type=${type} role=${role}` +
        `（合法值 type ∈ ${CHUNK_TYPES.join('|')}，role ∈ ${CHUNK_ROLES.join('|')}）；` +
        '新增取值须同步 src/chunk-kind.ts',
    );
  }
}
