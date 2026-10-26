/**
 * FEAT-A018 事件表 / 典故表双表模块（检索侧）：加载 / V1–V7 校验 / 漂移检测 / 名称桥（alias 子串匹配）。
 *
 * 契约：docs/feat-A018-event-table-interface.md §1（表设计）/ §2（加载与降级）/ §3.1–3.2（名称桥）/
 * §5.6（典故表 allusionHit，镜像 eventHit）。两表同构（schema 均 { meta, rows }，行字段 eventId /
 * eventName / aliases / chunkIds / type），共用同一套「加载 / 校验 / 漂移 / 降级 / 桥匹配」实现：
 * - 事件路 events.json（type=L1/L2/L3）与典故路 allusions.json（type=典故，无 L3）各自独立降级互不影响；
 * - 进程内单例：loadXxxTable 反复调用即整体覆盖（语义等价重启后重新加载），与 entity-table 同口径；
 * - 加载失败降级为「无事件路由 / 无典故路由」不阻断启动（核心语料失败仍终止，现状不变）；
 * - 漂移检测（§2.3）：缺失 >5% 整表降级 / ≤5% 剔缺失 chunkId 告警 / corpusChunkCount 不一致告警；
 * - 桥只读归一化后 query 子串（alias 原文即匹配串，不做二次归一化），零 LLM、不分流 type；
 * - 表内容变更生效方式 = 重启进程重新 load()，无持久化索引产物。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rewriteKeys } from '../normalize/entity-table.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 漂移阈值：缺失 chunkId 占比 > 5% 整表降级（接口 §2.3 首版口径）。 */
const DRIFT_MAX_RATIO = 0.05;

/**
 * 事件层级（需求 feat-A018 落表分层口径）：L1 = 有通行专名的事件（三英战吕布 / 草船借箭），白话问法多、
 * 优先处理；L2 = 无专名但完整闭环的情节单元（三顾茅庐全过程）；L3 = 死亡 / 登场，落表即「标签位点段
 * ±N」小位点组（2-5 段）、置顶保证区不参与池重排。检索装配差异见 sango-index.ts search() 池装配层。
 */
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

/** 典故行（镜像事件行；type 恒 '典故'、无 L3 语义）。 */
export interface EffectiveAllusionRow {
  allusionId: string;
  allusionName: string;
  /** 有效 alias（V3 剔除后，同事件口径）。 */
  aliases: string[];
  /** 有效 chunk 引用（漂移剔除后，事件内序）。 */
  chunkIds: string[];
  type: '典故';
}

/** 典故名桥命中组（镜像 MatchedEventGroup，无 type；按组优先级排序）。 */
export interface MatchedAllusionGroup {
  allusionId: string;
  allusionName: string;
  /** 本组命中的 alias（组内最长）。 */
  matchedAlias: string;
  /** 组内有效 chunk 引用总数（漂移剔除后）。 */
  groupSize: number;
  /** 有效 chunk 引用（事件内序）。 */
  chunkIds: string[];
}

/** 双表共用行（表内字段名两表一致：eventId / eventName，接口 §1 同构）。 */
interface TableRow {
  id: string;
  name: string;
  aliases: string[];
  chunkIds: string[];
  type: string;
}

/** 进程内单例状态（对齐 entity-table.ts 单一实现模式）。 */
interface TableState {
  /** 本路是否生效；true = 表加载失败 / 整表漂移降级（此时桥恒不命中）。 */
  degraded: boolean;
  /** 表 meta.normVersion；降级为空串。 */
  normVersion: string;
  /** 校验 + 漂移剔除后的有效行。 */
  rows: TableRow[];
  /** 全部有效 alias → 所属行，按长度降序、同长 (id 升序, 表内顺序) 排序（§3.2 尝试序）。 */
  aliasList: Array<{ alias: string; row: TableRow }>;
}

function freshTableState(): TableState {
  return { degraded: true, normVersion: '', rows: [], aliasList: [] };
}

interface TableModuleConfig {
  /** 日志前缀：`[sango] {logPrefix} ...`。 */
  logPrefix: string;
  /** 表文件：data/corpus/{fileName}。 */
  fileName: string;
  /** 输出 / 告警字段名（事件路 eventId，典故路 allusionId）。 */
  idLabel: string;
  nameLabel: string;
  /** 合法 type 集合（V5 校验）；典故路恒 {'典故'}、无 L3。 */
  validTypes: ReadonlySet<string>;
  /** 降级告警路由名（无事件路由 / 无典故路由）。 */
  degradedRouteName: string;
}

export interface TableModule {
  load: (
    dataDir: string,
    chunkExists: (chunkId: string) => boolean,
    corpusChunkCount: number,
  ) => boolean;
  degraded: () => boolean;
  normVersion: () => string;
  rowCount: () => number;
  match: (normalized: string) => Array<{ row: TableRow; matchedAlias: string }>;
}

/** chunkId → 表内序排序键：(回号, 段号, 同段块序)。ID 格式 {source}:{回号4位}:p{段号4位}:c{块序2位}（接口 §1.3）。 */
export function innerOrderKey(chunkId: string): [number, number, number] {
  const m = /^[^:]+:(\d{4}):p(\d{4}):c(\d{2})$/.exec(chunkId);
  // 格式非法（语料重建残留等）防御性垫底，保留引用不丢（漂移检测已按 docIndexOf 验存在性）。
  if (!m) return [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER];
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function sortChunkIdsInner(chunkIds: string[]): string[] {
  return [...chunkIds].sort((a, b) => {
    const [ca, pa, sa] = innerOrderKey(a);
    const [cb, pb, sb] = innerOrderKey(b);
    return ca - cb || pa - pb || sa - sb || (a < b ? -1 : a > b ? 1 : 0);
  });
}

/**
 * 双表共用的「加载 → 校验（V1/V2/V3/V5）→ 漂移剔除 → 单例重建 → 桥匹配」工厂。
 * 漂移检测需要 docIndexOf 就绪，由 SangoIndex.load() 在 docs 构建完成后调用（chunkExists 注入）。
 * 返回表模块（load 返回是否成功加载；false = 已降级，调用方无需分支处理，match 恒空即契约行为）。
 */
function createTableModule(config: TableModuleConfig): TableModule & { state: TableState } {
  const state = freshTableState();

  const resetToDegraded = (reason: string): void => {
    console.error(`[sango] ${config.logPrefix} 加载失败：${reason}，降级为${config.degradedRouteName}`);
    state.degraded = true;
    state.normVersion = '';
    state.rows = [];
    state.aliasList = [];
  };

  const load: TableModule['load'] = (dataDir, chunkExists, corpusChunkCount) => {
    const file = path.join(dataDir, 'corpus', config.fileName);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      resetToDegraded(`文件读取 / JSON 解析失败：${file}（${(e as Error).message}）`);
      return false;
    }
    const table = parsed as { meta?: unknown; rows?: unknown } | null;
    if (table === null || typeof table !== 'object' || Array.isArray(table)) {
      resetToDegraded(`顶层结构非法（应为 { meta, rows }）：${file}`);
      return false;
    }
    const meta = (table as { meta?: unknown }).meta as
      | { normVersion?: unknown; corpusChunkCount?: unknown }
      | undefined;
    const rowsRaw = (table as { rows?: unknown }).rows;
    if (!Array.isArray(rowsRaw)) {
      resetToDegraded(`rows 非数组：${file}`);
      return false;
    }
    // V7：meta 完整（normVersion / corpusChunkCount 存在）；缺失按顶层结构非法整表降级。
    const normVersion =
      typeof meta?.normVersion === 'string' && meta.normVersion.length > 0 ? meta.normVersion : '';
    const metaCount = typeof meta?.corpusChunkCount === 'number' ? meta.corpusChunkCount : null;
    if (!normVersion || metaCount === null) {
      resetToDegraded(`meta 不完整（normVersion / corpusChunkCount 缺失）：${file}`);
      return false;
    }
    // corpusChunkCount ≠ 当前语料 chunk 数 → 语料重建漂移信号（告警，不阻断）。
    if (metaCount !== corpusChunkCount) {
      console.error(
        `[sango] ${config.logPrefix} 漂移检测：meta.corpusChunkCount（${metaCount}）≠ 当前语料 chunk 数（${corpusChunkCount}），语料重建漂移信号`,
      );
    }

    // V1 / V2 / V5 行级违规剔行；V3 单条 alias 违规剔该 alias（对齐 entity-table 违规键剔除先例）。
    const entityRk = rewriteKeys();
    const kept: TableRow[] = [];
    const seenId = new Set<string>();
    const seenAlias = new Set<string>();
    const warn = (message: string): void => console.error(`[sango] ${config.logPrefix} 校验：${message}`);
    let rowDropped = 0;
    let aliasDropped = 0;
    for (const raw of rowsRaw as Array<Record<string, unknown>>) {
      const id = typeof raw.eventId === 'string' ? raw.eventId : '';
      const name = typeof raw.eventName === 'string' ? raw.eventName : '';
      const rawType = raw.type;
      const aliasesRaw = raw.aliases;
      const aliases = Array.isArray(aliasesRaw)
        ? aliasesRaw.filter((a): a is string => typeof a === 'string')
        : [];
      const chunkIdsRaw = raw.chunkIds;
      const chunkIds = Array.isArray(chunkIdsRaw)
        ? chunkIdsRaw.filter((c): c is string => typeof c === 'string')
        : [];
      if (!id || seenId.has(id)) {
        warn(`V1 ${config.idLabel} ${id ? '跨行重复' : '为空'}，剔行（${config.nameLabel}=${name || '(空)'}）`);
        rowDropped++;
        continue;
      }
      seenId.add(id);
      if (!name) {
        warn(`V2 ${config.nameLabel} 为空，剔行（${config.idLabel}=${id}）`);
        rowDropped++;
        continue;
      }
      if (!config.validTypes.has(rawType as string)) {
        warn(`V5 type 非法（${String(rawType)}），剔行（${config.idLabel}=${id}）`);
        rowDropped++;
        continue;
      }
      const keptAliases: string[] = [];
      const rowSeen = new Set<string>();
      for (const alias of aliases) {
        if (alias.length < 2) {
          warn(`V3 单字禁入，剔 alias「${alias}」（${config.idLabel}=${id}）`);
          aliasDropped++;
          continue;
        }
        if (rowSeen.has(alias)) {
          warn(`V3 行内重复，剔 alias「${alias}」（${config.idLabel}=${id}）`);
          aliasDropped++;
          continue;
        }
        rowSeen.add(alias);
        if (seenAlias.has(alias)) {
          warn(`V3 跨行重复，剔 alias「${alias}」（${config.idLabel}=${id}）`);
          aliasDropped++;
          continue;
        }
        if (entityRk.has(alias)) {
          warn(`V3 与实体表 rewriteKeys 冲突，剔 alias「${alias}」（${config.idLabel}=${id}）`);
          aliasDropped++;
          continue;
        }
        seenAlias.add(alias);
        keptAliases.push(alias);
      }
      kept.push({ id, name, aliases: keptAliases, chunkIds, type: String(rawType) });
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
    let filtered: TableRow[];
    if (ratio > DRIFT_MAX_RATIO) {
      console.error(
        `[sango] ${config.logPrefix} 漂移检测：缺失 chunkId ${missingIds.size}/${totalRefs}（${(ratio * 100).toFixed(1)}%）> 5%，整表降级为${config.degradedRouteName}`,
      );
      resetToDegraded(`语料漂移（缺失 chunkId 占比 ${(ratio * 100).toFixed(1)}% > 5%）`);
      return false;
    }
    if (missingIds.size > 0) {
      console.error(
        `[sango] ${config.logPrefix} 漂移检测：剔除缺失 chunkId ${missingIds.size}/${totalRefs}（≤5%），保留其余引用：${[...missingIds].sort().join(', ')}`,
      );
      let emptyGroups = 0;
      filtered = [];
      for (const r of kept) {
        const ids = r.chunkIds.filter((id) => !missingIds.has(id));
        if (ids.length === 0) {
          // 组空则等效本路无路由：该组不进桥匹配面（组已无可用证据段）。
          emptyGroups++;
          continue;
        }
        filtered.push({ ...r, chunkIds: ids });
      }
      if (emptyGroups > 0) {
        console.error(`[sango] ${config.logPrefix} 漂移检测：${emptyGroups} 组剔空（等效${config.degradedRouteName}）`);
      }
    } else {
      filtered = kept;
    }

    state.rows = filtered.map((r) => ({ ...r, chunkIds: sortChunkIdsInner(r.chunkIds) }));
    // 桥键 = 规范名（name）∪ aliases（§3.2）：规范名与实体表 rewriteKeys 冲突时不入 aliases，仍须能命中桥。
    // 加载日志的 aliases 计数沿用「表内有效 alias 数」，与桥键数区分（桥键另含规范名）。
    const aliasList: Array<{ alias: string; row: TableRow }> = [];
    let aliasCount = 0;
    for (const r of state.rows) {
      aliasCount += r.aliases.length;
      for (const key of new Set([r.name, ...r.aliases])) aliasList.push({ alias: key, row: r });
    }
    // 尝试序（§3.2）：长度降序、同长 (id 升序, 表内顺序) 升序（sort 稳定保表内顺序）。
    aliasList.sort(
      (x, y) =>
        y.alias.length - x.alias.length || (x.row.id < y.row.id ? -1 : x.row.id > y.row.id ? 1 : 0),
    );
    state.aliasList = aliasList;
    state.normVersion = normVersion;
    state.degraded = false;
    const chunkRefs = state.rows.reduce((s, r) => s + r.chunkIds.length, 0);
    console.error(
      `[sango] ${config.logPrefix} loaded: rows=${state.rows.length} aliases=${aliasCount} chunkRefs=${chunkRefs} normVersion=${normVersion}`,
    );
    return true;
  };

  const match: TableModule['match'] = (normalized) => {
    if (state.degraded || state.aliasList.length === 0 || normalized.length === 0) return [];
    const matched: Array<{ row: TableRow; matchedAlias: string }> = [];
    const hitRows = new Set<TableRow>();
    for (const { alias, row } of state.aliasList) {
      if (hitRows.has(row)) continue;
      if (!normalized.includes(alias)) continue;
      hitRows.add(row);
      matched.push({ row, matchedAlias: alias });
    }
    matched.sort(
      (x, y) =>
        y.matchedAlias.length - x.matchedAlias.length ||
        (x.row.id < y.row.id ? -1 : x.row.id > y.row.id ? 1 : 0),
    );
    return matched;
  };

  return {
    state,
    load,
    degraded: () => state.degraded,
    normVersion: () => state.normVersion,
    rowCount: () => state.rows.length,
    match,
  };
}

/** 事件路（events.json，type=L1/L2/L3）。 */
const eventModule = createTableModule({
  logPrefix: 'event-table',
  fileName: 'events.json',
  idLabel: 'eventId',
  nameLabel: 'eventName',
  validTypes: new Set<EventType>(['L1', 'L2', 'L3']),
  degradedRouteName: '无事件路由',
});

/** 典故路（allusions.json，type=典故；无 L3，不进保证区置顶）。 */
const allusionModule = createTableModule({
  logPrefix: 'allusion-table',
  fileName: 'allusions.json',
  idLabel: 'allusionId',
  nameLabel: 'allusionName',
  validTypes: new Set<string>(['典故']),
  degradedRouteName: '无典故路由',
});

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
  return eventModule.load(dataDir, chunkExists, corpusChunkCount);
}

/** 事件路是否生效；false = 表加载失败或整表漂移降级。诊断 eventHit.degraded 与桥开关同源。 */
export function eventsDegraded(): boolean {
  return eventModule.degraded();
}

/** 表 meta.normVersion（对齐 entity-table normVersion 降级口径：未加载 / 降级为空串）。 */
export function eventsNormVersion(): string {
  return eventModule.normVersion();
}

/** 实际生效行数（校验 / 漂移剔除后；启动日志 rows 值）。 */
export function eventsRowCount(): number {
  return eventModule.rowCount();
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
  return eventModule.match(normalized).map(({ row, matchedAlias }) => ({
    eventId: row.id,
    eventName: row.name,
    matchedAlias,
    type: row.type as EventType,
    groupSize: row.chunkIds.length,
    chunkIds: row.chunkIds,
  }));
}

/**
 * 加载典故表（dataDir/corpus/allusions.json）并重建单例状态（接口 §5.6 / 需求验收 7）。
 * 与 loadEventsTable 同机制；典故表加载失败只降级典故路（allusionsDegraded()=true），事件路不受影响。
 * 返回是否成功加载（false = 已降级为无典故路由；matchAllusions 恒空即契约行为）。
 */
export function loadAllusionsTable(
  dataDir: string = path.join(__dirname, '..', '..', 'data'),
  chunkExists: (chunkId: string) => boolean,
  corpusChunkCount: number,
): boolean {
  return allusionModule.load(dataDir, chunkExists, corpusChunkCount);
}

/** 典故路是否生效；false = 表加载失败或整表漂移降级。诊断 allusionHit.degraded 与桥开关同源。 */
export function allusionsDegraded(): boolean {
  return allusionModule.degraded();
}

/** 典故表 meta.normVersion（未加载 / 降级为空串）。 */
export function allusionsNormVersion(): string {
  return allusionModule.normVersion();
}

/** 实际生效典故行数（校验 / 漂移剔除后）。 */
export function allusionsRowCount(): number {
  return allusionModule.rowCount();
}

/**
 * 典故名桥（§5.6，镜像事件名桥）：对归一化后 query 全文子串匹配典故 alias。
 * 返回按组优先级（命中 alias 长度降序，同长 allusionId 升序）排序的命中组（组内 chunkIds 已按事件内序）。
 * 降级（表加载失败 / 整表漂移）恒返回 []。
 */
export function matchAllusions(normalized: string): MatchedAllusionGroup[] {
  return allusionModule.match(normalized).map(({ row, matchedAlias }) => ({
    allusionId: row.id,
    allusionName: row.name,
    matchedAlias,
    groupSize: row.chunkIds.length,
    chunkIds: row.chunkIds,
  }));
}
