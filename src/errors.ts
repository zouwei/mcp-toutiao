/**
 * 结构化错误。
 *
 * 为什么不直接 throw new Error(message)：调用方是 agent 或无人值守的流程，
 * 它需要据此**决定下一步动作** —— 「未登录」要去扫码、「风控」要人介入、
 * 「改版」要升级本服务。一句自由文本做不到这件事，所以 code 是必填的。
 *
 * 契约见 docs/specs/mcp-contract.md §4。
 */
export const ERROR_CODES = [
  'NOT_LOGGED_IN',
  'LOGIN_TIMEOUT',
  'CAPTCHA_REQUIRED',
  'EDITOR_NOT_FOUND',
  'IMAGE_UPLOAD_FAILED',
  'CONTENT_LIMIT',
  'PUBLISH_REJECTED',
  /** 点了发布但拿不到任何「发出去了」的证据 —— 不等于失败，也绝不能当成功 */
  'PUBLISH_UNCONFIRMED',
  'TIMEOUT',
  'BUSY',
  'BAD_INPUT',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ToutiaoErrorOptions {
  /** 卡在哪一步。超时/失败时这是最有用的一个字段 —— 「发布超时」和「上传封面超时」处置完全不同 */
  step?: string;
  /** 结构化补充信息（平台 toast 原文、期望与实际值等） */
  detail?: Record<string, unknown>;
  /** 现场截图（base64 PNG，不带 data: 前缀）。风控与选择器失效时必带 */
  screenshot?: string;
  cause?: unknown;
}

export class ToutiaoError extends Error {
  readonly code: ErrorCode;
  readonly step: string | undefined;
  readonly detail: Record<string, unknown> | undefined;
  readonly screenshot: string | undefined;

  constructor(code: ErrorCode, message: string, options: ToutiaoErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'ToutiaoError';
    this.code = code;
    this.step = options.step;
    this.detail = options.detail;
    this.screenshot = options.screenshot;
  }

  /** 给 MCP 返回体用的 JSON（不含截图 —— 截图作为独立的 image 块发出，不塞进文本里） */
  toPayload(): Record<string, unknown> {
    const payload: Record<string, unknown> = { code: this.code, message: this.message };
    if (this.step) payload['step'] = this.step;
    if (this.detail) payload['detail'] = this.detail;
    return payload;
  }
}

export function isToutiaoError(err: unknown): err is ToutiaoError {
  return err instanceof ToutiaoError;
}

/**
 * 把任意异常收敛成 ToutiaoError。
 *
 * Playwright 的超时异常长得都一样（TimeoutError: locator.click: Timeout 15000ms exceeded），
 * 单看消息分不清是页面没加载、元素改名还是网络慢 —— 所以由调用处传 step 与 fallback code，
 * 在离现场最近的地方赋予它含义。
 */
export function wrapError(
  err: unknown,
  fallback: ErrorCode,
  options: ToutiaoErrorOptions = {},
): ToutiaoError {
  if (isToutiaoError(err)) return err;
  const message = err instanceof Error ? err.message : String(err);
  const isTimeout = err instanceof Error && /timeout/i.test(err.name + err.message);
  return new ToutiaoError(isTimeout ? 'TIMEOUT' : fallback, message, { ...options, cause: err });
}
