# 语料目录说明（sango/data/corpus）

本目录下有 **两份刻意分离的产物**，格式不同、用途不同，不要混用。

| 目录 | 顶层字段 | 运行期是否使用 | 产出者 | 消费者 |
|------|----------|----------------|--------|--------|
| `sanguo-yanyi/` | `chunks[]` | **是（唯一在用）** | `sango/scripts/build_corpus.py` | `sango/src/search/sango-index.ts`（检索索引）、`sango/scripts/build_vectors.py`（向量） |
| `_segments/sanguo-yanyi/` | `segments[]` | 否（构建期中间产物） | 同上，同一脚本一次产出 | 仅探针：`mcp-orchestrator/scripts/probe/{chunk-sweep,recall-bench,verify-injection-window}.mjs` |

一句话：**服务端实际加载的是 `sanguo-yanyi/`（chunk 级）；`_segments/` 只是切分前的段级快照，给探针复跑切分决策用。**

## sanguo-yanyi/ —— chunk 级（schema v2，运行期）

`001.json` .. `120.json`，每回一个文件，共 2344 chunk。规范见 `dev-docs/docs/sango-corpus-spec.md` §5。

```json
{
  "source": "sanguo-yanyi",
  "chapter": 13,
  "title": "李傕郭汜大交兵 杨奉董承双救驾",
  "chunks": [
    {
      "id": "sanguo-yanyi:0013:c0013",
      "text": "郭汜败了一阵……",
      "type": "narration",
      "segFrom": 8,
      "segTo": 9,
      "quoteBalanced": false,
      "quotes": [
        { "qid": "Q1", "text": "李傕不奉诏，欲弑君自立！", "offset": 60, "speaker": "郦大叫" }
      ]
    }
  ]
}
```

- 检索出参即上表 `chunks[]` 里的字段逐条展开（`id/text/chapter/title/type/segFrom/segTo/quoteBalanced/quotes`），章节元数据随条目携带，跨进程调用方无需读语料目录。**唯一例外**：出参 `quotes[]` 只回 `{ offset, len }`（bug-00010 瘦身，引语文本由 `text` 切片还原），语料文件本身仍是 `{ qid, text, offset, speaker }`——语料与出参 schema 已分叉，见 `docs/sango-corpus-spec.md` §5。
- 参数：TARGET 250 / CAP 400 / 重叠 0 / MIN 100；只在 `。！？；` 切分；同回内连续 narration 可跨段合并，verse·comment 段内独立成 chunk。
- 非本 schema（例如仍是 `segments[]`）会在启动时**直接终止**：`corpus 格式非法（应为 schema v2 的 chunks[]）`。没有旧格式兼容层。

## _segments/sanguo-yanyi/ —— 段级（构建期中间产物）

同回同文件名，但顶层是 `segments[]`，字段只有 `index/type/text`，**不带 `id`，也不带 quotes**。

```json
{
  "source": "sanguo-yanyi",
  "chapter": 13,
  "title": "李傕郭汜大交兵 杨奉董承双救驾",
  "segments": [
    { "index": 12, "type": "narration", "text": "郭汜败了一阵，xxxxx" }
  ]
}
```

保留原因：切分决策的证据（句末标点 / 源段边界 / 是否切在句内）必须在**段级**语料上可复跑，chunk 级无法反推。生产代码不读此目录。

## 重建

```powershell
cd D:\workplace\mcp-server
py -3 sango/scripts/build_corpus.py    # 一次产出上面两份
py -3 sango/scripts/build_vectors.py   # 向量，与 sanguo-yanyi/ 的 chunks[] 同序
```

原文来源：`D:\workplace\dev-docs\docs\三国演义.txt`。改动切分逻辑后必须重跑并复核 `sango-corpus-spec.md` §1 的 I1~I9 判据与 §7 验收读数。
