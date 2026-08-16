/**
 * 运行时装配：把 config / logger / browser / session 拼成一个 ToolContext。
 *
 * 单独一个文件是为了让 cli、测试、嵌入式用法拿到**同一套**装配逻辑 ——
 * 三处各拼一遍的话，迟早有一处忘了 dispose。
 */
import { mkdirSync } from 'node:fs';

import { loadConfig, paths, type Config } from './config.js';
import { createLogger, type Logger } from './logger.js';
import { BrowserManager } from './core/browser.js';
import { setHumanizeEnabled } from './core/humanize.js';
import { SessionManager } from './core/session.js';
import type { ToolContext } from './mcp/tools.js';

export interface Runtime extends ToolContext {
  shutdown(): Promise<void>;
}

export function createRuntime(overrides: { config?: Config; logger?: Logger } = {}): Runtime {
  const config = overrides.config ?? loadConfig();
  const logger = overrides.logger ?? createLogger(config.logLevel);

  const dirs = paths(config);
  mkdirSync(dirs.profile, { recursive: true });
  mkdirSync(dirs.screenshots, { recursive: true });
  mkdirSync(dirs.tmp, { recursive: true });

  setHumanizeEnabled(config.humanize);

  const browser = new BrowserManager(config, logger);
  const session = new SessionManager(browser, config, logger);

  return {
    config,
    logger,
    browser,
    session,
    async shutdown() {
      session.dispose();
      await browser.shutdown();
    },
  };
}
