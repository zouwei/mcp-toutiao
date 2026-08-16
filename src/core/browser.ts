/**
 * 浏览器管理：进程级单例的持久化 context + 串行队列 + 空闲回收。
 *
 * 三条设计约束（理由见 docs/specs/browser-session.md）：
 * 1. **持久化 context** 而不是 cookies.json —— 头条登录态不止 cookie，
 *    还有 localStorage / IndexedDB 里的设备与会话信息。
 * 2. **常驻而不是每次调用冷启** —— MCP 是常驻服务，冷启一次 2–5s 纯属浪费。
 * 3. **空闲回收** —— 但等扫码的会话会 pin 住，否则二维码会被回收掉。
 */
import { mkdirSync } from 'node:fs';
import type { BrowserContext, Page } from 'playwright';

import { paths, type Config } from '../config.js';
import { ToutiaoError, wrapError } from '../errors.js';
import type { Logger } from '../logger.js';
import { SerialQueue } from './queue.js';
import { applyStealthPatches, resolveChromium, STEALTH_LAUNCH_ARGS } from './stealth.js';

/** 各类等待的默认预算。超时错误里要能看出是哪一类，所以分开命名而不是一个常数 */
export const TIMEOUTS = {
  navigation: 30_000,
  selector: 15_000,
  upload: 60_000,
  publish: 30_000,
} as const;

export class BrowserManager {
  private context: BrowserContext | null = null;
  private launching: Promise<BrowserContext> | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private pins = 0;
  private closed = false;
  private readonly queue: SerialQueue;
  private readonly log: Logger;

  constructor(
    private readonly config: Config,
    logger: Logger,
  ) {
    this.log = logger.child('browser');
    this.queue = new SerialQueue(config.queueMax);
  }

  /** 队列里跑一段需要页面的活。工具层一律走这个入口，别自己拿 context */
  async withPage<T>(label: string, task: (page: Page) => Promise<T>): Promise<T> {
    return this.queue.run(async () => {
      const context = await this.ensureContext();
      const page = await context.newPage();
      page.setDefaultTimeout(TIMEOUTS.selector);
      page.setDefaultNavigationTimeout(TIMEOUTS.navigation);
      try {
        return await task(page);
      } finally {
        await page.close().catch(() => {});
        this.scheduleIdleClose();
      }
    }, label);
  }

  /**
   * 拿一个不受队列管辖、由调用方自己负责关闭的页面。
   * 只给「取二维码后在后台等扫码」这一种场景用 —— 它要活过工具调用本身。
   */
  async openDetachedPage(): Promise<Page> {
    const context = await this.ensureContext();
    const page = await context.newPage();
    page.setDefaultTimeout(TIMEOUTS.selector);
    page.setDefaultNavigationTimeout(TIMEOUTS.navigation);
    return page;
  }

  /** pin 住浏览器不被空闲回收（等扫码期间）。**必须成对调用** */
  pin(): void {
    this.pins++;
    this.clearIdleTimer();
  }

  unpin(): void {
    this.pins = Math.max(0, this.pins - 1);
    this.scheduleIdleClose();
  }

  get isRunning(): boolean {
    return this.context !== null;
  }

  get queueDepth(): number {
    return this.queue.pending;
  }

  private async ensureContext(): Promise<BrowserContext> {
    if (this.closed) throw new ToutiaoError('INTERNAL', '服务正在关闭，拒绝新的浏览器任务');
    if (this.context) return this.context;
    if (this.launching) return this.launching;

    this.launching = this.launch().finally(() => {
      this.launching = null;
    });
    return this.launching;
  }

  private async launch(): Promise<BrowserContext> {
    const { profile } = paths(this.config);
    mkdirSync(profile, { recursive: true });

    const chromium = await resolveChromium(this.config.stealth, this.log);
    this.log.info('launching browser', {
      headless: this.config.headless,
      profile,
      stealth: this.config.stealth,
      executablePath: this.config.browserPath ?? '(bundled)',
    });

    let context: BrowserContext;
    try {
      context = await chromium.launchPersistentContext(profile, {
        headless: this.config.headless,
        viewport: { width: 1440, height: 900 },
        locale: 'zh-CN',
        timezoneId: 'Asia/Shanghai',
        args: STEALTH_LAUNCH_ARGS,
        ignoreDefaultArgs: ['--enable-automation'],
        ...(this.config.browserPath ? { executablePath: this.config.browserPath } : {}),
        ...(this.config.proxy ? { proxy: { server: this.config.proxy } } : {}),
      });
    } catch (err) {
      throw wrapError(err, 'INTERNAL', {
        step: 'launch',
        detail: { hint: '浏览器启动失败：容器缺依赖或 profile 目录不可写；本机首次需 npx playwright install chromium' },
      });
    }

    await applyStealthPatches(context, this.config.stealth);

    // 浏览器自己没了（崩溃/被杀）要把引用清掉，否则下次调用会在一个死 context 上重试，
    // 报出来的错误跟真实原因毫无关系。
    context.on('close', () => {
      if (this.context === context) {
        this.context = null;
        this.log.warn('browser context closed');
      }
    });

    this.context = context;
    this.scheduleIdleClose();
    return context;
  }

  private scheduleIdleClose(): void {
    this.clearIdleTimer();
    if (!this.context || this.pins > 0 || this.closed) return;
    this.idleTimer = setTimeout(() => {
      if (this.pins > 0 || this.queue.pending > 0) {
        this.scheduleIdleClose();
        return;
      }
      this.log.info('idle timeout reached, closing browser');
      void this.closeContext();
    }, this.config.idleTimeoutMs);
    // 空闲计时器不该拖住进程退出
    this.idleTimer.unref?.();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private async closeContext(): Promise<void> {
    const context = this.context;
    this.context = null;
    if (context) await context.close().catch(() => {});
  }

  /** 进程退出时调用 */
  async shutdown(): Promise<void> {
    this.closed = true;
    this.clearIdleTimer();
    await this.closeContext();
  }
}
