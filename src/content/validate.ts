/**
 * 发布前校验 —— 在**打开浏览器之前**跑完。
 *
 * 为什么不截断：无人值守下静默截断会让半截内容「发布成功」，等读者看到半句话时
 * 早没人知道是哪次跑的。压缩/改写是调用方的职责（飞燕 publish.prepare 的
 * onOverflow: compress），我们是最后那道闸，只负责拦。
 */
import { existsSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';

import { ToutiaoError } from '../errors.js';
import { LIMITS } from '../core/selectors.js';
import { countChars } from './markdown.js';

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;
/** 单张图上限：头条页面提示 ~10MB，留点余量给上传超时 */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export function validateArticleTitle(title: string): void {
  const length = countChars(title.trim());
  if (length < LIMITS.articleTitleMin) {
    throw new ToutiaoError(
      'CONTENT_LIMIT',
      `标题过短：头条要求至少 ${LIMITS.articleTitleMin} 个字，当前 ${length} 个字`,
      { step: 'validate', detail: { field: 'title', length, min: LIMITS.articleTitleMin } },
    );
  }
  if (length > LIMITS.articleTitleMax) {
    throw new ToutiaoError(
      'CONTENT_LIMIT',
      `标题超限：头条上限 ${LIMITS.articleTitleMax} 个字，当前 ${length} 个字 —— 请改短后重试（本服务不会自动截断）`,
      { step: 'validate', detail: { field: 'title', length, max: LIMITS.articleTitleMax } },
    );
  }
}

export function validateArticleContent(markdown: string): void {
  if (!markdown.trim()) {
    throw new ToutiaoError('CONTENT_LIMIT', '正文为空', { step: 'validate' });
  }
  const length = countChars(markdown);
  if (length > LIMITS.articleContentMax) {
    throw new ToutiaoError(
      'CONTENT_LIMIT',
      `正文过长：${length} 字，超过 ${LIMITS.articleContentMax} 字的防呆上限`,
      { step: 'validate', detail: { field: 'content', length } },
    );
  }
}

export function validateWeitoutiaoContent(plainText: string): void {
  const length = countChars(plainText.trim());
  if (length === 0) {
    throw new ToutiaoError('CONTENT_LIMIT', '微头条正文为空', { step: 'validate' });
  }
  if (length > LIMITS.weitoutiaoContentMax) {
    throw new ToutiaoError(
      'CONTENT_LIMIT',
      `微头条正文超限：上限 ${LIMITS.weitoutiaoContentMax} 字，当前 ${length} 字（已脱去 Markdown 标记后计数）`,
      { step: 'validate', detail: { field: 'content', length, max: LIMITS.weitoutiaoContentMax } },
    );
  }
}

export function validateImageCount(images: string[], max: number, field = 'images'): void {
  if (images.length > max) {
    throw new ToutiaoError(
      'CONTENT_LIMIT',
      `${field} 数量超限：上限 ${max} 张，当前 ${images.length} 张`,
      { step: 'validate', detail: { field, count: images.length, max } },
    );
  }
}

export const isRemote = (ref: string): boolean => /^https?:\/\//i.test(ref);

/**
 * 校验图片引用。
 *
 * 相对路径**直接报错**：MCP 服务的 cwd 对调用方不可见，猜一个基准目录只会产生
 * 「本机能跑、容器里找不到」这类最难查的幽灵故障。
 */
export function validateImageRefs(refs: string[], field = 'images'): void {
  for (const ref of refs) {
    if (!ref.trim()) {
      throw new ToutiaoError('BAD_INPUT', `${field} 里有空路径`, { step: 'validate' });
    }
    if (isRemote(ref)) continue;

    if (!isAbsolute(ref)) {
      throw new ToutiaoError(
        'BAD_INPUT',
        `图片必须是本地绝对路径或 http(s) 链接，收到相对路径：${ref} —— ` +
          `本服务的工作目录对调用方不可见，相对路径无法可靠解析`,
        { step: 'validate', detail: { field, ref } },
      );
    }
    if (!existsSync(ref)) {
      throw new ToutiaoError('BAD_INPUT', `图片文件不存在：${ref}`, {
        step: 'validate',
        detail: { field, ref },
      });
    }
    if (!IMAGE_EXT.test(ref)) {
      throw new ToutiaoError(
        'BAD_INPUT',
        `不支持的图片格式：${ref}（支持 png/jpg/jpeg/gif/webp/bmp）`,
        { step: 'validate', detail: { field, ref } },
      );
    }
    const size = statSync(ref).size;
    if (size > MAX_IMAGE_BYTES) {
      throw new ToutiaoError(
        'BAD_INPUT',
        `图片过大：${ref} 为 ${(size / 1024 / 1024).toFixed(1)}MB，上限 ${MAX_IMAGE_BYTES / 1024 / 1024}MB`,
        { step: 'validate', detail: { field, ref, size } },
      );
    }
  }
}
