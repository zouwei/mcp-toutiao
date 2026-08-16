/**
 * tsc 不保留可执行位，npm bin 需要 dist/cli.js 可执行。
 * 单独一个脚本而不是 `chmod +x`：Windows 上的 shell 没有 chmod。
 */
import { chmodSync, existsSync } from 'node:fs';

const target = new URL('../dist/cli.js', import.meta.url);
if (existsSync(target)) {
  chmodSync(target, 0o755);
}
