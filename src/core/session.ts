/**
 * 登录态：判定、取二维码、登出。
 *
 * 三条不容妥协的规则（理由见 docs/specs/browser-session.md §3–4）：
 * 1. 登录判定看 **URL 落点**，不看 cookie 在不在 —— cookie 还在但已失效是最常见的状态。
 * 2. 取码工具**不等扫码结果**：调用方（飞燕）的 SDK 默认 60s 超时，等扫码要 1–5 分钟，
 *    等下去必定是超时错误而不是二维码。后台留一个页面继续等。
 * 3. 同一时刻**只保留一个待扫码会话** —— 否则每调一次取码就多一个浏览器页面活到超时。
 */
import type { Page } from 'playwright';

import type { Config } from '../config.js';
import { ToutiaoError, wrapError } from '../errors.js';
import type { Logger } from '../logger.js';
import type { BrowserManager } from './browser.js';
import { assertNoCaptcha, captureScreenshot, dismissOverlays } from './overlays.js';
import { buildUrls, PATHS, SELECTORS, type SiteUrls } from './selectors.js';
import { pause } from './humanize.js';

export interface LoginStatus {
  is_logged_in: boolean;
  user?: { name?: string; media_id?: string };
  message?: string;
}

export interface QrcodeResult {
  /** 裸 base64 PNG（MCP image 块要的形态） */
  image: string;
  /** 提示文本，含绝对过期时间 —— 飞燕的 normalizeQrcode 会从文本里解析它 */
  hint: string;
  expiresAt: string;
  timeoutSec: number;
}

/** 二维码大约 50 秒刷新一次（toutiao-ops 实测值），过期时间按此给 */
const QR_TTL_SEC = 50;

export class SessionManager {
  private readonly log: Logger;
  private readonly urls: SiteUrls;
  /** 当前待扫码会话的取消钩子。开新的就把旧的关掉 */
  private pendingLogin: { seq: number; cancel: () => void } | null = null;
  private seq = 0;

  constructor(
    private readonly browser: BrowserManager,
    private readonly config: Config,
    logger: Logger,
  ) {
    this.log = logger.child('session');
    this.urls = buildUrls(config.baseUrl);
  }

  /** 进入后台首页并等重定向落定 */
  private async settleOnHome(page: Page): Promise<string> {
    await page.goto(this.urls.home, { waitUntil: 'domcontentloaded' });
    // 头条会做几跳（未登录 → 登录页；已登录 → dashboard）。等到落进任一已知路径为止，
    // 等不到也不报错 —— 下面按当前 URL + 页面特征判定。
    await page
      .waitForURL(
        (url) => {
          const s = url.toString();
          return s.includes(PATHS.dashboard) || s.includes(PATHS.login) || s.includes(PATHS.ssoHost);
        },
        { timeout: 15_000 },
      )
      .catch(() => {});
    return page.url();
  }

  static isLoginUrl(url: string): boolean {
    return url.includes(PATHS.login) || url.includes(PATHS.ssoHost);
  }

  static isDashboardUrl(url: string): boolean {
    return url.includes(PATHS.dashboard) && !url.includes(PATHS.login);
  }

  async checkStatus(): Promise<LoginStatus> {
    return this.browser.withPage('check_login_status', async (page) => {
      const url = await this.settleOnHome(page);

      if (SessionManager.isLoginUrl(url)) {
        return { is_logged_in: false, message: '未登录 —— 请调用 get_login_qrcode 扫码登录' };
      }

      if (SessionManager.isDashboardUrl(url)) {
        return { is_logged_in: true, ...(await readUserInfo(page)) };
      }

      // URL 说不清楚时看页面特征。读不出来就算未登录（发布流程自己还会再撞一次墙，
      // 信息一样到得了人手里），但**不因为读不到昵称就判未登录**。
      const hasDashboard = await page
        .locator(SELECTORS.dashboardMarker)
        .first()
        .isVisible({ timeout: 3000 })
        .catch(() => false);
      if (hasDashboard) return { is_logged_in: true, ...(await readUserInfo(page)) };

      return { is_logged_in: false, message: '未登录 —— 请调用 get_login_qrcode 扫码登录' };
    });
  }

  /** 发布流程的前置门。未登录直接抛，不自动弹码（取码是独立工具，agent 自己决定何时扫） */
  async ensureLoggedIn(page: Page): Promise<void> {
    const url = page.url();
    if (SessionManager.isDashboardUrl(url)) return;

    const status = await this.settleOnHome(page);
    if (SessionManager.isLoginUrl(status)) {
      throw new ToutiaoError(
        'NOT_LOGGED_IN',
        '头条号未登录或登录已失效 —— 请调用 get_login_qrcode 用今日头条 App 扫码后重试',
        { step: 'ensure_login' },
      );
    }
  }

  /**
   * 取二维码。**立刻返回**，后台继续等扫码。
   *
   * 已登录时不开新会话，直接回一句「已登录」—— 否则会给出一个永远等不到扫码的二维码。
   */
  async getQrcode(): Promise<QrcodeResult | { alreadyLoggedIn: true; status: LoginStatus }> {
    const status = await this.checkStatus();
    if (status.is_logged_in) return { alreadyLoggedIn: true, status };

    // 关掉上一个待扫码会话。放在锁外的等价物：先取出再调用，避免相互等待
    const previous = this.pendingLogin;
    this.pendingLogin = null;
    previous?.cancel();

    const seq = ++this.seq;
    this.browser.pin(); // 等扫码期间不许空闲回收
    let page: Page;
    try {
      page = await this.browser.openDetachedPage();
    } catch (err) {
      this.browser.unpin();
      throw wrapError(err, 'INTERNAL', { step: 'qrcode_open_page' });
    }

    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      if (this.pendingLogin?.seq === seq) this.pendingLogin = null;
      void page.close().catch(() => {});
      this.browser.unpin();
    };
    this.pendingLogin = { seq, cancel: release };

    try {
      await page.goto(this.urls.login, { waitUntil: 'domcontentloaded' });
      await dismissOverlays(page);
      await assertNoCaptcha(page, 'qrcode');

      const qr = page.locator(SELECTORS.loginQrcode).first();
      await qr.waitFor({ state: 'visible', timeout: 20_000 });
      await pause(300, 700);

      // 截二维码元素本身而不是整页：整页截图里二维码太小，手机扫不出来
      const buffer = await qr.screenshot({ type: 'png', timeout: 10_000 });
      const expiresAt = new Date(Date.now() + QR_TTL_SEC * 1000);

      // 后台继续等扫码 —— 不 await
      void this.waitForScan(page, seq, release);

      return {
        image: buffer.toString('base64'),
        hint:
          `请用今日头条 App 扫描二维码登录（二维码约 ${QR_TTL_SEC} 秒后失效，` +
          `请在 ${formatLocal(expiresAt)} 前完成扫码）。` +
          `扫码后调用 check_login_status 确认登录结果。`,
        expiresAt: expiresAt.toISOString(),
        timeoutSec: QR_TTL_SEC,
      };
    } catch (err) {
      const screenshot = await captureScreenshot(page);
      release();
      throw wrapError(err, 'LOGIN_TIMEOUT', {
        step: 'qrcode',
        ...(screenshot ? { screenshot } : {}),
      });
    }
  }

  /** 后台等扫码：URL 到达 dashboard 即认为成功（persistent context 会自动落盘） */
  private async waitForScan(page: Page, seq: number, release: () => void): Promise<void> {
    try {
      await page.waitForURL((url) => SessionManager.isDashboardUrl(url.toString()), {
        timeout: this.config.loginWaitMs,
      });
      this.log.info('login succeeded via qrcode scan', { seq });
    } catch {
      this.log.warn('login session ended without a successful scan', { seq });
    } finally {
      release();
    }
  }

  /** 登出：清站点会话。下次要重新扫码 —— 所以这在飞燕侧是个独立的确认动作 */
  async logout(): Promise<{ ok: true }> {
    const previous = this.pendingLogin;
    this.pendingLogin = null;
    previous?.cancel();

    return this.browser.withPage('logout', async (page) => {
      await page.goto(this.urls.home, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.context().clearCookies();
      // localStorage / sessionStorage 也要清：头条把部分会话信息放在那里，
      // 只清 cookie 会留下一个「半登录」状态，比彻底登出更难排查。
      await page
        .evaluate(() => {
          try {
            localStorage.clear();
            sessionStorage.clear();
          } catch {
            /* 跨域限制时忽略 */
          }
        })
        .catch(() => {});
      this.log.info('logged out, storage cleared');
      return { ok: true as const };
    });
  }

  /** 进程退出时把待扫码会话收掉 */
  dispose(): void {
    const previous = this.pendingLogin;
    this.pendingLogin = null;
    previous?.cancel();
  }
}

/** 昵称/media_id：尽力而为。取不到就不返回该字段，绝不因此判定未登录 */
async function readUserInfo(page: Page): Promise<{ user?: LoginStatus['user'] }> {
  const name = await page
    .evaluate(() => {
      const candidates = [
        '[class*="user-name"]',
        '[class*="userName"]',
        '[class*="account-name"]',
        '[class*="nick"]',
      ];
      for (const selector of candidates) {
        const text = document.querySelector(selector)?.textContent?.trim();
        if (text) return text;
      }
      return '';
    })
    .catch(() => '');

  const mediaId = await page
    .evaluate(() => {
      const match = /media_id["'\s:=]+(\d{6,})/.exec(document.documentElement.innerHTML);
      return match?.[1] ?? '';
    })
    .catch(() => '');

  if (!name && !mediaId) return {};
  return {
    user: {
      ...(name ? { name } : {}),
      ...(mediaId ? { media_id: mediaId } : {}),
    },
  };
}

function formatLocal(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}
