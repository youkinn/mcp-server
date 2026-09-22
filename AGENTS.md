# mcp-server — 项目规范

> 负责人：老陈（Transport / MCP / 接口）。团队级规则见 `D:\workplace\dev-docs\AGENTS.md`（含需求 / Bug / 排查对接文档索引）；本文件只列本项目特有约束。架构决策（单仓多 MCP / 独立构建部署 / TypeScript）见 `D:\workplace\dev-docs\docs\mcp-server-architecture.md`。

## 定位

- **单仓库 = 多个 MCP 子项目集合**；每个 MCP 一个独立目录，独立构建、独立部署（独立 stdio 子进程）。
- 当前成员：
  - `sango/`：三国演义检索 MCP（`sango_novel_search` / `sango_novel_chapter`，feat-A004 / A010）。TypeScript。
  - `fengyunsanguo/`：风云三国题库 MCP（`fengyunsanguo_query` / `fengyunsanguo_quiz_command` / `fengyunsanguo_quiz_route`，feat-A005）。TypeScript。
  - `weather/`：天气 MCP（get-alerts / get-forecast）。存量 JS；能力已于 feat-A011 下线，**目录保留但不再注册**（编排器残留 `MCP_WEATHER_SCRIPT` 直接忽略）。
- 新增 MCP：新建独立目录（own package.json / tsconfig / build → dist / data / scripts），TypeScript；**禁止改动其他 MCP 的代码**。

## 规范

- 基于 `@modelcontextprotocol/sdk` 的 MCP 服务端；stdio 传输。
- 所有日志输出到 stderr（MCP 协议用 stdout，写 stdout 会破坏协议）。
- 工具输入用 Zod schema 校验。
- 每个 MCP 独立 package.json：`build`（tsc → dist，TS 项目）与 `start`（node 入口）脚本；部署只针对被改动的 MCP。
- 数据随所属 MCP 项目目录存放，线上只读；构建期产物（如离线向量）由构建脚本生成。

## 新增 / 维护 MCP 的代码规范（2026-09-16 负责人审查意见沉淀）

- **版本号读 package.json**：`McpServer({ name, version })` 的 version 从各自 package.json 读取，禁止硬编码。
- **入口异常捕获**：stdio 连接放 `main()` 并在 `.catch` 中 `console.error + process.exit(1)`（参考 weather 的 main 模式）。
- **工具注册用 `registerTool`**：`server.tool()` 在 SDK 中已弃用（@deprecated），一律用 `server.registerTool(name, config, cb)`。
- **代码分层**：入口只做装配（加载 → 注册 → 连接）；类 / 工具函数 / 公共类型拆分到独立文件（types / search / utils 等），避免单体文件；类型文件只放公共、被多处引用的类型。
- **JSDoc 注释**：从业务角度适量编写（如「按 source 确定语料域」「无命中话术供模型兜底」）；难懂技术点（如哈希与构建脚本对齐）允许技术解释。
- **数据加载异常处理**：启动期读取数据（corpus / 向量 / 配置）必须处理异常——核心数据（如语料）加载失败 → 明确报错并终止启动；可降级数据（如向量）加载失败 → stderr 告警并降级（如 BM25-only），不阻断启动。

