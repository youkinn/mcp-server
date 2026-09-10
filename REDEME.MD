# Weather MCP Server

## 项目简介

这是一个基于 Node.js 和 Model Context Protocol (MCP) 的天气服务，使用标准输入输出（stdio）与 MCP 客户端通信。

当前提供两个工具：

- `get-alerts`：查询美国某个州的天气预警。
- `get-forecast`：根据经纬度查询天气预报。

## 运行环境

- Node.js 18 或更高版本（需要支持 `fetch`）。
- 能够访问 `https://api.weather.gov` 的网络环境。
- MCP 客户端，例如 Cline。

## 安装依赖

在项目根目录执行：

```bash
npm install
```

如果项目中已经存在 `node_modules`，通常可以跳过这一步；依赖发生变化后应重新执行。

## 启动服务

### 直接启动

在项目根目录执行：

```bash
npm start
```

该命令会执行 `node src/weather/index.js`。服务通过 stdio 工作，启动后不会提供 HTTP 地址，也不需要在命令行中输入参数。启动进程应由 MCP 客户端管理，不建议手动向终端输入普通文本。

如需绕过 npm，也可以直接执行：

```bash
node src/weather/index.js
```

### 调试启动

项目根目录的 `launch.json` 是 VS Code 断点调试配置，用于附加到正在运行的 Node.js MCP 服务。

如果需要使用 VS Code 调试器，可执行：

```bash
node --inspect=9229 src/weather/index.js
```

然后使用项目中的 `launch.json`，选择 `Attach to Cline Weather MCP Server` 附加到 `9229` 端口。

也可以在 VS Code 左侧点击“运行和调试”，在配置下拉列表中选择 `Attach to Cline Weather MCP Server`，再点击开始调试按钮。

## Cline 配置

项目根目录已提供 `cline_mcp_settings.json` 示例。配置内容如下：

```json
{
  "mcpServers": {
    "weather": {
      "command": "node",
      "args": [
        "D:\\workplace\\mcp-server\\src\\weather\\index.js"
      ],
      "cwd": "D:\\workplace\\mcp-server",
      "timeout": 600,
      "disabled": false
    }
  }
}
```

使用其他电脑或其他目录时，需要将 `args` 中的入口文件路径和 `cwd` 修改为实际路径。Windows 路径在 JSON 中需要使用双反斜杠（`\\`）。

调试时，可以将 `args` 改为：

```json
[
  "--inspect=9229",
  "D:\\workplace\\mcp-server\\src\\weather\\index.js"
]
```

配置完成后，重启或重新加载 MCP 客户端，使配置生效。

## 工具参数

### `get-alerts`

查询某个美国州的天气预警：

```json
{
  "state": "NY"
}
```

- `state`：必填，长度必须为 2 的美国州代码，例如 `CA`、`NY`。
- 服务会自动将州代码转换为大写。

### `get-forecast`

根据经纬度查询天气预报：

```json
{
  "latitude": 40.7128,
  "longitude": -74.0060
}
```

- `latitude`：必填，范围为 `-90` 到 `90`。
- `longitude`：必填，范围为 `-180` 到 `180`。
- 当前使用的 NWS API 主要支持美国境内的位置，其他国家或地区可能无法查询。

## 注意事项

1. 天气数据来自美国国家气象局 NWS API，服务运行时需要网络连接。
2. NWS API 可能因为网络、接口限流或目标位置不支持而返回错误。
3. 该项目是 stdio MCP 服务，不是 Web 服务；不要通过浏览器访问，也不需要配置端口。`9229` 仅用于 Node.js 调试。
4. 服务日志写入标准错误输出，MCP 协议通信使用标准输出。不要在业务代码中向标准输出写入非 MCP 协议内容，否则可能导致客户端通信异常。
5. 修改源代码后，需要重启 MCP 客户端中的服务进程才能加载新代码。
6. 项目已配置 `npm start` 脚本，启动命令为 `npm start`；该命令不接收业务参数。
7. 不要将 `node_modules` 提交到 Git；它已被 `.gitignore` 忽略。

## 目录说明

```text
src/weather/index.js       MCP 服务入口
cline_mcp_settings.json    Cline 配置示例
launch.json                VS Code 调试配置
package.json               项目依赖和元数据
```
