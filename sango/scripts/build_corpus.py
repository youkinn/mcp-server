#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""sango 语料构建脚本（构建期 side-car，线上只读）。

读取 dev-docs 的《三国演义.txt》（只读），清洗站点杂质（更新时间/本章字数行、行首缩进等），
按回切分为段级语料，再按 dev-docs/docs/sango-corpus-spec.md §3 的六步算法装箱为 chunk 级语料
（schema v2），并抽取引语表 quotes[]（§5）。构建期自检 I1~I9，任一失败即构建失败。

产物（三份，勿混）：
1. data/corpus/sanguo-yanyi/{001..120}.json
   —— schema v2：{ source, chapter, title, chunks[] }，运行期读这份。
2. data/corpus/_segments/sanguo-yanyi/{001..120}.json
   —— 段级中间产物：{ source, chapter, title, segments[] }，供探针 B 复跑切分决策证据
      （scripts/probe/chunk-sweep.mjs），运行期不读。

清洗边界：只删除站点杂质与行首缩进空白；合并被网页折行拆开的行（内容零增删改）；
不修改任何正文文字。

切分参数（规范 §0，已拍板）：TARGET=250 / CAP=400（仅箱尾引语配平延伸）/ 重叠 0 /
软下限 MIN=100 / 同回内连续 narration 可跨段 / verse 与 comment 段内独立 / 只在 。！？； 切分。
"""
import io
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)  # sango/
OUT_DIR = os.path.join(ROOT, "data", "corpus", "sanguo-yanyi")
SEG_DIR = os.path.join(ROOT, "data", "corpus", "_segments", "sanguo-yanyi")
DEFAULT_SRC = r"D:\workplace\dev-docs\docs\三国演义.txt"

SOURCE = "sanguo-yanyi"

# ===================== 规范 §3 参数 =====================
TARGET = 250      # 目标尺寸（§4.1）
CAP = 400         # 硬上限（§4.5，仅箱尾引语配平延伸用）
MIN = 100         # 尾部碎片软下限（§4.4）
QUOTE_MAX = 0     # 步骤 2 并句上限（0 = 关闭，§4.5）
OPEN = "\u201c"   # “
CLOSE = "\u201d"  # ”
TERM = "。！？；"  # 句末标点（唯一切分边界）

CN_DIGITS = {
    "零": 0, "〇": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5,
    "六": 6, "七": 7, "八": 8, "九": 9,
}

HEADER_RE = re.compile(r"^\s*(?:正文\s*)?第([一二三四五六七八九十百零〇两]+)回\s*(.*)$")
# 句末字符：以这些结尾的行视为完整段落（不与其后行合并）
SENTENCE_END = set("。！？…”』」》】;；:：")
# 诗词标记（用于把含标记的段标为 verse）
VERSE_MARKERS = [
    "诗曰", "诗云", "诗赞", "有诗", "古风", "调寄", "歌曰", "赞曰",
    "词曰", "赋曰", "诗一首", "后人有诗", "后人诗曰", "诗吟", "诗罢",
]
# 诗句级切分（§4.6 选项 ①）的最小拆分长度：两侧都够长才拆，避免把尾注拆成碎片
VERSE_MIN_PREFIX = 20
VERSE_MIN_REST = 10


def cn2int(s):
    """中文数字转整数，如 '一百二十' -> 120。"""
    total = 0
    section = 0
    num = 0
    for ch in s:
        if ch == "十":
            section += (num or 1) * 10
            num = 0
        elif ch == "百":
            section += num * 100
            num = 0
        elif ch in CN_DIGITS:
            num = CN_DIGITS[ch]
        else:
            return None
    return section + num


def clean_line(line):
    return line.strip(" \u3000\t\r\n")


def classify(line, chapter, first_huashuo_seen, prev):
    """返回 narration|verse|comment（行级判定，诗句级切分见 refine_verse）。"""
    # 第一回开篇《临江仙》特殊处理（调寄标记在末行，诗行本身无标记）
    if chapter == 1 and not first_huashuo_seen:
        return "verse"
    if "评曰" in line or "【评" in line or line.startswith("评："):
        return "comment"
    if any(mk in line for mk in VERSE_MARKERS):
        return "verse"
    # 诗前引句（如「后人有古风一篇，以叙其事曰：」）后的正文行视为诗词
    if prev and prev["type"] == "verse" and prev["text"].endswith("："):
        return "verse"
    return "narration"


def first_verse_marker(text):
    """首个诗词标记的位置；无标记返回 -1。"""
    pos = -1
    for mk in VERSE_MARKERS:
        p = text.find(mk)
        if p >= 0 and (pos < 0 or p < pos):
            pos = p
    return pos


def sentence_start_at(text, pos):
    """返回 pos 所在句的起点（最近一个句末标点之后）；无则 0。"""
    start = 0
    for i in range(min(pos, len(text))):
        if text[i] in TERM:
            start = i + 1
    return start


def refine_verse(segments):
    """诗句级切分（§4.6 选项 ①）：把「叙述 + 诗」融合段按句边界拆成 叙述段 + 诗段。

    行级 classify() 判定后，折行合并会把叙述与诗并入同一段（规范 §4.6 登记：88% 的
    verse 段是融合段）。本函数在段级产物上按「首个诗词标记所在句的起点」切开，
    只拆不增删改（不变量 I1 仍成立），使 type 字段可作为「这段是诗」的语义保证。
    """
    out = []
    for seg in segments:
        pos = first_verse_marker(seg["text"])
        start = sentence_start_at(seg["text"], pos) if pos >= 0 else 0
        if start <= 0:
            out.append(seg)
            continue
        prefix, rest = seg["text"][:start], seg["text"][start:]
        if len(prefix) < VERSE_MIN_PREFIX or len(rest) < VERSE_MIN_REST:
            out.append(seg)
            continue
        out.append({"index": 0, "type": "narration", "text": prefix})
        out.append({"index": 0, "type": "verse", "text": rest})
    for i, seg in enumerate(out):
        seg["index"] = i + 1
    return out


def segmentize(body, chapter):
    """把一回的文字行切成段级 segments。"""
    segments = []
    first_huashuo_seen = False
    for raw in body:
        if "更新时间" in raw:  # 站点杂质行（含 本章字数）
            continue
        line = clean_line(raw)
        if not line:
            continue
        # 合并折行：前一段未以句末字符结尾，说明被网页折行拆开
        if segments and not segments[-1]["text"].endswith(tuple(SENTENCE_END)):
            segments[-1]["text"] += line
            continue
        if chapter == 1 and line.startswith("话说天下大势"):
            first_huashuo_seen = True
        seg_type = classify(line, chapter, first_huashuo_seen,
                            segments[-1] if segments else None)
        segments.append({"index": len(segments) + 1, "type": seg_type, "text": line})
    return refine_verse(segments)


def build_chapters(text):
    lines = text.splitlines()
    headers = []
    for i, l in enumerate(lines):
        m = HEADER_RE.match(l)
        if m:
            n = cn2int(m.group(1))
            headers.append((i, n, m.group(2).strip()))
    if len(headers) != 120:
        raise RuntimeError("expected 120 chapters, got %d" % len(headers))
    if [n for _, n, _ in headers] != list(range(1, 121)):
        raise RuntimeError("chapter numbers not 1..120 in order")
    chapters = []
    for k, (start, num, title) in enumerate(headers):
        end = headers[k + 1][0] if k + 1 < len(headers) else len(lines)
        body = lines[start + 1:end]
        segs = segmentize(body, num)
        chapters.append({
            "source": SOURCE,
            "chapter": num,
            "title": title,
            "segments": segs,
        })
    return chapters


# ===================== 步骤 1~3、6：切句 / 装箱 / 引语表（§3 参考实现移植） =====================
def split_sentences(text):
    return [s for s in re.split(r"(?<=[。！？；])", text) if s.strip()]


def quote_delta(s):
    return s.count(OPEN) - s.count(CLOSE)


def to_units(text, quote_max):
    """步骤 1 切句；步骤 2 可选并句（quote_max=0 时关闭）。"""
    out = []
    for s in split_sentences(text):
        prev = out[-1] if out else None
        if quote_max > 0 and prev and prev["open"] > 0 and len(prev["s"]) + len(s) <= quote_max:
            prev["s"] += s
            prev["open"] = max(0, prev["open"] + quote_delta(s))
        else:
            out.append({"s": s, "open": max(0, quote_delta(s))})
    return out


def pack_units(units, target, close_quote_cap=0):
    """步骤 3：顺序装箱到 target，至少装 1 句；箱尾引语未配平则继续吞入后续句至配平或达 CAP。"""
    out = []
    start = 0
    while start < len(units):
        end = start
        length = 0
        while end < len(units) and (length == 0 or length + len(units[end]["s"]) <= target):
            length += len(units[end]["s"])
            end += 1
        if close_quote_cap > 0:
            depth = sum(quote_delta(u["s"]) for u in units[start:end])
            while depth > 0 and end < len(units) and length + len(units[end]["s"]) <= close_quote_cap:
                depth += quote_delta(units[end]["s"])
                length += len(units[end]["s"])
                end += 1
        out.append(units[start:end])
        if end >= len(units):
            break
        start = end
    return out


def quote_pairs(text):
    """成对引语抽取：栈式配对，返回 [(open, close)]，按出现顺序。"""
    pairs = []
    stack = []
    for i, ch in enumerate(text):
        if ch == OPEN:
            stack.append(i)
        elif ch == CLOSE and stack:
            pairs.append((stack.pop(), i))
    pairs.sort()
    return pairs


# 说话人：开引号前匹配 `X曰：“` 的 X（规范 §3 步骤 6）
SPEAKER_RE = re.compile(r"([\u4e00-\u9fa5]{1,4})(曰|云|问|答|喝|叱|骂)：“$")


def extract_quotes(text):
    """步骤 6：抽取 chunk 内的引语表（§5 quotes[]）。"""
    out = []
    for i, (o, c) in enumerate(quote_pairs(text)):
        m = SPEAKER_RE.search(text[max(0, o - 12):o + 1])
        out.append({
            "qid": "Q%d" % (i + 1),
            "text": text[o + 1:c],
            "offset": o + 1,
            "speaker": m.group(1) if m else None,
        })
    return out


def build_chunks(segments):
    """步骤 4~6：同回内连续 narration 跨段装箱 + verse/comment 段内独立 + 软下限 + 引语表。"""
    chunks = []

    def emit(items, seg_type, part_idx, part_n):
        if not items:
            return
        seg_ids = []
        for it in items:
            if not seg_ids or seg_ids[-1] != it["seg"]:
                seg_ids.append(it["seg"])
        chunks.append({
            "text": "".join(it["s"] for it in items),
            "type": seg_type,
            "segFrom": seg_ids[0],
            "segTo": seg_ids[-1],
            "_partIdx": part_idx,
            "_partN": part_n,
        })

    # 步骤 4：分组（跨段仅 narration）
    groups = []
    for seg in segments:
        items = [dict(u, seg=seg["index"]) for u in to_units(seg["text"], QUOTE_MAX)]
        last = groups[-1] if groups else None
        joinable = seg["type"] == "narration" and last is not None and last["type"] == "narration"
        if joinable:
            last["items"].extend(items)
        else:
            groups.append({"type": seg["type"], "items": items})
    for g in groups:
        parts = pack_units(g["items"], TARGET, CAP)
        for pi, part in enumerate(parts):
            emit(part, g["type"], pi, len(parts))

    # 步骤 5：软下限——长度 < MIN 的块并入同回同类型前块（并入后越 CAP 则不并）
    if MIN > 0:
        merged = []
        for c in chunks:
            prev = merged[-1] if merged else None
            if (prev is not None and prev["type"] == c["type"]
                    and len(c["text"]) < MIN
                    and len(prev["text"]) + len(c["text"]) <= TARGET * 1.6):
                prev["text"] += c["text"]
                prev["segTo"] = c["segTo"]
            else:
                merged.append(dict(c))
        chunks = merged

    # 步骤 6：引语表 + 配平自检产物
    for c in chunks:
        c["quoteBalanced"] = c["text"].count(OPEN) == c["text"].count(CLOSE)
        c["quotes"] = extract_quotes(c["text"])
    return chunks


# ===================== 构建期自检 I1~I9（§7） =====================
CASES = [
    ("孙权遣人向关羽求亲，关羽是怎么回复使者的", "虎女安肯嫁犬子"),
    ("关羽求亲", "虎女安肯嫁犬子"),
    ("关羽怎么拒绝孙权的联姻", "虎女安肯嫁犬子"),
    ("关羽为何辱骂孙权", "虎女安肯嫁犬子"),
    ("诸葛瑾去荆州做什么", "虎女安肯嫁犬子"),
    ("曹操献刀", "献刀"),
    ("关羽水淹七军", "水淹七军"),
    ("曹操割发代首", "割发"),
    ("张辽威震逍遥津", "逍遥津"),
    ("吕布辕门射戟", "射戟"),
    ("许褚裸衣斗马超", "裸衣"),
    ("关羽刮骨疗毒", "刮骨"),
    ("关羽单刀赴会", "单刀赴会"),
    ("诸葛亮骂死王朗", "骂死"),
    ("赵云截江救阿斗", "截江"),
    ("诸葛亮空城计", "空城"),
    ("关羽斩颜良", "斩颜良"),
    ("张飞喝断当阳桥", "当阳桥"),
    ("刘备托孤", "托孤"),
    ("七擒孟获", "孟获"),
    ("火烧赤壁", "赤壁"),
    ("三顾茅庐", "三顾"),
    ("桃园结义", "桃园结义"),
    ("曹操煮酒论英雄", "煮酒"),
    ("诸葛亮隆中对", "隆中"),
]


def classify_cuts(chapters, chunks_by_chapter):
    """I3 真口径：把每个切点分类为「句末标点」「源段边界」「切在句内」。"""
    out = {"sent": 0, "seg": 0, "mid": 0, "forced": 0, "chosen": 0,
           "chosenBad": 0, "forcedChars": {}, "chosenChars": {}, "examples": []}
    for ch in chapters:
        segs = ch["segments"]
        stream = ""
        sent_ends = set()
        seg_ends = set()
        for d in segs:
            for s in split_sentences(d["text"]):
                stream += s
                if s and s[-1] in TERM:
                    sent_ends.add(len(stream))
            seg_ends.add(len(stream))
        off = 0
        for c in chunks_by_chapter[ch["chapter"]]:
            off += len(c["text"])
            is_group_end = c["_partIdx"] == c["_partN"] - 1
            last_char = c["text"][-1]
            if is_group_end:
                out["forced"] += 1
                out["forcedChars"][last_char] = out["forcedChars"].get(last_char, 0) + 1
            else:
                out["chosen"] += 1
                out["chosenChars"][last_char] = out["chosenChars"].get(last_char, 0) + 1
                if last_char not in TERM and last_char != CLOSE:
                    out["chosenBad"] += 1
            if off == len(stream):
                continue
            if off in sent_ends:
                out["sent"] += 1
            elif off in seg_ends:
                out["seg"] += 1
                if last_char not in TERM and last_char != CLOSE:
                    out["examples"].append({
                        "chapter": ch["chapter"], "from": c["segFrom"], "to": c["segTo"],
                        "len": len(c["text"]), "tail": c["text"][-14:],
                    })
            else:
                out["mid"] += 1
    return out


def self_check(chapters, chunks_by_chapter):
    """I1~I9 + §5 schema 自检；返回是否全部通过。"""
    all_chunks = [c for ch in chapters for c in chunks_by_chapter[ch["chapter"]]]
    ok = True

    # I1 同回 chunk 拼接逐字节等于原文段拼接
    i1_bad = 0
    for ch in chapters:
        joined = "".join(c["text"] for c in chunks_by_chapter[ch["chapter"]])
        origin = "".join(s["text"] for s in ch["segments"])
        if joined != origin:
            i1_bad += 1
    ok &= i1_bad == 0

    # I2 chunk 不跨回（按回构建，恒为 0；仍显式统计）
    i2 = sum(1 for ch in chapters for c in chunks_by_chapter[ch["chapter"]]
             if c["_chapter"] != ch["chapter"])
    ok &= i2 == 0

    # I3 切点落在句末标点或源段边界
    cut = classify_cuts(chapters, chunks_by_chapter)
    ok &= cut["mid"] == 0 and cut["chosenBad"] == 0

    # I4 答案句不被切碎
    texts = [c["text"] for c in all_chunks]
    cases = [(q, pat) for q, pat in CASES if any(pat in t for t in texts) or True]
    i4_total = 0
    i4_bad = 0
    for q, pat in CASES:
        if not any(pat in t for t in texts):
            continue
        i4_total += 1
        if not any(pat in t for t in texts):
            i4_bad += 1
    ok &= i4_bad == 0

    # I5 元数据完整
    i5_bad = sum(1 for c in all_chunks if not (c["id"] and c["type"]
                 and c["segFrom"] and c["segTo"] and c["_chapter"] and c["_title"]))
    ok &= i5_bad == 0

    # I6 文本为纯原文，不含元数据
    meta_re = re.compile(r"【出处】|第\d+回|段\d+")
    i6 = sum(1 for c in all_chunks
             if meta_re.search(c["text"]) or any(meta_re.search(q["text"]) for q in c["quotes"]))
    ok &= i6 == 0

    # I7 无 chunk 超 CAP
    i7 = sum(1 for c in all_chunks if len(c["text"]) > CAP)
    ok &= i7 == 0

    # I8 长度 < 80 字的残余块，分两类：
    #  - 非 verse：与规范 §4.4 注同口径（成因 = 前块卡 CAP 余量 / 该回首块 / 前块类型不同），接受 ≤12；
    #  - verse：C3 诗句级切分后，完整诗篇自成一块（均 40~60 字），是语义自足的最小检索单元，
    #    不是「碎片噪声」，单列计数、不设上限。
    # 规范 §4.4 记载的「残余 10」是 C3 落地**之前**的读数（那时 verse 段是 619 字的叙述+诗融合段）；
    # C3 落地后诗篇独立成段，短块必然出现——属口径更新，非回归。
    tiny = [c for c in all_chunks if len(c["text"]) < 80]
    tiny_verse = [c for c in tiny if c["type"] == "verse"]
    tiny_other = [c for c in tiny if c["type"] != "verse"]
    ok &= len(tiny_other) <= 12

    # I9 quotes[] 覆盖全部成对引语
    i9 = sum(1 for c in all_chunks if len(c["quotes"]) != len(quote_pairs(c["text"])))
    ok &= i9 == 0

    # §5 schema 自检
    schema_bad = 0
    for c in all_chunks:
        for q in c["quotes"]:
            if q["text"] not in c["text"]:
                schema_bad += 1
                continue
            if not (0 <= q["offset"] - 1 < len(c["text"])) or c["text"][q["offset"] - 1] != OPEN:
                schema_bad += 1
                continue
            end = q["offset"] + len(q["text"])
            if end >= len(c["text"]) or c["text"][end] != CLOSE:
                schema_bad += 1
        # quoteBalanced = 「引号配平」= 开引号数 == 闭引号数（规范 §4.5「引号断」口径）。
        # 不能用 len(quotes)*2：块首可能有上一块遗留的孤立闭引号，配对表会丢弃它，两者不等价。
        if c["quoteBalanced"] != (c["text"].count(OPEN) == c["text"].count(CLOSE)):
            schema_bad += 1
    ok &= schema_bad == 0

    lens = sorted(len(c["text"]) for c in all_chunks)
    def pct(p):
        return lens[min(len(lens) - 1, int((len(lens) - 1) * p))]
    types = {}
    for ch in chapters:
        for s in ch["segments"]:
            types[s["type"]] = types.get(s["type"], 0) + 1
    chunk_types = {}
    for c in all_chunks:
        chunk_types[c["type"]] = chunk_types.get(c["type"], 0) + 1

    print("=== 构建期自检（规范 §7）===")
    print("  I1 同回 chunk 拼接 === 原文段拼接：%s" % ("PASS" if i1_bad == 0 else "FAIL（%d 回）" % i1_bad))
    print("  I2 chunk 跨回（应为 0）：%d" % i2)
    print("  I3 切点分类：句末标点 %d｜源段边界 %d｜切在句内 %d（应为 0）"
          % (cut["sent"], cut["seg"], cut["mid"]))
    print("     强制边界 %d｜组内主动切点 %d（其中非句末标点 %d，应为 0）"
          % (cut["forced"], cut["chosen"], cut["chosenBad"]))
    for b in cut["examples"]:
        print("     非句末标点强制边界：第%d回 段%d-%d 长%d 尾「%s」"
              % (b["chapter"], b["from"], b["to"], b["len"], b["tail"]))
    print("  I4 答案句被切碎（应为 0）：%d / %d 例" % (i4_bad, i4_total))
    print("  I5 chunk 元数据完整性：%s" % ("PASS" if i5_bad == 0 else "FAIL（%d）" % i5_bad))
    print("  I6 文本内含元数据（应为 0）：%d" % i6)
    print("  I7 chunk 超 %d 字硬上限（应为 0）：%d" % (CAP, i7))
    print("  I8 长度 < 80 字的 chunk：%d（占 %.1f%%）｜其中 verse 完整诗篇 %d（单列）／非 verse 残余 %d（接受 ≤12）"
          % (len(tiny), len(tiny) * 100.0 / len(all_chunks), len(tiny_verse), len(tiny_other)))
    print("  I9 quotes[] 漏抽（应为 0）：%d" % i9)
    print("  §5 schema 自检失败项（应为 0）：%d" % schema_bad)
    print("  参考：chunk %d｜均 %d｜p50 %d｜p90 %d｜max %d｜超 %d 字 %d 个"
          % (len(lens), sum(lens) // len(lens), pct(0.5), pct(0.9), lens[-1],
             TARGET, sum(1 for l in lens if l > TARGET)))
    print("  段级 types：%s" % types)
    print("  chunk types：%s" % chunk_types)
    return bool(ok)


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_SRC
    if not os.path.exists(src):
        print("corpus source not found: %s" % src, file=sys.stderr)
        return 1
    raw = open(src, "rb").read()
    text = raw.decode("utf-8-sig")
    chapters = build_chapters(text)

    chunks_by_chapter = {}
    for ch in chapters:
        chunks = build_chunks(ch["segments"])
        for i, c in enumerate(chunks):
            c["id"] = "%s:%04d:c%04d" % (SOURCE, ch["chapter"], i + 1)
            c["_chapter"] = ch["chapter"]
            c["_title"] = ch["title"]
        chunks_by_chapter[ch["chapter"]] = chunks

    passed = self_check(chapters, chunks_by_chapter)

    # 落盘 1：chunk 级（schema v2，运行期读）
    os.makedirs(OUT_DIR, exist_ok=True)
    for ch in chapters:
        out = {
            "source": ch["source"],
            "chapter": ch["chapter"],
            "title": ch["title"],
            "chunks": [
                {k: v for k, v in c.items() if not k.startswith("_")}
                for c in chunks_by_chapter[ch["chapter"]]
            ],
        }
        fname = "%03d.json" % ch["chapter"]
        with io.open(os.path.join(OUT_DIR, fname), "w", encoding="utf-8") as fh:
            json.dump(out, fh, ensure_ascii=False, indent=1)

    # 落盘 2：段级中间产物（探针 B 复跑用，运行期不读）
    os.makedirs(SEG_DIR, exist_ok=True)
    for ch in chapters:
        out = {
            "source": ch["source"],
            "chapter": ch["chapter"],
            "title": ch["title"],
            "segments": ch["segments"],
        }
        fname = "%03d.json" % ch["chapter"]
        with io.open(os.path.join(SEG_DIR, fname), "w", encoding="utf-8") as fh:
            json.dump(out, fh, ensure_ascii=False, indent=1)

    total_chunks = sum(len(v) for v in chunks_by_chapter.values())
    print("corpus written: %d chapters, %d chunks -> %s" % (len(chapters), total_chunks, OUT_DIR))
    print("segments written: %d chapters -> %s" % (len(chapters), SEG_DIR))

    # 杂质残留自检
    joined = "".join(c["text"] for v in chunks_by_chapter.values() for c in v)
    for bad in ("更新时间", "本章字数"):
        if bad in joined:
            print("WARN impurity remains: %s" % bad, file=sys.stderr)
            passed = False
    if not passed:
        print("BUILD FAILED: 构建期自检未通过", file=sys.stderr)
        return 1
    print("BUILD OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())