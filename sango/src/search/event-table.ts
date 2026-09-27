/**
 * FEAT-A018 事件表单一实现模块（检索侧）：加载 / V1–V7 校验 / 漂移检测 / 事件名桥（alias 子串匹配）。
 *
 * 契约：docs/feat-A018-event-table-interface.md §1（表设计）/ §2（加载与降级）/ §3.1–3.2（事件名桥）。
 * - 进程内单例：loadEventsTable 反复调用即整体覆盖（语义等价重启后重新加载），与 entity-table 同口径；
 * - 加载失败降级为「无事件路由」不阻断启动（核心语料失败仍终止，现状不变）；
 * - 漂移检测（§2.3）：缺失 >5% 整表降级 / ≤5% 剔缺失 chunkId 告警 / corpusChunkCount 不一致告警；
 * - 桥只读归一化后 query 子串（alias 原文即匹配串，不做二次归一化），零 LLM、不分流 type；
 * - 表内容变更生效方式 = 重启进程重新 load()，无持久化索引产物。
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rewriteKeys } from '../normalize/entity-table.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 漂移阈值：缺失 chunkId 占比 > 5% 整表降级（接口 §2.3 首版口径）。 */
const DRIFT_MAX_RATIO = 0.05;

export type EventType = 'L1' | 'L2' | 'L3';

/** 事件行（仅保留桥 / 装配消费字段；characters / exampleQuestion 本期不消费、不载入）。 */
export interface EffectiveEventRow {
  eventId: string;
  eventName: string;
  /** 有效 alias（单字禁入 / 行内去重 / 跨行唯一 / 与实体表 rewriteKeys 无交集，V3 剔除后）。 */
  aliases: string[];
  /** 有效 chunk 引用（漂移剔除后），按事件内序（chapter 升序、回内 c 序号升序）重排，不依赖表内书写顺序。 */
  chunkIds: string[];
  type: EventType;
}

/** 事件名桥命中组（已按组优先级排序：命中 alias 长度降序，同长 eventId 升序）。 */
export interface MatchedEventGroup {
  eventId: string;
  eventName: string;
  /** 本组命中的 alias（组内最长：按长度降序逐个尝试，首个 includes 命中者）。 */
  matchedAlias: string;
  type: EventType;
  /** 组内有效 chunk 引用总数（漂移剔除后）。 */
  groupSize: number;
  /** 有效 chunk 引用（事件内序），供组内闭环 topK 装配（§3.3）。 */
  chunkIds: string[];
}

/** 进程内单例状态（对齐 entity-table.ts 单一实现模式）。 */
const eventState: {
  /** 事件路是否生效；true = 表加载失败 / 整表漂移降级（此时桥恒不命中）。 */
  degraded: boolean;
  /** 表 meta.normVersion；降级为空串。 */
  normVersion: string;
  /** 校验 + 漂移剔除后的有效事件行。 */
  rows: EffectiveEventRow[];
  /** 全部有效 alias → 所属行，按长度降序、同长 (eventId 升序, 表内顺序) 排序（§3.2 尝试序）。 */
  aliasList: Array<{ alias: string; row: EffectiveEventRow }>;
} = {
  degraded: true,
  normVersion: '',
  rows: [],
  aliasList: [],
};

function resetToDegraded(reason: string): void {
  console.error(`[sango] event-table 加载失败：${reason}，降级为无事件路由`);
  eventState.degraded = true;
  eventState.normVersion = '';
  eventState.rows = [];
  eventState.aliasList = [];
}

/** chunkId → 事件内序排序键：(chapter, 回内 c 序号)。主键格式 {source}:{回号4位零补}:c{回内序号4位零补}（接口 §1.3）。 */
function innerOrderKey(chunkId: string): [number, number] {
  const m = /^[^:]+:(\d{4}):c(\d{4})$/.exec(chunkId);
  // 格式非法（语料重建残留等）防御性垫底，保留引用不丢（漂移检测已按 docIndexOf 验存在性）。
  if (!m) return [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER];
  return [Number(m[1]), Number(m[2])];
}

function sortChunkIdsInner(chunkIds: string[]): string[] {
  return [...chunkIds].sort((a, b) => {
    const [ca, sa] = innerOrderKey(a);
    const [cb, sb] = innerOrderKey(b);
    return ca - cb || sa - sb || (a < b ? -1 : a > b ? 1 : 0);
  });
}

/**
 * 加载事件表（dataDir/corpus/events.json）并重建单例状态。
 * 漂移检测需要 docIndexOf 就绪，由 SangoIndex.load() 在 docs 构建完成后调用（chunkExists 注入）。
 * 返回是否成功加载（false = 已降级为无事件路由；调用方无需分支处理，matchEvents 恒空即契约行为）。
 * 日志：成功 [sango] event-table loaded: rows=… aliases=… chunkRefs=… normVersion=…（对齐 entity-table）；
 * 校验 / 漂移 / 降级告警均落 stderr。
 */
export function loadEventsTable(
  dataDir: string = path.join(__dirname, '..', '..', 'data'),
  chunkExists: (chunkId: string) => boolean,
  corpusChunkCount: number,
): boolean {
  const file = path.join(dataDir, 'corpus', 'events.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    resetToDegraded(`文件读取 / JSON 解析失败：${file}（${(e as Error).message}）`);
    return false;
  }
  const events = parsed as { meta?: unknown; rows?: unknown } | null;
  if (events === null || typeof events !== 'object' || Array.isArray(events)) {
    resetToDegraded(`顶层结构非法（应为 { meta, rows }）：${file}`);
    return false;
  }
  const meta = (events as { meta?: unknown }).meta as
    | { normVersion?: unknown; corpusChunkCount?: unknown }
    | undefined;
  const rowsRaw = (events as { rows?: unknown }).rows;
  if (!Array.isArray(rowsRaw)) {
        resetToDegraded(`rows 非数组：${file}`);
    return false;
  }
  // V7：meta 完整（normVersion / corpusChunkCount 存在）；缺失按顶层结构非法整表降级。
  const normVersion = typeof meta?.normVersion === 'string' && meta.normVersion.length > 0 ? meta.normVersion : '';
  const metaCount = typeof meta?.corpusChunkCount === 'number' ? meta.corpusChunkCount : null;
  if (!normVersion || metaCount === null) {
    resetToDegraded(`meta 不完整（normVersion / corpusChunkCount 缺失）：${file}`);
    return false;
  }
  // corpusChunkCount ≠ 当前语料 chunk 数 → 语料重建漂移信号（告警，不阻断）。
  if (metaCount !== corpusChunkCount) {
    console.error(
      `[sango] event-table 漂移检测：meta.corpusChunkCount（${metaCount}）≠ 当前语料 chunk 数（${corpusChunkCount}），语料重建漂移信号`,
    );
  }

  // V1 / V2 / V5 行级违规剔行；V3 单条 alias 违规剔该 alias（对齐 entity-table 违规键剔除先例）。
  const entityRk = rewriteKeys();
  const kept: EffectiveEventRow[] = [];
  const seenEventId = new Set<string>();
  const seenAlias = new Set<string>();
  const warn = (message: string): void => console.error(`[sango] event-table 校验：${message}`);
  let rowDropped = 0;
  let aliasDropped = 0;
  for (const raw of rowsRaw as Array<Record<string, unknown>>) {
    const eventId = typeof raw.eventId === 'string' ? raw.eventId : '';
    const eventName = typeof raw.eventName === 'string' ? raw.eventName : '';
    const rawType = raw.type;
    const aliasesRaw = raw.aliases;
    const aliases = Array.isArray(aliasesRaw)
      ? aliasesRaw.filter((a): a is string => typeof a === 'string')
      : [];
    const chunkIdsRaw = raw.chunkIds;
    const chunkIds = Array.isArray(chunkIdsRaw)
      ? chunkIdsRaw.filter((c): c is string => typeof c === 'string')
      : [];
    if (!eventId || seenEventId.has(eventId)) {
      warn(`V1 eventId ${eventId ? '跨行重复' : '为空'}，剔行（eventName=${eventName || '(空)'}）`);
      rowDropped++;
      continue;
    }
    seenEventId.add(eventId);
    if (!eventName) {
      warn(`V2 eventName 为空，剔行（eventId=${eventId}）`);
      rowDropped++;
      continue;
    }
    if (rawType !== 'L1' && rawType !== 'L2' && rawType !== 'L3') {
      warn(`V5 type 非法（${String(rawType)}），剔行（eventId=${eventId}）`);
      rowDropped++;
      continue;
    }
    const keptAliases: string[] = [];
    const rowSeen = new Set<string>();
    for (const alias of aliases) {
      if (alias.length < 2) {
        warn(`V3 单字禁入，剔 alias「${alias}」（eventId=${eventId}）`);
        aliasDropped++;
        continue;
      }
      if (rowSeen.has(alias)) {
        warn(`V3 行内重复，剔 alias「${alias}」（eventId=${eventId}）`);
        aliasDropped++;
        continue;
      }
      rowSeen.add(alias);
      if (seenAlias.has(alias)) {
        warn(`V3 跨行重复，剔 alias「${alias}」（eventId=${eventId}）`);
        aliasDropped++;
        continue;
      }
      if (entityRk.has(alias)) {
        warn(`V3 与实体表 rewriteKeys 冲突，剔 alias「${alias}」（eventId=${eventId}）`);
        aliasDropped++;
        continue;
      }
      seenAlias.add(alias);
      keptAliases.push(alias);
    }
    kept.push({ eventId, eventName, aliases: keptAliases, chunkIds, type: rawType });
  }
  if (kept.length === 0) {
    resetToDegraded(`有效行数 0（rows 空或全部行未通过 V1/V2/V5 校验）`);
    return false;
  }

  // 漂移检测（§2.3）：全部保留行引用的 chunkId 与当前语料（docIndexOf）比对。
  const allRefs = kept.flatMap((r) => r.chunkIds);
  const totalRefs = allRefs.length;
  const missingIds = new Set<string>();
  for (const id of allRefs) {
    if (!chunkExists(id)) missingIds.add(id);
  }
  const ratio = totalRefs === 0 ? 0 : missingIds.size / totalRefs;
  let filtered: EffectiveEventRow[];
  if (ratio > DRIFT_MAX_RATIO) {
    console.error(
      `[sango] event-table 漂移检测：缺失 chunkId ${missingIds.size}/${totalRefs}（${(ratio * 100).toFixed(1)}%）> 5%，整表降级为无事件路由`,
    );
    resetToDegraded(`语料漂移（缺失 chunkId 占比 ${(ratio * 100).toFixed(1)}% > 5%）`);
    return false;
  }
  if (missingIds.size > 0) {
    console.error(
      `[sango] event-table 漂移检测：剔除缺失 chunkId ${missingIds.size}/${totalRefs}（≤5%），保留其余引用：${[...missingIds].sort().join(', ')}`,
    );
    let emptyGroups = 0;
    filtered = [];
    for (const r of kept) {
      const ids = r.chunkIds.filter((id) => !missingIds.has(id));
      if (ids.length === 0) {
        // 组空则等效无事件路由：该组不进桥匹配面（组已无可用证据段）。
        emptyGroups++;
        continue;
      }
      filtered.push({ ...r, chunkIds: ids });
    }
    if (emptyGroups > 0) {
      console.error(`[sango] event-table 漂移检测：${emptyGroups} 组剔空（等效无事件路由）`);
    }
  } else {
    filtered = kept;
  }

  eventState.rows = filtered.map((r) => ({ ...r, chunkIds: sortChunkIdsInner(r.chunkIds) }));
  const aliasList: Array<{ alias: string; row: EffectiveEventRow }> = [];
  for (const r of eventState.rows) {
    for (const alias of r.aliases) aliasList.push({ alias, row: r });
  }
  // 尝试序（§3.2）：长度降序、同长 (eventId 升序, 表内顺序) 升序（sort 稳定保表内顺序）。
  aliasList.sort(
    (x, y) =>
      y.alias.length - x.alias.length ||
      (x.row.eventId < y.row.eventId ? -1 : x.row.eventId > y.row.eventId ? 1 : 0),
  );
  eventState.aliasList = aliasList;
  eventState.normVersion = normVersion;
  eventState.degraded = false;
  const chunkRefs = eventState.rows.reduce((s, r) => s + r.chunkIds.length, 0);
  console.error(
    `[sango] event-table loaded: rows=${eventState.rows.length} aliases=${aliasList.length} chunkRefs=${chunkRefs} normVersion=${normVersion}`,
  );
  return true;
}

/** 事件路是否生效；false = 表加载失败或整表漂移降级。诊断 eventHit.degraded 与桥开关同源。 */
export function eventsDegraded(): boolean {
  return eventState.degraded;
}

/** 表 meta.normVersion（对齐 entity-table normVersion 降级口径：未加载 / 降级为空串）。 */
export function eventsNormVersion(): string {
  return eventState.normVersion;
}

/** 实际生效行数（校验 / 漂移剔除后；启动日志 rows 值）。 */
export function eventsRowCount(): number {
  return eventState.rows.length;
}

/**
 * 事件名桥（§3.2）：对归一化后 query 全文子串匹配事件 alias。
 * - 单组命中：有效 alias 按长度降序、同长 (eventId 升序, 表内顺序) 逐个尝试，首个 includes 命中 → 所属组命中，
 *   matchedAlias = 该 alias（组内最长命中者）；
 * - 多组命中：命中组不再参与后续匹配，其余组按同规则继续；
 * - 返回按组优先级（命中 alias 长度降序，同长 eventId 升序）排序的命中组（组内 chunkIds 已按事件内序）。
 * - 降级（表加载失败 / 整表漂移）恒返回 []。
 */
export function matchEvents(normalized: string): MatchedEventGroup[] {
  if (eventState.degraded || eventState.aliasList.length === 0 || normalized.length === 0) return [];
  const matched: Array<{ row: EffectiveEventRow; matchedAlias: string }> = [];
  const hitRows = new Set<EffectiveEventRow>();
  for (const { alias, row } of eventState.aliasList) {
    if (hitRows.has(row)) continue;
    if (!normalized.includes(alias)) continue;
    hitRows.add(row);
    matched.push({ row, matchedAlias: alias });
  }
  matched.sort(
    (x, y) =>
      y.matchedAlias.length - x.matchedAlias.length ||
      (x.row.eventId < y.row.eventId ? -1 : x.row.eventId > y.row.eventId ? 1 : 0),
  );
  return matched.map(({ row, matchedAlias }) => ({
    eventId: row.eventId,
    eventName: row.eventName,
    matchedAlias,
    type: row.type,
    groupSize: row.chunkIds.length,
    chunkIds: row.chunkIds,
  }));
}
