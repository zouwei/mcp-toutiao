/**
 * streamable-http 传输：一个 `/mcp` 端点 + `/healthz`。
 *
 * **无状态**：每个请求新建 McpServer + Transport（`sessionIdGenerator: undefined`）。
 * 复用单个 transport 在 initialize 之后的通知会 500 —— 飞燕的 e2e 实测过。
 * 浏览器实例是进程级单例，与 MCP 会话无关：会话可以来来去去，登录态必须活着。
 *
 * 用 node:http 而不是 fastify/express：一共三条路由，为此拖一个 web 框架不值。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import type { Logger } from '../logger.js';
import { buildMcpServer } from '../mcp/server.js';
import type { ToolContext } from '../mcp/tools.js';

export const MCP_PATH = '/mcp';

export interface HttpServerHandle {
  server: Server;
  port: number;
  close(): Promise<void>;
}

export async function startHttpServer(ctx: ToolContext, log: Logger): Promise<HttpServerHandle> {
  const { authToken, host, port } = ctx.config;

  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      log.error('http handler crashed', { error: err instanceof Error ? err.message : String(err) });
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal_error' }));
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? '/').split('?')[0] ?? '/';

    // 健康检查不鉴权：容器编排要用它，给它塞 Token 只会让部署更难
    if (path === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          service: 'toutiao-mcp',
          browserRunning: ctx.browser.isRunning,
          queueDepth: ctx.browser.queueDepth,
        }),
      );
      return;
    }

    if (path !== MCP_PATH) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found', hint: `MCP 端点是 ${MCP_PATH}` }));
      return;
    }

    if (authToken && !checkBearer(req.headers.authorization, authToken)) {
      res.writeHead(401, {
        'content-type': 'application/json',
        'www-authenticate': 'Bearer realm="toutiao-mcp"',
      });
      res.end(JSON.stringify({ error: 'unauthorized', code: 'auth_token_required' }));
      return;
    }

    const body = req.method === 'POST' ? await readJsonBody(req) : undefined;
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const mcp = buildMcpServer(ctx);
    res.on('close', () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });

  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  log.info(`toutiao-mcp listening on http://${host}:${actualPort}${MCP_PATH}`, {
    authRequired: Boolean(authToken),
  });
  if (!authToken) {
    log.warn('AUTH_TOKEN 未设置：任何能访问该端口的人都可以用这个头条号发内容 —— 生产部署请务必设置');
  }

  return {
    server,
    port: actualPort,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/** 定长比较，避免用比较耗时侧漏 token */
function checkBearer(header: string | undefined, expected: string): boolean {
  const prefix = 'bearer ';
  if (!header || !header.toLowerCase().startsWith(prefix)) return false;
  const provided = Buffer.from(header.slice(prefix.length).trim());
  const want = Buffer.from(expected);
  if (provided.length !== want.length) return false;
  return timingSafeEqual(provided, want);
}

const MAX_BODY_BYTES = 8 * 1024 * 1024;

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let raw = '';
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      // 不设上限的话，一个超大 body 就能把内存吃光
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        return;
      }
      raw += chunk.toString('utf8');
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : undefined);
      } catch {
        resolve(undefined);
      }
    });
    req.on('error', () => resolve(undefined));
  });
}
