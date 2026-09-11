# mcp-server — Project Conventions

## Architecture
- MCP server using `@modelcontextprotocol/sdk`
- Stdio transport
- Two tools: `get-alerts` (by US state code) and `get-forecast` (by lat/lon)
- Data source: weather.gov NWS API

## Conventions
- All logs go to stderr (MCP protocol uses stdout for transport)
- Tool input validated with Zod schemas
- Server name: "weather", version: "1.0.0"

## Owner: 老陈 (for API & integration work)
