/**
 * bug-00052 活文档：回目锚比较口径归一化（matcher.matchEvidence 与 runner.findNoAnchorItems 同一 norm）。
 * 背景：extractAnchors 产出的 titleAnchors.title 保留原文，回目带中文标点（如「陆逊营烧七百里，孔明巧布八阵图」）
 * 时与归一化回目比对恒失配；修复 = 比较口径统一 norm，提取结果仍保留原文（供页面展示）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { extractAnchors, matchEvidence } from '../../benchmark/matcher.ts';
import { findNoAnchorItems } from '../../benchmark/runner.ts';
import type { BenchmarkItem } from '../../benchmark/parser.ts';
import { SangoIndex } from '../../search/sango-index.ts';
import type { SearchEntry } from '../../types.ts';

/** 构造最小 SearchEntry（正文不含回目锚短语，隔离出回目标题比较路径）。 */
function mkEntry(id: string, chapter: number, title: string, text: string): SearchEntry {
  return { id, chapter, title, text, type: 'narration', segFrom: 1, segTo: 1 };
}

test('① bug-00052 回目锚含中文逗号：matchEvidence 经 norm 仍命中对应回目（限定回号）', () => {
  const { titleAnchors, textAnchors } = extractAnchors('第84回目：“陆逊营烧七百里，孔明巧布八阵图”');
  assert.equal(titleAnchors[0].chapter, 84, '回目锚限定回号提取正确');
  assert.equal(titleAnchors[0].title, '陆逊营烧七百里，孔明巧布八阵图', '提取保留原文含中文逗号，归一化发生在比较口径');
  const entries = [
    mkEntry('sanguo-yanyi:0001:c0001', 1, '第一回 无关回目', '此处为无关正文。'),
    mkEntry('sanguo-yanyi:0084:c0001', 84, '第八十四回 陆逊营烧七百里，孔明巧布八阵图', '此处为无关正文。'),
  ];
  const m = matchEvidence(entries, textAnchors, titleAnchors);
  assert.equal(m.rank, 2, '命中第 84 回条目（限定回号）');
  assert.equal(m.hit?.chapter, 84, '命中回号正确');
});

test('② bug-00052 回目锚含中文逗号：findNoAnchorItems 与 matchEvidence 同一 norm 口径，锚可定位、不误标 noAnchor', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'a015-matcher-'));
  try {
    const corpusDir = path.join(dir, 'corpus', 'sanguo-yanyi');
    mkdirSync(corpusDir, { recursive: true });
    writeFileSync(
      path.join(corpusDir, '084.json'),
      JSON.stringify({
        source: 'sanguo-yanyi',
        chapter: 84,
        title: '第八十四回 陆逊营烧七百里，孔明巧布八阵图',
        chunks: [{ id: 'sanguo-yanyi:0084:c0001', text: '此处为无关正文。', type: 'narration', segFrom: 1, segTo: 1 }],
      }),
      'utf8',
    );
    const index = new SangoIndex(dir);
    index.load();
    const { titleAnchors } = extractAnchors('第84回目：“陆逊营烧七百里，孔明巧布八阵图”');
    // 仅保留回目锚、清空正文锚：正文锚会经「短语回退匹配任意回目」兜住，无法单独验证回目锚归一化路径。
    const item: BenchmarkItem = {
      id: '战役#1',
      category: '战役',
      num: 1,
      question: '彝陵之战战场在哪',
      answer: '猇亭',
      evidence: '第84回目：“陆逊营烧七百里，孔明巧布八阵图”',
      textAnchors: [],
      titleAnchors,
      chapterRefs: [84],
    };
    assert.deepEqual(findNoAnchorItems(index, [item]), [], '回目锚归一化后可定位 → 不入 noAnchor 列表');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('③ bug-00059 正文锚先在无关回候选命中被限回跳过，最终命中证据回内候选（rank 正确）', () => {
  const entries = [
    mkEntry('sanguo-yanyi:0029:c0001', 29, '第二十九回 无关回目', '毒已入骨，不可救也。'),
    mkEntry('sanguo-yanyi:0075:c0001', 75, '第七十五回 真证据回', '毒已入骨。'),
  ];
  const m = matchEvidence(entries, ['毒已入骨'], [], [75]);
  assert.equal(m.rank, 2, '跳过第 29 回无关回，命中第 75 回证据回候选');
  assert.equal(m.hit?.chapter, 75, '命中回号为证据回');
});

test('④ bug-00059 证据回内无含锚候选 → rank 0（不跨回命中无关回）', () => {
  const entries = [
    mkEntry('sanguo-yanyi:0029:c0001', 29, '第二十九回 无关回目', '毒已入骨。'),
    mkEntry('sanguo-yanyi:0075:c0001', 75, '第七十五回 证据回', '此处未含该锚。'),
  ];
  const m = matchEvidence(entries, ['毒已入骨'], [], [75]);
  assert.equal(m.rank, 0, '证据回内无含锚候选，且不回落到无关回');
  assert.equal(m.hit, null);
});

test('⑤ bug-00059 chapterRefs 为空 → 不限回，维持原行为（可跨回命中）', () => {
  const entries = [
    mkEntry('sanguo-yanyi:0029:c0001', 29, '第二十九回 无关回目', '毒已入骨，不可救也。'),
    mkEntry('sanguo-yanyi:0075:c0001', 75, '第七十五回 真证据回', '毒已入骨。'),
  ];
  const m = matchEvidence(entries, ['毒已入骨'], [], []);
  assert.equal(m.rank, 1, 'chapterRefs 为空时按 rank 序首个含锚候选即命中');
  assert.equal(m.hit?.chapter, 29);
});

test('⑥ bug-00059 传 chapterRefs 后回目锚（步骤②）仍正常命中（不回归）', () => {
  const { titleAnchors, textAnchors, chapterRefs } = extractAnchors('第84回目：“陆逊营烧七百里，孔明巧布八阵图”');
  const entries = [
    mkEntry('sanguo-yanyi:0001:c0001', 1, '第一回 无关回目', '此处为无关正文。'),
    mkEntry('sanguo-yanyi:0084:c0001', 84, '第八十四回 陆逊营烧七百里，孔明巧布八阵图', '此处为无关正文。'),
  ];
  const m = matchEvidence(entries, textAnchors, titleAnchors, chapterRefs);
  assert.equal(m.rank, 2, '回目锚（步骤②）在传 chapterRefs 后仍命中限定回号条目');
  assert.equal(m.hit?.chapter, 84);
});
