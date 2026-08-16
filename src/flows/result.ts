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
/** 平台判失败的常见文案 */
const FAILURE_HINTS = /(失败|不能|禁止|违规|敏感|超出|请先|未通过|错误)/;

export interface PublishWatcher {
  stop(): void;
  captured(): { url?: string; itemId?: string };
}

/**
 * 从发布点击之前就挂上监听。挂晚了会错过响应 —— 这类竞态在偶发失败里最难查。
 */
export function watchPublishResponses(page: Page): PublishWatcher {
  let url: string | undefined;
  let itemId: string | undefined;

  const onResponse = (response: Response): void => {
    if (!PUBLISH_API.test(response.url())) return;
    void response
      .json()
      .then((body: unknown) => {
        const found = extractIds(body);
        if (found.itemId && !itemId) itemId = found.itemId;
        if (found.url && !url) url = found.url;
      })
      .catch(() => {
        /* 不是 JSON 就算了，还有第二第三层 */
      });
  };

  page.on('response', onResponse);
  return {
    stop: () => page.off('response', onResponse),
    captured: () => ({ ...(url ? { url } : {}), ...(itemId ? { itemId } : {}) }),
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

  return {
    verified: false,
    note: '未能从页面确认发布结果（没拿到接口响应、页面也没跳转）—— 内容很可能已经发出去了，请到头条后台核对后再决定是否重发',
  };
}
