/**
 * 发布结果判定：三层，从可靠到兜底。
 *
 *   1. 拦截发布接口的响应 → 拿到文章 id / url（最可靠）
 *   2. URL 变化（跳到作品管理/成功页）
 *   3. toast 文案
 *
 * **三层都读不到时返回成功但 verified:false**，不报失败 ——
 * 报失败会诱导调用方重发，而重复发布比「不确定」糟糕得多。
 * （对称规则见飞燕 interpretLoginResult：读不懂 ≠ 未登录。）
 */
import type { Page, Response } from 'playwright';

import { ToutiaoError } from '../errors.js';
import { captureScreenshot, readToast } from '../core/overlays.js';
import { PATHS } from '../core/selectors.js';

export interface PublishOutcome {
  url?: string;
  itemId?: string;
  verified: boolean;
  note?: string;
}

/** 发布接口的路径特征。宁可多匹配几个也不要漏 —— 拿不到 id 只是降级，不影响发布 */
const PUBLISH_API = /\/(mp\/agw\/article\/publish|article\/publish|weitoutiao\/publish|post\/publish|content\/publish)/i;
/** 从任意形状的响应体里捞出「人话」错误说明 */
function pickMessage(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const o = body as Record<string, unknown>;
  for (const key of ['message', 'msg', 'errmsg', 'error_msg', 'description', 'prompt', 'reason', 'tips']) {
    const v = o[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  for (const nested of ['data', 'result', 'error']) {
    const v = o[nested];
    if (v && typeof v === 'object') {
      const found = pickMessage(v);
      if (found) return found;
    }
  }
  return undefined;
}

/** 业务错误码（头条对失败也回 HTTP 200，真正的判据在这里） */
function pickCode(body: unknown): string | number | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const o = body as Record<string, unknown>;
  for (const key of ['code', 'errno', 'err_no', 'status_code']) {
    const v = o[key];
    if (typeof v === 'number' || typeof v === 'string') return v;
  }
  return undefined;
}

/** 平台判失败的常见文案 */
const FAILURE_HINTS = /(失败|不能|禁止|违规|敏感|超出|请先|未通过|错误)/;

export interface PublishWatcher {
  stop(): void;
  captured(): {
    url?: string;
    itemId?: string;
    /** 发布接口**回了**（哪怕是业务错误）—— 用来区分「请求没发出去」和「发了被拒」 */
    responded?: boolean;
    /** 平台自己给的错误码/说明。以前整个响应体只挑 id，其余全丢，等于把平台的原话扔了 */
    apiMessage?: string;
    apiCode?: string | number;
  };
}

/**
 * 从发布点击之前就挂上监听。挂晚了会错过响应 —— 这类竞态在偶发失败里最难查。
 */
export function watchPublishResponses(page: Page): PublishWatcher {
  let url: string | undefined;
  let itemId: string | undefined;
  let responded = false;
  let apiMessage: string | undefined;
  let apiCode: string | number | undefined;

  const onResponse = (response: Response): void => {
    if (!PUBLISH_API.test(response.url())) return;
    responded = true;
    void response
      .text()
      .then((raw: string) => {
        let body: unknown;
        try {
          body = JSON.parse(raw);
        } catch {
          return; // 不是 JSON 就算了，还有第二第三层
        }
        const found = extractIds(body);
        if (found.itemId && !itemId) itemId = found.itemId;
        if (found.url && !url) url = found.url;
        /**
         * 头条对业务失败也回 **HTTP 200**，错误藏在 body 的 code/message 里。
         * 只挑 id 的话，「发布被拒」和「网络没通」在我们这边长得一模一样 ——
         * 2026-08-17 就是这样连查了几轮：请求发出去了、200 回来了、内容却没发布。
         */
        if (!found.itemId) {
          const msg = pickMessage(body);
          if (msg && !apiMessage) apiMessage = msg.slice(0, 200);
          const code = pickCode(body);
          if (code !== undefined && apiCode === undefined) apiCode = code;
        }
      })
      .catch(() => {
        /* 读不到响应体不该盖过真正的错误 */
      });
  };

  page.on('response', onResponse);
  return {
    stop: () => page.off('response', onResponse),
    captured: () => ({
      ...(url ? { url } : {}),
      ...(itemId ? { itemId } : {}),
      ...(responded ? { responded } : {}),
      ...(apiMessage ? { apiMessage } : {}),
      ...(apiCode !== undefined ? { apiCode } : {}),
    }),
  };
}

/** 在返回体里找 id / url。头条各接口的字段名不统一，所以按候选键递归找 */
function extractIds(body: unknown): { url?: string; itemId?: string } {
  const result: { url?: string; itemId?: string } = {};
  const ID_KEYS = ['item_id', 'itemId', 'article_id', 'articleId', 'group_id', 'groupId', 'pgc_id'];
  const URL_KEYS = ['article_url', 'url', 'share_url', 'display_url'];

  const visit = (node: unknown, depth: number): void => {
    if (depth > 5 || node === null || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (!result.itemId && ID_KEYS.includes(key) && (typeof value === 'string' || typeof value === 'number')) {
        const text = String(value);
        if (/^\d{6,}$/.test(text)) result.itemId = text;
      }
      if (!result.url && URL_KEYS.includes(key) && typeof value === 'string' && /^https?:\/\//.test(value)) {
        result.url = value;
      }
      visit(value, depth + 1);
    }
  };

  visit(body, 0);
  return result;
}

/**
 * 判定结果。先看有没有失败 toast（失败必须报出来），再依次取三层证据。
 */
export async function resolvePublishOutcome(
  page: Page,
  watcher: PublishWatcher,
  step: string,
): Promise<PublishOutcome> {
  const toast = await readToast(page, 5000);
  if (toast && FAILURE_HINTS.test(toast)) {
    watcher.stop();
    throw new ToutiaoError('PUBLISH_REJECTED', `头条拒绝了这次发布：${toast}`, {
      step,
      detail: { toast },
      screenshot: await captureScreenshot(page),
    });
  }

  const captured = watcher.captured();
  watcher.stop();

  /**
   * 接口回了、却没给 id，还带着一句错误说明 → 这就是**平台明确拒绝**，
   * 不是「不确定」。把平台原话原样抛出去，别让用户再去后台猜。
   */
  if (captured.responded && !captured.itemId && captured.apiMessage) {
    throw new ToutiaoError('PUBLISH_REJECTED', `头条拒绝了这次发布：${captured.apiMessage}`, {
      step,
      detail: { apiCode: captured.apiCode, apiMessage: captured.apiMessage },
      screenshot: await captureScreenshot(page, true),
    });
  }

  if (captured.itemId || captured.url) {
    return {
      ...(captured.url ? { url: captured.url } : {}),
      ...(captured.itemId ? { itemId: captured.itemId } : {}),
      verified: true,
    };
  }

  const currentUrl = page.url();
  const leftEditor = !currentUrl.includes('publish');
  if (leftEditor && currentUrl.includes(PATHS.dashboard)) {
    return { url: currentUrl, verified: true };
  }

  if (toast) return { verified: true, note: `平台提示：${toast}` };

  /**
   * 拿不到任何证据。**措辞过去写成「内容很可能已经发出去了」，那是猜的，而且猜错了**：
   * 2026-08-17 真机核对，这种情况下文章根本没发出去（点击被 AI 助手抽屉拦截）。
   * 这里只如实说「没确认到」，该判成功还是失败由调用方决定（article.ts 判失败）。
   */
  return {
    verified: false,
    note: '未能从页面确认发布结果：没拿到接口响应、页面没跳转、也没有平台提示',
  };
}
