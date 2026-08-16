/**
 * 微头条发布。
 *
 * 与文章最大的不同：正文是**纯文本**框，Markdown 标记会原样显示给读者。
 * 所以先 toPlainText 脱标记、**再**算字数 —— 顺序反了就是在为垃圾做压缩
 * （飞燕小红书链路踩过这个坑）。`#话题` 必须保留：它是内容不是语法。
 */
import type { Page } from 'playwright';

import { wrapError } from '../errors.js';
import type { Logger } from '../logger.js';
import { pause, typeParagraphs } from '../core/humanize.js';
import { assertNoCaptcha, captureScreenshot, dismissOverlays } from '../core/overlays.js';
import { buildUrls, LIMITS, SELECTORS, TEXTS } from '../core/selectors.js';
import { toPlainText } from '../content/markdown.js';
import {
  validateImageCount,
  validateImageRefs,
  validateWeitoutiaoContent,
  isRemote,
} from '../content/validate.js';
import { focusEditor } from './paste.js';
import { resolvePublishOutcome, watchPublishResponses } from './result.js';
import type { FlowDeps } from './article.js';

export interface PublishWeitoutiaoParams {
  content: string;
  images?: string[];
  topic?: string;
  first_publish?: boolean;
  declarations?: string[];
  draft?: boolean;
}

export interface PublishWeitoutiaoResult {
  success: true;
  action: 'published' | 'draft_saved';
  url?: string;
  itemId?: string;
  verified: boolean;
  length: number;
  images: number;
  note?: string;
}

export async function publishWeitoutiao(
  deps: FlowDeps,
  params: PublishWeitoutiaoParams,
): Promise<PublishWeitoutiaoResult> {
  const { browser, session, config, logger } = deps;
  const log = logger.child('weitoutiao');

  const text = toPlainText(params.content);
  validateWeitoutiaoContent(text);

  const images = (params.images ?? []).filter((ref) => !isRemote(ref));
  const remote = (params.images ?? []).filter(isRemote);
  validateImageRefs(params.images ?? [], 'images');
  validateImageCount(params.images ?? [], LIMITS.weitoutiaoImagesMax, 'images');
  if (remote.length > 0) {
    // 微头条的图只能走本地文件上传，没有「粘贴外链让平台转存」这条路
    throw wrapError(
      new Error(`微头条配图必须是本地绝对路径，收到 ${remote.length} 个网络地址`),
      'BAD_INPUT',
      { step: 'validate', detail: { remote } },
    );
  }

  return browser.withPage('publish_weitoutiao', async (page) => {
    await session.ensureLoggedIn(page);
    await page.goto(buildUrls(config.baseUrl).weitoutiaoPublish, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    await pause(1000, 2000);
    await dismissOverlays(page);
    await assertNoCaptcha(page, 'weitoutiao_open');

    // ── 正文：逐段输入（纯文本框，一次性带 \n 打进去换行会被吃掉） ──
    await focusEditor(page, 'weitoutiao_body');
    await typeParagraphs(page, text);
    await pause(500, 1000);

    // ── 配图 ──
    if (images.length > 0) await uploadImages(page, images, log);

    // ── 可选项 ──
    if (params.topic) await setTopic(page, params.topic);
    if (params.first_publish) {
      await page.getByText(TEXTS.firstPublish, { exact: false }).first().click({ timeout: 5000 }).catch(() => {});
    }
    for (const item of params.declarations ?? []) {
      const label = TEXTS.declarations[item] ?? item;
      await page.getByText(label, { exact: false }).first().click({ timeout: 4000 }).catch(() => {});
      await pause(200, 400);
    }
    await pause(400, 900);

    await dismissOverlays(page);
    await assertNoCaptcha(page, 'weitoutiao_publish');
    const watcher = watchPublishResponses(page);

    try {
      const buttonName = params.draft ? TEXTS.weitoutiaoDraftButton : TEXTS.weitoutiaoPublishButton;
      await page.getByRole('button', { name: buttonName, exact: true }).first().click({ timeout: 15_000 });
      await pause(2000, 3500);
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    } catch (err) {
      watcher.stop();
      const screenshot = await captureScreenshot(page);
      throw wrapError(err, 'PUBLISH_REJECTED', {
        step: params.draft ? 'weitoutiao_draft_click' : 'weitoutiao_publish_click',
        ...(screenshot ? { screenshot } : {}),
      });
    }

    if (params.draft) {
      watcher.stop();
      log.info('weitoutiao saved as draft');
      return {
        success: true as const,
        action: 'draft_saved' as const,
        verified: true,
        length: [...text].length,
        images: images.length,
      };
    }

    const outcome = await resolvePublishOutcome(page, watcher, 'weitoutiao_publish');
    log.info('weitoutiao published', { verified: outcome.verified });

    return {
      success: true as const,
      action: 'published' as const,
      ...(outcome.url ? { url: outcome.url } : {}),
      ...(outcome.itemId ? { itemId: outcome.itemId } : {}),
      verified: outcome.verified,
      length: [...text].length,
      images: images.length,
      ...(outcome.note ? { note: outcome.note } : {}),
    };
  });
}

async function uploadImages(page: Page, files: string[], log: Logger): Promise<void> {
  try {
    // 先试直接喂 file input（少一次 UI 依赖）；没有再点「图片」按钮触发 filechooser
    const input = page.locator(SELECTORS.fileInput).first();
    if (await input.count().then((n) => n > 0).catch(() => false)) {
      await input.setInputFiles(files);
    } else {
      const [chooser] = await Promise.all([
        page.waitForEvent('filechooser', { timeout: 15_000 }),
        page.getByText(TEXTS.imageEntry, { exact: false }).first().click({ timeout: 10_000 }),
      ]);
      await chooser.setFiles(files);
    }
    await pause(3000, 5000);

    const confirm = page.locator(SELECTORS.drawerConfirm).first();
    if (await confirm.isVisible({ timeout: 8000 }).catch(() => false)) {
      await confirm.click();
      await pause(1000, 2000);
    }
    log.info('weitoutiao images uploaded', { count: files.length });
  } catch (err) {
    const screenshot = await captureScreenshot(page);
    throw wrapError(err, 'IMAGE_UPLOAD_FAILED', {
      step: 'weitoutiao_images',
      detail: { count: files.length },
      ...(screenshot ? { screenshot } : {}),
    });
  }
}

async function setTopic(page: Page, topic: string): Promise<void> {
  try {
    await focusEditor(page, 'weitoutiao_topic');
    await page.keyboard.type(`#${topic}`, { delay: 60 });
    await pause(800, 1500);
    // 话题下拉里选第一个候选；选不到就保留 #话题 文本（仍然是内容，不算失败）
    await page.getByText(topic, { exact: false }).first().click({ timeout: 4000 }).catch(() => {});
  } catch {
    // 话题加不上不阻塞发布
  }
}
