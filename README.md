# Weather MCP Server

一个基于 Node.js 和 Model Context Protocol（MCP）的天气服务，通过 stdio 与 MCP 客户端通信。

## 功能

- `get-alerts`：查询美国指定州的天气预警。
- `get-forecast`：根据经纬度查询天气预报。

## 环境要求

- Node.js 18 或更高版本（需要内置 `fetch`）。
- 能够访问 [National Weather Service API](https://api.weather.gov/) 的网络环境。
- 一个支持 MCP 的客户端，例如 Cline。

## 安装

在项目根目录执行：

```bash
npm install
```

## 启动

### 使用 npm 启动

```bash
npm start
```

该命令等价于：

```bash
node src/weather/index.js
```

服务使用 stdio 通信，不会启动 HTTP 服务，也不需要传入业务参数。通常应由 MCP 客户端启动和管理该进程，不要向运行中的进程输出普通文本。

### 在 Cline 中配置

项目提供了 [cline_mcp_settings.json](cline_mcp_settings.json) 配置示例：

```json
{
  "mcpServers": {
    "weather": {
      "command": "node",
      "args": [
        "--inspect=9229",
        "D:\\workplace\\mcp-server\\src\\weather\\index.js"
      ],
      "cwd": "D:\\workplace\\mcp-server",
      "timeout": 600,
      "disabled": false
    }
  }
}
```

使用其他电脑或目录时，请将 `args` 中的入口文件路径和 `cwd` 改为实际路径。Windows 路径在 JSON 中需要使用双反斜杠。

配置完成后，重启或重新加载 Cline，使 MCP 服务配置生效。配置中的 `--inspect=9229` 用于断点调试；如果不需要调试，可以删除该参数。

## VS Code 断点调试

项目的 [.vscode/launch.json](.vscode/launch.json) 已配置 `Attach to Cline Weather MCP Server`，用于附加到监听 `9229` 端口的 Node.js 进程。

调试步骤：

1. 先通过 Cline 配置启动 MCP 服务，或在终端执行：

   ```bash
   node --inspect=9229 src/weather/index.js
   ```

2. 在 VS Code 左侧打开“运行和调试”。
3. 在配置下拉列表中选择 `Attach to Cline Weather MCP Server`。
4. 点击开始调试按钮，然后在源码中设置断点。

`9229` 仅用于 Node.js 调试，不是天气服务的 HTTP 端口。如果端口已被占用，请同时修改启动命令中的端口和 `.vscode/launch.json` 中的 `port`。

## 工具参数

### `get-alerts`

请求示例：

```json
{
  "state": "NY"
}
```

`state` 必填，必须是长度为 2 的美国州代码，例如 `CA` 或 `NY`。服务会自动转换为大写。

### `get-forecast`

请求示例：

```json
{
  "latitude": 40.7128,
  "longitude": -74.0060
}
```

- `latitude` 必填，范围为 `-90` 到 `90`。
- `longitude` 必填，范围为 `-180` 到 `180`。

当前使用的 NWS API 主要支持美国境内的位置，其他国家或地区可能无法查询。

## 注意事项与排查

- 天气数据依赖 `https://api.weather.gov`，网络不可用、接口限流或位置不受支持时可能查询失败。
- 服务日志写入 stderr，MCP 协议通信使用 stdout。业务代码不要向 stdout 输出额外内容，否则可能破坏 MCP 通信。
- 修改源码后，需要重启 Cline 中的 MCP 服务进程才能加载新代码。
- 这是 stdio MCP 服务，不是 Web 服务；不要通过浏览器访问，也不需要配置 HTTP 端口。
- 如果 `npm start` 无法执行，请先确认已在项目根目录运行 `npm install`，并检查 Node.js 版本。
- `node_modules` 已被 `.gitignore` 忽略，不要提交到 Git。

## 目录结构

```text
src/weather/index.js       MCP 服务入口
cline_mcp_settings.json    Cline 配置示例
.vscode/launch.json        VS Code 断点调试配置
package.json               依赖和 npm 脚本
README.md                  项目说明
```
