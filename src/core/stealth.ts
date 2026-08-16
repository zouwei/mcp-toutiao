/**
 * 反自动化特征处理，三档可切（`TOUTIAO_STEALTH`）。
 *
 * 为什么默认不是 playwright-extra + puppeteer-extra-plugin-stealth：
 * 它拖进整个 puppeteer-extra 生态，而我们真正需要的只是几行 addInitScript
 * 与启动参数。更重要的是 —— **无头扫码是否会被风控是 spike B 的未知数**，
 * 把这一层做成可替换比赌某个方案划算。三条退路：
 *   builtin（默认，自带补丁）→ extra（装了 playwright-extra 就接管 launch）
 *   → TOUTIAO_BROWSER_PATH 换整个指纹浏览器。
 */
import { chromium as playwrightChromium } from 'playwright';
import type { BrowserContext, BrowserType } from 'playwright';
import type { StealthMode } from '../config.js';
import type { Logger } from '../logger.js';

/** 启动参数：headless 最明显的特征来自这几个开关 */
export const STEALTH_LAUNCH_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-infobars',
  // 容器里 /dev/shm 默认只有 64MB，Chromium 渲染大页面会崩成白屏 / target closed。
  // 飞燕的容器 spec 没有 shmSize 字段，只能从浏览器这边解决。
  '--disable-dev-shm-usage',
];

/**
 * 页面级补丁，在**每个新文档**执行（addInitScript），所以 iframe 内的页面也覆盖得到。
 * 只补最容易被查的几项 —— 补得越多越容易补出破绽（比如伪造一个与 UA 不一致的 platform）。
 */
const BUILTIN_PATCH = `
(() => {
  try {
    Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => undefined, configurable: true });
  } catch {}
  try {
    Object.defineProperty(Navigator.prototype, 'languages', {
      get: () => ['zh-CN', 'zh', 'en'], configurable: true,
    });
  } catch {}
  try {
    if (!window.chrome) {
      Object.defineProperty(window, 'chrome', { value: { runtime: {} }, configurable: true });
    }
  } catch {}
  try {
    const permissions = window.navigator.permissions;
    const originalQuery = permissions && permissions.query;
    if (originalQuery) {
      permissions.query = (parameters) =>
        parameters && parameters.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission })
          : originalQuery.call(permissions, parameters);
    }
  } catch {}
})();
`;

/**
 * 选一个 chromium 实现。
 *
 * `extra` 档要在 **launch 之前**接管（插件是在启动时织入的），所以这件事必须由
 * browser.ts 在建 context 前问一次，而不能等 context 建好再打补丁。
 * 没装依赖就退回官方 chromium 并 warn —— 这层是加固，不是运行前提。
 */
export async function resolveChromium(mode: StealthMode, logger: Logger): Promise<BrowserType> {
  if (mode !== 'extra') return playwrightChromium;

  try {
    // 动态 import + 变量 specifier：没装这两个可选依赖时，打包/类型检查都不该失败
    const extraSpecifier = 'playwright-extra';
    const stealthSpecifier = 'puppeteer-extra-plugin-stealth';
    const extra = (await import(/* @vite-ignore */ extraSpecifier)) as {
      chromium: BrowserType & { use: (plugin: unknown) => void };
    };
    const stealth = (await import(/* @vite-ignore */ stealthSpecifier)) as {
      default: () => unknown;
    };
    extra.chromium.use(stealth.default());
    logger.info('stealth: 已启用 playwright-extra + stealth 插件');
    return extra.chromium;
  } catch (err) {
    logger.warn('stealth: playwright-extra / stealth 插件不可用，回退 builtin', {
      reason: err instanceof Error ? err.message : String(err),
    });
    return playwrightChromium;
  }
}

/** 页面补丁。`extra` 档也照打：两者补的点不完全重合，重复定义同一属性是幂等的 */
export async function applyStealthPatches(
  context: BrowserContext,
  mode: StealthMode,
): Promise<void> {
  if (mode === 'off') return;
  await context.addInitScript(BUILTIN_PATCH);
}
