/**
 * 临时静态文件服务：把本地图片暴露给页面（`paste-url` 策略需要一个 http URL）。
 *
 * 三条约束，都是安全考虑：
 * 1. **只监听 127.0.0.1**，端口随机 —— 不给局域网任何可达面。
 * 2. 只服务**显式登记过的文件**，用随机 token 作路径 —— 不是一个目录静态服务器，
 *    路径穿越无从谈起。
 * 3. **发布完立即关闭**，不长驻。
 */
import { createReadStream, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { extname } from 'node:path';

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

export class TempFileServer {
  private server: Server | null = null;
  private readonly files = new Map<string, string>(); // token → 绝对路径
  private origin = '';

  async start(): Promise<void> {
    if (this.server) return;
    const server = createServer((req, res) => {
      const token = (req.url ?? '').replace(/^\/+/, '').split('?')[0] ?? '';
      const file = this.files.get(token);
      if (!file) {
        res.writeHead(404).end();
        return;
      }
      try {
        const size = statSync(file).size;
        res.writeHead(200, {
          'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
          'content-length': String(size),
          'cache-control': 'no-store',
        });
        createReadStream(file).pipe(res);
      } catch {
        res.writeHead(500).end();
      }
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });

    const address = server.address();
    if (typeof address === 'object' && address) this.origin = `http://127.0.0.1:${address.port}`;
    this.server = server;
  }

  /** 登记一个文件，返回可访问的 URL */
  publish(absolutePath: string): string {
    const token = randomBytes(12).toString('hex') + extname(absolutePath);
    this.files.set(token, absolutePath);
    return `${this.origin}/${token}`;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.files.clear();
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
