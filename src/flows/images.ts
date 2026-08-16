/**
 * 配图：封面上传 + 正文插图三策略。
 *
 * 正文插图是这个项目最大的未知数（评估文档的 spike A）。所以做成策略可切、
 * 带**发布前校验**的形态，而不是赌某一种做法：
 *
 *   paste-url        把图片变成 http URL 一起粘贴，指望编辑器自动转存
 *   intercept-upload 先用编辑器自己的上传通道把每张图传上去、拿到 CDN URL，再整体粘贴
 *   editor-upload    分段粘贴，遇图走 UI 上传插入（最慢最稳）
 *   auto             paste-url →（校验没转存）→ intercept-upload →（不行）→ editor-upload
 *
 * 校验点是关键：不校验就会得到「发布成功但图是外链」，这类问题读者先于我们发现。
 */
import type { Page } from 'playwright';

import type { ImageStrategy } from '../config.js';
import { ToutiaoError, wrapError } from '../errors.js';
import type { Logger } from '../logger.js';
import { pause } from '../core/humanize.js';
import { captureScreenshot } from '../core/overlays.js';
import { SELECTORS, TEXTS } from '../core/selectors.js';
import { TempFileServer } from '../core/file-server.js';
import { isRemote } from '../content/validate.js';
import type { ImageRef } from '../content/markdown.js';
import { clearEditor, dispatchPaste, editorImageSources, focusEditor } from './paste.js';

/** 头条自家图片 CDN 的域名特征：src 变成这些就说明已转存 */
const TOUTIAO_CDN = /(byteimg\.com|pstatp\.com|bytecdn\.cn|toutiaoimg\.com|toutiaocdn\.)/i;

export interface InlineImagePlan {
  /** placeholder → 可直接写进 HTML 的 src；空 map = 走 editor-upload 逐张插入 */
  resolved: Map<string, string>;
  strategy: ImageStrategy;
  /** 需要在发布前校验「是否已转存」 */
  needsTransferCheck: boolean;
}

/**
 * 上传封面。
 *
 * 注意流程里**不调 dismissOverlays** —— 那个函数会隐藏 `.byte-drawer-wrapper`，
 * 而封面抽屉正是我们自己要用的（见 overlays.ts 的注释）。
 */
export async function uploadCover(
  page: Page,
  mode: 'auto' | 'single' | 'triple' | 'none',
  covers: string[],
  logger: Logger,
): Promise<{ uploaded: number; mode: string }> {
  const effective = mode === 'auto' ? (covers.length >= 3 ? 'triple' : covers.length >= 1 ? 'single' : 'none') : mode;
  if (effective === 'none' || covers.length === 0) {
    await selectCoverMode(page, 'none').catch(() => {});
    return { uploaded: 0, mode: 'none' };
  }

  const wanted = effective === 'triple' ? 3 : 1;
  const files = covers.slice(0, wanted);

  try {
    await selectCoverMode(page, effective);
    await pause(400, 800);

    const addButton = page.locator(SELECTORS.coverAddButton).first();
    await addButton.click({ timeout: 10_000 });
    await pause(800, 1500);

    // 本地上传按钮触发 filechooser。remote 图这里也要先落地成本地文件 —— 由调用方
    // 保证 cover 是本地路径；remote 封面在 article.ts 里已提前下载。
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 15_000 }),
      page.getByText(TEXTS.localUpload, { exact: false }).first().click({ timeout: 10_000 }),
    ]);
    await chooser.setFiles(files);
    await pause(2000, 3500);

    const confirm = page.locator(SELECTORS.drawerConfirm).first();
    await confirm.waitFor({ state: 'visible', timeout: 30_000 });
    await confirm.click();
    await pause(800, 1500);

    logger.info('cover uploaded', { count: files.length, mode: effective });
    return { uploaded: files.length, mode: effective };
  } catch (err) {
    // 关掉可能残留的抽屉，否则后面所有点击都会打在遮罩上
    await page.locator(SELECTORS.drawerCancel).first().click({ timeout: 3000 }).catch(() => {});
    await page.keyboard.press('Escape').catch(() => {});
    throw wrapError(err, 'IMAGE_UPLOAD_FAILED', {
      step: 'cover',
      detail: { mode: effective, files: files.length },
      ...(await screenshotOf(page)),
    });
  }
}

async function selectCoverMode(page: Page, mode: 'single' | 'triple' | 'none'): Promise<void> {
  const label = TEXTS.coverModes[mode];
  await page.getByText(label, { exact: false }).first().click({ timeout: 8000 });
}

/**
 * 为正文插图准备可用的 src。
 *
 * @param tempServer paste-url 策略下把本地文件暴露成 http URL 的临时服务
 */
export async function planInlineImages(
  page: Page,
  images: ImageRef[],
  strategy: ImageStrategy,
  tempServer: TempFileServer,
  logger: Logger,
): Promise<InlineImagePlan> {
  if (images.length === 0) {
    return { resolved: new Map(), strategy, needsTransferCheck: false };
  }

  if (strategy === 'editor-upload') {
    return { resolved: new Map(), strategy, needsTransferCheck: false };
  }

  if (strategy === 'intercept-upload') {
    const resolved = await uploadViaEditorChannel(page, images, logger);
    return { resolved, strategy, needsTransferCheck: false };
  }

  // paste-url 与 auto 的第一跳：本地文件走临时静态服务，远程图原样用
  await tempServer.start();
  const resolved = new Map<string, string>();
  for (const image of images) {
    resolved.set(image.placeholder, isRemote(image.src) ? image.src : tempServer.publish(image.src));
  }
  return { resolved, strategy, needsTransferCheck: true };
}

/**
 * 校验外链图是否被平台转存。
 *
 * 没转存就意味着发出去的是我们临时服务的 URL（发布后立刻 404）或第三方外链 ——
 * 必须在**发布之前**发现。返回 false 让调用方回落到别的策略。
 */
export async function verifyImagesTransferred(page: Page, expected: number): Promise<boolean> {
  if (expected === 0) return true;
  // 转存是异步的，给平台一点时间
  for (let i = 0; i < 10; i++) {
    const sources = await editorImageSources(page);
    const transferred = sources.filter((src) => TOUTIAO_CDN.test(src)).length;
    if (transferred >= expected) return true;
    // 还挂着我们的临时地址 = 尚未转存
    await pause(1000, 1500);
  }
  return false;
}

/**
 * intercept-upload：借编辑器自己的上传通道。
 *
 * 思路 —— 逐张用编辑器的 file input 传上去（签名、鉴权全由页面自己处理），
 * 从插入的节点上读回 CDN URL，然后清空编辑器，把 URL 填进 HTML 整体粘贴。
 * 比逆向上传接口稳（不碰签名），比 editor-upload 快（正文只粘一次）。
 */
async function uploadViaEditorChannel(
  page: Page,
  images: ImageRef[],
  logger: Logger,
): Promise<Map<string, string>> {
  const resolved = new Map<string, string>();
  const locals = images.filter((image) => !isRemote(image.src));
  for (const image of images) {
    if (isRemote(image.src)) resolved.set(image.placeholder, image.src);
  }
  if (locals.length === 0) return resolved;

  await focusEditor(page, 'intercept_upload');
  const before = new Set(await editorImageSources(page));

  for (const image of locals) {
    await insertImageViaEditor(page, image.src);
    const after = await editorImageSources(page);
    const fresh = after.find((src) => !before.has(src) && TOUTIAO_CDN.test(src));
    if (!fresh) {
      throw new ToutiaoError(
        'IMAGE_UPLOAD_FAILED',
        `通过编辑器上传后没能读到平台图片地址：${image.src}`,
        { step: 'intercept_upload', ...(await screenshotOf(page)) },
      );
    }
    before.add(fresh);
    resolved.set(image.placeholder, fresh);
  }

  // 探图阶段插进去的节点不能留在正文里 —— 后面会整体重新粘贴
  await clearEditor(page);
  logger.info('inline images uploaded via editor channel', { count: resolved.size });
  return resolved;
}

/**
 * editor-upload：分段粘贴 —— 文本段用 paste，图片位置走 UI 上传插入。
 *
 * 最慢（每张图一次交互）也最不容易被拒：走的完全是人类路径。
 * 是 auto 策略的最后一条退路。
 */
export async function pasteSegmentedWithUploads(
  page: Page,
  html: string,
  images: ImageRef[],
  logger: Logger,
): Promise<void> {
  const byPlaceholder = new Map(images.map((image) => [image.placeholder, image]));
  // 按占位 img 标签切开，保留顺序
  const parts = html.split(/(<img\s+src="__TOUTIAO_IMG_\d+__"[^>]*>)/);

  await focusEditor(page, 'segmented_paste');
  for (const part of parts) {
    if (!part) continue;
    const match = /src="(__TOUTIAO_IMG_\d+__)"/.exec(part);
    if (match?.[1]) {
      const image = byPlaceholder.get(match[1]);
      if (!image) continue;
      if (isRemote(image.src)) {
        // 远程图没有本地文件可传，只能原样粘（编辑器多半会转存）
        await dispatchPaste(page, `<img src="${image.src}" alt="${image.alt}" />`, '');
      } else {
        await insertImageViaEditor(page, image.src);
      }
      await pause(500, 1000);
      continue;
    }
    await dispatchPaste(page, part, '');
    await pause(300, 700);
  }
  logger.info('segmented paste finished', { images: images.length });
}

/** 用编辑器的图片入口插入一张本地图（editor-upload 与 intercept-upload 共用） */
export async function insertImageViaEditor(page: Page, absolutePath: string): Promise<void> {
  // 优先直接喂 file input：比点按钮少一次 UI 依赖，也不受弹层遮挡影响
  const input = page.locator(SELECTORS.fileInput).first();
  if (await input.count().then((n) => n > 0).catch(() => false)) {
    await input.setInputFiles(absolutePath);
  } else {
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 15_000 }),
      page.locator(SELECTORS.editorImageButton).first().click({ timeout: 10_000 }),
    ]);
    await chooser.setFiles(absolutePath);
  }
  await pause(2000, 4000);

  // 上传可能有确认弹层，有就点掉；没有也不算错
  const confirm = page.locator(SELECTORS.drawerConfirm).first();
  if (await confirm.isVisible({ timeout: 3000 }).catch(() => false)) {
    await confirm.click().catch(() => {});
    await pause(800, 1500);
  }
}

async function screenshotOf(page: Page): Promise<{ screenshot?: string }> {
  const screenshot = await captureScreenshot(page);
  return screenshot ? { screenshot } : {};
}
