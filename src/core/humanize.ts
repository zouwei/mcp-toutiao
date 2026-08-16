/**
 * 人类化节奏。
 *
 * 不做鼠标轨迹模拟 —— 收益不明而复杂度高。等 spike B（无头扫码是否被风控）
 * 有结论再决定要不要加，现在只做最基本的：随机停顿 + 逐字输入。
 */
import type { Page } from 'playwright';

/** 可注入的随机源：测试里换成确定值，免得断言跟着骰子走 */
export interface Random {
  (): number;
}

export const defaultRandom: Random = Math.random;

/**
 * 人类化开关（进程级，启动时设一次）。
 *
 * 关掉之后所有停顿归零、打字不带延迟 —— **只给测试与本地调试用**：
 * 假站测试里这些停顿占了 95% 的时间，而它们防的是真站的风控，假站没有风控。
 * 生产别关：固定节奏与瞬时输入是最容易被识别的自动化特征。
 *
 * 用模块级状态而不是把 config 穿进每个调用点：pause() 有三十来个调用处，
 * 为一个时序开关污染所有签名不划算。代价是它是全局的 —— 所以只允许启动时设置。
 */
let humanizeEnabled = true;

export function setHumanizeEnabled(enabled: boolean): void {
  humanizeEnabled = enabled;
}

export function isHumanizeEnabled(): boolean {
  return humanizeEnabled;
}

export function randomInt(min: number, max: number, rng: Random = defaultRandom): number {
  return Math.floor(rng() * (max - min + 1)) + min;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 随机停顿。默认区间偏短：慢不等于像人，卡半天更像脚本挂了 */
export function pause(min = 200, max = 800, rng: Random = defaultRandom): Promise<void> {
  if (!humanizeEnabled) return Promise.resolve();
  return sleep(randomInt(min, max, rng));
}

/**
 * 逐字输入。Playwright 的 `type` 自带 delay，但固定 delay 本身就是个特征，
 * 所以按字符给随机 delay。
 */
export async function typeLikeHuman(
  page: Page,
  text: string,
  opts: { minDelay?: number; maxDelay?: number; rng?: Random } = {},
): Promise<void> {
  if (!humanizeEnabled) {
    await page.keyboard.type(text);
    return;
  }
  const { minDelay = 50, maxDelay = 130, rng = defaultRandom } = opts;
  for (const ch of text) {
    await page.keyboard.type(ch, { delay: randomInt(minDelay, maxDelay, rng) });
  }
}

/**
 * 逐段输入：段落之间按 Enter。
 * 用于微头条这类纯文本框 —— 一次性 type 整段带 \n 的文本，换行会被吃掉。
 */
export async function typeParagraphs(
  page: Page,
  text: string,
  opts: { rng?: Random } = {},
): Promise<void> {
  const paragraphs = text.split('\n');
  for (let i = 0; i < paragraphs.length; i++) {
    const para = paragraphs[i];
    if (para) await typeLikeHuman(page, para, { minDelay: 30, maxDelay: 80, ...opts });
    if (i < paragraphs.length - 1) {
      await page.keyboard.press('Enter');
      await pause(100, 300, opts.rng);
    }
  }
}
