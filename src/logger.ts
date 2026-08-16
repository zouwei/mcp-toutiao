/**
 * 日志一律写 **stderr**。
 *
 * stdio 传输下 stdout 是 MCP 的协议通道，往里写一个字节客户端就解析失败 ——
 * 而这类故障的表现是「客户端说服务器坏了」，排查方向完全指向错误的地方。
 * eslint 的 no-console 规则兜住裸 console.log。
 */
import type { LogLevel } from './config.js';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

export function createLogger(level: LogLevel = 'info', scope = 'toutiao-mcp'): Logger {
  const threshold = ORDER[level];

  const write = (lvl: LogLevel, message: string, fields?: Record<string, unknown>): void => {
    if (ORDER[lvl] < threshold) return;
    const time = new Date().toISOString();
    const extra = fields && Object.keys(fields).length > 0 ? ' ' + safeJson(fields) : '';
    process.stderr.write(`${time} ${lvl.toUpperCase().padEnd(5)} [${scope}] ${message}${extra}\n`);
  };

  return {
    debug: (m, f) => write('debug', m, f),
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
    child: (sub) => createLogger(level, `${scope}:${sub}`),
  };
}

/** 日志里出现循环引用/超大对象不该把服务弄崩，也不该刷屏 */
function safeJson(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    return text.length > 2000 ? text.slice(0, 2000) + '…' : text;
  } catch {
    return '[unserializable]';
  }
}

/** 测试用：什么都不输出 */
export function silentLogger(): Logger {
  const noop = (): void => {};
  const logger: Logger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => logger,
  };
  return logger;
}
