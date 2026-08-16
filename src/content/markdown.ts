/**
 * Markdown → 头条编辑器能吃的 HTML。
 *
 * 头条正文是 ProseMirror，对 paste 事件里的 `text/html` 有完整解析器 ——
 * 一次粘贴就能得到真正的标题/列表/引用/加粗。逐字打字则会把 `## 标题`
 * 原样打成四个字符。所以这一层的产出是 HTML，不是纯文本。
 */
import { marked } from 'marked';

export interface ImageRef {
  /** 原始 src（本地绝对路径或 http(s) URL） */
  src: string;
  alt: string;
  /** 在 HTML 里的占位标记，供后续替换成平台 CDN URL 或删除 */
  placeholder: string;
}

export interface RenderedArticle {
  html: string;
  /** 正文里出现的图片，按出现顺序 */
  images: ImageRef[];
  /** 纯文本视图（粘贴失败时的降级路径 + 字数统计） */
  text: string;
}

/** 占位标记：用注释而不是自定义属性 —— 属性会被编辑器的 schema 过滤掉，注释也会，但我们只在替换阶段用它 */
const placeholderFor = (index: number): string => `__TOUTIAO_IMG_${index}__`;

/**
 * 渲染。
 *
 * h1 降级为 h2：文章标题走单独的标题框，正文里再来一个 h1 是重复的，
 * 而头条编辑器对 h1 的处理并不稳定。
 */
export function renderArticleHtml(markdown: string): RenderedArticle {
  const images: ImageRef[] = [];

  const renderer = new marked.Renderer();
  const originalHeading = renderer.heading.bind(renderer);
  renderer.heading = (token) => {
    const html = originalHeading(token);
    return token.depth === 1 ? html.replace(/^<h1/, '<h2').replace(/<\/h1>$/, '</h2>') : html;
  };
  renderer.image = ({ href, text }) => {
    const index = images.length;
    const placeholder = placeholderFor(index);
    images.push({ src: href, alt: text ?? '', placeholder });
    // 先出占位 img，`flows/images.ts` 按策略替换 src 或整体改写
    return `<img src="${placeholder}" alt="${escapeHtml(text ?? '')}" />`;
  };

  const html = marked.parse(markdown, { async: false, gfm: true, breaks: true, renderer });

  return { html, images, text: toPlainText(markdown) };
}

/**
 * Markdown → 纯文本（微头条用，也用于字数统计）。
 *
 * **必须在算字数之前脱标记** —— 顺序反了就是在为垃圾做压缩（飞燕小红书链路踩过）。
 * `#话题` 必须保留：它是内容不是语法。
 */
export function toPlainText(markdown: string): string {
  let text = markdown;

  // 代码块：保留内容，去掉围栏
  text = text.replace(/```[^\n]*\n([\s\S]*?)```/g, '$1');
  text = text.replace(/`([^`]+)`/g, '$1');
  // 图片整行丢弃（纯文本场景里一个 alt 没有意义）
  text = text.replace(/^[ \t]*!\[[^\]]*\]\([^)]*\)[ \t]*$/gm, '');
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  // 链接保留文字
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  // 标题：去掉行首 #（注意行内的 #话题 不受影响 —— 这里锚定了行首 + 空格）
  text = text.replace(/^#{1,6}[ \t]+/gm, '');
  // 引用与列表符号
  text = text.replace(/^[ \t]*>[ \t]?/gm, '');
  text = text.replace(/^[ \t]*[-*+][ \t]+/gm, '');
  text = text.replace(/^[ \t]*\d+\.[ \t]+/gm, '');
  // 强调
  text = text.replace(/\*\*\*([^*]+)\*\*\*/g, '$1');
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1');
  text = text.replace(/\*([^*]+)\*/g, '$1');
  text = text.replace(/__([^_]+)__/g, '$1');
  text = text.replace(/~~([^~]+)~~/g, '$1');
  // 分隔线
  text = text.replace(/^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, '');
  // 连续空行压成一个
  text = text.replace(/\n{3,}/g, '\n\n');

  return text.trim();
}

/** 中文场景按「字符数」算，与平台的计数口径一致（emoji 用码点计数，避免代理对算两个） */
export function countChars(text: string): number {
  return [...text].length;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 把占位标记替换成真实可用的 src；替换不到的图片整个删掉并回报 */
export function applyImageSources(
  html: string,
  resolved: Map<string, string>,
): { html: string; dropped: string[] } {
  const dropped: string[] = [];
  const next = html.replace(
    /<img\s+src="(__TOUTIAO_IMG_\d+__)"[^>]*>/g,
    (match, placeholder: string) => {
      const src = resolved.get(placeholder);
      if (!src) {
        dropped.push(placeholder);
        return '';
      }
      return match.replace(placeholder, src);
    },
  );
  return { html: next, dropped };
}
