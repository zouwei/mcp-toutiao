import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    // 假站流程测试要起真 Chromium：默认 5s 不够，但也别放任无限等
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // 浏览器实例是进程级单例，测试文件之间必须隔离，否则一个文件关了浏览器另一个正在用
    fileParallelism: false,
  },
});
