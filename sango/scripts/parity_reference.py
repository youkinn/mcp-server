#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""A4 自检的离线参照：复刻 scripts/build_vectors.py 的 BGE-M3 口径，输出 query 向量。

用法：py -3 scripts/parity_reference.py <query> [<query> ...]
输出：stdout 为 JSON（UTF-8），形如 {"草船借箭": [0.01, -0.02, ...], ...}

口径与 build_vectors.py 的 try_bge3() 完全一致（不反向改离线口径）：
SentenceTransformer("BAAI/bge-m3") + encode(normalize_embeddings=True)。
"""
import json
import os
import sys

os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")


def main():
    queries = sys.argv[1:]
    if not queries:
        print("[parity] 用法：py -3 scripts/parity_reference.py <query> ...", file=sys.stderr)
        return 1
    from sentence_transformers import SentenceTransformer

    model = SentenceTransformer("BAAI/bge-m3")
    vecs = model.encode(queries, normalize_embeddings=True, batch_size=16,
                        show_progress_bar=False)
    out = {q: [float(x) for x in v] for q, v in zip(queries, vecs)}
    json.dump(out, sys.stdout)
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
