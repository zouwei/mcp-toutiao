/**
 * 图文文章发布。
 *
 * 步骤序列见 docs/specs/publish-flows.md §1。这里只做编排，
 * 具体定位在 core/selectors.ts，具体机制在 paste.ts / images.ts / result.ts。
 */
import type { Page } from 'playwright';

import type { Config, ImageStrategy } from '../config.js';
import { ToutiaoError, wrapError } from '../errors.js';
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
  const hasExplicitCover = coverRefs.length > 0;
  const bodyHasLocalImages = inlineRefs.some((ref) => !isRemote(ref));

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

      /**
       * ── 封面（**必须在正文之前**）──
       *
       * 2026-08-18 真机：正文里一旦有图，头条会**拿首图自动填充封面** ——
       * 这时「添加封面」按钮就不存在了，只剩「编辑 | 替换」，而「替换」打开的是
       * 另一套抽屉（里面没有「本地上传」）。所以显式封面要**赶在正文之前**传，
       * 那时页面还是干净的「＋ 添加封面」。
       */
      let cover: { uploaded: number; mode: string } = { uploaded: 0, mode: 'none' };
      if (hasExplicitCover) {
        cover = await uploadCover(page, params.cover_mode ?? 'auto', coverRefs, log);
      }

      // ── 正文（含插图策略） ──
      const usedStrategy = await writeBody(page, article, plain, config.imageStrategy, tempServer, log);

      if (!hasExplicitCover) {
        if (bodyHasLocalImages) {
          /**
           * 没给封面但正文有图 → **不要再传一次**。平台已经用首图填好了封面，
           * 我们再去点「添加封面」只会撞上不存在的按钮（这正是上一版的失败点）。
           */
          log.info('封面由平台按正文首图自动填充，跳过封面上传');
          cover = { uploaded: 0, mode: 'auto-from-body' };
        } else {
          // 一张图都没有：显式选「无封面」，别让平台留个空位
          cover = await uploadCover(page, params.cover_mode ?? 'auto', [], log);
        }
      }

      // ── 可选项 ──
      if (params.first_publish) await clickByText(page, TEXTS.firstPublish);
      if (params.collection) await addToCollection(page, params.collection);
      // 平台默认勾选「同时发布微头条」：不显式要就取消掉，
      // 否则调用方以为发了 1 条、实际发了 2 条
      if (params.also_weitoutiao !== true) {
        // 取消不掉就等于一次调用发两条内容 —— 这必须让调用方知道，不能默默继续
        const unchecked = await uncheckAlsoWeitoutiao(page);
        if (!unchecked) log.warn('「同时发布微头条」未能取消，本次发布可能同时产生一条微头条');
      }
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

      /**
       * 发布窗口内的**所有** toutiao 域 POST 往返。
       * `watchPublishResponses` 只认 `/mp/agw/article/publish` 那一族 —— 端点改版就抓瞎，
       * 而且分不清「请求压根没发」和「发了但被拒」。这两种情况的修法完全不同。
       */
      const netLog: Array<Record<string, unknown>> = [];
      const onRequest = (req: { method(): string; url(): string; postData(): string | null }): void => {
        if (req.method() !== 'POST' || !req.url().includes('toutiao.com')) return;
        const path = req.url().split('?')[0]?.slice(0, 110);
        // 发布请求的载荷里带着图片 uri —— 平台回「图片uri非法」时，得看得见到底传了什么
        if (path?.includes('/article/publish')) {
          const raw = req.postData() ?? '';
          const imgs = [...raw.matchAll(/(?:img_uri|uri|image_uri|cover|web_uri)[=":]+([^&"',}\]]{4,120})/gi)]
            .map((m) => decodeURIComponent(m[1] ?? ''))
            .filter(Boolean);
          netLog.push({ '→': path, 图片字段: [...new Set(imgs)].slice(0, 6) });
          return;
        }
        netLog.push({ '→': path });
      };
      const onResponse = (res: { request(): { method(): string }; url(): string; status(): number }): void => {
        if (res.request().method() === 'POST' && res.url().includes('toutiao.com')) {
          netLog.push({ '←': res.url().split('?')[0]?.slice(0, 110), status: res.status() });
        }
      };
      page.on('request', onRequest);
      page.on('response', onResponse);
      /**
       * 确认按钮到底点到了没有。**这个返回值以前被丢掉了** ——
       * 于是「预览并发布」被 AI 助手抽屉挡住、确认框根本没出现时，流程照样往下走，
       * 最后报告「已发布」。2026-08-17 真机核对：后台一条新内容都没有。
       */
      let confirmed = false;
      /** 到底点中了哪个按钮名 —— 排查时「点了确认却没发出去」和「点中了别的按钮」是两回事 */
      let confirmedBy: string | null = null;
      let sceneBeforeConfirm: Record<string, unknown> = {};

      try {
        const publishButton = page.getByRole('button', { name: TEXTS.articlePublishButton }).first();
        await publishButton.scrollIntoViewIfNeeded().catch(() => {});
        await pause(300, 600);
        await publishButton.click({ timeout: 15_000 });
        await pause(2500, 4000);
        // 点开预览之后、点确认之前的现场 —— 失败时最需要看的就是这一刻
        sceneBeforeConfirm = await describeScene(page);

        // 预览页再点一次确认；有的账号还会多一层「确定」
        confirmedBy = await clickWhichButton(page, [TEXTS.confirmPublishButton, ...TEXTS.genericConfirm], 12_000);
        confirmed = confirmedBy !== null;
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

      /**
       * 没有任何证据表明发出去了，就**不许报成功**。
       *
       * 判据有两条：确认按钮压根没点到（confirmed=false），或者点了但拿不到
       * 接口响应/跳转/提示（outcome.verified=false）。
       * 以前这里返回 `success:true, action:'published'` 外加一句「很可能已经发出去了」——
       * 实测那句话是错的：文章还在草稿里，而调用方（飞雁）把整条工作流标成了成功，
       * 用户是去头条后台翻了一圈才发现什么都没有。**宁可报不确定，也不能谎报成功。**
       */
      if (!confirmed || !outcome.verified) {
        const scene = await describeScene(page);
        throw new ToutiaoError(
          'PUBLISH_UNCONFIRMED',
          confirmed
            ? '点了确认，但没能从页面确认发布结果（没拿到接口响应、页面也没跳转）——' +
              '请到头条创作中心「内容管理」核对：已发布就不要重试，仍在草稿里则重发。'
            : '没找到可点的「确认发布」——发布很可能没有真正提交（常见原因：编辑器右侧的 AI 助手抽屉盖住了按钮）。' +
              '请到头条创作中心「内容管理」核对后再重试。',
          {
            step: 'article_publish_confirm',
            detail: {
              title,
              confirmed,
              confirmedBy,
              verified: outcome.verified,
              imageStrategy: usedStrategy,
              sceneBeforeConfirm,
              // 空数组 = 点了确认但**一个请求都没发出去**（前端就被挡住了）
              netLog: netLog.slice(-14),
              ...scene,
            },
            ...(await shot(page, true)),
          },
        );
      }

      page.off('request', onRequest);
      page.off('response', onResponse);
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

  /**
   * auto 的顺序：**有本地图就先走 editor-upload**（粘贴文件 → 平台自己的上传通道）。
   *
   * 原来第一跳是 paste-url，它在真站是「能过校验却发不出去」的最坏形态：编辑器把外链图
   * 显示出来、src 甚至变成头条 CDN 域名（于是 `verifyImagesTransferred` 返回 true，
   * **假阳性**），但发布时平台回 `{code:7115,"图片uri非法"}`，整篇作废
   * —— 2026-08-18 实测，连查五轮才定位到。图片必须**从本地经平台上传通道**传上去
   * 才有合法 uri（封面一直这么做，所以封面从没出过这问题）。
   *
   * intercept-upload 不进 auto 阶梯：真站没有 `input[type=file]`、工具栏按钮也认不出来，
   * 它只会等 filechooser 等到超时。显式指定仍可用（留着给页面改版后再修）。
   * 全是远程图时没有本地文件可传，只能回到 paste-url 让编辑器自己转存。
   */
  const hasLocal = article.images.some((image) => !isRemote(image.src));
  const ladder = hasLocal ? (['editor-upload', 'paste-url'] as const) : (['paste-url', 'editor-upload'] as const);
  for (const strategy of ladder) {
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

/**
 * 点中了就返回按钮名，全没点中返回 null。
 * 比 boolean 多这一个信息量：排查时「确认发布」和「确定」是完全不同的两种情况
 * —— 后者很可能点到了别处的弹窗按钮。
 */
async function clickWhichButton(page: Page, names: string[], timeout: number): Promise<string | null> {
  for (const name of names) {
    const ok = await page
      .getByRole('button', { name })
      .first()
      .click({ timeout })
      .then(() => true)
      .catch(() => false);
    if (ok) return name;
  }
  return null;
}

/**
 * 失败现场：当前 URL、可见按钮、弹窗文本、页面提示。
 * 「去后台核对」这句话对排查毫无帮助 —— 得让人看见当时页面上有什么。
 */
async function describeScene(page: Page): Promise<Record<string, unknown>> {
  const grab = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => fn().catch(() => fallback);
  const buttons = await grab(async () => {
    const all = await page.getByRole('button').allInnerTexts();
    return all.map((t) => t.trim()).filter(Boolean).slice(0, 20);
  }, [] as string[]);
  const dialog = await grab(
    () => page.locator('[role="dialog"], [class*="modal"]:not([style*="display: none"])').first().innerText({ timeout: 1500 }),
    '',
  );
  const toast = await grab(() => page.locator('[class*="message"], [class*="toast"]').first().innerText({ timeout: 1500 }), '');
  /**
   * 页面上的"红字"。校验失败时头条不弹 toast，而是在对应表单项下方给一行提示 ——
   * 只看 dialog/toast 是找不到它的。
   */
  const notices = await grab(async () => {
    const texts = await page
      .locator('[class*="error"], [class*="danger"], [class*="invalid"], [class*="warning"], [class*="tip"]')
      .allInnerTexts();
    return [...new Set(texts.map((t) => t.replace(/\s+/g, ' ').trim()).filter((t) => t && t.length < 120))].slice(0, 8);
  }, [] as string[]);

  return {
    url: page.url(),
    visibleButtons: buttons,
    ...(notices.length ? { pageNotices: notices } : {}),
    ...(dialog.trim() ? { dialogText: dialog.replace(/\s+/g, ' ').slice(0, 300) } : {}),
    ...(toast.trim() ? { pageToast: toast.replace(/\s+/g, ' ').slice(0, 200) } : {}),
  };
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

/**
 * 取消平台默认勾选的「同时发布微头条」。
 *
 * ⚠ 2026-08-17 真机：这里原来是「点文案，点成功就返回」。真站上
 * 「同时发布微头条」是**左列的行标签**、复选框在右边另一个元素里 ——
 * 点行标签什么都不会发生，但 `click()` 本身是成功的，于是函数直接 return，
 * 复选框始终勾着。**点击成功不等于状态改变，必须回读复选框。**
 * （假站当时把文字和 checkbox 写在同一个 label 里，所以测试全绿也没发现。）
 */
async function uncheckAlsoWeitoutiao(page: Page): Promise<boolean> {
  const box = weitoutiaoCheckbox(page);
  if ((await box.count()) === 0) return false;
  if (!(await box.isChecked().catch(() => false))) return true; // 本来就没勾

  const row = page.locator(SELECTORS.weitoutiaoRow).first();
  const stillChecked = async (): Promise<boolean> => box.isChecked().catch(() => true);

  /**
   * 三级降级。**每一级都回读 input.checked**，不看点击有没有"成功"——
   * 2026-08-17 真机：点左列行标签 click() 是成功的，复选框却纹丝不动。
   *  1. force 勾选/取消：input 被 .byte-checkbox-mask 盖着，常规点击会被拦
   *  2. 点外层 label（原生 label 行为）
   *  3. 点复选框旁边那句文案
   */
  await box.uncheck({ force: true, timeout: 4000 }).catch(() => {});
  if (!(await stillChecked())) return true;

  await row.locator(SELECTORS.weitoutiaoToggle).first().click({ timeout: 4000 }).catch(() => {});
  await pause(200, 400);
  if (!(await stillChecked())) return true;

  await row
    .getByText(TEXTS.alsoWeitoutiaoToggle, { exact: false })
    .first()
    .click({ timeout: 4000 })
    .catch(() => {});
  await pause(200, 400);
  if (!(await stillChecked())) return true;

  /**
   * 最后一级：直接对 input 派发 click。
   * 前三级都是"真实鼠标"，会被 `.byte-checkbox-mask` 这类自定义样式挡住 ——
   * force 也救不了，因为它只跳过可操作性检查，点击坐标照样落在遮罩上。
   * 程序化 click 会派发真实 click 事件，React 的委托监听同样收得到。
   */
  await box.evaluate((el: HTMLInputElement) => el.click()).catch(() => {});
  await pause(200, 400);
  return !(await stillChecked());
}

/** 「同时发布微头条」那一行里的复选框（判据取 input.checked，不看样式类名） */
function weitoutiaoCheckbox(page: Page) {
  return page.locator(SELECTORS.weitoutiaoRow).first().locator('input[type="checkbox"]').first();
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

async function shot(page: Page, fullPage = false): Promise<{ screenshot?: string }> {
  const screenshot = await captureScreenshot(page, fullPage);
  return screenshot ? { screenshot } : {};
}
