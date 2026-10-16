#!/usr/bin/env python3
# -*- coding: utf-8 -*-
'''sango 语料构建脚本（构建期 side-car，线上只读）。

读取 dev-docs 的《三国演义.txt》（只读），清洗站点杂质与行首缩进，按
dev-docs/docs/sango-corpus-split-scheme.md（切分 v2）切段、装块：

- 段 = 源文件一行；回目行不入段，只作章节元数据（回号 + 回目名）。
- 块 = 段长 ≤ CAP 时整段一块；段长 > CAP 的正文段在段内按句装箱为子块；
  诗词段整段成块、不切（超 CAP 走 §9 白名单豁免）。
- 切点只在句末标点（。！？；，含其后紧跟的收尾引号）之后，且该处引号深度为 0（“” 与 ‘’ 均计入深度）。
- 块不跨段、不跨段混装；子块按序拼接逐字等于父段原文。

构建期自检 I1~I13，任一不变量不满足即构建失败（I12 属注入侧运行时，不在此校验）。

产物：
1. data/corpus/sanguo-yanyi/{001..120}.json —— 运行期读这份。
   文件 { source, chapter, title, chunks[] }；块字段
   { chunk_id, parent_id, seq_in_parent, type, text, char_count, role }，
   成组的块另带 group_id（孤立段不带该键）；role ∈ 主体|引题（§4 引题行，不出检索索引），
   type ∈ 正文|诗词；parent_id = {source}:{回号4位}:p{段号4位}，
   chunk_id = {parent_id}:c{seq_in_parent 2位}。
2. <系统临时目录>/sango-segments-dump/{001..120}.json + INDEX.json —— 段清单（段号、
   类型、role、组、字数、首尾片段），默认不落盘；SANGO_EMIT_SEGMENTS=1 时输出，供人工核对 /
   文档同源使用，运行期不读。

切分参数（split-scheme §3）：TARGET=350 / CAP=600 / 尾块下限 TINY=60。
'''
import io
import json
import math
import os
import re
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)  # sango/
OUT_DIR = os.path.join(ROOT, 'data', 'corpus', 'sanguo-yanyi')
SEG_DUMP_DIR = os.path.join(tempfile.gettempdir(), 'sango-segments-dump')
SEG_DUMP_CHARS = 20  # 段清单里首／尾片段的字数
DEFAULT_SRC = r'D:\workplace\dev-docs\docs\三国演义.txt'

SOURCE = 'sanguo-yanyi'
# §6 上下文组定义表（人工维护的单一真源）：语料 group_id 由本表按段区间 join 得出
GROUP_TABLE = os.path.join(ROOT, 'data', 'corpus', 'context-groups.json')

# ===================== 切分参数（split-scheme §3） =====================
TARGET = 350    # 段内装箱目标：累积 ≥ TARGET 时在最近一个合法切点收口
CAP = 600       # 块硬上限（诗词段与 §9 白名单段除外）
TINY = 60       # 尾块下限：严格 < TINY 且回并前块后仍 ≤ CAP 时回并（恰好等于 TINY 不回并）
TERM = '。！？；'  # 句末标点（唯一切分边界）
CLOSING = '”’』」》】'  # 收尾引号：紧跟句末标点，归前句
QUOTE_OPEN = '“‘'   # 计入引号深度的起始引号
QUOTE_CLOSE = '”’'  # 计入引号深度的收尾引号
QUOTE_ALL = '“‘”’'

TYPE_PROSE = '正文'
TYPE_VERSE = '诗词'

# §4 索引角色：引题行 = 行尾「：」+ 行内无句末标点 + ≤ LEAD_MAX_CHARS 字（照常出块、不出检索索引）
ROLE_MAIN = '主体'
ROLE_LEAD = '引题'
LEAD_MAX_CHARS = 12

CN_DIGITS = {
    '零': 0, '〇': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5,
    '六': 6, '七': 7, '八': 8, '九': 9,
}

HEADER_RE = re.compile(r'^\s*(?:正文\s*)?第([一二三四五六七八九十百零〇两]+)回\s*(.*)$')

# 诗词标记（§4；引号内的标记不计）
VERSE_MARKERS = [
    '诗', '歌', '词', '赋', '吟', '赞', '谣', '偈', '古风', '一绝',
    '联', '祭文', '单道', '正是', '为证', '一首', '八句', '十六字', '口占',
]
# §4 第 3 条「多行韵文续行」的句式判据：不含引号，且满足两种对仗形态之一
VERSE_CONT_MIN_SEMI = 2    # 长句对仗：分号 ≥ 2
VERSE_CONT_MAX_CLAUSE = 9  # 长句对仗：各分句（按 ，。；！？： 切分）≤ 9 字
VERSE_CONT_MIN_CLAUSE = 4  # 短句体：分句 ≥ 4（按 ，。；！？：、 切分，含顿号）
VERSE_CONT_MAX_SHORT = 5   # 短句体：各分句 ≤ 5 字
CLAUSE_SPLIT_RE = re.compile('[，。；！？：]')
CLAUSE_SPLIT_ALL_RE = re.compile('[，。；！？：、]')

# §9 白名单：超 CAP 豁免段 / 源文本自身引号不配平段（段号 = 回内正文行序号，从 1 起）
WL_OVER_CAP = ((69, 3),)
WL_UNBALANCED_QUOTE = ((44, 8), (114, 4), (114, 5))

# §1／§4 读数（与 split-scheme 文档同步维护）：全书段数 2129、引题块 19
EXPECT_SEGMENTS = 2129
EXPECT_LEAD_BLOCKS = 19


def cn2int(s):
    '''中文数字转整数，如 一百二十 -> 120。'''
    total = 0
    section = 0
    num = 0
    for ch in s:
        if ch == '十':
            section += (num or 1) * 10
            num = 0
        elif ch == '百':
            section += num * 100
            num = 0
        elif ch in CN_DIGITS:
            num = CN_DIGITS[ch]
        else:
            return None
    return section + num


def clean_line(line):
    return line.strip(' \u3000\t\r\n')


def depth0_marker(text):
    '''首个诗词标记的下标（引号深度为 0 处）；无则 -1（§4 第 4 条）。'''
    depth = 0
    for i, ch in enumerate(text):
        if ch in QUOTE_OPEN:
            depth += 1
        elif ch in QUOTE_CLOSE:
            if depth > 0:
                depth -= 1
        elif depth == 0:
            for mk in VERSE_MARKERS:
                if text.startswith(mk, i):
                    return i
    return -1


def lead_phrase(text):
    '''段尾引题短语：段末两个句子（最后一个句末标点之前的尾句 + 其后的收尾）。

    引题常写作「…写下八句言语，付与刘璝。其文曰：」两小句，标记落在前一小句；
    更早的叙述句不算（§4 第 5 条：书略曰／表曰／诏曰 这类文书引题的标记不在引题短语内）。
    '''
    cuts = [i for i, ch in enumerate(text) if ch in TERM]
    return text[cuts[-2] + 1:] if len(cuts) >= 2 else text


def is_verse_continuation(text):
    '''§4 第 3 条：多行韵文续行 —— 不含量角引号，且满足两种对仗形态之一：

    ① 长句对仗：≥2 个分号且各分句都 ≤ 9 字（赋／祭文一类的长句对仗）；
    ② 短句体：≥4 个分句且各分句都 ≤ 5 字（四言／五言短句体）。
    '''
    if any(ch in QUOTE_ALL for ch in text):
        return False
    clauses = [c for c in CLAUSE_SPLIT_RE.split(text) if c]
    if (text.count('；') >= VERSE_CONT_MIN_SEMI and clauses
            and max(len(c) for c in clauses) <= VERSE_CONT_MAX_CLAUSE):
        return True
    short = [c for c in CLAUSE_SPLIT_ALL_RE.split(text) if c]
    return (len(short) >= VERSE_CONT_MIN_CLAUSE
            and max(len(c) for c in short) <= VERSE_CONT_MAX_SHORT)


def classify_segments(lines):
    '''行级诗词判定（§4 四条，次序即优先级）；返回与 lines 等长的类型列表。'''
    base = []
    for i, text in enumerate(lines):
        # 1. 独占一行、行首至行尾无正文、带诗词标记的引题
        if text.endswith('：') and not any(c in TERM for c in text) and depth0_marker(text) >= 0:
            base.append(TYPE_VERSE)
            continue
        # 2. 前一自然段以「：」结尾，且其段尾引题短语（段末两句）内含诗词标记
        #    （§4 第 5 条：标记只在引题短语内匹配——「写书曰／表曰／诏曰」这类文书引题，
        #     标记出现在更早的叙述句里，故不入诗）
        prev = lines[i - 1] if i > 0 else None
        if prev is not None and prev.endswith('：') and depth0_marker(lead_phrase(prev)) >= 0:
            base.append(TYPE_VERSE)
            continue
        base.append(TYPE_PROSE)
    # 3. 多行韵文的续行：紧跟上一条诗词段（含续行本身，逐行级联）
    types = list(base)
    for i, text in enumerate(lines):
        if (types[i] == TYPE_PROSE and i > 0 and types[i - 1] == TYPE_VERSE
                and is_verse_continuation(text)):
            types[i] = TYPE_VERSE
    return types


def classify_role(text):
    '''§4 索引角色：引题行 = 行尾「：」+ 行内无句末标点 + ≤ LEAD_MAX_CHARS 字。'''
    if text.endswith('：') and len(text) <= LEAD_MAX_CHARS and not any(c in TERM for c in text):
        return ROLE_LEAD
    return ROLE_MAIN


def body_lines(body):
    '''回内正文行：去除站点杂质行与空行，保留行序（段号 = 本列表序号 = 底本行号）。'''
    lines = []
    for raw in body:
        if '更新时间' in raw:  # 站点杂质行（含 本章字数）
            continue
        line = clean_line(raw)
        if line:
            lines.append(line)
    return lines


def segmentize(lines):
    '''把一回的正文行切成段：一行一段、段号 = 行号；不做任何段级合并（§1）。'''
    types = classify_segments(lines)
    return [{'index': i + 1, 'type': types[i], 'role': classify_role(lines[i]),
             'text': lines[i]} for i in range(len(lines))]


def iter_sentences(text):
    '''按句末标点切句，返回 [(句文本, 句末是否为合法切点)]。

    合法切点 = 句末标点（含其后紧跟的收尾引号）之后引号深度为 0（§2 第 2~3 条）。
    '''
    out = []
    start = 0
    i = 0
    n = len(text)
    depth = 0
    while i < n:
        ch = text[i]
        if ch in QUOTE_OPEN:
            depth += 1
            i += 1
        elif ch in QUOTE_CLOSE:
            if depth > 0:
                depth -= 1
            i += 1
        elif ch in TERM:
            j = i + 1
            while j < n and text[j] in CLOSING:
                if text[j] in QUOTE_CLOSE and depth > 0:
                    depth -= 1
                j += 1
            out.append((text[start:j], depth == 0))
            start = j
            i = j
        else:
            i += 1
    if start < n:
        out.append((text[start:], False))
    return out


def split_segment(text):
    '''§2：段内装箱为子块；返回子块列表（按序拼接逐字等于 text）。'''
    if len(text) <= CAP:
        return [text]
    sents = iter_sentences(text)
    blocks = []
    cur = []  # [(句文本, 句末是否为合法切点)]

    def total():
        return sum(len(s) for s, _ in cur)

    def legal_end():
        acc = 0
        best = 0
        for s, ok in cur:
            acc += len(s)
            if ok:
                best = acc
        return best

    def close_at(cut):
        head = []
        tail = []
        acc = 0
        for s, ok in cur:
            if acc + len(s) <= cut:
                head.append(s)
            else:
                tail.append((s, ok))
            acc += len(s)
        return ''.join(head), tail

    for s, ok in sents:
        while cur and total() + len(s) > CAP:
            cut = legal_end()
            if cut == 0:
                break  # 引号内无处可切：整段引语留在同一块（§9 白名单）
            head, cur = close_at(cut)
            blocks.append(head)
        cur.append((s, ok))
        if total() >= TARGET:
            cut = legal_end()
            if cut == total() and cut > 0:
                head, cur = close_at(cut)
                blocks.append(head)
    if cur:
        blocks.append(''.join(s for s, _ in cur))
    if len(blocks) >= 2 and len(blocks[-1]) < TINY and len(blocks[-2]) + len(blocks[-1]) <= CAP:
        tail_block = blocks.pop()
        blocks[-1] += tail_block
    return blocks


def build_chunks(chapter, group_of):
    '''段 -> 块（块不跨段；诗词段整段一块）；块上写 role 与 group_id（§4／§6）。'''
    chunks = []
    for seg in chapter['segments']:
        parent_id = '%s:%04d:p%04d' % (SOURCE, chapter['chapter'], seg['index'])
        if seg['type'] == TYPE_VERSE:
            blocks = [seg['text']]
        else:
            blocks = split_segment(seg['text'])
        gid = group_of.get((chapter['chapter'], seg['index']))
        for k, b in enumerate(blocks, 1):
            chunk = {
                'chunk_id': '%s:c%02d' % (parent_id, k),
                'parent_id': parent_id,
                'seq_in_parent': k,
                'type': seg['type'],
                'text': b,
                'char_count': len(b),
            }
            if gid:
                chunk['group_id'] = '%s:%s' % (SOURCE, gid)
            chunk['role'] = seg['role']
            chunks.append(chunk)
    return chunks


def build_chapters(text):
    lines = text.splitlines()
    headers = []
    for i, l in enumerate(lines):
        m = HEADER_RE.match(l)
        if m:
            headers.append((i, cn2int(m.group(1)), m.group(2).strip()))
    if len(headers) != 120:
        raise RuntimeError('expected 120 chapters, got %d' % len(headers))
    if [n for _, n, _ in headers] != list(range(1, 121)):
        raise RuntimeError('chapter numbers not 1..120 in order')
    chapters = []
    for k, (start, num, title) in enumerate(headers):
        end = headers[k + 1][0] if k + 1 < len(headers) else len(lines)
        seg_lines = body_lines(lines[start + 1:end])
        chapters.append({
            'source': SOURCE,
            'chapter': num,
            'title': title,
            'lines': seg_lines,
            'segments': segmentize(seg_lines),
        })
    return chapters


def balanced(text):
    '''段内引号配平（不跨段继承）：深度全程非负且收尾归零。'''
    depth = 0
    for ch in text:
        if ch in QUOTE_OPEN:
            depth += 1
        elif ch in QUOTE_CLOSE:
            depth -= 1
            if depth < 0:
                return False
    return depth == 0


def pct(vals, p):
    '''最近秩分位（ceil 取位），与 split-scheme §3 的读数口径一致。'''
    idx = int(math.ceil(p * len(vals))) - 1
    return vals[max(0, min(len(vals) - 1, idx))]


def self_check(chapters, chunks_by_chapter, seg_block_count, group_of):
    '''§7 I1~I13 构建期自检 + 统计输出；返回是否全部通过（I12 属注入侧运行时，不在此校验）。'''
    fails = []
    all_chunks = [c for ch in chapters for c in chunks_by_chapter[ch['chapter']]]
    seg_total = sum(len(ch['segments']) for ch in chapters)
    verse_total = sum(1 for ch in chapters for s in ch['segments'] if s['type'] == TYPE_VERSE)
    prose_total = seg_total - verse_total

    def seg_of(ch, c):
        return ch['segments'][int(c['parent_id'].split(':p')[-1]) - 1]

    def parents_of(ch):
        out = {}
        for c in chunks_by_chapter[ch['chapter']]:
            out.setdefault(c['parent_id'], []).append(c)
        return out

    # I1 拼接一个父段的全部子块 = 父段原文（逐字）
    for ch in chapters:
        by_parent = parents_of(ch)
        for seg in ch['segments']:
            pid = '%s:%04d:p%04d' % (SOURCE, ch['chapter'], seg['index'])
            if ''.join(c['text'] for c in by_parent.get(pid, [])) != seg['text']:
                fails.append('I1 拼接不等于原文 %s' % pid)

    # I2 正文块 ≤ CAP；诗词块整段不切；超 CAP 的块必须命中 §9 白名单
    over_cap = []
    wl_hit_over = 0
    for ch in chapters:
        for c in chunks_by_chapter[ch['chapter']]:
            if c['type'] == TYPE_VERSE and (c['seq_in_parent'] != 1 or c['text'] != seg_of(ch, c)['text']):
                fails.append('I2 诗词段被切 %s' % c['chunk_id'])
            if len(c['text']) > CAP:
                over_cap.append((ch['chapter'], c))
                if (ch['chapter'], int(c['parent_id'].split(':p')[-1])) in WL_OVER_CAP:
                    wl_hit_over += 1
                else:
                    fails.append('I2 超 CAP 未登记白名单 %s len=%d' % (c['chunk_id'], len(c['text'])))

    # I3 切点落在句末标点之后且该处引号深度为 0
    for ch in chapters:
        for pid, cs in parents_of(ch).items():
            if len(cs) < 2:
                continue
            seg = seg_of(ch, cs[0])
            legal = set()
            acc = 0
            for s, ok in iter_sentences(seg['text']):
                acc += len(s)
                if ok:
                    legal.add(acc)
            acc = 0
            for c in cs[:-1]:
                acc += len(c['text'])
                if acc not in legal:
                    fails.append('I3 非法切点 %s off=%d' % (pid, acc))

    # I4 块 ⊆ 父段；子块有序；chunk_id 可由 parent_id + seq_in_parent 回放
    for ch in chapters:
        for pid, cs in parents_of(ch).items():
            seg = seg_of(ch, cs[0])
            off = 0
            for i, c in enumerate(cs):
                if c['seq_in_parent'] != i + 1:
                    fails.append('I4 seq 不连续 %s' % pid)
                if c['chunk_id'] != '%s:c%02d' % (pid, c['seq_in_parent']):
                    fails.append('I4 chunk_id 不可回放 %s' % c['chunk_id'])
                if seg['text'][off:off + len(c['text'])] != c['text']:
                    fails.append('I4 块非父段子串 %s' % c['chunk_id'])
                off += len(c['text'])

    # I5 块内引号配平（段内校验）；例外段见 §9
    wl_hit_quote = 0
    for ch in chapters:
        for c in chunks_by_chapter[ch['chapter']]:
            if balanced(c['text']):
                continue
            if (ch['chapter'], int(c['parent_id'].split(':p')[-1])) in WL_UNBALANCED_QUOTE:
                wl_hit_quote += 1
            else:
                fails.append('I5 引号不配平 %s' % c['chunk_id'])

    # I6 不存在跨段合并 / 跨段混装：每个块只来自单一父段
    for ch in chapters:
        for c in chunks_by_chapter[ch['chapter']]:
            pid = c['parent_id']
            want = '%s:%04d:p%04d' % (SOURCE, ch['chapter'], int(pid.split(':p')[-1]))
            if pid != want:
                fails.append('I6 跨段块 %s' % c['chunk_id'])

    # I7 尾块 < TINY 必须已回并前块，或登记为「并入即超 CAP」的例外
    tiny_tail = []
    for ch in chapters:
        for pid, cs in parents_of(ch).items():
            last = cs[-1]
            if len(last['text']) < TINY and len(cs) > 1:
                if len(cs[-2]['text']) + len(last['text']) <= CAP:
                    fails.append('I7 尾块可回并未回并 %s len=%d' % (last['chunk_id'], len(last['text'])))
                else:
                    tiny_tail.append((ch['chapter'], last['chunk_id'], len(last['text'])))

    # I8 类型只能是 正文／诗词，不出现 comment
    for c in all_chunks:
        if c['type'] not in (TYPE_PROSE, TYPE_VERSE):
            fails.append('I8 非法类型 %s' % c['chunk_id'])

    # I9 段号 = 行号（段文本逐段等于回内正文行，无合并／无丢弃）；段数 = §1 读数
    if seg_total != EXPECT_SEGMENTS:
        fails.append('I9 段数 %d != §1 读数 %d' % (seg_total, EXPECT_SEGMENTS))
    for ch in chapters:
        if len(ch['segments']) != len(ch['lines']):
            fails.append('I9 段数 != 行数（回 %d）' % ch['chapter'])
        for i, seg in enumerate(ch['segments']):
            if seg['index'] != i + 1 or seg['text'] != ch['lines'][i]:
                fails.append('I9 段号/文本与底本行不符（回 %d 段 %d）' % (ch['chapter'], seg['index']))

    # I10 组表自检在 load_groups 内完成（groupId 唯一、区间不重叠、组内连号不跨回）

    # I11 role=引题 块数 = §4 读数（不出检索索引由消费端保证）
    lead_blocks = [c for c in all_chunks if c['role'] == ROLE_LEAD]
    if len(lead_blocks) != EXPECT_LEAD_BLOCKS:
        fails.append('I11 引题块 %d != §4 读数 %d' % (len(lead_blocks), EXPECT_LEAD_BLOCKS))

    # I13 语料 group_id 与组表逐段一致（表中每段都有对应块且带同组 ID，反之亦然）
    for ch in chapters:
        for c in chunks_by_chapter[ch['chapter']]:
            seg_no = int(c['parent_id'].split(':p')[-1])
            want = group_of.get((ch['chapter'], seg_no))
            got = c['group_id'].split(':')[-1] if c.get('group_id') else None
            if got != want:
                fails.append('I13 组不一致 %s：语料 %s / 表 %s' % (c['chunk_id'], got, want))

    # ---------- 统计（§3） ----------
    lens = sorted(len(c['text']) for c in all_chunks)
    split_ids = set(pid for pid, n in seg_block_count.items() if n > 1)
    sub_lens = sorted(len(c['text']) for c in all_chunks
                      if c['parent_id'] in split_ids and len(c['text']) <= CAP)
    split_parents = len(split_ids)
    one_block = seg_total - split_parents
    sub_blocks = sum(seg_block_count[pid] for pid in split_ids)
    sub_tiny60 = sum(1 for c in all_chunks
                     if c['parent_id'] in split_ids and len(c['text']) < 60)
    sub_tiny80 = sum(1 for c in all_chunks
                     if c['parent_id'] in split_ids and len(c['text']) < 80)

    print('=== 构建期自检（split-scheme §6 I1~I8）===')
    print('  I1 子块拼接 = 父段原文（逐字）：%s'
          % ('PASS' if not any(f.startswith('I1') for f in fails) else 'FAIL'))
    print('  I2 正文块 ≤ %d / 诗词不切 / 超 CAP 命中白名单：%s（超 CAP %d 个，白名单命中 %d）'
          % (CAP, 'PASS' if not any(f.startswith('I2') for f in fails) else 'FAIL',
             len(over_cap), wl_hit_over))
    print('  I3 切点在句末标点后且引号深度 0：%s'
          % ('PASS' if not any(f.startswith('I3') for f in fails) else 'FAIL'))
    print('  I4 块 ⊆ 父段／有序／chunk_id 可回放：%s'
          % ('PASS' if not any(f.startswith('I4') for f in fails) else 'FAIL'))
    print('  I5 块内引号配平：%s（白名单命中 %d）'
          % ('PASS' if not any(f.startswith('I5') for f in fails) else 'FAIL', wl_hit_quote))
    print('  I6 无跨段合并／混装：%s'
          % ('PASS' if not any(f.startswith('I6') for f in fails) else 'FAIL'))
    print('  I7 尾块 < %d 已回并或登记例外：%s'
          % (TINY, 'PASS' if not any(f.startswith('I7') for f in fails) else 'FAIL'))
    print('  I8 类型仅 正文／诗词：%s'
          % ('PASS' if not any(f.startswith('I8') for f in fails) else 'FAIL'))
    print('  I9 段号 = 行号／段数 = %d：%s'
          % (EXPECT_SEGMENTS, 'PASS' if not any(f.startswith('I9') for f in fails) else 'FAIL'))
    print('  I10 组表 groupId 唯一／区间不重叠：PASS（load_groups 校验）')
    print('  I11 role=引题 块 %d：%s'
          % (len(lead_blocks), 'PASS' if not any(f.startswith('I11') for f in fails) else 'FAIL'))
    print('  I13 语料 group_id 与组表一致：%s'
          % ('PASS' if not any(f.startswith('I13') for f in fails) else 'FAIL'))
    for f in fails:
        print('  !! %s' % f)

    print('--- 统计（§3）---')
    print('  段数 %d（正文 %d / 诗词 %d）' % (seg_total, prose_total, verse_total))
    print('  块数 %d' % len(all_chunks))
    print('  一段一块 %d（%.1f%%）' % (one_block, one_block * 100.0 / seg_total))
    print('  被切父段 %d｜子块 %d（均 %.2f 块/段）'
          % (split_parents, sub_blocks, float(sub_blocks) / split_parents))
    print('  块长 p50 %d / p90 %d / 均值 %d / max %d'
          % (pct(lens, 0.5), pct(lens, 0.9), sum(lens) // len(lens), lens[-1]))
    if sub_lens:
        print('  子块长 p50 %d / p90 %d（不含超 CAP 白名单块）｜子块 <60：%d；<80：%d'
              % (pct(sub_lens, 0.5), pct(sub_lens, 0.9), sub_tiny60, sub_tiny80))
    print('  全库块长 <60：%d；<80：%d'
          % (sum(1 for l in lens if l < 60), sum(1 for l in lens if l < 80)))
    print('  超 CAP 块：%d（%s）' % (len(over_cap), ', '.join(
        '%d回 %s len=%d' % (ch, c['chunk_id'], len(c['text'])) for ch, c in over_cap) or '-'))
    print('  尾块 <60 例外（并入即超 CAP）：%s' % ('; '.join(
        '%s len=%d' % (cid, ln) for _, cid, ln in tiny_tail) or '-'))
    groups = sorted(set(group_of.values()))
    glens = sorted(sum(len(s['text']) for c in chapters for s in c['segments']
                       if group_of.get((c['chapter'], s['index'])) == g)
                   for g in groups)
    print('  组 %d / 覆盖段 %d（%.1f%%）｜组字数 p50 %d / p90 %d / max %d'
          % (len(groups), len(group_of), len(group_of) * 100.0 / seg_total,
             pct(glens, 0.5), pct(glens, 0.9), glens[-1]))
    print('  引题块（role=引题）%d' % len(lead_blocks))
    return not fails


def load_groups(path):
    '''读 §6 组定义表 -> {(回号, 段号): groupId}；顺带做 I10 校验（唯一／不重叠／连号）。'''
    with io.open(path, encoding='utf-8') as fh:
        rows = json.load(fh)['rows']
    group_of = {}
    seen = set()
    for r in rows:
        gid = r['groupId']
        ch, s, e = r['chapter'], r['segStart'], r['segEnd']
        if gid in seen:
            raise RuntimeError('I10 groupId 重复：%s' % gid)
        seen.add(gid)
        if not (1 <= s <= e):
            raise RuntimeError('I10 组区间非法：%s' % gid)
        for k in range(s, e + 1):
            if (ch, k) in group_of:
                raise RuntimeError('I10 组区间重叠：%s（回 %d 段 %d）' % (gid, ch, k))
            group_of[(ch, k)] = gid
    return group_of


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_SRC
    if not os.path.exists(src):
        print('corpus source not found: %s' % src, file=sys.stderr)
        return 1
    text = open(src, 'rb').read().decode('utf-8-sig')
    chapters = build_chapters(text)

    group_of = load_groups(GROUP_TABLE)
    print('groups loaded: %d groups / %d segments' % (len(set(group_of.values())), len(group_of)))
    chunks_by_chapter = {}
    seg_block_count = {}
    for ch in chapters:
        chunks = build_chunks(ch, group_of)
        for c in chunks:
            seg_block_count[c['parent_id']] = seg_block_count.get(c['parent_id'], 0) + 1
        chunks_by_chapter[ch['chapter']] = chunks

    passed = self_check(chapters, chunks_by_chapter, seg_block_count, group_of)

    os.makedirs(OUT_DIR, exist_ok=True)
    for ch in chapters:
        out = {
            'source': ch['source'],
            'chapter': ch['chapter'],
            'title': ch['title'],
            'chunks': chunks_by_chapter[ch['chapter']],
        }
        with io.open(os.path.join(OUT_DIR, '%03d.json' % ch['chapter']), 'w',
                     encoding='utf-8', newline='') as fh:
            json.dump(out, fh, ensure_ascii=False, indent=1)
            fh.write('\n')

    if os.environ.get('SANGO_EMIT_SEGMENTS'):
        os.makedirs(SEG_DUMP_DIR, exist_ok=True)
        index = []
        for ch in chapters:
            rows = [{
                'index': s['index'],
                'type': s['type'],
                'role': s['role'],
                'group': group_of.get((ch['chapter'], s['index'])),
                'char_count': len(s['text']),
                'head': s['text'][:SEG_DUMP_CHARS],
                'tail': s['text'][-SEG_DUMP_CHARS:],
            } for s in ch['segments']]
            out = {
                'source': ch['source'],
                'chapter': ch['chapter'],
                'title': ch['title'],
                'segments': rows,
            }
            with io.open(os.path.join(SEG_DUMP_DIR, '%03d.json' % ch['chapter']), 'w',
                         encoding='utf-8', newline='') as fh:
                json.dump(out, fh, ensure_ascii=False, indent=1)
                fh.write('\n')
            index.append({
                'chapter': ch['chapter'],
                'title': ch['title'],
                'segments': len(rows),
                'prose': sum(1 for r in rows if r['type'] == TYPE_PROSE),
                'verse': sum(1 for r in rows if r['type'] == TYPE_VERSE),
            })
        total_segments = sum(r['segments'] for r in index)
        with io.open(os.path.join(SEG_DUMP_DIR, 'INDEX.json'), 'w',
                     encoding='utf-8', newline='') as fh:
            json.dump({'source': SOURCE, 'total_segments': total_segments,
                       'chapters': index}, fh, ensure_ascii=False, indent=1)
        print('segments dumped: %d chapters, %d segments -> %s'
              % (len(index), total_segments, SEG_DUMP_DIR))

    total_chunks = sum(len(v) for v in chunks_by_chapter.values())
    print('corpus written: %d chapters, %d chunks -> %s' % (len(chapters), total_chunks, OUT_DIR))

    joined = ''.join(c['text'] for v in chunks_by_chapter.values() for c in v)
    for bad in ('更新时间', '本章字数'):
        if bad in joined:
            print('WARN impurity remains: %s' % bad, file=sys.stderr)
            passed = False
    if not passed:
        print('BUILD FAILED: 构建期自检未通过', file=sys.stderr)
        return 1
    print('BUILD OK')
    return 0


if __name__ == '__main__':
    sys.exit(main())
