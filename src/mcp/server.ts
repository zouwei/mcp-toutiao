/**
 * McpServer 装配。stdio 与 http 两条传输共用这里 —— 协议只是皮。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { TOOL_DEFS, toErrorResult, withToolTimeout, type ToolContext } from './tools.js';

export const SERVER_INFO = { name: 'toutiao-mcp', version: '0.1.0' } as const;

const INSTRUCTIONS =
  '今日头条创作者平台（mp.toutiao.com）发布服务，走登录态浏览器自动化。' +
  '典型用法：check_login_status →（未登录则 get_login_qrcode 让用户扫码）→ publish_article / publish_weitoutiao。' +
  '发布耗时可达数分钟，请给足超时；返回体里 verified=false 表示没能从平台确认结果，' +
  '此时应提示用户去后台核对，切勿直接重发。';

export function buildMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });

  for (const def of TOOL_DEFS) {
    server.registerTool(def.name, def.config, (async (args: Record<string, unknown>) => {
      try {
        return await withToolTimeout(
          def.handler(ctx, args ?? {}),
          ctx.config.toolTimeoutMs,
          def.name,
        );
      } catch (err) {
        // 任何异常都要以 MCP 错误形态回去，绝不让连接挂掉 ——
        // 连接断了的话调用方连「为什么失败」都拿不到。
        ctx.logger.error(`tool ${def.name} failed`, {
          error: err instanceof Error ? err.message : String(err),
        });
        return toErrorResult(err);
      }
    }) as never);
  }

  return server;
}
