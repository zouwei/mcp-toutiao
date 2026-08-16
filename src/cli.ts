#!/usr/bin/env node
/**
 * 命令行入口：serve | stdio | login | doctor
 *
 * 没引 commander 之类的解析库 —— 四条子命令、五个参数，手写比拖依赖省事，
 * 而这是个要塞进容器的服务，每个依赖都是攻击面。
 */
import { createRuntime } from './runtime.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { startHttpServer } from './transports/http.js';
import { startStdioServer } from './transports/stdio.js';
import { isToutiaoError } from './errors.js';

const HELP = `toutiao-mcp — 今日头条创作者平台 MCP 服务

用法：
  toutiao-mcp serve [--port <n>] [--host <h>]   启动 streamable-http 服务（默认 0.0.0.0:18070，端点 /mcp）
  toutiao-mcp stdio                             以 stdio 方式运行（Claude Code / Cursor 等桌面客户端）
  toutiao-mcp login                             本机有头浏览器扫码登录（首次使用或 cookie 过期时）
  toutiao-mcp doctor                            自检：浏览器可用性、数据目录、登录态

环境变量（完整列表见 README）：
  TOUTIAO_DATA_DIR          数据目录（浏览器 profile，默认 ./data）
  TOUTIAO_HEADLESS          false = 有头模式（调试/过验证码）
  TOUTIAO_IMAGE_STRATEGY    auto | paste-url | intercept-upload | editor-upload
  AUTH_TOKEN                http 模式的 Bearer Token（强烈建议设置）
  PORT / HOST               http 监听（默认 18070 / 0.0.0.0）
`;

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const command = argv[0] ?? 'serve';

  if (command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(HELP);
    return 0;
  }
  if (command === '--version' || command === '-v') {
    process.stdout.write('0.1.0\n');
    return 0;
  }

  switch (command) {
    case 'serve':
      return serve(argv.slice(1));
    case 'stdio':
      return stdio();
    case 'login':
      return login();
    case 'doctor':
      return doctor();
    default:
      process.stderr.write(`未知命令：${command}\n\n${HELP}`);
      return 2;
  }
}

function readFlag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  if (index >= 0 && argv[index + 1]) return argv[index + 1];
  const inline = argv.find((arg) => arg.startsWith(`--${name}=`));
  return inline?.split('=').slice(1).join('=');
}

async function serve(argv: string[]): Promise<number> {
  const base = loadConfig();
  const port = Number(readFlag(argv, 'port') ?? base.port);
  const host = readFlag(argv, 'host') ?? base.host;
  const runtime = createRuntime({ config: { ...base, port, host } });

  const handle = await startHttpServer(runtime, runtime.logger);
  installShutdown(async () => {
    await handle.close();
    await runtime.shutdown();
  }, runtime.logger);
  return -1; // 常驻
}

async function stdio(): Promise<number> {
  const runtime = createRuntime();
  const stop = await startStdioServer(runtime, runtime.logger);
  installShutdown(async () => {
    await stop();
    await runtime.shutdown();
  }, runtime.logger);
  return -1;
}

/** 本机扫码：强制有头模式。容器里没有图形环境，这条命令是给本机准备 profile 用的 */
async function login(): Promise<number> {
  const config = { ...loadConfig(), headless: false };
  const runtime = createRuntime({ config });
  const log = runtime.logger.child('login');

  try {
    const status = await runtime.session.checkStatus();
    if (status.is_logged_in) {
      log.info('已经是登录状态，无需重复登录', { user: status.user });
      return 0;
    }

    const result = await runtime.session.getQrcode();
    if ('alreadyLoggedIn' in result) return 0;

    log.info('浏览器已打开登录页 —— 请用今日头条 App 扫码');
    log.info(`（二维码也已存到 ${config.dataDir}/screenshots/login-qrcode.png）`);
    const { writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    writeFileSync(
      join(config.dataDir, 'screenshots', 'login-qrcode.png'),
      Buffer.from(result.image, 'base64'),
    );

    // 轮询到登录成功或超时。有头模式下用户可能手动过验证码，所以等满 loginWaitMs
    const deadline = Date.now() + config.loginWaitMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      const current = await runtime.session.checkStatus();
      if (current.is_logged_in) {
        log.info('登录成功，会话已保存', { user: current.user, profile: `${config.dataDir}/profile` });
        return 0;
      }
    }
    log.error('等待扫码超时');
    return 1;
  } finally {
    await runtime.shutdown();
  }
}

async function doctor(): Promise<number> {
  const runtime = createRuntime();
  const log = runtime.logger.child('doctor');
  let failed = false;

  log.info('配置', {
    dataDir: runtime.config.dataDir,
    headless: runtime.config.headless,
    stealth: runtime.config.stealth,
    imageStrategy: runtime.config.imageStrategy,
    authToken: runtime.config.authToken ? '(已设置)' : '(未设置)',
  });

  try {
    const status = await runtime.session.checkStatus();
    log.info('浏览器可用，已打开头条后台', { is_logged_in: status.is_logged_in });
    if (!status.is_logged_in) log.warn('尚未登录 —— 请执行 toutiao-mcp login 或调用 get_login_qrcode');
  } catch (err) {
    failed = true;
    log.error('自检失败', {
      code: isToutiaoError(err) ? err.code : 'INTERNAL',
      message: err instanceof Error ? err.message : String(err),
    });
  } finally {
    await runtime.shutdown();
  }
  return failed ? 1 : 0;
}

function installShutdown(stop: () => Promise<void>, log: ReturnType<typeof createLogger>): void {
  let stopping = false;
  const handler = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    log.info(`收到 ${signal}，正在关闭…`);
    void stop()
      .catch(() => {})
      .finally(() => process.exit(0));
  };
  process.on('SIGINT', () => handler('SIGINT'));
  process.on('SIGTERM', () => handler('SIGTERM'));
}

main()
  .then((code) => {
    if (code >= 0) process.exit(code);
    // code < 0 表示常驻服务，不退出
  })
  .catch((err: unknown) => {
    process.stderr.write(`启动失败：${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  });
