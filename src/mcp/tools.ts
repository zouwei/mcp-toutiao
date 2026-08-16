/**
 * MCP 工具面。
 *
 * **工具描述就是给 agent 的指令** —— 飞燕 2026-08-15 的教训：agent 拿不到能转述的
 * 信息，就会自己编一句「已发布」。所以 description 里必须写清限制、耗时、失败后该干什么。
 *
 * 契约见 docs/specs/mcp-contract.md。
 */
import { z } from 'zod';

import type { Config } from '../config.js';
import { isToutiaoError, ToutiaoError, wrapError } from '../errors.js';
import type { Logger } from '../logger.js';
import type { BrowserManager } from '../core/browser.js';
import type { SessionManager } from '../core/session.js';
import { LIMITS } from '../core/selectors.js';
import { publishArticle, type FlowDeps } from '../flows/article.js';
import { publishWeitoutiao } from '../flows/weitoutiao.js';

export interface ToolContext {
  browser: BrowserManager;
  session: SessionManager;
  config: Config;
  logger: Logger;
}

/** MCP 返回块。手写而不是从 SDK 导入：SDK 的类型带一堆泛型，这里只需要这两种 */
type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export interface ToolResult {
  content: ContentBlock[];
  isError?: boolean;
}

const imageList = (max: number, what: string) =>
  z
    .array(z.string())
    .max(max)
    .optional()
    .describe(`${what}（本地绝对路径，或 http(s) 链接；最多 ${max} 张。相对路径会被拒绝）`);

export const ARTICLE_SCHEMA = {
  title: z
    .string()
    .describe(`文章标题，${LIMITS.articleTitleMin}–${LIMITS.articleTitleMax} 个字（头条硬限制，超限直接失败，本服务不会自动截断）`),
  content: z.string().describe('正文，Markdown 格式（会渲染成头条富文本；# 一级标题会降为二级）'),
  images: imageList(30, '正文插图。正文里写了 ![](路径) 就按位置插入；只传本参数则追加到文末'),
  cover: imageList(3, '封面图。不传则从 images 里取'),
  cover_mode: z
    .enum(['auto', 'single', 'triple', 'none'])
    .optional()
    .describe('封面模式，默认 auto（有图=单图，≥3 张=三图，无图=无封面）'),
  first_publish: z.boolean().optional().describe('勾选「头条首发」，默认 false'),
  also_weitoutiao: z
    .boolean()
    .optional()
    .describe('是否同时发一条微头条。头条页面默认勾选，本服务默认取消（false），避免一次调用发出两条内容'),
  declarations: z
    .array(z.string())
    .optional()
    .describe('作品声明，可选：取材网络 / 引用站内 / 个人观点 / 引用AI / 虚构演绎 / 投资观点 / 健康医疗'),
  collection: z.string().optional().describe('添加至合集的名称（需已存在）'),
  draft: z
    .boolean()
    .optional()
    .describe('true = 只填内容不发布（头条会自动存草稿），适合人工过目后再发'),
};

export const WEITOUTIAO_SCHEMA = {
  content: z
    .string()
    .describe(`微头条正文，纯文本，不超过 ${LIMITS.weitoutiaoContentMax} 字。Markdown 标记会被脱去（#话题 会保留）`),
  images: imageList(LIMITS.weitoutiaoImagesMax, '配图（微头条只支持本地文件，不支持网络地址）'),
  topic: z.string().optional().describe('话题名称，不含 #'),
  first_publish: z.boolean().optional().describe('勾选「头条首发」，默认 false'),
  declarations: z.array(z.string()).optional().describe('作品声明，同 publish_article'),
  draft: z.boolean().optional().describe('true = 存草稿而不是发布'),
};

export interface ToolDef {
  name: string;
  config: {
    description: string;
    inputSchema: z.ZodRawShape;
  };
  handler: (ctx: ToolContext, args: Record<string, unknown>) => Promise<ToolResult>;
}

export const TOOL_DEFS: ToolDef[] = [
  {
    name: 'check_login_status',
    config: {
      description:
        '查询今日头条创作者平台（mp.toutiao.com）的登录状态。返回 {"is_logged_in": bool, "user": {...}}。' +
        '未登录不是错误 —— 收到 false 就去调 get_login_qrcode。发布前建议先查一次。',
      inputSchema: {},
    },
    handler: async (ctx) => json(await ctx.session.checkStatus()),
  },
  {
    name: 'get_login_qrcode',
    config: {
      description:
        '获取头条号扫码登录的二维码，返回一段提示文本 + 一个 PNG 图片块（请把图片展示给用户）。' +
        '本工具立即返回、不等待扫码结果：用户扫完之后再调 check_login_status 确认。' +
        '二维码约 50 秒失效，过期就再调一次。已登录时不会返回二维码，而是直接告知已登录。',
      inputSchema: {},
    },
    handler: async (ctx) => {
      const result = await ctx.session.getQrcode();
      if ('alreadyLoggedIn' in result) {
        return json({ ...result.status, message: '已登录，无需扫码' });
      }
      return {
        content: [
          { type: 'text', text: result.hint },
          { type: 'image', data: result.image, mimeType: 'image/png' },
        ],
      };
    },
  },
  {
    name: 'logout',
    config: {
      description:
        '退出头条号登录（清除本地浏览器会话）。执行后必须重新扫码才能发布 —— 请先与用户确认。',
      inputSchema: {},
    },
    handler: async (ctx) => json(await ctx.session.logout()),
  },
  {
    name: 'publish_article',
    config: {
      description:
        '发布图文文章到今日头条创作者平台（走登录态浏览器自动化，不需要官方 API）。' +
        `标题限 ${LIMITS.articleTitleMin}–${LIMITS.articleTitleMax} 字；正文收 Markdown。` +
        '耗时较长：纯文本约 30–60 秒，带封面和插图 2–5 分钟 —— **请把客户端超时设到 300 秒以上**。' +
        '返回体里的 verified 表示是否从平台确认到了结果；verified=false 时内容很可能已经发出去了，' +
        '请提示用户去后台核对，不要直接重发。未登录会返回 NOT_LOGGED_IN，此时先走 get_login_qrcode。' +
        '发布前请把限制讲给用户，不要自行截断内容。',
      inputSchema: ARTICLE_SCHEMA,
    },
    handler: async (ctx, args) => json(await publishArticle(flowDeps(ctx), args as never)),
  },
  {
    name: 'publish_weitoutiao',
    config: {
      description:
        `发布微头条（短内容）到今日头条。正文纯文本、不超过 ${LIMITS.weitoutiaoContentMax} 字，` +
        `配图最多 ${LIMITS.weitoutiaoImagesMax} 张且必须是本地文件。耗时约 30–120 秒。` +
        'Markdown 标记会被脱去后再计数（#话题 保留）。其余同 publish_article。',
      inputSchema: WEITOUTIAO_SCHEMA,
    },
    handler: async (ctx, args) => json(await publishWeitoutiao(flowDeps(ctx), args as never)),
  },
];

function flowDeps(ctx: ToolContext): FlowDeps {
  return { browser: ctx.browser, session: ctx.session, config: ctx.config, logger: ctx.logger };
}

function json(payload: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

/**
 * 统一的失败出口。
 *
 * 两件必须做的事：①`isError: true`（调用方据此判失败，别指望它读文本）；
 * ②有截图就作为**独立的 image 块**发出去 —— 不塞进文本里（base64 会把文本撑爆）。
 */
export function toErrorResult(err: unknown): ToolResult {
  const error = isToutiaoError(err) ? err : wrapError(err, 'INTERNAL');
  const content: ContentBlock[] = [{ type: 'text', text: JSON.stringify(error.toPayload()) }];
  if (error.screenshot) {
    content.push({ type: 'image', data: error.screenshot, mimeType: 'image/png' });
  }
  return { content, isError: true };
}

/** 单次工具调用的总预算。超了要能说清是哪个工具，而不是让调用方自己猜 */
export async function withToolTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  toolName: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new ToutiaoError(
                'TIMEOUT',
                `工具 ${toolName} 超过 ${Math.round(timeoutMs / 1000)} 秒仍未完成 —— 浏览器任务可能仍在后台进行，请到头条后台核对后再重试`,
                { step: toolName },
              ),
            ),
          timeoutMs,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
