/**
 * Phase 0 真机 spike —— **需要一个测试头条号**，会真的操作 mp.toutiao.com。
 *
 * 目的是回答评估文档里的两个未知数，把结论写进 docs/spike.md：
 *   A. 正文插图注入：三种策略哪种真能让平台转存？格式保真度如何？
 *   B. 无头容器里扫码登录会不会被风控？profile 能活多久？
 *
 * 默认**只存草稿**（--publish 才真发）。跑法：
 *   TOUTIAO_HEADLESS=false pnpm spike -- --login          # 先扫码
 *   pnpm spike -- --strategy paste-url                    # 试一种策略，存草稿
 *   pnpm spike -- --strategy auto --publish               # 真发一篇（小号！）
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { loadConfig, type ImageStrategy } from '../src/config.js';
import { createRuntime } from '../src/runtime.js';
import { publishArticle } from '../src/flows/article.js';
import { isToutiaoError } from '../src/errors.js';

const argv = process.argv.slice(2);
const has = (flag: string): boolean => argv.includes(`--${flag}`);
const value = (flag: string): string | undefined => {
  const index = argv.indexOf(`--${flag}`);
  return index >= 0 ? argv[index + 1] : undefined;
};

const SAMPLE = `## 这是一次自动化验证

本文由 toutiao-mcp 的 spike 脚本生成，用于验证 Markdown 到头条富文本的保真度。

**加粗**、*斜体*、\`行内代码\`。

- 列表项一
- 列表项二

> 引用块

![测试配图](__IMAGE__)

结尾段落。`;

async function main(): Promise<number> {
  const strategy = (value('strategy') ?? 'auto') as ImageStrategy;
  const image = value('image');
  const config = { ...loadConfig(), imageStrategy: strategy };
  const runtime = createRuntime({ config });
  const log = runtime.logger.child('spike');

  try {
    const status = await runtime.session.checkStatus();
    log.info('登录态', status as unknown as Record<string, unknown>);

    if (has('login')) {
      if (status.is_logged_in) return 0;
      const qr = await runtime.session.getQrcode();
      if ('alreadyLoggedIn' in qr) return 0;
      const dir = join(config.dataDir, 'screenshots');
      mkdirSync(dir, { recursive: true });
      const file = join(dir, 'spike-qrcode.png');
      writeFileSync(file, Buffer.from(qr.image, 'base64'));
      log.info(`二维码已保存到 ${file} —— 请扫码，然后重跑本脚本`);
      // 等一会儿，让后台的等扫码流程有机会完成
      await new Promise((resolve) => setTimeout(resolve, config.loginWaitMs));
      log.info('最终登录态', (await runtime.session.checkStatus()) as unknown as Record<string, unknown>);
      return 0;
    }

    if (!status.is_logged_in) {
      log.error('未登录 —— 先跑 TOUTIAO_HEADLESS=false pnpm spike -- --login');
      return 1;
    }

    const started = Date.now();
    const result = await publishArticle(runtime, {
      title: `自动化验证 ${new Date().toISOString().slice(5, 16)}`,
      content: image ? SAMPLE.replace('__IMAGE__', image) : SAMPLE.replace(/!\[[^\]]*\]\([^)]*\)/, ''),
      ...(image ? { cover: [image] } : {}),
      draft: !has('publish'),
    });

    log.info('结果', {
      ...result,
      elapsedSec: Math.round((Date.now() - started) / 1000),
      configuredStrategy: strategy,
    });
    log.info('请到头条后台核对：正文结构是否正确、插图是否是平台地址、封面是否设上');
    return 0;
  } catch (err) {
    if (isToutiaoError(err)) {
      log.error('失败', { code: err.code, step: err.step, message: err.message, detail: err.detail });
      if (err.screenshot) {
        const file = join(config.dataDir, 'screenshots', `spike-failure-${Date.now()}.png`);
        writeFileSync(file, Buffer.from(err.screenshot, 'base64'));
        log.error(`现场截图：${file}`);
      }
    } else {
      log.error('失败', { message: err instanceof Error ? err.message : String(err) });
    }
    return 1;
  } finally {
    await runtime.shutdown();
  }
}

main().then((code) => process.exit(code));
