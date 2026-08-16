import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'data/', 'docs/', 'coverage/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      /**
       * stdio 传输下 stdout 是 MCP 的协议通道 —— 往里写一个字节就会让客户端解析失败。
       * 日志一律走 src/logger.ts（写 stderr）。
       */
      'no-console': 'error',
    },
  },
  {
    // 脚本与测试不受 stdout 约束
    files: ['scripts/**', 'test/**', '**/*.test.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    // 纯 JS 脚本：给 Node 全局（URL/process/…），否则 no-undef 会误报
    files: ['**/*.mjs', '**/*.js'],
    languageOptions: {
      globals: { process: 'readonly', URL: 'readonly', console: 'readonly' },
    },
  },
);
