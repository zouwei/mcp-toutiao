#!/usr/bin/env node

/**
 * 打印 CHANGELOG 里某个版本那一段（给 CI 取 Release 正文用）。
 *
 *   node scripts/changelog-section.mjs v0.1.0
 *
 * 为什么是独立脚本而不是 workflow 里的 `node -e`：第一版就是内联的，
 * 结果在 ESM 模式下用了 `require` —— 抛错被 `|| true` 吞掉，静默回落到
 * GitHub 自动生成的记录（v0.1.0 就是这么发出去的）。
 * 独立文件能本地跑、能被测试覆盖，**CI 里的逻辑不该是只有 CI 能执行的**。
 *
 * 取不到就打印空并以 1 退出，让调用方明确知道要回落，而不是发一段别的版本的说明。
 */
import { existsSync, readFileSync } from 'node:fs';
import { extractSection } from './release-notes.mjs';

const version = process.argv[2];
if (!version) {
  console.error('用法：node scripts/changelog-section.mjs <version>');
  process.exit(2);
}

const md = existsSync('CHANGELOG.md') ? readFileSync('CHANGELOG.md', 'utf-8') : '';
const section = extractSection(md, version);
if (!section) process.exit(1);
process.stdout.write(section);
