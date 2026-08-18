/**
 * 流程测试：真 Chromium × 本地假站，不碰真站，CI 可跑。
 *
 * 这是没有真账号时唯一能验证「机制真的работает」的手段 —— 断言的是
 * **页面实际收到了什么**（标题文本、编辑器 HTML、filechooser 拿到的文件、
 * 勾选状态），而不是我们调了哪些函数。
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig, type Config } from '../src/config.js';
import { silentLogger } from '../src/logger.js';
import { isToutiaoError } from '../src/errors.js';
import { BrowserManager } from '../src/core/browser.js';
import { setHumanizeEnabled } from '../src/core/humanize.js';
import { SessionManager } from '../src/core/session.js';
import { publishArticle } from '../src/flows/article.js';
import { publishWeitoutiao } from '../src/flows/weitoutiao.js';
import { startFakeSite, type FakeSite } from './fake-site/server.js';

/** 1×1 PNG，够用来验证「文件真的被传进去了」 */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

let site: FakeSite;
let dataDir: string;
let browser: BrowserManager;
let deps: { browser: BrowserManager; session: SessionManager; config: Config; logger: ReturnType<typeof silentLogger> };
let imageA: string;
let imageB: string;

async function boot(options: Parameters<typeof startFakeSite>[0] = {}): Promise<void> {
  site = await startFakeSite(options);
  dataDir = mkdtempSync(join(tmpdir(), 'toutiao-mcp-test-'));
  imageA = join(dataDir, 'a.png');
  imageB = join(dataDir, 'b.png');
  writeFileSync(imageA, PNG_1PX);
  writeFileSync(imageB, PNG_1PX);

  const config: Config = {
    ...loadConfig({}),
    baseUrl: site.origin,
    dataDir,
    headless: true,
    // 测试里不要等 10 分钟才回收，也不要因为空闲回收把测试中的浏览器关掉
    idleTimeoutMs: 60_000,
    humanize: false, // 假站没有风控，停顿纯属浪费；生产别关
  };
  setHumanizeEnabled(config.humanize);
  const logger = silentLogger();
  browser = new BrowserManager(config, logger);
  deps = { browser, session: new SessionManager(browser, config, logger), config, logger };
}

afterEach(async () => {
  await browser?.shutdown();
  await site?.close();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

describe('publish_article', () => {
  beforeEach(async () => {
    await boot();
  });

  it('fills title + rich-text body and completes the publish click chain', async () => {
    const result = await publishArticle(deps, {
      title: '这是一个测试标题',
      content: '## 小节\n\n正文**加粗**内容。\n\n- 项目一\n- 项目二',
    });

    expect(result.success).toBe(true);
    expect(result.action).toBe('published');
    // 第一层判定：从发布接口响应里拿到了 item_id 与 url
    expect(result.verified).toBe(true);
    expect(result.itemId).toBe('7412345678901234567');
    expect(result.url).toContain('toutiao.com/item/');

    expect(site.state.title).toBe('这是一个测试标题');
    // 粘贴走的是 text/html → 编辑器里应该是真结构，而不是 "## 小节" 这样的字面量
    expect(site.state.bodyHtml).toContain('<h2');
    expect(site.state.bodyHtml).toContain('<strong>加粗</strong>');
    expect(site.state.bodyHtml).toContain('<li>');
    expect(site.state.bodyText).not.toContain('##');
    expect(site.state.publishClicked).toBe(true);
  });

  it('unchecks 「同时发布微头条」 by default so one call publishes exactly one thing', async () => {
    expect(site.state.alsoWeitoutiaoChecked).toBe(true); // 平台默认勾选

    await publishArticle(deps, { title: '默认取消微头条', content: '正文' });

    expect(site.state.alsoWeitoutiaoChecked).toBe(false);
  });

  it('keeps 「同时发布微头条」 when the caller explicitly asks for it', async () => {
    await publishArticle(deps, {
      title: '显式要微头条',
      content: '正文',
      also_weitoutiao: true,
    });

    expect(site.state.alsoWeitoutiaoChecked).toBe(true);
  });

  it('uploads the cover through the drawer file chooser', async () => {
    const result = await publishArticle(deps, {
      title: '带封面的文章',
      content: '正文',
      cover: [imageA],
    });

    expect(result.cover).toEqual({ uploaded: 1, mode: 'single' });
    expect(site.state.coverFiles).toEqual(['a.png']);
  });

  it('checks 首发 and 声明 when asked', async () => {
    await publishArticle(deps, {
      title: '带声明的文章',
      content: '正文',
      first_publish: true,
      declarations: ['引用AI'],
    });

    expect(site.state.firstPublishChecked).toBe(true);
    expect(site.state.declarations).toContain('引用AI');
  });

  it('draft mode fills content but never clicks publish', async () => {
    const result = await publishArticle(deps, {
      title: '草稿标题不发布',
      content: '正文内容',
      draft: true,
    });

    expect(result.action).toBe('draft_saved');
    expect(site.state.bodyText).toContain('正文内容');
    expect(site.state.publishClicked).toBe(false);
  });

  it('rejects an over-long title before opening the browser — no silent truncation', async () => {
    const before = browser.isRunning;
    await expect(
      publishArticle(deps, { title: '标'.repeat(31), content: '正文' }),
    ).rejects.toMatchObject({ code: 'CONTENT_LIMIT' });
    // 校验发生在开浏览器之前
    expect(browser.isRunning).toBe(before);
  });

  it('rejects relative image paths (the cwd of this service is invisible to callers)', async () => {
    await expect(
      publishArticle(deps, { title: '相对路径应当被拒', content: '正文', images: ['./a.png'] }),
    ).rejects.toMatchObject({ code: 'BAD_INPUT' });
  });
});

describe('publish_article · inline images', () => {
  /**
   * 2026-08-18 真机：本地图**必须经平台自己的上传通道**（粘贴文件），
   * 贴外链 URL 只是"显示出来"——发布时平台回 code 7115「图片uri非法」，整篇作废。
   * 所以 auto 有本地图时第一跳就是 editor-upload。
   */
  it('本地图走平台上传通道（粘贴文件），而不是贴临时 URL', async () => {
    await boot({ transferImages: true });

    const result = await publishArticle(deps, {
      title: '带正文插图的文章',
      content: `开头\n\n![图一](${imageA})\n\n中间\n\n![图二](${imageB})\n\n结尾`,
    });

    expect(result.images).toBe(2);
    expect(result.imageStrategy).toBe('editor-upload');
    // 判据是"平台真的收到了文件"，不是"src 看起来像 CDN"——后者正是当初的假阳性
    expect(site.state.inlineFiles).toHaveLength(2);
    // 关键断言：编辑器里的 img 已经是平台 CDN 地址，不再是我们的临时服务地址。
    // 不校验这一点，就会出现「发布成功但图是外链」——读者比我们先发现。
    expect(site.state.bodyHtml).toContain('byteimg.com');
    expect(site.state.bodyHtml).not.toContain('127.0.0.1');
    expect(site.state.bodyHtml).not.toContain('__TOUTIAO_IMG_');
  });

  it('平台不转存外链时也不会把外链留在正文里', async () => {
    await boot({ transferImages: false });

    const result = await publishArticle(deps, {
      title: '不转存时应当回落',
      content: `正文\n\n![图一](${imageA})`,
    });

    // 不能停在「图是我们的临时地址」的状态上 —— 发出去读者会看到 404
    expect(result.imageStrategy).not.toBe('paste-url');
    expect(site.state.bodyHtml).not.toContain('127.0.0.1');
  });

  it('appends images passed only via the images param (never silently drops them)', async () => {
    await boot({ transferImages: true });

    const result = await publishArticle(deps, {
      title: '正文没写图但传了图',
      content: '只有文字的正文',
      images: [imageA],
    });

    expect(result.images).toBe(1);
    expect(site.state.bodyHtml).toContain('byteimg.com');
  });
});

describe('publish_article · failures', () => {
  it('surfaces the platform rejection toast verbatim', async () => {
    await boot({ failPublish: true });

    const error = await publishArticle(deps, { title: '会被平台拒绝', content: '正文' }).catch(
      (err: unknown) => err,
    );

    expect(isToutiaoError(error) && error.code).toBe('PUBLISH_REJECTED');
    expect(isToutiaoError(error) && error.message).toContain('敏感信息');
    // 失败必须带现场截图，否则没人知道页面当时是什么样
    expect(isToutiaoError(error) && typeof error.screenshot).toBe('string');
  });

  it('接口没回 JSON 但有成功 toast → 仍算确认（第三层判定），不报失败', async () => {
    await boot({ publishResponse: false });

    const result = await publishArticle(deps, { title: '拿不到确认信息', content: '正文' });

    // toast/跳转都算证据。有证据就别报失败 —— 报失败会诱导调用方重发，而重复发布更糟
    expect(result.success).toBe(true);
    expect(result.verified).toBe(true);
    expect(site.state.publishClicked).toBe(true);
  });

  /**
   * 2026-08-17 真机事故 run_fG3bGH8OXh：点击被 AI 助手抽屉拦下，
   * 接口、跳转、toast **一个证据都没有**，而流程返回了
   * `{success:true, action:'published', verified:false}` —— 飞雁据此把整条工作流
   * 标成成功，用户去头条后台翻了一圈才发现一条都没发出去。
   * **零证据必须报错，不能谎报成功。**
   */
  it('一个证据都没有时必须抛 PUBLISH_UNCONFIRMED，绝不报成功', async () => {
    await boot({ silentPublish: true });

    await expect(
      publishArticle(deps, { title: '零证据发布', content: '正文' }),
    ).rejects.toMatchObject({ code: 'PUBLISH_UNCONFIRMED' });
  });

  it('报错要告诉用户先去后台核对，而不是直接重发（重复发布更糟）', async () => {
    await boot({ silentPublish: true });

    try {
      await publishArticle(deps, { title: '零证据发布', content: '正文' });
      expect.unreachable('应当抛错');
    } catch (err) {
      const e = err as { code?: string; message?: string };
      expect(e.code).toBe('PUBLISH_UNCONFIRMED');
      expect(e.message).toContain('内容管理');
    }
  });

  it('refuses to publish when not logged in', async () => {
    await boot({ loggedIn: false });

    await expect(publishArticle(deps, { title: '未登录不该发出去', content: '正文' })).rejects.toMatchObject({
      code: 'NOT_LOGGED_IN',
    });
  });
});

describe('publish_weitoutiao', () => {
  beforeEach(async () => {
    await boot();
  });

  it('types plain text with markdown stripped but keeps #话题', async () => {
    const result = await publishWeitoutiao(deps, {
      content: '## 标题会被脱掉\n\n**加粗**也是。聊聊 #人工智能 的进展',
    });

    expect(result.success).toBe(true);
    expect(site.state.weitoutiaoText).toContain('标题会被脱掉');
    expect(site.state.weitoutiaoText).toContain('#人工智能');
    expect(site.state.weitoutiaoText).not.toContain('##');
    expect(site.state.weitoutiaoText).not.toContain('**');
  });

  it('uploads images and clicks 存草稿 in draft mode', async () => {
    const result = await publishWeitoutiao(deps, {
      content: '带图的微头条',
      images: [imageA, imageB],
      draft: true,
    });

    expect(result.action).toBe('draft_saved');
    expect(site.state.weitoutiaoImages).toEqual(['a.png', 'b.png']);
    expect(site.state.draftClicked).toBe(true);
    expect(site.state.publishClicked).toBe(false);
  });

  it('rejects remote image URLs — weitoutiao only takes local files', async () => {
    await expect(
      publishWeitoutiao(deps, { content: '正文', images: ['https://example.com/a.png'] }),
    ).rejects.toMatchObject({ code: 'BAD_INPUT' });
  });

  it('rejects content over the character limit instead of truncating', async () => {
    await expect(publishWeitoutiao(deps, { content: '字'.repeat(2001) })).rejects.toMatchObject({
      code: 'CONTENT_LIMIT',
    });
  });
});

describe('session', () => {
  it('reports logged-in status with user info', async () => {
    await boot({ loggedIn: true });
    const status = await deps.session.checkStatus();

    expect(status.is_logged_in).toBe(true);
    expect(status.user?.name).toBe('测试头条号');
  });

  /**
   * 2026-08-17 真机事故的回归钉：未登录时头条会**先跳一次 `/profile_v4/` 再弹回登录页**，
   * 旧实现在中间那一跳就认定「落地了」，于是把未登录报成已登录 —— 用户在飞雁账户页
   * 看到「已登录」，实际根本没扫码。
   *
   * 断言的是「跳转链走完之后才判定」，所以只要 settleOnHome 退回"第一次匹配就返回"，
   * 这条必然变红。
   */
  it('waits out the whole redirect chain — the transient /profile_v4 hop must not read as logged in', async () => {
    await boot({ loggedIn: false });

    const status = await deps.session.checkStatus();
    expect(status.is_logged_in).toBe(false);
    // 顺带确认给用户的话是「去扫码」，而不是一句空洞的 false
    expect(status.message).toContain('扫码');
  });

  it('reports logged-out and returns a QR image block', async () => {
    await boot({ loggedIn: false });

    expect((await deps.session.checkStatus()).is_logged_in).toBe(false);

    const qr = await deps.session.getQrcode();
    expect('alreadyLoggedIn' in qr).toBe(false);
    if ('alreadyLoggedIn' in qr) return;
    // 形状必须能被飞燕的 normalizeQrcode 读懂：裸 base64 PNG + 带过期时间的提示文本
    expect(qr.image.length).toBeGreaterThan(100);
    expect(Buffer.from(qr.image, 'base64').subarray(1, 4).toString()).toBe('PNG');
    expect(qr.hint).toContain('扫');
    expect(new Date(qr.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('does not hand out a QR code when already logged in', async () => {
    await boot({ loggedIn: true });
    const qr = await deps.session.getQrcode();
    expect('alreadyLoggedIn' in qr).toBe(true);
  });
});

/**
 * 2026-08-18 真机 run_a6Noq-A_IK：生成了 5 张配图、MCP 自报 images:5、发布也成功，
 * 但文章里**只剩最后一张**。
 * 根因：逐张插图前调的是 `focusEditor`（= 点编辑器正中央），第一张图插进去后
 * 中心就落在那张图上，点中图片在 ProseMirror 里等于**选中该节点**，
 * 下一次粘贴把它替换掉 —— 五张依次互相覆盖。
 * 修法：插图前把光标折叠到文末，永远追加、不产生选区。
 */
describe('多图正文（每张都必须留下）', () => {
  it('连插 3 张图，3 张全在，且顺序与正文一致', async () => {
    await boot({ transferImages: true });

    const imageC = join(dataDir, 'c.png');
    writeFileSync(imageC, PNG_1PX);

    const result = await publishArticle(deps, {
      title: '三张配图的文章',
      content: `第一段\n\n![图一](${imageA})\n\n第二段\n\n![图二](${imageB})\n\n第三段\n\n![图三](${imageC})`,
    });

    expect(result.images).toBe(3);
    // 关键断言：**编辑器里真的有 3 张**。MCP 自报的数字不算数 —— 上次它也报了 5
    const imgCount = (site.state.bodyHtml.match(/<img/g) ?? []).length;
    expect(imgCount, `编辑器里只剩 ${imgCount} 张`).toBe(3);
    // 正文文字也不能被图片替换掉
    expect(site.state.bodyText).toContain('第一段');
    expect(site.state.bodyText).toContain('第三段');
  });
});
