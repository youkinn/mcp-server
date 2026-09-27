/**
 * 评测集解析（story-A015-02）：解析 SANGO_BENCHMARK_FILE 评测集 md。
 * 结构契约（评测集文件头部）：## 类别 小节 + 表头固定 | # | 问题 | 标准答案 | 证据 | 的表格行；
 * 「十二 / 十三」小节为模板不计题。解析逻辑与 dev-docs CLI（feat-A015-verify.mjs parseBenchmark）
 * 同口径，收敛后 HTTP 接口与 CLI 薄壳共用本模块（feat-A015 契约 §1：判定逻辑只存一份）。
 */
import { readFileSync } from 'node:fs';
import { extractAnchors } from './matcher.ts';

/** 评测集固定类别：小节标题去掉「一、」等编号前缀后必须以此开头才计题（与 CLI CATEGORIES 同口径）。 */
const CATEGORIES = ['人物', '地名', '战役', '典故', '器物', '身体部位', '问法归一', '官职', '数字称谓', '事件关系', '死亡', '拒答'];

/** 回目锚（限定回号 + 回目片段）。 */
export interface TitleAnchor {
  chapter: number;
  title: string;
}

/** 单题：id = 类别#序号，锚由证据列提取。 */
export interface BenchmarkItem {
  id: string;
  category: string;
  num: number;
  question: string;
  answer: string;
  evidence: string;
  textAnchors: string[];
  titleAnchors: TitleAnchor[];
  chapterRefs: number[];
}

/** 解析评测集 md（与 verify.mjs parseBenchmark 逐行同口径；读取失败抛错，由 server 层转 500）。 */
export function parseBenchmark(mdPath: string): BenchmarkItem[] {
  const lines = readFileSync(mdPath, 'utf8').split(/\r?\n/);
  const items: BenchmarkItem[] = [];
  let category = '';
  for (const line of lines) {
    const sec = line.match(/^##\s+(.+)$/);
    if (sec) {
      const catRaw = sec[1].replace(/^[一二三四五六七八九十]+、?\s*/, '').trim();
      const cat = CATEGORIES.find((c) => catRaw.startsWith(c));
      if (cat) category = cat;
      continue;
    }
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').map((c) => c.trim());
    if (!/^\d+$/.test(cells[1])) continue;
    const question = cells[2];
    const answer = cells[3];
    const evidence = cells[cells.length - 2];
    if (!question || !evidence) continue;
    items.push({ id: `${category}#${cells[1]}`, category, num: Number(cells[1]), question, answer, evidence, ...extractAnchors(evidence) });
  }
  return items;
}
