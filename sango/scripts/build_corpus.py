#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""sango 语料构建脚本（构建期 side-car，线上只读）。

读取 dev-docs 的《三国演义.txt》（只读），去除站点杂质（更新时间/本章字数行、
行首缩进等），按回切分为段级语料，输出 sango/data/corpus/sanguo-yanyi/001.json .. 120.json。

契约（每回一个 JSON）：
{ "source": "sanguo-yanyi", "chapter": N, "title": "回目",
  "segments": [ { "index": 1.., "type": "narration|verse|comment", "text": "段落" } ] }

清洗边界：只删除站点杂质与行首缩进空白；合并被网页折行拆开的行（内容零增删改）；
不修改任何正文文字。
"""
import io
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)  # sango/
OUT_DIR = os.path.join(ROOT, "data", "corpus", "sanguo-yanyi")
DEFAULT_SRC = r"D:\workplace\dev-docs\docs\三国演义.txt"

CN_DIGITS = {
    "零": 0, "〇": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5,
    "六": 6, "七": 7, "八": 8, "九": 9,
}


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


HEADER_RE = re.compile(r"^\s*(?:正文\s*)?第([一二三四五六七八九十百零〇两]+)回\s*(.*)$")
# 句末字符：以这些结尾的行视为完整段落（不与其后行合并）
SENTENCE_END = set("。！？…”』」》】;；:：")
# 诗词标记（用于把含标记的段标为 verse）
VERSE_MARKERS = [
    "诗曰", "诗云", "诗赞", "有诗", "古风", "调寄", "歌曰", "赞曰",
    "词曰", "赋曰", "诗一首", "后人有诗", "后人诗曰", "诗吟", "诗罢",
]


def clean_line(line):
    return line.strip(" \u3000\t\r\n")


def classify(line, chapter, first_huashuo_seen, prev):
    """返回 narration|verse|comment。"""
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


def segmentize(body, chapter):
    """把一正的文字行切成段级 segments。"""
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
    return segments


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
            "source": "sanguo-yanyi",
            "chapter": num,
            "title": title,
            "segments": segs,
        })
    return chapters


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_SRC
    if not os.path.exists(src):
        print("corpus source not found: %s" % src, file=sys.stderr)
        return 1
    raw = open(src, "rb").read()
    text = raw.decode("utf-8-sig")
    chapters = build_chapters(text)
    os.makedirs(OUT_DIR, exist_ok=True)
    total_segs = 0
    for ch in chapters:
        fname = "%03d.json" % ch["chapter"]
        with io.open(os.path.join(OUT_DIR, fname), "w", encoding="utf-8") as fh:
            json.dump(ch, fh, ensure_ascii=False, indent=1)
        total_segs += len(ch["segments"])
    print("corpus written: %d chapters, %d segments -> %s" % (len(chapters), total_segs, OUT_DIR))
    # 杂质残留自检
    joined = "\n".join(seg["text"] for ch in chapters for seg in ch["segments"])
    for bad in ("更新时间", "本章字数"):
        if bad in joined:
            print("WARN impurity remains: %s" % bad, file=sys.stderr)
    types = {}
    for ch in chapters:
        for seg in ch["segments"]:
            types[seg["type"]] = types.get(seg["type"], 0) + 1
    print("segment types: %s" % types)
    return 0


if __name__ == "__main__":
    sys.exit(main())
