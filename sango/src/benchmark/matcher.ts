/**
 * 证据锚匹配（story-A015-02）：中文标点归一化 + 引号原文锚提取 + 检索结果内锚定位。
 * 判定口径与 dev-docs CLI（feat-A015-verify.mjs）逐条同源——判定逻辑只存一份（feat-A015 契约 §1），
 * 本模块即收敛后的唯一实现，禁止再另起炉灶。
 */
import type { SearchEntry } from '../types.ts';

/** 中文标点归一化：去标点/空白，用于抗引文标点差异（与 verify.mjs norm 逐字符同口径）。 */
export function norm(text: string): string {
  return text.replace(/[，。、；：？！“”‘’（）《》〈〉…\s,.;:?!()'"\-—~·]/g, '');
}

/** 回目锚：限定回号 + 回目片段。 */
export interface TitleAnchor {
  chapter: number;
  title: string;
}

/**
 * 提取证据锚：正文锚（引号内原文，去括注；再按句读切出 ≥4 字短语作长锚失配回退）、
 * 回目锚（第N回目：“…”格式，限定回号）、回号引用。正文锚归一化后去重；回目锚按 回号|标题 去重。
 * 与 verify.mjs extractAnchors 逐条同口径。
 */
export function extractAnchors(
  evidence: string,
): { textAnchors: string[]; titleAnchors: TitleAnchor[]; chapterRefs: number[] } {
  const textAnchors: string[] = [];
  const titleAnchors: TitleAnchor[] = [];
  const chapterRefs: number[] = [];
  for (const m of evidence.matchAll(/第(\d+)回目?\s*[：:]/g)) chapterRefs.push(Number(m[1]));
  for (const m of evidence.matchAll(/“([^”]+)”/g)) {
    for (const seg of m[1].split(/…|\.\.\./)) {
      const cleaned = seg.replace(/（[^）]*）/g, '').trim();
      if (cleaned.length >= 2) textAnchors.push(cleaned);
      // 句读拆分短语：长锚失配时可回退短语（≥4 字）
      for (const phrase of cleaned.split(/[，。；、？！]/)) {
        const ph = phrase.trim();
        if (ph.length >= 4) textAnchors.push(ph);
      }
    }
  }
  for (const m of evidence.matchAll(/第(\d+)回目\s*[：:]\s*“([^”]+)”/g)) {
    titleAnchors.push({ chapter: Number(m[1]), title: m[2].trim() });
  }
  return {
    textAnchors: [...new Set(textAnchors.map(norm))].filter(Boolean),
    titleAnchors: [...new Set(titleAnchors.map((a) => `${a.chapter}|${a.title}`))].map((s) => {
      const [c, ...rest] = s.split('|');
      return { chapter: Number(c), title: rest.join('|') };
    }),
    chapterRefs: [...new Set(chapterRefs)],
  };
}

/** 证据锚判定结果：rank = 命中排名（1 起）；0 = 未命中/未召回。 */
export interface EvidenceMatch {
  rank: number;
  hit: SearchEntry | null;
}

/**
 * 在检索结果内定位证据段：① 正文匹配（归一化后子串）→ ② 回目锚匹配（限定回号优先）→
 * ③ 仅当无回目锚时，正文锚（≥4 字）回退匹配任意回目。与 verify.mjs 判定循环逐条同口径。
 */
export function matchEvidence(entries: SearchEntry[], textAnchors: string[], titleAnchors: TitleAnchor[]): EvidenceMatch {
  // 1) 正文匹配（归一化后子串优先）
  for (let i = 0; i < entries.length; i++) {
    const nt = norm(entries[i].text);
    for (const a of textAnchors) {
      if (nt.includes(a)) return { rank: i + 1, hit: entries[i] };
    }
  }
  // 2) 回目标题匹配：显式回目锚（限定回号）优先；仅当无回目锚时正文锚（≥4 字）回退匹配任意回目
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const nTitle = norm(e.title);
    let matched = false;
    for (const ta of titleAnchors) {
      if (e.chapter === ta.chapter && nTitle.includes(ta.title)) {
        matched = true;
        break;
      }
    }
    if (!matched && titleAnchors.length === 0) {
      for (const a of textAnchors) {
        if (a.length >= 4 && nTitle.includes(a)) {
          matched = true;
          break;
        }
      }
    }
    if (matched) return { rank: i + 1, hit: e };
  }
  return { rank: 0, hit: null };
}
