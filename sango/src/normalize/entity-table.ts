/**
 * FEAT-A016 实体表加载与归一化（单一模块，检索侧 SangoIndex 与 sango_query_embed 共用同一实例）。
 *
 * 契约：docs/feat-A016-term-normalization-interface.md §1（单表文件契约）/ §2.1（归一化实现）/
 * §5（query.rewrites / env.normVersion 诊断字段）；
 * 表结构见 docs/feat-A016-entity-table-design.md（§2 schema / §7 内存结构 / §8 加载校验）。
 * - 表内违规键（单字 / banned / 跨行重复 / canonical 自指等）→ 告警 + 剔键，不拒全表（接口 §1.6）；
 * - 「键排斥规则」（bug-00036）：rewriteKeys 不得是表内他行 canonical 的真子串（跨行子串改写目标歧义）→ 告警 + 剔键；
 *   本行 canonical 子串短式经逐键裁决保留，替换时依赖「邻接延伸检查」兜底（键命中处能延伸为表内已知词则不替换，
 *   防 canonical 原文被二次扩张，如 长坂坡 不再出现 长坂坡坡）；
 * - 文件缺失 / JSON 损坏 / 结构非法 / 有效行数 0 → 告警 + normalize 退化为恒等（接口 §1.6）；
 * - 进程内单例：loadEntityTable 反复调用即整体覆盖（语义等价重启后重新加载），检索侧与工具侧口径恒同。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 单表行（表设计 §2.2，与 entity-table.json rows[] 逐字段对应）。 */
export interface EntityTableRow {
  type: string;
  id: string | null;
  canonical: string;
  aliases: string[];
  rewriteKeys: string[];
  fragmentOnly: string[];
  organGuard: unknown;
  note?: string;
}

/** canonToRow 行摘要（规范形 → 该行执行信息，人物行 id 承载 PID，供标签建设侧回查）。 */
export interface CanonInfo {
  type: string;
  id: string | null;
  aliases: string[];
  fragmentOnly: string[];
  organGuard: unknown;
  note?: string;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** 默认数据目录（与 SangoIndex 的 DEFAULT_DATA_DIR 同源：data/）。 */
export const DEFAULT_DATA_DIR = path.resolve(__dirname, '..', '..', 'data');

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 进程内单例状态（表设计 §7 内存结构）：
 * - keyToCanon：改写键 → 规范形（替换映射，正则构造输入）；
 * - canonToRow：规范形 → { type, id, aliases, fragmentOnly, organGuard, note }；
 * - fragmentKeyToCanon：fragmentOnly 全表并集 → 规范形（索引侧双写扩展）；与 text 命中匹配用；
 * - keyExtensions：改写键 → 表内已知词（任意行 canonical / aliases / rewriteKeys）中「更长含该键」词及其出现偏移，
 *   邻接延伸检查用（bug-00036：键命中处能延伸为已知词则不替换，防 canonical 真子串键二次扩张）；
 * - bannedRewriteKeys / guards：policy 审计数据（加载校验 / organGuard 引用）；
 * - pattern：改写键按长度降序的 alternation 正则（最长匹配口径，与退役 alias.json 时代一致）。
 */
const tableState = {
  keyToCanon: new Map<string, string>(),
  canonToRow: new Map<string, CanonInfo>(),
  fragmentKeyToCanon: new Map<string, string>(),
  keyExtensions: new Map<string, Array<{ word: string; offset: number }>>(),
  bannedRewriteKeys: new Set<string>(),
  guards: [] as Array<{
    term: string;
    semantic: string;
    total: number;
    bad: Array<[string, number]>;
    good: Array<[string, number]>;
    hasAmbiguity: boolean;
  }>,
  pattern: null as RegExp | null,
  rowsCount: 0,
  rewriteKeyCount: 0,
  normVersion: '',
};

function resetToDegraded(reason: string): void {
  console.error(`[sango] entity-table 加载失败：${reason}，降级为不做归一化`);
  tableState.keyToCanon.clear();
  tableState.canonToRow.clear();
  tableState.fragmentKeyToCanon.clear();
  tableState.keyExtensions.clear();
  tableState.bannedRewriteKeys.clear();
  tableState.guards = [];
  tableState.pattern = null;
  tableState.rowsCount = 0;
  tableState.rewriteKeyCount = 0;
  tableState.normVersion = '';
}

function warnOnce(message: string): void {
  console.error(`[sango] entity-table 校验：${message}`);
}

/** 表内 rewriteKeys 总数（含人物与非人物；表加载失败 / 降级为 0）。诊断 env.aliasCount 与启动日志同源。 */
export function rewriteKeyCount(): number {
  return tableState.rewriteKeyCount;
}

/** 表 meta.normVersion（8 位内容 hash）；表加载失败 / 降级为空串。工具出参与缓存 version_tag 复用。 */
export function normVersion(): string {
  return tableState.normVersion;
}

/** 实际生效行数（校验剔行后；启动日志 rows 值）。 */
export function rowsCount(): number {
  return tableState.rowsCount;
}

/** fragmentOnly 键 → 规范形（表设计 §6 消费矩阵：索引侧双写扩展，接口 §2.3）。 */
export function fragmentKeyToCanon(): ReadonlyMap<string, string> {
  return tableState.fragmentKeyToCanon;
}

/** 规范形 → 行摘要（表设计 §7 canonToRow；人物行 id 承载 PID）。 */
export function canonToRow(): ReadonlyMap<string, CanonInfo> {
  return tableState.canonToRow;
}

/**
 * 加载实体表（dataDir/entity-table.json）并重建单例状态；失败按接口 §1.6 降级为恒等。
 * 返回是否成功加载（false = 已降级；调用方无需分支处理，normalize 恒等即契约行为）。
 */
export function loadEntityTable(dataDir: string = DEFAULT_DATA_DIR): boolean {
  const file = path.join(dataDir, 'entity-table.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    resetToDegraded(`文件读取 / JSON 解析失败：${file}（${(e as Error).message}）`);
    return false;
  }
  const table = parsed as {
    meta?: { schemaVersion?: unknown; normVersion?: unknown };
    rows?: unknown;
    policy?: { bannedRewriteKeys?: unknown; ambiguityGuard?: unknown };
  } | null;
  // 结构校验（§8 检查 1：schemaVersion == 1；有效行数 0 亦降级）
  if (
    table === null ||
    typeof table !== 'object' ||
    Array.isArray(table) ||
    !Array.isArray(table.rows) ||
    table.rows.length === 0 ||
    table.meta === null ||
    typeof table.meta !== 'object' ||
    table.meta.schemaVersion !== 1 ||
    table.policy === null ||
    typeof table.policy !== 'object'
  ) {
    resetToDegraded(`结构非法（应有 meta.schemaVersion=1 + rows[] + policy）：${file}`);
    return false;
  }

  const banned = new Set<string>();
  for (const term of Array.isArray(table.policy.bannedRewriteKeys) ? table.policy.bannedRewriteKeys : []) {
    if (typeof term === 'string' && term.length > 0) banned.add(term);
  }
  const guards: typeof tableState.guards = [];
  if (Array.isArray(table.policy.ambiguityGuard)) {
    for (const g of table.policy.ambiguityGuard as Array<Record<string, unknown>>) {
      if (g === null || typeof g !== 'object' || typeof g.term !== 'string') continue;
      guards.push({
        term: g.term,
        semantic: typeof g.semantic === 'string' ? g.semantic : '',
        total: typeof g.total === 'number' ? g.total : 0,
        bad: Array.isArray(g.bad) ? (g.bad as Array<[string, number]>) : [],
        good: Array.isArray(g.good) ? (g.good as Array<[string, number]>) : [],
        hasAmbiguity: g.hasAmbiguity === true,
      });
    }
  }
  // 守卫禁入集（§5 消费 ②）：单字 / 歧义复合词不得作改写键（身体行白名单防回归）
  const guardTerms = new Set<string>();
  const guardBads = new Set<string>();
  for (const g of guards) {
    guardTerms.add(g.term);
    for (const [bad] of g.bad) guardBads.add(bad);
  }

  const canonByType = new Map<string, Set<string>>();
  const idSeen = new Set<string>();
  const kept: Array<{ row: EntityTableRow; rewriteKeys: string[]; fragmentOnly: string[] }> = [];

  for (const raw of table.rows as Array<Record<string, unknown>>) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      warnOnce('行不是对象，剔除该行');
      continue;
    }
    const type = typeof raw.type === 'string' ? raw.type : '';
    const canonical = typeof raw.canonical === 'string' ? raw.canonical : '';
    if (type.length === 0 || canonical.length === 0) {
      warnOnce(`行缺 type / canonical（${JSON.stringify(raw).slice(0, 60)}…），剔除该行`);
      continue;
    }
    // §8 检查 2：canonical 在 type 内唯一
    const seen = canonByType.get(type) ?? new Set<string>();
    if (seen.has(canonical)) {
      warnOnce(`canonical 在 type=${type} 内重复：${canonical}，剔除该行（含其键）`);
      continue;
    }
    seen.add(canonical);
    canonByType.set(type, seen);
    // §8 检查 7：人物行 id 非空且全局唯一
    const rawId = raw.id;
    const personId = typeof rawId === 'string' && rawId.length > 0 ? rawId : null;
    if (type === '人物') {
      if (typeof rawId !== 'string' || rawId.length === 0) {
        warnOnce(`人物行 id 缺失：${canonical}，剔除该行（含其键）`);
        continue;
      }
      if (idSeen.has(rawId)) {
        warnOnce(`人物行 id 重复：${rawId}（${canonical}），剔除该行（含其键）`);
        continue;
      }
      idSeen.add(rawId);
    }
    const strArr = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : [];
    const aliases = strArr(raw.aliases);
    const fragmentOnly = strArr(raw.fragmentOnly);
    let rewriteKeys = strArr(raw.rewriteKeys);
    if (aliases.length === 0) {
      warnOnce(`行 aliases 为空：${canonical}，剔除该行（含其键）`);
      continue;
    }
    const aSet = new Set(aliases);
    // §8 检查 3：rewriteKeys ⊆ aliases 且与 fragmentOnly 互斥（违规剔键）
    const forFragment = new Set(fragmentOnly);
    rewriteKeys = rewriteKeys.filter((k) => {
      if (!aSet.has(k)) {
        warnOnce(`${canonical} 的 rewriteKeys 项不在 aliases：${k}，剔键`);
        return false;
      }
      if (forFragment.has(k)) {
        warnOnce(`${canonical} 的 rewriteKeys 与 fragmentOnly 互斥被破坏：${k}，剔键`);
        return false;
      }
      return true;
    });
    // §8 检查 4 / 5 / K1 / K2 + §5 消费 ②：单字 / banned / guard 禁入剔键
    rewriteKeys = rewriteKeys.filter((k) => {
      if (k.length === 1) {
        warnOnce(`${canonical} 的 rewriteKeys 为单字：${k}，剔键（K1）`);
        return false;
      }
      if (banned.has(k)) {
        warnOnce(`${canonical} 的 rewriteKeys 命中 policy.bannedRewriteKeys：${k}，剔键（K2）`);
        return false;
      }
      if (guardTerms.has(k) || guardBads.has(k)) {
        warnOnce(`${canonical} 的 rewriteKeys 命中 ambiguityGuard 禁入集：${k}，剔键`);
        return false;
      }
      return true;
    });
    kept.push({
      row: {
        type,
        id: type === '人物' ? personId : null,
        canonical,
        aliases,
        rewriteKeys,
        fragmentOnly: fragmentOnly.filter((k) => aSet.has(k)),
        organGuard: raw.organGuard ?? null,
        ...(typeof raw.note === 'string' && raw.note.length > 0 ? { note: raw.note } : {}),
      },
      rewriteKeys,
      fragmentOnly: fragmentOnly.filter((k) => aSet.has(k)),
    });
  }

  if (kept.length === 0) {
    resetToDegraded(`有效行数 0（${file}）`);
    return false;
  }

  // §8 检查 8：canonical 不出现于任何行的 rewriteKeys / fragmentOnly（防循环 / 二次替换，违例剔键）
  const rkSet = new Map<string, string>(); // 键 → canonical（跨行重复检测直接复用）
  for (const k of kept.flatMap((x) => x.rewriteKeys)) rkSet.set(k, '');
  for (const x of kept) {
    const rowRks = new Set(x.rewriteKeys);
    for (const k of x.rewriteKeys) {
      if (k === x.row.canonical) {
        warnOnce(`canonical 出现在本行 rewriteKeys：${k}，剔键（§8 #8）`);
        rowRks.delete(k);
      }
    }
    for (const k of x.fragmentOnly) {
      if (k === x.row.canonical) {
        warnOnce(`canonical 出现在本行 fragmentOnly：${k}，剔除片段素材（§8 #8）`);
        x.row.fragmentOnly = x.row.fragmentOnly.filter((f) => f !== k);
        x.fragmentOnly = x.fragmentOnly.filter((f) => f !== k);
      }
    }
    x.rewriteKeys = [...rowRks];
    x.row.rewriteKeys = [...rowRks];
  }

  // §8 检查 9（键排斥规则，bug-00036）：rewriteKeys 不得是表内他行 canonical 的真子串——
  // 跨行子串键的改写目标歧义（如 遁甲 同时 ⊂奇门遁甲 与 ⊂遁甲天书），告警 + 剔键（与 K1/K2 同类）；
  // 本行 canonical 子串短式（博望⊂博望坡 等）经 bug-00036 逐键裁决保留，靠邻接延伸检查兜底。
  const otherRowCanons = new Set(kept.flatMap((x) => [x.row.canonical]));
  for (const x of kept) {
    const rowRks = new Set(x.rewriteKeys);
    for (const k of x.rewriteKeys) {
      const cross = [...otherRowCanons].find(
        (c) => c !== x.row.canonical && c.length > k.length && c.includes(k),
      );
      if (cross) {
        warnOnce(
          `${x.row.canonical} 的 rewriteKeys 是表内他行 canonical「${cross}」的真子串：${k}，剔键（K4，bug-00036）`,
        );
        rowRks.delete(k);
      }
    }
    x.rewriteKeys = [...rowRks];
    x.row.rewriteKeys = [...rowRks];
  }

  // 重建单例状态（keyToCanon / canonToRow / fragmentKeyToCanon / pattern）
  const keyToCanon = new Map<string, string>();
  const canonToRow = new Map<string, CanonInfo>();
  const fragmentKeyToCanon = new Map<string, string>();
  for (const x of kept) {
    const info: CanonInfo = {
      type: x.row.type,
      id: x.row.id,
      aliases: x.row.aliases,
      fragmentOnly: x.row.fragmentOnly,
      organGuard: x.row.organGuard,
      ...(x.row.note ? { note: x.row.note } : {}),
    };
    canonToRow.set(x.row.canonical, info);
    for (const k of x.rewriteKeys) keyToCanon.set(k, x.row.canonical);
    for (const f of x.row.fragmentOnly) {
      if (!fragmentKeyToCanon.has(f)) fragmentKeyToCanon.set(f, x.row.canonical);
    }
  }
  // §8 检查 6：rewriteKeys 全表唯一（跨行重复键整体弃用，同合并轮 R6 口径）——
  // 计数须在逐行键集上做（keyToCanon 已是去重 Map，直接数恒为 1）
  const perRowKeyCount = new Map<string, number>();
  for (const x of kept) {
    for (const k of new Set(x.rewriteKeys)) perRowKeyCount.set(k, (perRowKeyCount.get(k) ?? 0) + 1);
  }
  const dupKeys = [...perRowKeyCount].filter(([, n]) => n > 1).map(([k]) => k);
  for (const k of dupKeys) {
    warnOnce(`rewriteKeys 跨行重复：${k}，整体弃用（不进 fragmentOnly）`);
    keyToCanon.delete(k);
  }

  // 邻接延伸检查索引（bug-00036 机制层）：改写键 → 表内已知词（任意行 canonical / aliases / rewriteKeys）
  // 中「更长且含该键」的词及其出现偏移；normalize 替换前先核对命中处能否延伸为已知词，能延伸则不替换，
  // 防 canonical 原文被键二次扩张（长坂坡 不因 长坂 键变 长坂坡坡；独立语境 博望之战 照常改写）。
  const knownWords = new Set<string>();
  for (const x of kept) {
    knownWords.add(x.row.canonical);
    for (const a of x.row.aliases) knownWords.add(a);
    for (const k of x.rewriteKeys) knownWords.add(k);
  }
  const keyExtensions = new Map<string, Array<{ word: string; offset: number }>>();
  for (const k of keyToCanon.keys()) {
    const ext: Array<{ word: string; offset: number }> = [];
    for (const w of knownWords) {
      if (w.length <= k.length || !w.includes(k)) continue;
      let from = 0;
      for (;;) {
        const j = w.indexOf(k, from);
        if (j < 0) break;
        ext.push({ word: w, offset: j });
        from = j + 1;
      }
    }
    if (ext.length > 0) keyExtensions.set(k, ext);
  }

  const aliasNames = [...keyToCanon.keys()].sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
  tableState.keyToCanon = keyToCanon;
  tableState.canonToRow = canonToRow;
  tableState.fragmentKeyToCanon = fragmentKeyToCanon;
  tableState.keyExtensions = keyExtensions;
  tableState.bannedRewriteKeys = banned;
  tableState.guards = guards;
  tableState.pattern = aliasNames.length > 0 ? new RegExp(aliasNames.map(escapeRegExp).join('|'), 'g') : null;
  tableState.rowsCount = kept.length;
  tableState.rewriteKeyCount = keyToCanon.size;
  tableState.normVersion = typeof table.meta.normVersion === 'string' ? table.meta.normVersion : '';

  console.error(
    `[sango] entity-table loaded: rows=${tableState.rowsCount} keys=${tableState.rewriteKeyCount} normVersion=${tableState.normVersion}`,
  );
  return true;
}
 /** 一次改写命中明细（query 侧替换记录）：from=原文片段、to=规范形。 */
 export interface NormalizeHit {
   from: string;
   to: string;
 }

 /** normalizeDetail 出参：text=归一化后文本；hits=实际改写命中明细（按替换发生顺序）。 */
 export interface NormalizeDetail {
   text: string;
   hits: NormalizeHit[];
 }

 /**
 * 文本归一化 + query 侧实际改写命中明细（接口 §5 query.rewrites 数据源；test-1921 提测增补）。
 * 替换算法与 normalize 完全一致（改写键按长度降序 alternation 全局替换，最长匹配口径不变；
 * 替换前做邻接延伸检查（bug-00036）：键命中处若与邻接字符能延伸为表内已知词（任意行 canonical /
 * aliases / rewriteKeys 中最长命中），则不替换该键——防 canonical 原文被真子串键二次扩张）。
 * hits 口径：
 * - 按替换发生顺序（String.replace 回调即自左向右处理序）排列；
 * - 仅记「实际发生替换」的键：邻接延伸检查保护未替换的键不计入；
 * - fragmentOnly 键不在 query 侧替换（不进入 keyToCanon / pattern），不计入；
 * - 无改写 / 表加载失败降级（pattern=null）→ hits=[] 且 text 恒等（接口 §1.6：检索与工具继续工作）。
 */
 export function normalizeDetail(text: string): NormalizeDetail {
   if (!tableState.pattern) return { text, hits: [] };
   const hits: NormalizeHit[] = [];
   const out = text.replace(tableState.pattern, (m, offset: number) => {
     const ext = tableState.keyExtensions.get(m);
     if (ext) {
       for (const { word, offset: j } of ext) {
         const start = offset - j;
         if (start >= 0 && text.startsWith(word, start)) return m;
       }
     }
     const to = tableState.keyToCanon.get(m);
     if (to === undefined || to === m) return m;
     hits.push({ from: m, to });
     return to;
   });
   return { text: out, hits };
 }

 /** 文本归一化：签名与行为不变（内部委托 normalizeDetail().text），既有调用点零改动。 */
 export function normalize(text: string): string {
   return normalizeDetail(text).text;
 }
