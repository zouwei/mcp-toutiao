/**
 * 图文文章发布。
 *
 * 步骤序列见 docs/specs/publish-flows.md §1。这里只做编排，
 * 具体定位在 core/selectors.ts，具体机制在 paste.ts / images.ts / result.ts。
 */
import type { Page } from 'playwright';

import type { Config, ImageStrategy } from '../config.js';
import { wrapError } from '../errors.js';
import type { Logger } from '../logger.js';
import type { BrowserManager } from '../core/browser.js';
import type { SessionManager } from '../core/session.js';
import { pause, typeLikeHuman } from '../core/humanize.js';
import { assertNoCaptcha, captureScreenshot, dismissOverlays } from '../core/overlays.js';
import { buildUrls, SELECTORS, TEXTS } from '../core/selectors.js';
import { TempFileServer } from '../core/file-server.js';
import { applyImageSources, renderArticleHtml, toPlainText } from '../content/markdown.js';
import {
  validateArticleContent,
  validateArticleTitle,
  validateImageRefs,
  isRemote,
} from '../content/validate.js';
import { pasteRichText, clearEditor } from './paste.js';
import {
  planInlineImages,
  pasteSegmentedWithUploads,
  uploadCover,
  verifyImagesTransferred,
} from './images.js';
import { resolvePublishOutcome, watchPublishResponses } from './result.js';

export interface PublishArticleParams {
  title: string;
  content: string;
  images?: string[];
  cover?: string[];
  cover_mode?: 'auto' | 'single' | 'triple' | 'none';
  first_publish?: boolean;
  also_weitoutiao?: boolean;
  declarations?: string[];
  collection?: string;
  draft?: boolean;
}

export interface PublishArticleResult {
  success: true;
  action: 'published' | 'draft_saved';
  title: string;
  url?: string;
  itemId?: string;
  verified: boolean;
  imageStrategy: ImageStrategy;
  images: number;
  cover: { uploaded: number; mode: string };
  note?: string;
}

export interface FlowDeps {
  browser: BrowserManager;
  session: SessionManager;
  config: Config;
  logger: Logger;
}

export async function publishArticle(
  deps: FlowDeps,
  params: PublishArticleParams,
): Promise<PublishArticleResult> {
  const { browser, session, config, logger } = deps;
  const log = logger.child('article');

  // ── 打开浏览器之前先把能查的都查掉 ──
  const title = params.title.trim();
  validateArticleTitle(title);
  validateArticleContent(params.content);
  const inlineRefs = params.images ?? [];
  const coverRefs = params.cover ?? [];
  validateImageRefs(inlineRefs, 'images');
  validateImageRefs(coverRefs, 'cover');

  const rendered = renderArticleHtml(params.content);
  // 正文里写了 ![]() 就以正文为准；只传了 images 参数而正文没写，则追加到文末 ——
  // 否则调用方传了图却哪儿都看不到，这种「安静地什么都没发生」最难查。
  const article = appendOrphanImages(rendered, inlineRefs);
  const plain = toPlainText(params.content);
  const covers = coverRefs.length > 0 ? coverRefs : inlineRefs.filter((ref) => !isRemote(ref));

  const tempServer = new TempFileServer();

  return browser
    .withPage('publish_article', async (page) => {
      await session.ensureLoggedIn(page);
      await page.goto(buildUrls(config.baseUrl).articlePublish, { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
      await pause(1000, 2000);
      await dismissOverlays(page);
      await assertNoCaptcha(page, 'article_open');

      // ── 标题 ──
      const titleBox = page.locator(SELECTORS.articleTitle).first();
      await titleBox.waitFor({ state: 'visible', timeout: 15_000 });
      await titleBox.click();
      await pause(200, 500);
      await typeLikeHuman(page, title);
      await pause(400, 800);

      // ── 正文（含插图策略） ──
      const usedStrategy = await writeBody(page, article, plain, config.imageStrategy, tempServer, log);

      // ── 封面 ──
      const cover = await uploadCover(page, params.cover_mode ?? 'auto', covers, log);

      // ── 可选项 ──
      if (params.first_publish) await clickByText(page, TEXTS.firstPublish);
      if (params.collection) await addToCollection(page, params.collection);
      // 平台默认勾选「同时发布微头条」：不显式要就取消掉，
      // 否则调用方以为发了 1 条、实际发了 2 条
      if (params.also_weitoutiao !== true) await uncheckAlsoWeitoutiao(page);
      if (params.declarations?.length) await setDeclarations(page, params.declarations);
      await pause(400, 900);

      if (params.draft) {
        // 文章页没有独立的「存草稿」按钮 —— 编辑即自动存草稿
        log.info('draft mode: content filled, not publishing');
        return {
          success: true as const,
          action: 'draft_saved' as const,
          title,
          verified: true,
          imageStrategy: usedStrategy,
          images: article.images.length,
          cover,
          note: '内容已填入并由头条自动存为草稿，可在创作中心「内容管理 → 草稿」里确认后手动发布',
        };
      }

      // ── 发布 ──
      await dismissOverlays(page);
      await assertNoCaptcha(page, 'article_publish');
      const watcher = watchPublishResponses(page); // 必须在点击之前挂上

      try {
        const publishButton = page.getByRole('button', { name: TEXTS.articlePublishButton }).first();
        await publishButton.scrollIntoViewIfNeeded().catch(() => {});
        await pause(300, 600);
        await publishButton.click({ timeout: 15_000 });
        await pause(2500, 4000);

        // 预览页再点一次确认；有的账号还会多一层「确定」
        await clickAnyButton(page, [TEXTS.confirmPublishButton, ...TEXTS.genericConfirm], 12_000);
        await pause(1500, 3000);
        await clickAnyButton(page, [...TEXTS.genericConfirm], 5000);
        await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
      } catch (err) {
        watcher.stop();
        throw wrapError(err, 'PUBLISH_REJECTED', {
          step: 'article_publish_click',
          ...(await shot(page)),
        });
      }

      const outcome = await resolvePublishOutcome(page, watcher, 'article_publish');
      log.info('article published', { title, verified: outcome.verified });

      return {
        success: true as const,
        action: 'published' as const,
        title,
        ...(outcome.url ? { url: outcome.url } : {}),
        ...(outcome.itemId ? { itemId: outcome.itemId } : {}),
        verified: outcome.verified,
        imageStrategy: usedStrategy,
        images: article.images.length,
        cover,
        ...(outcome.note ? { note: outcome.note } : {}),
      };
    })
    .finally(() => {
      // 临时静态服务必须关掉：它持有本地文件的访问入口
      void tempServer.stop();
    });
}

/**
 * 写正文，按策略处理插图，必要时逐级回落。
 * 返回**实际生效**的策略 —— 调用方（与 spike）要据此判断哪条路真的能用。
 */
async function writeBody(
  page: Page,
  article: ReturnType<typeof renderArticleHtml>,
  plain: string,
  configured: ImageStrategy,
  tempServer: TempFileServer,
  log: Logger,
): Promise<ImageStrategy> {
  const attempt = async (strategy: ImageStrategy): Promise<ImageStrategy | null> => {
    if (strategy === 'editor-upload') {
      await pasteSegmentedWithUploads(page, article.html, article.images, log);
      return 'editor-upload';
    }

    const plan = await planInlineImages(page, article.images, strategy, tempServer, log);
    const { html, dropped } = applyImageSources(article.html, plan.resolved);
    if (dropped.length > 0) {
      log.warn('some inline images could not be resolved and were dropped', { count: dropped.length });
    }
    await pasteRichText(page, html, plain, 'article_body');

    if (plan.needsTransferCheck) {
      const ok = await verifyImagesTransferred(page, article.images.length);
      if (!ok) {
        log.warn('inline images were not transferred by the platform, falling back', { strategy });
        return null;
      }
    }
    return strategy === 'auto' ? 'paste-url' : strategy;
  };

  if (configured !== 'auto') {
    const used = await attempt(configured);
    if (used) return used;
    // 显式指定的策略失败了就报错，不擅自换 —— 用户指定它一定有理由
    throw wrapError(
      new Error(`图片策略 ${configured} 未能让平台转存图片`),
      'IMAGE_UPLOAD_FAILED',
      { step: 'article_body', detail: { strategy: configured } },
    );
  }

  // auto：paste-url → intercept-upload → editor-upload
  for (const strategy of ['paste-url', 'intercept-upload', 'editor-upload'] as const) {
    try {
      const used = await attempt(strategy);
      if (used) return used;
    } catch (err) {
      log.warn('image strategy failed, trying the next one', {
        strategy,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
    await clearEditor(page).catch(() => {});
  }

  throw wrapError(new Error('三种插图策略都没能把正文写进去'), 'IMAGE_UPLOAD_FAILED', {
    step: 'article_body',
  });
}

/** 只传了 images 参数、正文里没写 ![]() 时，把它们追加到文末 */
function appendOrphanImages(
  rendered: ReturnType<typeof renderArticleHtml>,
  refs: string[],
): ReturnType<typeof renderArticleHtml> {
  if (refs.length === 0 || rendered.images.length > 0) return rendered;

  const images = refs.map((src, index) => ({
    src,
    alt: '',
    placeholder: `__TOUTIAO_IMG_${index}__`,
  }));
  const html =
    rendered.html + images.map((image) => `<p><img src="${image.placeholder}" alt="" /></p>`).join('');
  return { ...rendered, html, images };
}

async function clickByText(page: Page, text: string): Promise<void> {
  await page
    .getByText(text, { exact: false })
    .first()
    .click({ timeout: 8000 })
    .catch(() => {
      // 可选项点不到不该让整篇发不出去
    });
}

async function clickAnyButton(page: Page, names: string[], timeout: number): Promise<boolean> {
  for (const name of names) {
    const button = page.getByRole('button', { name }).first();
    const ok = await button
      .click({ timeout })
      .then(() => true)
      .catch(() => false);
    if (ok) return true;
  }
  return false;
}

async function addToCollection(page: Page, name: string): Promise<void> {
  try {
    await page.getByText(TEXTS.addToCollection, { exact: false }).first().click({ timeout: 8000 });
    await pause(500, 1000);
    await page
      .locator('[class*="collection"] input, [class*="search"] input')
      .first()
      .fill(name, { timeout: 5000 })
      .catch(() => {});
    await pause(500, 1000);
    await page.getByText(name, { exact: false }).first().click({ timeout: 5000 });
    await clickAnyButton(page, [...TEXTS.genericConfirm], 3000);
  } catch {
    // 合集加不上不阻塞发布
  }
}

async function uncheckAlsoWeitoutiao(page: Page): Promise<void> {
  for (const text of TEXTS.alsoWeitoutiao) {
    const ok = await page
      .getByText(text, { exact: false })
      .first()
      .click({ timeout: 4000 })
      .then(() => true)
      .catch(() => false);
    if (ok) return;
  }
}

async function setDeclarations(page: Page, declarations: string[]): Promise<void> {
  for (const item of declarations) {
    const label = TEXTS.declarations[item] ?? item;
    await page
      .getByText(label, { exact: false })
      .first()
      .click({ timeout: 4000 })
      .catch(() => {});
    await pause(200, 400);
  }
}

async function shot(page: Page): Promise<{ screenshot?: string }> {
  const screenshot = await captureScreenshot(page);
  return screenshot ? { screenshot } : {};
}
