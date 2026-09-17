# mcp-server — 项目规范

> 后端负责人：老陈。团队级规则见 `dev-docs/AGENTS.md`。

- 基于 `@modelcontextprotocol/sdk` 的 MCP 服务端，stdio 传输；由 mcp-orchestrator 的 transport 作为子进程启动，为 orchestrator 提供工具。
- 两个工具：`get-alerts`（按美国州代码）、`get-forecast`（按经纬度）；数据源 weather.gov NWS API。
- 服务名 "weather"，版本 "1.0.0"。

## 规范

- 所有日志输出到 stderr —— MCP 协议用 stdout 传输，写 stdout 会破坏协议。
- 工具输入用 Zod schema 校验。
