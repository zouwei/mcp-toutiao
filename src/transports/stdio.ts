/**
 * stdio 传输：给桌面 agent（Claude Code / Cursor）用 `npx @moraya/toutiao-mcp`。
 *
 * 唯一要小心的事：**stdout 是协议通道**。所有日志走 stderr（logger.ts 已保证），
 * 这里再重申一次是因为往 stdout 写一个字节的后果是「客户端说服务器坏了」，
 * 排查方向会完全跑偏。
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import type { Logger } from '../logger.js';
import { buildMcpServer } from '../mcp/server.js';
import type { ToolContext } from '../mcp/tools.js';

export async function startStdioServer(ctx: ToolContext, log: Logger): Promise<() => Promise<void>> {
  const mcp = buildMcpServer(ctx);
  const transport = new StdioServerTransport();
  await mcp.connect(transport);
  log.info('toutiao-mcp running on stdio');

  return async () => {
    await transport.close().catch(() => {});
    await mcp.close().catch(() => {});
  };
}
