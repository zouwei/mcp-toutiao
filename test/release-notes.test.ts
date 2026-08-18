/**
 * 发行说明的清洗与提取。
 * 这两处错了会把奇怪的东西发布出去（模型的自言自语、或者别的版本的说明），
 * 而且发出去就撤不回来 —— 所以单独测。
 */
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
