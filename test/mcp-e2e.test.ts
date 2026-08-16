/**
 * MCP 端到端：真 Client × 真 streamable-http 传输 × 真浏览器 × 假站。
 *
 * 验的是**契约**而不是内部实现：工具清单、Bearer 鉴权、返回块的形状
 * （飞燕的 flattenContent / normalizeQrcode / interpretLoginResult 就吃这些形状）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { loadConfig, type Config } from '../src/config.js';
import { silentLogger } from '../src/logger.js';
import { setHumanizeEnabled } from '../src/core/humanize.js';
import { BrowserManager } from '../src/core/browser.js';
import { SessionManager } from '../src/core/session.js';
import { startHttpServer, type HttpServerHandle } from '../src/transports/http.js';
import { startFakeSite, type FakeSite } from './fake-site/server.js';

const TOKEN = 'test-token-abc';

let site: FakeSite;
let handle: HttpServerHandle;
let browser: BrowserManager;
let dataDir: string;
let endpoint: string;

beforeAll(async () => {
  site = await startFakeSite({ loggedIn: true });
  dataDir = mkdtempSync(join(tmpdir(), 'toutiao-mcp-e2e-'));

  const config: Config = {
    ...loadConfig({}),
    baseUrl: site.origin,
    dataDir,
    headless: true,
    humanize: false,
    authToken: TOKEN,
    host: '127.0.0.1',
    port: 0, // 随机端口，避免与开发机上跑着的实例撞车
  };
  setHumanizeEnabled(false);

  const logger = silentLogger();
  browser = new BrowserManager(config, logger);
  const session = new SessionManager(browser, config, logger);
  handle = await startHttpServer({ browser, session, config, logger }, logger);
  endpoint = `http://127.0.0.1:${handle.port}/mcp`;
}, 120_000);

afterAll(async () => {
  await handle?.close();
  await browser?.shutdown();
  await site?.close();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

async function connect(token = TOKEN): Promise<Client> {
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(endpoint), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

describe('MCP over streamable-http', () => {
  it('exposes exactly the five documented tools', async () => {
    const client = await connect();
    const { tools } = await client.listTools();

    expect(tools.map((t) => t.name).sort()).toEqual([
      'check_login_status',
      'get_login_qrcode',
      'logout',
      'publish_article',
      'publish_weitoutiao',
    ]);

    // 工具描述就是给 agent 的指令 —— 空描述等于把 agent 放养
    for (const tool of tools) expect((tool.description ?? '').length).toBeGreaterThan(20);

    // 发布工具必须在描述里讲清耗时，否则客户端会用默认超时把自己掐死
    const article = tools.find((t) => t.name === 'publish_article');
    expect(article?.description).toMatch(/超时|秒/);
    await client.close();
  });

  it('rejects a wrong bearer token', async () => {
    await expect(connect('wrong-token')).rejects.toThrow();
  });

  it('returns login status as a JSON text block (the shape feiyan parses)', async () => {
    const client = await connect();
    const result = (await client.callTool({ name: 'check_login_status', arguments: {} })) as {
      content: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };

    expect(result.isError).toBeFalsy();
    expect(result.content).toHaveLength(1);
    expect(result.content[0]?.type).toBe('text');
    expect(JSON.parse(result.content[0]!.text!)).toMatchObject({ is_logged_in: true });
    await client.close();
  });

  it('surfaces validation failures as isError + structured JSON, not as a broken connection', async () => {
    const client = await connect();
    const result = (await client.callTool({
      name: 'publish_article',
      arguments: { title: '标'.repeat(50), content: '正文' },
    })) as { content: Array<{ type: string; text?: string }>; isError?: boolean };

    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0]!.text!) as { code: string; message: string };
    expect(payload.code).toBe('CONTENT_LIMIT');
    expect(payload.message).toContain('标题');
    await client.close();
  });

  it('serves /healthz without auth so container orchestration can use it', async () => {
    const response = await fetch(`http://127.0.0.1:${handle.port}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, service: 'toutiao-mcp' });
  });
});

describe('MCP qrcode block shape', () => {
  it('returns [text, image] — the exact shape feiyan normalizeQrcode expects', async () => {
    // 单独起一个未登录的假站：形状对不上会让飞燕报「解析不出二维码」，
    // 而真实原因是载荷根本没送到（飞燕 2026-08-14 踩过）
    const loggedOut = await startFakeSite({ loggedIn: false });
    const dir = mkdtempSync(join(tmpdir(), 'toutiao-mcp-qr-'));
    const config: Config = {
      ...loadConfig({}),
      baseUrl: loggedOut.origin,
      dataDir: dir,
      headless: true,
      humanize: false,
      authToken: '',
      host: '127.0.0.1',
      port: 0,
    };
    const logger = silentLogger();
    const localBrowser = new BrowserManager(config, logger);
    const session = new SessionManager(localBrowser, config, logger);
    const local = await startHttpServer({ browser: localBrowser, session, config, logger }, logger);

    try {
      const client = new Client({ name: 'qr-client', version: '1.0.0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${local.port}/mcp`)));
      const result = (await client.callTool({ name: 'get_login_qrcode', arguments: {} })) as {
        content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
      };

      expect(result.content).toHaveLength(2);
      expect(result.content[0]?.type).toBe('text');
      expect(result.content[0]?.text).toContain('扫');
      expect(result.content[1]?.type).toBe('image');
      expect(result.content[1]?.mimeType).toBe('image/png');
      expect(Buffer.from(result.content[1]!.data!, 'base64').subarray(1, 4).toString()).toBe('PNG');
      await client.close();
    } finally {
      await local.close();
      await localBrowser.shutdown();
      await loggedOut.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
