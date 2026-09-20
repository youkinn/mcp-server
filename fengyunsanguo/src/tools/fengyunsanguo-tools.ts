/**
 * fengyunsanguo 三工具：定义与处理逻辑（feat-A005 契约）。
 * 独立成文件，避免处理函数堆在 index.ts 装配层；装配层把已 bind(server) 的
 * registerTool 与 FengyunsanguoService 实例作为入参传入。
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  DEFAULT_CANDIDATE_LIMIT,
  FengyunsanguoService,
} from '../fengyunsanguo-service.ts';

/**
 * 注册 fengyunsanguo 三工具：候选召回、随机一题状态机、L3 高置信识别。
 * @param registerTool - server.registerTool（已 bind(server)，依赖 this）。
 * @param service - 已加载题库的服务实例（会话 Map 挂在实例上，进程内 TTL 30 分钟）。
 */
export function registerFengyunsanguoTools(
  registerTool: McpServer['registerTool'],
  service: FengyunsanguoService,
): void {
  registerTool(
    'fengyunsanguo_query',
    {
      description:
        '风云三国题库候选召回：仅当用户询问风云三国游戏内招募武将问答题时调用；text 传用户原始问法，返回候选题目（编号列表：题干 → 答案），供 LLM 判定对应题，答案取自题库原文。超出 8 条按 8 截断。',
      inputSchema: z.object({
        text: z.string().min(1).describe('用户原始问法（风云三国招募题）'),
        limit: z.number().int().min(1).optional().default(1).describe(`候选条数，默认 1，最大 ${DEFAULT_CANDIDATE_LIMIT}（超出按 ${DEFAULT_CANDIDATE_LIMIT} 截断）`),
      }),
    },
    async (args) => {
      const hits = service.candidates(args.text, Math.min(args.limit, DEFAULT_CANDIDATE_LIMIT));
      const text = hits.length
        ? hits
          .map((hit, index) => `${index + 1}. ${hit.question.question} → ${hit.answer}`)
          .join('\n')
        : '未召回到任何候选题目';
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  registerTool(
    'fengyunsanguo_quiz_command',
    {
      description:
        '风云三国随机一题状态机（本地规则，不经 LLM）：「随机一题」/「来一题」随机出题（题干 + A-D 选项，不含答案）；选项字母（A/a/ａ）或选项文本判题（答错附正确答案）；「答案」/「这题选什么」查当前题正确答案；无有效会话返回提示。会话按 sessionId 存于子进程内存，TTL 30 分钟，重启即清；同一轮出题—作答—查答案期间 sessionId 保持不变。',
      inputSchema: z.object({
        message: z.string().min(1).describe('随机一题指令 / 作答内容 / 查答案指令'),
        sessionId: z.string().optional().describe('判题会话标识（前端 UUID 生成）；缺省或空视为无会话'),
      }),
    },
    async (args) => {
      const text = service.handleRandom(args.message, args.sessionId);
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  registerTool(
    'fengyunsanguo_quiz_route',
    {
      description:
        '风云三国 L3 高置信识别：判定 text 是否为题库内风云三国问题（256 维哈希向量余弦 + 词法相似度，阈值 0.9），返回 JSON 布尔 true/false；供路由层在无标签自动路由时调用，不经 LLM。',
      inputSchema: z.object({
        text: z.string().min(1).describe('用户问句'),
      }),
    },
    async (args) => {
      const hit = service.isHighConfidenceFengyunsanguoQuery(args.text);
      return { content: [{ type: 'text' as const, text: String(hit) }] };
    },
  );
}
