/**
 * 往 ProseMirror 编辑器里注入正文。
 *
 * 主路径是**合成 paste 事件**：ProseMirror 对 `text/html` 有完整解析器，一次粘贴
 * 就得到真正的标题/列表/引用结构；逐字打字只会把 `## 标题` 打成四个字符。
 *
 * 但合成事件是可能被 preventDefault 掉的 —— **粘贴后必须验证编辑器里真有内容**。
 * 静默的空正文比报错糟糕得多：它会「发布成功」。
 */
import type { Page } from 'playwright';

import { ToutiaoError } from '../errors.js';
import { pause, typeParagraphs } from '../core/humanize.js';
import { captureScreenshot } from '../core/overlays.js';
import { SELECTORS } from '../core/selectors.js';

export interface PasteOutcome {
  method: 'paste' | 'typed';
  length: number;
}

export async function focusEditor(page: Page, step: string): Promise<void> {
  const editor = page.locator(SELECTORS.editor).first();
  try {
    await editor.waitFor({ state: 'visible', timeout: 15_000 });
  } catch (err) {
    throw new ToutiaoError(
      'EDITOR_NOT_FOUND',
      '找不到正文编辑器 —— 多半是头条前端改版，请升级本服务（selectors.ts）',
      { step, screenshot: await captureScreenshot(page), cause: err },
    );
  }
  await editor.click({ timeout: 10_000 });
  await pause(200, 400);
}

/**
 * 聚焦编辑器并把光标**放到文末**。
 *
 * ⚠ 逐张插图时**绝不能**用 `focusEditor`（它是 `editor.click()`，点的是元素正中央）：
 * 第一张图插进去后，中心位置往往就落在那张图上，而在 ProseMirror 里
 * **点中图片 = 选中该图片节点**，下一次粘贴会把它整个替换掉。
 * 2026-08-18 真机：连插 5 张，最后文章里只剩最后一张（run_a6Noq-A_IK）。
 *
 * 这里用 Selection API 把光标折叠到内容末尾，不产生任何选区，
 * 后续粘贴一律是「追加」而不是「替换选中内容」。
 */
export async function focusEditorAtEnd(page: Page, step: string): Promise<void> {
  const editor = page.locator(SELECTORS.editor).first();
  try {
    await editor.waitFor({ state: 'visible', timeout: 15_000 });
  } catch (err) {
    throw new ToutiaoError(
      'EDITOR_NOT_FOUND',
      '找不到正文编辑器 —— 多半是头条前端改版，请升级本服务（selectors.ts）',
      { step, screenshot: await captureScreenshot(page), cause: err },
    );
  }
  await editor.evaluate((el: HTMLElement) => {
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false); // false = 折叠到末尾
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  });
  await pause(150, 300);
}

/**
 * 注入 HTML；失败自动降级为逐段打字。
 * @param plain 降级路径用的纯文本（也放进 clipboardData 的 text/plain，供编辑器自己选）
 */
export async function pasteRichText(
  page: Page,
  html: string,
  plain: string,
  step: string,
): Promise<PasteOutcome> {
  await focusEditor(page, step);

  const before = await editorTextLength(page);
  await dispatchPaste(page, html, plain);
  await pause(500, 900);

  const after = await editorTextLength(page);
  if (after > before) return { method: 'paste', length: after };

  // 降级：逐段打字。丢掉富文本结构，但**内容不会丢** —— 这个取舍在无人值守下是对的
  await focusEditor(page, step);
  await typeParagraphs(page, plain);
  await pause(300, 600);

  const typedLength = await editorTextLength(page);
  if (typedLength <= before) {
    throw new ToutiaoError('EDITOR_NOT_FOUND', '正文写入失败：粘贴与逐字输入都没能让编辑器产生内容', {
      step,
      screenshot: await captureScreenshot(page),
      detail: { before, afterPaste: after, afterTyping: typedLength },
    });
  }
  return { method: 'typed', length: typedLength };
}

/**
 * 在当前光标处派发一次 paste 事件。不做验证 —— 分段插入时每段都验一次没有意义，
 * 由调用方在整段结束后统一验。
 */
export async function dispatchPaste(page: Page, html: string, plain: string): Promise<void> {
  await page.evaluate(
    ({ html: payload, plain: fallback, selector }) => {
      const editor = document.querySelector(selector);
      if (!editor) return;
      (editor as HTMLElement).focus();
      const dt = new DataTransfer();
      dt.setData('text/html', payload);
      dt.setData('text/plain', fallback);
      editor.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
      );
    },
    { html, plain, selector: SELECTORS.editor },
  );
}

export async function editorTextLength(page: Page): Promise<number> {
  return page
    .evaluate((selector) => {
      const editor = document.querySelector(selector);
      return editor ? (editor.textContent ?? '').trim().length : 0;
    }, SELECTORS.editor)
    .catch(() => 0);
}

/** 读取编辑器里所有 img 的 src —— 用于验证外链图是否被平台转存 */
export async function editorImageSources(page: Page): Promise<string[]> {
  return page
    .evaluate((selector) => {
      const editor = document.querySelector(selector);
      if (!editor) return [];
      return Array.from(editor.querySelectorAll('img'))
        .map((img) => img.getAttribute('src') ?? '')
        .filter(Boolean);
    }, SELECTORS.editor)
    .catch(() => []);
}

/** 清空编辑器（intercept-upload 策略要先探一次图再重来） */
export async function clearEditor(page: Page): Promise<void> {
  await focusEditor(page, 'clear_editor');
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Backspace');
  await pause(200, 400);
}
