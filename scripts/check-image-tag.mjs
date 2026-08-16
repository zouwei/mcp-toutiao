/**
 * 校验 Dockerfile 里的 Playwright 基础镜像版本与 package.json 的 playwright 依赖一致。
 *
 * 不一致的后果：容器启动时 Playwright 找不到匹配的浏览器，会尝试联网下载 ——
 * 生产容器多半没有这个网络，于是失败在一个与真实原因毫无关系的地方。
 */
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const declared = (pkg.dependencies?.playwright ?? '').replace(/^[\^~]/, '');
const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
const match = /ARG PLAYWRIGHT_VERSION=([\d.]+)/.exec(dockerfile);

if (!match) {
  console.error('Dockerfile 里找不到 ARG PLAYWRIGHT_VERSION');
  process.exit(1);
}

if (match[1] !== declared) {
  console.error(
    `版本不一致：Dockerfile 的 PLAYWRIGHT_VERSION=${match[1]}，package.json 的 playwright=${declared}\n` +
      '请同时更新两处 —— 不一致会让容器在运行时尝试下载浏览器并失败。',
  );
  process.exit(1);
}

console.log(`playwright 版本一致：${declared}`);
