#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""sango 离线向量构建脚本（构建期 side-car，线上只读）。

读取 sango/data/corpus/sanguo-yanyi/*.json（段级语料），按段级同序生成
sango/data/vectors/sanguo-yanyi.bin。

.bin 格式（little-endian）：
  [0:4]   magic = b"SNGV"
  [4:8]   dim    uint32
  [8:12]  count  uint32
  [12:16] scheme uint32  0=确定性哈希向量，1=BGE-M3
  [16:]   count * dim 个 float32（行主序，L2 归一化）

优先使用 BGE-M3（先设 HF_ENDPOINT=https://hf-mirror.com 以便下载）；
下载/依赖不可行时降级为确定性哈希向量（保证管线可跑）。

TODO(向量升级)：
- 恢复 BGE-M3 后需保证运行期（TS 侧）能用同一模型对 query 编码
  （如内嵌 onnxruntime 推理或独立向量服务），否则向量语义空间与 query 不一致；
  scheme=1 时 TS 侧会退化为 BM25-only 并在 stderr 告警。
- 底本版权上线前需确认《三国演义.txt》来源可用性（见未解决问题登记）。
"""
import glob
import io
import json
import os
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)  # sango/
CORPUS_DIR = os.path.join(ROOT, "data", "corpus", "sanguo-yanyi")
OUT_DIR = os.path.join(ROOT, "data", "vectors")
OUT_BIN = os.path.join(OUT_DIR, "sanguo-yanyi.bin")

DIM_HASH = 256
FNV_OFFSET = 0x811C9DC5
FNV_PRIME = 0x01000193
SCHEME_HASH = 0
SCHEME_BGE3 = 1


def fnv1a_32(s):
    h = FNV_OFFSET
    for b in s.encode("utf-8"):
        h = ((h ^ b) * FNV_PRIME) & 0xFFFFFFFF
    return h


def tokenize(text):
    """与 TS 侧 tokenize 完全一致：非空白字符的 unigram + bigram。"""
    chars = [c for c in text if not c.isspace()]
    toks = list(chars)
    for i in range(len(chars) - 1):
        toks.append(chars[i] + chars[i + 1])
    return toks


def hash_embed(text, dim):
    """确定性哈希向量（与 TS 侧 embedHash 完全一致），L2 归一化。"""
    vec = [0.0] * dim
    for t in tokenize(text):
        h = fnv1a_32(t)
        idx = (h & 0x7FFFFFFF) % dim
        sign = 1 if (h & 0x80000000) == 0 else -1
        vec[idx] += sign
    norm = sum(v * v for v in vec) ** 0.5
    if norm > 0:
        vec = [v / norm for v in vec]
    return vec


def load_texts():
    files = sorted(glob.glob(os.path.join(CORPUS_DIR, "*.json")))
    texts = []
    for f in files:
        with io.open(f, "r", encoding="utf-8") as fh:
            ch = json.load(fh)
        for seg in ch["segments"]:
            texts.append(seg["text"])
    return texts


def try_bge3(texts):
    """尝试 BGE-M3；返回 (vectors, dim, scheme) 或 (None, 0, SCHEME_HASH)。"""
    os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
    try:
        from sentence_transformers import SentenceTransformer

        model = SentenceTransformer("BAAI/bge-m3")
        vecs = model.encode(texts, normalize_embeddings=True,
                            batch_size=16, show_progress_bar=False)
        return vecs, vecs.shape[1], SCHEME_BGE3
    except Exception as exc:  # noqa: BLE001 - 任何原因都降级
        print("[vectors] BGE-M3 不可用，降级为确定性哈希向量：%s" % exc, file=sys.stderr)
        return None, DIM_HASH, SCHEME_HASH


def write_bin(vecs, dim, scheme):
    os.makedirs(OUT_DIR, exist_ok=True)
    n = len(vecs)
    with open(OUT_BIN, "wb") as fh:
        fh.write(b"SNGV")
        fh.write(struct.pack("<III", dim, n, scheme))
        for v in vecs:
            fh.write(struct.pack("<%df" % dim, *v))
    return n


def main():
    texts = load_texts()
    if not texts:
        print("[vectors] 未读取到语料段，先运行 build_corpus.py", file=sys.stderr)
        return 1
    vecs, dim, scheme = try_bge3(texts)
    if vecs is None:
        vecs = [hash_embed(t, DIM_HASH) for t in texts]
        dim = DIM_HASH
    n = write_bin(vecs, dim, scheme)
    print("vectors written: %d segments x dim=%d scheme=%s -> %s"
          % (n, dim, "bge-m3" if scheme == SCHEME_BGE3 else "hash", OUT_BIN))
    print("order aligned: corpus segment order == vectors row order")
    return 0


if __name__ == "__main__":
    sys.exit(main())
