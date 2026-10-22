# 语料目录说明（sango/data/corpus）

本目录下 `sanguo-yanyi/` 是**运行期语料**（唯一被服务端加载的语料），其余（`tags/`、`allusions.json`、`events.json`、`context-groups.json`、`segments.md`、`tags-prompt.md`）为派生数据、生成资料或人工维护的表，各自契约见对应文档（如 `dev-docs/docs/sango-tag-system.md`）。

| 目录 | 顶层字段 | 运行期是否使用 | 产出者 | 消费者 |
|------|----------|----------------|--------|--------|
| `sanguo-yanyi/` | `chunks[]` | **是（唯一在用）** | `sango/scripts/build_corpus.py` | `sango/src/search/sango-index.ts`（检索索引）、`sango/scripts/build_vectors.py`（向量） |

## sanguo-yanyi/ —— 段/块结构（切分 v2，运行期）

`001.json` .. `120.json`，每回一个文件，共 **2,289** 块。切分口径见 `dev-docs/docs/sango-corpus-split-scheme.md`，段清单见本目录 `segments.md`。

```json
{
  "source": "sanguo-yanyi",
  "chapter": 2,
  "title": "张翼德怒鞭督邮 何国舅谋诛宦竖",
  "chunks": [
    {
      "chunk_id": "sanguo-yanyi:0002:p0002:c01",
      "parent_id": "sanguo-yanyi:0002:p0002",
      "seq_in_parent": 1,
      "type": "prose",
      "role": "body",
      "text": "于是三人连夜引军来投朱儁……",
      "char_count": 351
    }
  ]
}
```

- **段 = 原文一行**（回目行不入段），**块 ⊂ 父段**（1:1 或 1:N），块不跨段、不混装；`type ∈ prose|verse`（正文 / 诗词），`role ∈ body|lead`（主体 / 引题）。
- ID 规则：`parent_id` = `{source}:{回号4位}:p{段号4位}`；`chunk_id` = `{parent_id}:c{seq_in_parent 两位}`；`chunk_id` 可由 `parent_id + seq_in_parent` 回放。
- 切分参数：TARGET 350 / CAP 600。段长 ≤ CAP → 整段一块；段长 > CAP → 段内按句切子块。
- 切点：只在句末标点 `。！？；` 之后（紧跟其后的收尾引号 `”’』」》】` 归前句），且**吸收这些收尾引号之后该处引号深度为 0**（`“”` 与 `‘’` 都计入深度）；引号内部的句末标点不作切点。
- 诗词段**整段成块、不切**（超 CAP 走白名单）；尾块 < 60 字并入前块（并入后 ≤ CAP），不跨段。
- 检索出参即 `chunks[]` 字段逐条展开（`chunk_id/parent_id/seq_in_parent/type/text/char_count/role` + 回级 `chapter/title`；成组的块另有 `group_id`，孤立段不带该键）：一次召回可跨回，编排侧只能逐条渲染出处。

### 当前读数（底本 = 人民文学出版社版）

| 项 | 值 |
|---|---|
| 底本 | `dev-docs/docs/三国演义.txt`：120 回 / 2,128 段 / 591,870 字；注 576 条同批产出（`dev-docs/docs/sango-annotations.json`） |
| 段 | 2,128（正文 1,891 / 诗词 237） |
| 块 | 2,289（一段一块 1,992 = 93.6%；被切父段 136；被切父段内块 297） |
| 引题 | `role=lead` 19 块（照常出块、不进检索索引） |
| 上下文组 | 281 组 / 覆盖 601 段（28.2%）；组字数 p50 296 / p90 623 / max 1069 |
| 块长 | p50 255 / p90 468 / 均值 258 / max 1572 字 |
| 已知例外（白名单） | 引语溢出：69 回 3 段（→ 68 + 1572）；段内引号不配平：44 回 8 段、114 回 4 段、114 回 5 段；含叙述前缀的引题：91 回 2 段、118 回 14 段；尾块并入即超 CAP：85 回 19 段（568 + 33） |

## 重建

```powershell
cd D:\workplace\mcp-server
py -3 sango/scripts/build_corpus.py                                  # 语料（sanguo-yanyi/）
$env:SANGO_EMIT_SEGMENTS=1; py -3 sango/scripts/build_corpus.py       # 另出段清单 -> %TEMP%\sango-segments-dump\
py -3 sango/scripts/build_vectors.py                                 # 向量，与 sanguo-yanyi/ 的 chunks[] 同序
```

原文来源：`D:\workplace\dev-docs\docs\三国演义.txt`。改动切分逻辑后必须重跑并复核 `sango-corpus-split-scheme.md` §6 的 I1~I8 自检与 §3 读数。

> 取值契约：`type` / `role` 的枚举值、类型与启动校验唯一维护在 `sango/src/chunk-kind.ts`；语料出现表外取值时加载期抛错终止启动。展示层需要中文文案时在展示模块局部映射，不反向影响语料取值。
