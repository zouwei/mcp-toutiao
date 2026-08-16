import { describe, expect, it } from 'vitest';

import { applyImageSources, countChars, renderArticleHtml, toPlainText } from './markdown.js';

describe('renderArticleHtml', () => {
  it('renders GFM structure the ProseMirror editor can consume', () => {
    const { html } = renderArticleHtml(
      ['## 小标题', '', '正文**加粗**与*斜体*。', '', '- 一', '- 二', '', '> 引用'].join('\n'),
    );

    expect(html).toContain('<h2');
    expect(html).toContain('<strong>加粗</strong>');
    expect(html).toContain('<li>');
    expect(html).toContain('<blockquote>');
  });

  it('demotes h1 to h2 — the article title lives in its own input box', () => {
    const { html } = renderArticleHtml('# 我是标题\n\n正文');
    expect(html).not.toContain('<h1');
    expect(html).toContain('<h2');
  });

  it('extracts images in order and leaves replaceable placeholders', () => {
    const { html, images } = renderArticleHtml(
      '开头\n\n![封面](/tmp/a.png)\n\n中间\n\n![图二](https://example.com/b.jpg)',
    );

    expect(images.map((i) => i.src)).toEqual(['/tmp/a.png', 'https://example.com/b.jpg']);
    expect(images[0]?.alt).toBe('封面');
    // 占位符必须还在 html 里，否则后续替换无从下手
    for (const image of images) expect(html).toContain(image.placeholder);
  });

  it('escapes alt text so a crafted alt cannot inject markup', () => {
    const { html } = renderArticleHtml('![" onerror="alert(1)](/tmp/a.png)');
    expect(html).not.toContain('onerror="alert(1)"');
    expect(html).toContain('&quot;');
  });
});

describe('toPlainText', () => {
  it('strips markdown markup before counting — order matters', () => {
    const text = toPlainText('## 标题\n\n**加粗**和[链接](https://x.com)。\n\n- 列表项');
    expect(text).toContain('标题');
    expect(text).toContain('加粗和链接。');
    expect(text).toContain('列表项');
    expect(text).not.toContain('**');
    expect(text).not.toContain('##');
    expect(text).not.toContain('https://x.com');
  });

  it('keeps #话题 — it is content, not syntax', () => {
    // 行首 # 后必须有空格才是标题；话题标签紧跟文字，不该被当成标题剥掉
    expect(toPlainText('今天聊聊 #人工智能 的进展')).toBe('今天聊聊 #人工智能 的进展');
    expect(toPlainText('#话题在行首')).toBe('#话题在行首');
    expect(toPlainText('# 这是标题')).toBe('这是标题');
  });

  it('drops image lines but keeps link text', () => {
    expect(toPlainText('![配图](/tmp/a.png)\n\n正文')).toBe('正文');
  });

  it('keeps code block content without the fences', () => {
    expect(toPlainText('```js\nconst a = 1;\n```')).toBe('const a = 1;');
  });
});

describe('countChars', () => {
  it('counts by code point so emoji are one char', () => {
    expect(countChars('你好')).toBe(2);
    expect(countChars('👍')).toBe(1);
  });
});

describe('applyImageSources', () => {
  it('replaces placeholders and reports the ones it could not resolve', () => {
    const { html, images } = renderArticleHtml('![a](/tmp/a.png)\n\n![b](/tmp/b.png)');
    const resolved = new Map([[images[0]!.placeholder, 'https://cdn.toutiao.com/a.png']]);

    const result = applyImageSources(html, resolved);

    expect(result.html).toContain('https://cdn.toutiao.com/a.png');
    expect(result.html).not.toContain(images[1]!.placeholder);
    // 解析不到的图整个删掉，而不是留一个 src 是占位符的坏 img 发出去
    expect(result.dropped).toEqual([images[1]!.placeholder]);
  });
});
