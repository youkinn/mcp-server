# mcp-server — 项目规范

## 架构
- 基于 `@modelcontextprotocol/sdk` 的 MCP 服务端
- Stdio 传输
- 两个工具：`get-alerts`（按美国州代码）和 `get-forecast`（按经纬度）
- 数据源：weather.gov NWS API

## 规范
- 所有日志输出到 stderr（MCP 协议使用 stdout 进行传输）
- 工具输入使用 Zod schema 校验
- 服务名称："weather"，版本："1.0.0"

## 负责人：老陈（API 和集成开发）