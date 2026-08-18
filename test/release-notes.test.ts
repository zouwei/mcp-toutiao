/**
 * 发行说明的清洗与提取。
 * 这两处错了会把奇怪的东西发布出去（模型的自言自语、或者别的版本的说明），
 * 而且发出去就撤不回来 —— 所以单独测。
 */
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { extractSection, sanitizeNotes } from '../scripts/release-notes.mjs';

describe('sanitizeNotes', () => {
  it('剥掉代码围栏', () => {
    expect(sanitizeNotes('```markdown\n### 修复\n\n- 修了 A\n```')).toBe('### 修复\n\n- 修了 A');
  });

  it('丢掉正文之前的开场白（模型常见的"好的，以下是…"）', () => {
    expect(sanitizeNotes('好的，以下是发行说明：\n\n### 新增\n\n- 加了 B')).toBe('### 新增\n\n- 加了 B');
  });

  it('认不出结构就原样返回 —— 发一段不规整的，好过发一段空的', () => {
    expect(sanitizeNotes('就改了个错别字')).toBe('就改了个错别字');
  });

  it('空输入不炸', () => {
    expect(sanitizeNotes(undefined)).toBe('');
  });
});

describe('extractSection', () => {
  const CHANGELOG = `# 变更记录

## v0.2.0

### 新增

- 新东西

## v0.1.0

首个发行版。
`;

  it('取出指定版本那一段，不含标题行', () => {
    expect(extractSection(CHANGELOG, '0.2.0')).toBe('### 新增\n\n- 新东西');
  });

  it('带 v 前缀也认（tag 名直接传进来）', () => {
    expect(extractSection(CHANGELOG, 'v0.1.0')).toBe('首个发行版。');
  });

  it('取不到就返回空 —— 调用方据此回落，绝不能串到别的版本的说明', () => {
    expect(extractSection(CHANGELOG, '9.9.9')).toBe('');
  });
});

/**
 * CI 取 Release 正文用的那条命令。
 * 2026-08-18 v0.1.0 就栽在这儿：内联 `node -e` 在 ESM 下用了 `require`，
 * 抛错被 `|| true` 吞掉 → 静默回落成自动生成的记录，而流水线还是绿的。
 * **CI 里的逻辑必须能在本地跑，也必须被测到。**
 */
describe('changelog-section 脚本', () => {
  const run = (arg: string) => {
    const { status, stdout } = spawnSync('node', ['scripts/changelog-section.mjs', arg], {
      cwd: new URL('..', import.meta.url).pathname,
      encoding: 'utf-8',
    });
    return { status, out: stdout.trim() };
  };

  it('取得到本仓库真实 CHANGELOG 里的 v0.1.0（退出码 0）', () => {
    const { status, out } = run('v0.1.0');
    expect(status).toBe(0);
    expect(out).toContain('###');
  });

  it('取不到时输出为空并以非 0 退出 —— 让 CI 知道要回落，而不是发错版本的说明', () => {
    const { status, out } = run('v9.9.9');
    expect(status).toBe(1);
    expect(out).toBe('');
  });
});
