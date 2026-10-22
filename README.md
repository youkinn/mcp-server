# mcp-server

天枢项目群的 MCP 服务端集合（别名：器坊）。单仓库包含多个独立 MCP 子项目，均通过 stdio 提供工具，由 `mcp-orchestrator` 启动和调用。

## 目录结构

```text
mcp-server/
├── sango/            三国演义检索 MCP（TypeScript）
│   ├── src/          源码与测试
│   ├── data/         语料与索引数据
│   ├── scripts/      语料 / 向量等构建脚本
│   └── dist/         构建产物
├── fengyunsanguo/    风云三国题库 MCP（TypeScript）
│   ├── src/          源码与测试
│   ├── data/         题库数据
│   └── dist/         构建产物
├── weather/          天气 MCP（存量 JS，已下线）
├── package.json      根工作区与公共脚本
└── node_modules/     共享依赖（不提交）
```

## 子项目

| 目录 | 工具 | 说明 |
|---|---|---|
| `sango/` | `sango_novel_search`、`sango_novel_chapter` | 三国演义检索与整回原文；另有内部工具 `sango_query_embed`，模型不可见 |
| `fengyunsanguo/` | `fengyunsanguo_query`、`fengyunsanguo_quiz_command`、`fengyunsanguo_quiz_route` | 风云三国题库问答、随机出题与判题 |
| `weather/` | `get-alerts`、`get-forecast` | 天气服务，已下线，目录保留但不再注册 |

## 构建与运行

```bash
npm install
npm run build:all            # 构建 sango 与 fengyunsanguo
npm run start:sango
npm run start:fengyunsanguo
npm run start:weather        # 仅用于调试历史天气服务
```

各子项目也可单独执行 `npm --prefix <目录> run build / start / test`。

## 约定

- 每个 MCP 独立目录、独立构建与部署；新增 MCP 不改动其他子项目。
- 新增 MCP 使用 TypeScript；存量 `weather/` 为 JS。基于 `@modelcontextprotocol/sdk`，工具入参用 Zod 校验。
- 日志写 stderr；stdout 只用于 MCP 协议。
- 数据随子项目存放，线上只读；构建期产物由脚本生成。

接口契约见 `D:\workplace\dev-docs\mcp-orchestrator\api\`，表与专题设计见 `D:\workplace\dev-docs\docs\`，团队约定见 `D:\workplace\dev-docs\AGENTS.md`。
