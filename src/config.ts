/**
 * 环境变量解析 —— **唯一一处**读 process.env 的地方（除了 cli 里的少量启动参数）。
 * 别处一律收 Config 参数：这样测试不用改环境变量，也不会出现「某个模块偷偷读了个 env」。
 */
import { resolve } from 'node:path';

import { DEFAULT_BASE_URL } from './core/selectors.js';

export const IMAGE_STRATEGIES = ['auto', 'paste-url', 'intercept-upload', 'editor-upload'] as const;
export type ImageStrategy = (typeof IMAGE_STRATEGIES)[number];

export const STEALTH_MODES = ['builtin', 'extra', 'off'] as const;
export type StealthMode = (typeof STEALTH_MODES)[number];

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface Config {
  /** 站点根地址。生产恒为 https://mp.toutiao.com —— 可配是为了给测试留假站接缝 */
  baseUrl: string;
  dataDir: string;
  headless: boolean;
  browserPath: string | undefined;
  proxy: string | undefined;
  stealth: StealthMode;
  /** 人类化节奏（随机停顿 + 逐字输入）。只在测试/调试时关 —— 见 core/humanize.ts */
  humanize: boolean;
  imageStrategy: ImageStrategy;
  /** 空闲多久关掉浏览器（省内存）。等扫码的会话会 pin 住，不受此影响 */
  idleTimeoutMs: number;
  /** 队列排队上限，超过直接 BUSY —— 无限排队会让调用方以为只是慢 */
  queueMax: number;
  /** 后台等扫码的上限 */
  loginWaitMs: number;
  /** 单次工具调用的总预算 */
  toolTimeoutMs: number;
  authToken: string;
  host: string;
  port: number;
  logLevel: LogLevel;
}

function num(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(raw);
  if (!raw || !Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function bool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(raw.trim().toLowerCase());
}

function oneOf<T extends string>(raw: string | undefined, allowed: readonly T[], fallback: T): T {
  const value = raw?.trim().toLowerCase() as T | undefined;
  return value && allowed.includes(value) ? value : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    baseUrl: env['TOUTIAO_BASE_URL']?.trim() || DEFAULT_BASE_URL,
    dataDir: resolve(env['TOUTIAO_DATA_DIR'] ?? './data'),
    headless: bool(env['TOUTIAO_HEADLESS'], true),
    browserPath: env['TOUTIAO_BROWSER_PATH']?.trim() || undefined,
    proxy: env['TOUTIAO_PROXY']?.trim() || undefined,
    stealth: oneOf(env['TOUTIAO_STEALTH'], STEALTH_MODES, 'builtin'),
    humanize: bool(env['TOUTIAO_HUMANIZE'], true),
    imageStrategy: oneOf(env['TOUTIAO_IMAGE_STRATEGY'], IMAGE_STRATEGIES, 'auto'),
    idleTimeoutMs: num(env['TOUTIAO_IDLE_TIMEOUT_MS'], 600_000, 10_000, 24 * 3600_000),
    queueMax: num(env['TOUTIAO_QUEUE_MAX'], 4, 1, 64),
    loginWaitMs: num(env['TOUTIAO_LOGIN_WAIT_MS'], 300_000, 30_000, 1800_000),
    toolTimeoutMs: num(env['TOUTIAO_TOOL_TIMEOUT_MS'], 600_000, 30_000, 3600_000),
    // 与 xiaohongshu-mcp 同名，飞燕的 McpContainerSpec.authTokenEnv 可以直接复用这套约定
    authToken: env['AUTH_TOKEN']?.trim() ?? '',
    host: env['HOST']?.trim() || '0.0.0.0',
    port: num(env['PORT'], 18070, 1, 65535),
    logLevel: oneOf(env['LOG_LEVEL'], LOG_LEVELS, 'info'),
  };
}

/** 各子目录：集中在这里，免得散落的 join 拼错 */
export function paths(config: Config) {
  return {
    profile: resolve(config.dataDir, 'profile'),
    screenshots: resolve(config.dataDir, 'screenshots'),
    tmp: resolve(config.dataDir, 'tmp'),
  };
}
