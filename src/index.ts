/**
 * 库入口：把服务嵌进别的 Node 进程时用这里。
 * 命令行入口在 cli.ts。
 */
export { loadConfig, paths, type Config, type ImageStrategy, type StealthMode } from './config.js';
export { createLogger, silentLogger, type Logger } from './logger.js';
export { ToutiaoError, isToutiaoError, ERROR_CODES, type ErrorCode } from './errors.js';
export { BrowserManager, TIMEOUTS } from './core/browser.js';
export { SessionManager, type LoginStatus, type QrcodeResult } from './core/session.js';
export { LIMITS, SELECTORS, TEXTS, URLS } from './core/selectors.js';
export { renderArticleHtml, toPlainText, countChars } from './content/markdown.js';
export {
  publishArticle,
  type PublishArticleParams,
  type PublishArticleResult,
  type FlowDeps,
} from './flows/article.js';
export {
  publishWeitoutiao,
  type PublishWeitoutiaoParams,
  type PublishWeitoutiaoResult,
} from './flows/weitoutiao.js';
export { buildMcpServer, SERVER_INFO } from './mcp/server.js';
export { TOOL_DEFS, type ToolContext } from './mcp/tools.js';
export { startHttpServer, MCP_PATH, type HttpServerHandle } from './transports/http.js';
export { startStdioServer } from './transports/stdio.js';
export { createRuntime, type Runtime } from './runtime.js';
