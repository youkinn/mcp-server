# mcp-server — 项目规范

> 团队级规则见 `dev-docs/AGENTS.md`；本文件只列本项目特有约束。架构决策（单仓多 MCP / 独立构建部署 / TypeScript）见 `dev-docs/docs/mcp-server-architecture.md`。

## 定位

- **单仓库 = 多个 MCP 子项目集合**；每个 MCP 一个独立目录，独立构建、独立部署（独立 stdio 子进程）。
- 当前成员：
  - `weather/`：天气 MCP（get-alerts / get-forecast）。存量 JS；2026-09-16 仅迁移目录（原 `src/weather/`），**代码/行为零改动**。
  - `sango/`：三国演义检索 MCP（`sango_novel_search`，feat-A004）。TypeScript 打底。
- 新增 MCP：新建独立目录（own package.json / tsconfig / build → dist / data / scripts），TypeScript；**禁止改动其他 MCP 的代码**。

## 规范

- 基于 `@modelcontextprotocol/sdk` 的 MCP 服务端；stdio 传输。
- 所有日志输出到 stderr（MCP 协议用 stdout，写 stdout 会破坏协议）。
- 工具输入用 Zod schema 校验。
- 每个 MCP 独立 package.json：`build`（tsc → dist，TS 项目）与 `start`（node 入口）脚本；部署只针对被改动的 MCP。
- 数据随所属 MCP 项目目录存放，线上只读；构建期产物（如离线向量）由构建脚本生成。

## 负责人：老陈（API 和集成开发）
