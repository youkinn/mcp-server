/**
 * 死亡意图识别：把用户问法归并到「人物之死-XXX之死」标签对应的意图子类，
 * 供检索侧对命中死亡标签的 chunk 做强命中置顶（见 SangoIndex.search）。
 *
 * 纯规则实现（正则 + 词表）：三国死亡类问答的语域封闭、问法可枚举，
 * 正则方案零依赖、确定性、可单测；更开放的花样措辞由既有多路召回（BM25/向量）兜底，
 * 此处判定失败不会阻断检索，只退回普通排序。
 */
import type { DeathIntent } from '../types.ts';

/**
 * 意图判定顺序：specific 在前，先命中先返回。
 * 如「被谁|谁手」优先于「怎么…死」，避免「死在谁手里」这类问法被地点规则抢先。
 */
const DEATH_PATTERNS: ReadonlyArray<{ kind: DeathIntent; re: RegExp }> = [
  { kind: 'death_agent', re: /被谁|谁杀|谁斩|谁所杀|死于谁手|死在谁手|何人.*杀/ },
  { kind: 'death_place', re: /死[在哪于]|死于何地|丧命何处|殒命.*[何哪处]/ },
  { kind: 'death_time', re: /何时.*死|什么时候.*死|死.*(在哪年|何年|哪年)/ },
  { kind: 'death_confirm', re: /死了(吗|没有)?[？?]?$|死没死/ },
  { kind: 'death_manner', re: /怎么.*死|如何.*死|死因|死亡原因|因何.*死|为何.*死|是怎么没的|之死$/ },
  { kind: 'death_last_words', re: /临终|死前|死时|遗言|遗诏|遗嘱|遗书|遗表|遗令|托孤|嘱托|交代后事/ },
  { kind: 'death_aftermath', re: /死后|死了之后|结局|后来.*(怎样|如何)|之后.*(继任|接任|怎样)/ },
];

/** 死亡意图大门：必须先含死亡语义词（含凶手类问法的 杀/斩），避免无关语境误触发。 */
const DEATH_GATE = /(死|亡|丧命|殒命|遇害|杀|被杀|斩|结局|遗言|遗诏|遗嘱|遗书|遗表|遗令|托孤|临终|驾崩)/;

/** 判定用户输入是否属于死亡类意图；非死亡问法或无法归并时返回 null（检索侧按普通多路召回处理）。 */
export function matchDeathIntent(raw: string): DeathIntent | null {
  if (!DEATH_GATE.test(raw)) return null;
  for (const { kind, re } of DEATH_PATTERNS) {
    if (re.test(raw)) return kind;
  }
  return null;
}
