/**
 * 遮挡物清理 + 现场取证（截图 / 风控探测）。
 *
 * 头条后台常年有活动弹窗、新手引导、位置权限提示。任何点击之前先清一遍，
 * 否则点击会打在遮罩上 —— 报错是「元素不可见」，与真实原因相隔十万八千里。
 */
import type { Page } from 'playwright';
import { SELECTORS, TEXTS } from './selectors.js';
import { pause } from './humanize.js';
import { ToutiaoError } from '../errors.js';

/**
 * 关掉/隐藏页面上的弹窗与遮罩。
 *
 * **注意**：兜底那步是 `display:none` 隐藏 `.byte-drawer-wrapper`，而封面上传抽屉
 * 正是我们自己要用的。所以本函数只在「进入页面后」和「点发布前」调用，
 * 上传流程内部绝不调 —— 否则会把自己要用的抽屉藏掉。
 */
export async function dismissOverlays(page: Page, rounds = 3): Promise<number> {
  let total = 0;
  for (let i = 0; i < rounds; i++) {
    const closed = await page
      .evaluate((dismissTexts: readonly string[]) => {
        let count = 0;
        const closeSelectors = [
          '.byte-modal-wrapper .byte-modal-close',
          '.byte-modal-wrapper [class*="close"]',
          '[class*="modal"] [class*="close"]',
          '[class*="dialog"] [class*="close"]',
          '[class*="popup"] [class*="close"]',
          '[role="dialog"] [class*="close"]',
          '[class*="banner"] [class*="close"]',
          '[class*="guide"] [class*="close"]',
        ];
        for (const selector of closeSelectors) {
          document.querySelectorAll(selector).forEach((el) => {
            try {
              (el as HTMLElement).click();
              count++;
            } catch {
              /* 关不掉就算了，下一轮兜底隐藏 */
            }
          });
        }

        // 文案按钮：「我知道了」「稍后再说」「一律不允许」……
        // 限宽 400px 是为了避开整块横幅里的大按钮（点它可能是跳转而不是关闭）
        const clickable = document.querySelectorAll('button, [role="button"], a, span, div');
        for (const el of clickable) {
          const text = el.textContent?.trim();
          if (!text || text.length > 12) continue;
          if (!dismissTexts.some((t) => text === t || text.startsWith(t))) continue;
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0 && rect.width < 400) {
            try {
              (el as HTMLElement).click();
              count++;
            } catch {
              /* 同上 */
            }
          }
        }

        // 兜底：隐藏遮罩层。不删节点 —— 删了页面的框架代码可能报错
        document
          .querySelectorAll(
            '.byte-modal-wrapper, [class*="modal-mask"], [class*="drawer-mask"], [class*="banner-wrap"]',
          )
          .forEach((el) => {
            (el as HTMLElement).style.display = 'none';
            count++;
          });

        return count;
      }, TEXTS.dismiss)
      .catch(() => 0);

    total += closed;
    if (closed === 0) break;
    await pause(300, 600);
  }

  await page.keyboard.press('Escape').catch(() => {});
  return total;
}

/** 现场截图：base64 PNG（不带 data: 前缀，MCP image 块要的就是裸 base64） */
export async function captureScreenshot(page: Page): Promise<string | undefined> {
  try {
    const buffer = await page.screenshot({ type: 'png', fullPage: false, timeout: 10_000 });
    return buffer.toString('base64');
  } catch {
    // 截图失败不该盖过真正的错误
    return undefined;
  }
}

/**
 * 风控探测。发现滑块/验证码就抛 —— 继续操作只会把账号推得更深。
 * 附截图：这类问题必须人看一眼才知道该怎么办。
 */
export async function assertNoCaptcha(page: Page, step: string): Promise<void> {
  const captcha = page.locator(SELECTORS.captcha).first();
  const visible = await captcha.isVisible({ timeout: 1000 }).catch(() => false);
  if (!visible) return;

  throw new ToutiaoError(
    'CAPTCHA_REQUIRED',
    '页面出现验证码/滑块，自动化无法继续 —— 需要人工在有头模式下通过验证（TOUTIAO_HEADLESS=false），或更换出口 IP 后重试',
    { step, screenshot: await captureScreenshot(page) },
  );
}

/** 读取页面 toast 文案（发布结果判定的第三层，也是失败原因的主要来源） */
export async function readToast(page: Page, timeout = 3000): Promise<string | undefined> {
  const toast = page.locator(SELECTORS.toast).first();
  try {
    await toast.waitFor({ state: 'visible', timeout });
    const text = (await toast.textContent())?.trim();
    return text || undefined;
  } catch {
    return undefined;
  }
}
