import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
const NWS_API_BASE = "https://api.weather.gov";
const USER_AGENT = "weather-app/1.0";

function log(message, details) {
  const suffix = details === undefined ? "" : ` ${JSON.stringify(details)}`;
  process.stderr.write(`${message}${suffix}\n`);
}

// 创建服务器实例
const server = new McpServer({
  name: "weather",
  version: "1.0.0",
});


// 用于发起 NWS API 请求的辅助函数
async function makeNWSRequest(url) {
  const headers = {
    "User-Agent": USER_AGENT,
    Accept: "application/geo+json",
  };
  try {
    const response = await fetch(url, { headers });
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    return (await response.json());
  }
  catch (error) {
    console.error("Error making NWS request:", error);
    return null;
  }
}

// 格式化预警数据
function formatAlert(feature) {
  const props = feature.properties;
  return [
    `Event: ${props.event || "Unknown"}`,
    `Area: ${props.areaDesc || "Unknown"}`,
    `Severity: ${props.severity || "Unknown"}`,
    `Status: ${props.status || "Unknown"}`,
    `Headline: ${props.headline || "No headline"}`,
    "---",
  ].join("\n");
}

server.registerTool("get-alerts", {
  description: "获取美国某个州的当前天气预警（数据源：美国国家气象局 NWS）。仅覆盖美国境内，state 必须是美国两字母州代码；非美国地区不要调用本工具。",
  inputSchema: {
    state: z.string().length(2).describe("两字母州代码(如 CA, NY)"),
  },
}, async ({ state }) => {
  const stateCode = state.toUpperCase();
  const alertsUrl = `${NWS_API_BASE}/alerts?area=${stateCode}`;
  log("[get-alerts] requesting alerts", { state: stateCode });
  const alertsData = await makeNWSRequest(alertsUrl);
  if (!alertsData) {
    log("[get-alerts] failed to retrieve alerts", { state: stateCode });
    return { content: [{ type: "text", text: "Failed to retrieve alerts data" }] };
  }
  const features = alertsData.features || [];
  if (features.length === 0) {
    log("[get-alerts] no active alerts", { state: stateCode });
    return { content: [{ type: "text", text: `No active alerts for ${stateCode}` }] };
  }
  const formattedAlerts = features.map(formatAlert).slice(0, 20);
  log("[get-alerts] alerts formatted", {
    state: stateCode,
    count: formattedAlerts.length,
  });
  return {
    content: [{
      type: "text",
      text: `Active alerts for ${stateCode}:\n\n${formattedAlerts.join("\n")}`,
    }],
  };
});

server.registerTool("get-forecast", {
  description: "获取美国境内某个经纬度位置的天气预报（数据源：美国国家气象局 NWS）。仅覆盖美国境内；非美国地区（如中国北京）不要调用本工具，应直接告知用户仅支持美国天气，不要编造数据。",
  inputSchema: {
    latitude: z.number().min(-90).max(90).describe("位置的纬度"),
    longitude: z.number().min(-180).max(180).describe("位置的经度"),
  },
}, async ({ latitude, longitude }) => {
  const pointsUrl = `${NWS_API_BASE}/points/${latitude.toFixed(4)},${longitude.toFixed(4)}`;
  log("[get-forecast] requesting grid point", { latitude, longitude });
  const pointsData = await makeNWSRequest(pointsUrl);
  if (!pointsData) {
    log("[get-forecast] failed to retrieve grid point", { latitude, longitude });
    return {
      content: [{
        type: "text",
        text: `Failed to retrieve grid point data for coordinates: ${latitude}, ${longitude}. This location may not be supported by the NWS API (only US locations are supported).`,
      }],
    };
  }
  const forecastUrl = pointsData.properties?.forecast;
  if (!forecastUrl) {
    log("[get-forecast] forecast URL missing", { latitude, longitude });
    return { content: [{ type: "text", text: "Failed to get forecast URL from grid point data" }] };
  }
  log("[get-forecast] requesting forecast", { latitude, longitude });
  const forecastData = await makeNWSRequest(forecastUrl);
  if (!forecastData) {
    log("[get-forecast] failed to retrieve forecast", { latitude, longitude });
    return { content: [{ type: "text", text: "Failed to retrieve forecast data" }] };
  }
  const periods = forecastData.properties?.periods || [];
  if (periods.length === 0) {
    log("[get-forecast] no forecast periods", { latitude, longitude });
    return { content: [{ type: "text", text: "No forecast periods available" }] };
  }
  const formattedForecast = periods.map((period) => [
    `${period.name || "Unknown"}:`,
    `Temperature: ${period.temperature || "Unknown"}°${period.temperatureUnit || "F"}`,
    `Wind: ${period.windSpeed || "Unknown"} ${period.windDirection || ""}`,
    `${period.shortForecast || "No forecast available"}`,
    "---",
  ].join("\n"));
  log("[get-forecast] forecast formatted", {
    latitude,
    longitude,
    count: formattedForecast.length,
  });
  return {
    content: [{
      type: "text",
      text: `Forecast for ${latitude}, ${longitude}:\n\n${formattedForecast.join("\n")}`,
    }],
  };
});

// 启动服务器
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("Weather MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
