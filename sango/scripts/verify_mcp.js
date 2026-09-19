/**
 * sango 最小 MCP 客户端验证脚本（临时验证用，不需要 orchestrator）。
 * 用法: node sango/scripts/verify_mcp.js
 * 验证: list 到 sango_novel_search；source=sanguo-yanyi 返回结构化条目数组；
 *       sanguozhi（枚举内但本期未开放）与非法 source 均报错。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(__dirname, '..', 'src', 'index.ts');

const child = spawn(process.execPath, [serverPath], {
  stdio: ['pipe', 'pipe', 'pipe'],
});

let buf = '';
const pending = new Map();
let nextId = 1;

child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      process.stderr.write(`[client] 非 JSON 输出: ${line}\n`);
      continue;
    }
    if (msg.id && pending.has(msg.id)) {
      const { resolve } = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg);
    }
  }
});

child.stderr.setEncoding('utf8');
child.stderr.on('data', (d) => process.stderr.write(`[server-stderr] ${d}`));

function send(method, params = {}) {
  const id = nextId++;
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout: ${method}`)), 15000);
    pending.set(id, { resolve: (m) => { clearTimeout(t); resolve(m); } });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const results = [];
  await sleep(300); // 等服务端加载语料
  const init = await send('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'verify-mcp', version: '1.0.0' },
  });
  results.push(['initialize', init.result?.serverInfo?.name, init.result?.protocolVersion]);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const list = await send('tools/list');
  const names = (list.result?.tools ?? []).map((t) => t.name);
  results.push(['tools/list', names.join(','), list.result?.tools?.length]);

  const call1 = await send('tools/call', {
    name: 'sango_novel_search',
    arguments: { source: 'sanguo-yanyi', query: '关羽', limit: 3 },
  });
  const text1 = call1.result?.content?.map((c) => c.text).join('\n') ?? '';
  let entryCount = 0;
  let firstEntryKeys = '';
  let firstEntryOrigin = '';
  try {
    const parsed = JSON.parse(text1);
    if (Array.isArray(parsed)) {
      entryCount = parsed.length;
      firstEntryKeys = parsed[0] ? Object.keys(parsed[0]).join(',') : '';
      firstEntryOrigin = parsed[0] ? `第${parsed[0].chapter}回 ${parsed[0].title}` : '';
    }
  } catch {
    // 无命中话术（非 JSON）时保持原样
  }
  results.push(['call sanguo-yanyi/关羽', `isError=${!!call1.result?.isError}`, `chars=${text1.length} entries=${entryCount} keys=${firstEntryKeys} 首条出处=${firstEntryOrigin}`]);
  process.stdout.write('--- 命中示例（结构化条目）---\n' + text1.slice(0, 400) + '\n---\n');

  const call2 = await send('tools/call', {
    name: 'sango_novel_search',
    arguments: { source: 'sanguozhi', query: '关羽', limit: 3 },
  });
  const errText2 = call2.error
    ? `jsonrpc-error: ${call2.error.message ?? 'unknown'}`
    : `isError=${!!call2.result?.isError} msg=${(call2.result?.content?.[0]?.text ?? '').slice(0, 120)}`;
  results.push(['call sanguozhi(本期未开放)', 'rejected=' + (!!call2.error || !!call2.result?.isError), errText2]);

  const call3 = await send('tools/call', {
    name: 'sango_novel_search',
    arguments: { source: 'bad_source', query: '关羽' },
  });
  const errText = call3.error
    ? `jsonrpc-error: ${call3.error.message ?? 'unknown'}`
    : `isError=${!!call3.result?.isError} msg=${(call3.result?.content?.[0]?.text ?? '').slice(0, 120)}`;
  results.push(['call bad_source(非法)', 'rejected=' + (!!call3.error || !!call3.result?.isError), errText]);

  const call4 = await send('tools/call', {
    name: 'sango_novel_search',
    arguments: { source: 'sanguo-yanyi', query: '赤壁之战', limit: 2 },
  });
  const text4 = call4.result?.content?.map((c) => c.text).join('\n') ?? '';
  results.push(['call sanguo-yanyi/赤壁之战', `isError=${!!call4.result?.isError}`, `chars=${text4.length}`]);

  process.stdout.write('\n=== 验证结果 ===\n');
  for (const [name, a, b] of results) {
    process.stdout.write(`[${name}] ${a} | ${b}\n`);
  }
  child.kill();
}

main().catch((e) => {
  process.stderr.write(`[client] 失败: ${e.message}\n`);
  child.kill();
  process.exitCode = 1;
});
