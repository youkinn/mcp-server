#!/usr/bin/env node
/**
 * FEAT-A016 表合并（R1–R14）：表起草 → sango/data/entity-table.json（可复跑，幂等）。
 *
 * 契约（以文档为准，本脚本为其实现）：
 *   - 表设计：dev-docs/docs/feat-A016-entity-table-design.md §2 schema / §3 合并规则 / §8 校验清单
 *   - 执行接口：dev-docs/docs/feat-A016-term-normalization-interface.md §1.4（构建方式，运行时零计算）
 * 输入：dev-docs/test/term-diff/report/feat-A016-entity-table-draft.json（唯一起草输入，只读）
 * 输出：sango/data/entity-table.json（git 跟踪；表内容变更 → 重跑本脚本 → normVersion 换代）
 *
 * 用法：
 *   node scripts/merge-entity-table.mjs [draftPath] [outPath]
 * 依赖 Node 18+（node:crypto SHA-256）。
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DRAFT = 'D:\\workplace\\dev-docs\\test\\term-diff\\report\\feat-A016-entity-table-draft.json';
const DEFAULT_OUT = path.resolve(HERE, '..', 'data', 'entity-table.json');

/** R2：终审禁入改写键的 verdict 集合（表设计 §4 判定映射）。 */
const BANNED_VERDICTS = new Set([
  '禁入改写键（泛官职裸词）',
  '跨主条目',
  '跨主条目（多主条目候选）',
  '跨主条目（同串跨人组）',
]);

/** R5：bug-00031 冲突组（同字不同人），从所在人物行 aliases 全删除、不进表。 */
const BUG31_CONFLICT_WORDS = ['子明', '公明', '子孝', '子远'];

/** R4：解析残渣（非真实别名），从 aliases / rewriteKeys / fragmentOnly 全删除。 */
const PARSE_RESIDUE = new Set(['疑似', '待统计复核）']);

/** R9：典故两字茎（独立语义占比核查结论）进入 fragmentOnly（禁入改写键）。 */
const STEM_TO_FRAGMENT = new Set(['美人', '疑兵', '诈降', '反间', '拖刀', '连环', '空城']);

/** R10：数字称谓过泛缩略进入 fragmentOnly；其余（五虎将 / 十八镇诸侯 等）保留。 */
const NUMBER_PHRASE_TO_FRAGMENT = new Set(['六出', '九伐']);

/**
 * 重复 id 裁定（表设计 §2.3 + alias.json 权威归属）：
 * 草稿对 P019 / P026 / P030 / P099 各出现两行且两行 inAliasJson 均为 true（该字段无法区分），
 * 以 alias.json 实测归属为准 —— P019=吕蒙 / P026=徐晃 / P030=曹仁 / P099=刘协（原号保留），
 * 对应另一行（孙亮 / 管辂 / 孙和 / 曹奂）按 rows 顺序从最大号 +1 续号（P148 起）。
 */
const DUP_ID_OWNER = new Map([
  ['P019', '吕蒙'],
  ['P026', '徐晃'],
  ['P030', '曹仁'],
  ['P099', '刘协'],
]);

function dedup(arr) {
  const out = [];
  const seen = new Set();
  for (const item of arr) {
    if (typeof item !== 'string' || item.length === 0 || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

function verify(cond, message, problems) {
  if (!cond) problems.push(message);
}

/** rows 段规范化序列化（每行键排序 + 行序连接）→ 8 位内容 hash（不含 meta / generatedAt / policy）。 */
function contentHash(rows) {
  const canon = rows.map((row) =>
    JSON.stringify(Object.fromEntries(Object.entries(row).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))),
  );
  return createHash('sha256').update(canon.join('\n'), 'utf8').digest('hex').slice(0, 8);
}

/** 按 schema §2.2 列序组装行对象（写盘可读 + hash 稳定：键序固定；note 有值才携带）。 */
function makeRow({ type, id, canonical, aliases, rewriteKeys, fragmentOnly, organGuard, note }) {
  const row = { type, id, canonical, aliases, rewriteKeys, fragmentOnly, organGuard };
  if (note) row.note = note;
  return row;
}

function main() {
  const draftPath = process.argv[2] ?? DEFAULT_DRAFT;
  const outPath = process.argv[3] ?? DEFAULT_OUT;
  let draft;
  try {
    draft = JSON.parse(readFileSync(draftPath, 'utf8'));
  } catch (e) {
    console.error(`[merge] 表起草读取失败：${draftPath}（${e.message}）`);
    process.exit(1);
  }
  for (const key of ['person', 'nonPerson', 'referentVerdicts', 'ambiguityGuard']) {
    if (!Array.isArray(draft[key])) {
      console.error(`[merge] 表起草缺 ${key}[] 段：${draftPath}`);
      process.exit(1);
    }
  }

  // ---- 终审判定集（R2 / R4 消费）----
  const bannedTerms = dedup(draft.referentVerdicts.filter((r) => BANNED_VERDICTS.has(r.verdict)).map((r) => r.term));
  const bannedKeySet = new Set(bannedTerms);
  const banVerdictByTerm = new Map();
  for (const r of draft.referentVerdicts) {
    if (BANNED_VERDICTS.has(r.verdict)) banVerdictByTerm.set(r.term, r.verdict);
  }
  const residueSet = new Set(draft.referentVerdicts.filter((r) => PARSE_RESIDUE.has(r.term)).map((r) => r.term));

  const rows = [];
  const usedIds = new Set();
  const problems = [];

  // ---- person 行（R1 / R2 / R5 / R14）：候选改写键 = aliases - 终审禁入 - 残渣 - bug31 ----
  const idCounts = new Map();
  for (const r of draft.person) {
    if (r.id) idCounts.set(r.id, (idCounts.get(r.id) ?? 0) + 1);
  }
  let nextId = draft.person.reduce((m, r) => Math.max(m, /^P\d+$/.test(r.id ?? '') ? Number(r.id.slice(1)) : 0), 0) + 1;

  for (const r of draft.person) {
    const aliases = dedup(r.aliases ?? []).filter((a) => !residueSet.has(a) && !BUG31_CONFLICT_WORDS.includes(a));
    const bug31Hit = dedup(r.aliases ?? []).filter((a) => BUG31_CONFLICT_WORDS.includes(a));
    const bannedIn = aliases.filter((a) => bannedKeySet.has(a));
    const notes = [];
    if (bannedIn.length > 0) {
      const verdicts = dedup(bannedIn.map((a) => banVerdictByTerm.get(a) ?? ''));
      notes.push(`R2：${bannedIn.join('、')} 终审${verdicts.join('；')}禁入改写键（移入 fragmentOnly）`);
    }
    if (bug31Hit.length > 0) notes.push(`R5：bug-00031 冲突词 ${bug31Hit.join('、')} 已从 aliases 删除（冲突组不进表）`);
    let id = r.id ?? null;
    if (id === null || (idCounts.get(id) > 1 && DUP_ID_OWNER.get(id) !== r.canonical)) {
      id = `P${nextId++}`;
    }
    usedIds.add(id);
    // 自指键剔除：canonical ∈ 本行 aliases 时不得作自己的改写键（§8 #8：canonical 不出现在任何行键中）
    const rewriteKeys = aliases.filter((a) => !bannedKeySet.has(a) && a !== r.canonical);
    rows.push(
      makeRow({
        type: '人物',
        id,
        canonical: r.canonical,
        aliases,
        rewriteKeys,
        fragmentOnly: bannedIn,
        organGuard: null,
        note: notes.join('；'),
      }),
    );
  }

  // ---- nonPerson 行（R2 / R6 / R7 / R8 / R9 / R10 / R11 / R12）----
  const guards = draft.ambiguityGuard;
  const guardBySemantic = new Map();
  for (const g of guards) {
    if (typeof g?.semantic === 'string') guardBySemantic.set(g.semantic, g);
  }

  for (const r of draft.nonPerson) {
    const type = r.type;
    const aliases = dedup(r.aliases ?? []).filter((a) => !residueSet.has(a));
    let rewriteKeys = dedup(r.rewriteKeys ?? []).filter((k) => aliases.includes(k) && !residueSet.has(k));
    let fragmentOnly = dedup(r.fragmentOnly ?? []).filter((k) => aliases.includes(k) && !residueSet.has(k));
    const notes = [];

    // R2：候选改写键 ∩ 终审禁入 → fragmentOnly + banned
    const bannedIn = rewriteKeys.filter((k) => bannedKeySet.has(k));
    if (bannedIn.length > 0) {
      const verdicts = dedup(bannedIn.map((k) => banVerdictByTerm.get(k) ?? ''));
      notes.push(`R2：${bannedIn.join('、')} 终审${verdicts.join('；')}禁入改写键（移入 fragmentOnly）`);
      rewriteKeys = rewriteKeys.filter((k) => !bannedKeySet.has(k));
      fragmentOnly = dedup([...fragmentOnly, ...bannedIn]).filter((k) => k !== r.canonical);
    }

    // R7：官职 / 势力类行 rewriteKeys 置空，aliases 全落 fragmentOnly
    if (type === '官职' || type === '势力') {
      const canonicalVerdict = banVerdictByTerm.get(r.canonical);
      if (canonicalVerdict) {
        // 表设计 §2.4 禁入案例口径：canonical 本身命中终审禁入时记 R7+R2（如 皇帝 / 太子）
        notes.push(`R7+R2：${r.canonical} 终审${canonicalVerdict}禁入改写键，${type}类行 aliases 全落 fragmentOnly`);
      } else if (bannedIn.length === 0) {
        notes.push(`R7：${type}类行不设改写键，aliases 全落 fragmentOnly`);
      }
      rewriteKeys = [];
      fragmentOnly = dedup([...aliases, ...fragmentOnly]).filter((k) => k !== r.canonical);
    } else if (type === '死亡') {
      // R8：多字死亡短语仅作片段侧素材
      notes.push('R8：多字死亡短语仅作片段侧素材（禁入改写键）');
      rewriteKeys = [];
      fragmentOnly = dedup([...aliases, ...fragmentOnly]).filter((k) => k !== r.canonical);
    } else if (type === '典故') {
      // R9：两字茎移入 fragmentOnly；苦肉 / 假途 / 反客 / 韬晦 保留
      const moved = rewriteKeys.filter((k) => STEM_TO_FRAGMENT.has(k));
      if (moved.length > 0) {
        notes.push(`R9：两字茎 ${moved.join('、')} 移入 fragmentOnly（独立语义占比核查）`);
        rewriteKeys = rewriteKeys.filter((k) => !STEM_TO_FRAGMENT.has(k));
        fragmentOnly = dedup([...fragmentOnly, ...moved]).filter((k) => k !== r.canonical);
      }
    } else if (type === '数字称谓') {
      // R10：过泛缩略（六出 / 九伐）→ fragmentOnly；五虎将 / 十八镇诸侯 等保留
      const moved = rewriteKeys.filter((k) => NUMBER_PHRASE_TO_FRAGMENT.has(k));
      if (moved.length > 0) {
        notes.push(`R10：${moved.join('、')} 数字称谓过泛不作键（移入 fragmentOnly）`);
        rewriteKeys = rewriteKeys.filter((k) => !NUMBER_PHRASE_TO_FRAGMENT.has(k));
        fragmentOnly = dedup([...fragmentOnly, ...moved]).filter((k) => k !== r.canonical);
      }
    }

    // R11 / R12：身体 / 时间行走起草值（起草即满足 guard good 白名单 / 年份短语口径），仅校验。
    // 身体行 organGuard 审计引用：canonical 命中 ambiguityGuard.semantic 即挂引用（表设计 §5 ③）。
    let organGuard = r.organGuard ?? null;
    if (type === '身体' && !organGuard && guardBySemantic.has(r.canonical)) {
      const g = guardBySemantic.get(r.canonical);
      organGuard = { term: g.term, semantic: g.semantic, total: g.total, hasAmbiguity: g.hasAmbiguity };
    }

    rows.push(
      makeRow({
        type,
        id: null,
        canonical: r.canonical,
        aliases,
        rewriteKeys,
        fragmentOnly,
        organGuard,
        note: notes.join('；'),
      }),
    );
  }

  // ---- R6：同串跨行键（同 term 指向多 canonical）→ 从相关行 rewriteKeys 剔除，不进 fragmentOnly ----
  const keyCount = new Map();
  for (const row of rows) {
    for (const k of dedup(row.rewriteKeys)) keyCount.set(k, (keyCount.get(k) ?? 0) + 1);
  }
  const dupKeys = [...keyCount].filter(([, n]) => n > 1).map(([k]) => k);
  if (dupKeys.length > 0) {
    for (const row of rows) {
      const hit = dedup(row.rewriteKeys).filter((k) => dupKeys.includes(k));
      if (hit.length > 0) {
        row.rewriteKeys = row.rewriteKeys.filter((k) => !dupKeys.includes(k));
        row.note = dedup([row.note, `R6：${hit.join('、')} 同串跨行键（多目标）弃用，不进 fragmentOnly`].filter(Boolean)).join('；');
      }
    }
  }

  // ---- R13：最终全集校验（表设计 §8 加载校验 1–8 的合并轮预检）----
  {
    const byType = new Map();
    for (const row of rows) {
      const seen = byType.get(row.type) ?? new Set();
      verify(!seen.has(row.canonical), `canonical 在 type=${row.type} 内重复：${row.canonical}`, problems);
      seen.add(row.canonical);
      byType.set(row.type, seen);
    }
    for (const row of rows) {
      const aSet = new Set(row.aliases);
      const fSet = new Set(row.fragmentOnly);
      for (const k of row.rewriteKeys) {
        verify(aSet.has(k), `rewriteKeys 项不在 aliases：${row.canonical} => ${k}`, problems);
        verify(!fSet.has(k), `rewriteKeys 与 fragmentOnly 互斥被破坏：${row.canonical} => ${k}`, problems);
        verify(k.length > 1, `rewriteKeys 出现单字键：${row.canonical} => ${k}`, problems);
        verify(!bannedKeySet.has(k), `rewriteKeys 命中终审禁入：${row.canonical} => ${k}`, problems);
      }
      for (const k of row.fragmentOnly) verify(aSet.has(k), `fragmentOnly 项不在 aliases：${row.canonical} => ${k}`, problems);
      if (row.type === '人物') {
        verify(typeof row.id === 'string' && row.id.length > 0, `人物行 id 缺失：${row.canonical}`, problems);
      }
    }
    const allKeys = new Map();
    for (const row of rows) for (const k of row.rewriteKeys) allKeys.set(k, (allKeys.get(k) ?? 0) + 1);
    for (const [k, n] of allKeys) verify(n === 1, `rewriteKeys 跨行重复：${k}（${n} 行）`, problems);
    const ids = new Set();
    for (const row of rows) {
      if (row.type !== '人物') continue;
      verify(!ids.has(row.id), `人物行 id 重复：${row.id}（${row.canonical}）`, problems);
      ids.add(row.id);
    }
    const rkSet = new Set();
    const foSet = new Set();
    for (const row of rows) {
      for (const k of row.rewriteKeys) rkSet.add(k);
      for (const k of row.fragmentOnly) foSet.add(k);
    }
    for (const row of rows) {
      verify(!rkSet.has(row.canonical), `canonical 出现在 rewriteKeys：${row.canonical}`, problems);
      verify(!foSet.has(row.canonical), `canonical 出现在 fragmentOnly：${row.canonical}`, problems);
    }
  }

  // ---- 合并断言样例（表设计 §8 验证方式）----
  {
    const wuguan = rows.find((r) => r.canonical === '过五关斩六将');
    verify(wuguan?.rewriteKeys?.includes('五关斩六将'), '五关斩六将 ∈ 过五关斩六将行 rewriteKeys', problems);
    verify(!rows.some((r) => (r.rewriteKeys ?? []).includes('甘露元年')), '甘露元年 不在任何 rewriteKeys', problems);
    const allAliases = rows.flatMap((r) => r.aliases);
    for (const w of BUG31_CONFLICT_WORDS) verify(!allAliases.includes(w), `bug-00031 冲突词 ${w} 不在任何 aliases`, problems);
    verify(!rows.some((r) => (r.rewriteKeys ?? []).includes('天子')), '天子 不在任何 rewriteKeys', problems);
    const personRows = rows.filter((r) => r.type === '人物');
    verify(new Set(personRows.map((r) => r.id)).size === personRows.length, '人物行 id 无重复', problems);
  }

  if (problems.length > 0) {
    console.error(`[merge] 校验失败（${problems.length} 项）：`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }

  // ---- policy（表设计 §4 / §5：终审禁入 + bug31；ambiguityGuard 原样）----
  const policy = {
    bannedRewriteKeys: dedup([...bannedTerms, ...BUG31_CONFLICT_WORDS]).sort(),
    ambiguityGuard: guards.map((g) => ({
      term: g.term,
      semantic: g.semantic,
      total: g.total,
      bad: g.bad,
      good: g.good,
      hasAmbiguity: g.hasAmbiguity,
    })),
  };

  const meta = {
    schemaVersion: 1,
    normVersion: contentHash(rows),
    generatedAt: new Date().toISOString(),
  };

  const table = { meta, rows, policy };
  writeFileSync(outPath, `${JSON.stringify(table, null, 2)}\n`, 'utf8');

  const personCount = rows.filter((r) => r.type === '人物').length;
  const rkCount = new Set(rows.flatMap((r) => r.rewriteKeys)).size;
  const foCount = rows.reduce((n, r) => n + r.fragmentOnly.length, 0);
  console.log(`[merge] 已写出 ${outPath}`);
  console.log(
    `[merge] rows=${rows.length}（person=${personCount} / nonPerson=${rows.length - personCount}）rewriteKeys=${rkCount} fragmentOnly=${foCount} bannedRewriteKeys=${policy.bannedRewriteKeys.length} normVersion=${meta.normVersion}`,
  );
}

main();
