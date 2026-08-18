#!/usr/bin/env node

/**
 * 用**真实的改动**起草这一版的发行说明，写进 CHANGELOG.md。
 *
 *   pnpm release:notes 0.2.0     # 起草 v0.2.0 的说明并插进 CHANGELOG
 *   pnpm release:notes           # 版本号取 package.json
 *
 * 设计取舍（照搬 moraya 那套的经验）：
 *  - **AI 只写草稿，不碰 git**：不自动提交、不自动打 tag。发版是有后果的动作，
 *    最后一步必须是人按下去。
 *  - **在本地生成，不在 CI**：CI 里没有 Claude 二进制，也不该为发版去管 API key。
 *    生成结果落进 CHANGELOG 并随提交进仓库，release.yml 直接取那一段当 Release 正文。
 *  - **找不到 claude 就机械兜底**：发不出说明也不能让发版流程卡死。
 */
import { execFileSync, execSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractSection, sanitizeNotes } from './release-notes.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** 交给模型的 diff 上限 —— 再多既慢又贵，而且对写说明没有帮助 */
const MAX_DIFF_CHARS = 60_000;

function sh(cmd) {
  try {
    return execSync(cmd, { cwd: root, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

/** 找一个能跑的 claude：PATH → 当前会话 → VS Code 扩展自带的二进制 */
function findClaude() {
  const onPath = sh('command -v claude');
  if (onPath) return onPath;
  if (process.env.CLAUDE_CODE_EXECPATH && existsSync(process.env.CLAUDE_CODE_EXECPATH)) {
    return process.env.CLAUDE_CODE_EXECPATH;
  }
  const extRoot = join(homedir(), '.vscode', 'extensions');
  if (existsSync(extRoot)) {
    const found = readdirSync(extRoot)
      .filter((d) => d.startsWith('anthropic.claude-code-'))
      .sort()
      .reverse()
      .map((d) => join(extRoot, d, 'resources', 'native-binary', 'claude'))
      .find((p) => existsSync(p));
    if (found) return found;
  }
  return null;
}

function collectContext() {
  const lastTag = sh('git describe --tags --abbrev=0');
  const range = lastTag ? `${lastTag}..HEAD` : '';
  let diff = sh(`git diff ${range || 'HEAD'}`) || sh('git diff --cached');
  const truncated = diff.length > MAX_DIFF_CHARS;
  if (truncated) diff = diff.slice(0, MAX_DIFF_CHARS);
  return {
    lastTag,
    commits: range ? sh(`git log ${range} --pretty=format:"- %s"`) : sh('git log --pretty=format:"- %s"'),
    nameStatus: sh(`git diff ${range || 'HEAD'} --name-status`),
    untracked: sh('git ls-files --others --exclude-standard'),
    stat: sh(`git diff ${range || 'HEAD'} --stat`),
    diff,
    truncated,
  };
}

/** 没有 claude 时的机械版：至少把提交列表和改动面摆出来 */
function fallbackNotes(ctx) {
  return [
    ctx.commits || '- （无提交记录）',
    '',
    '### 改动面',
    '',
    '```',
    ctx.stat || '(none)',
    '```',
  ].join('\n');
}

function buildPrompt(version, ctx) {
  return `你在为 toutiao-mcp（今日头条发布 MCP 服务）写 v${version} 的发行说明。

要求：
- 直接输出 Markdown 正文，**不要**标题行（版本号那行由脚本写）、不要代码围栏、不要任何解释性开场白
- 用三级标题分组，常见分组：### 新增 / ### 修复 / ### 变更 / ### 已知限制（没有的组就不写）
- 每条说清**改了什么**以及**对使用者意味着什么**；修 bug 要写出原来的症状
- 真机联调发现的问题要单独点明（这个项目的价值就在于它跑在真站上）
- 中文行文，代码标识符、路径、命令保留英文
- 3～10 条，别流水账

${ctx.lastTag ? `距上一个版本 ${ctx.lastTag} 的提交：` : '全部提交：'}
${ctx.commits || '(none)'}

改动文件：
${ctx.nameStatus || '(none)'}

${ctx.untracked ? `新增未跟踪文件：\n${ctx.untracked}\n` : ''}
差异统计：
${ctx.stat || '(none)'}

差异${ctx.truncated ? '（已截断）' : ''}：
${ctx.diff || '(empty)'}`;
}

function main() {
  const version =
    process.argv[2]?.replace(/^v/, '') ?? JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')).version;
  const changelogPath = join(root, 'CHANGELOG.md');
  const changelog = existsSync(changelogPath) ? readFileSync(changelogPath, 'utf-8') : '# 变更记录\n';

  if (extractSection(changelog, version)) {
    console.log(`CHANGELOG 里已经有 v${version} 那一段了 —— 不覆盖，需要重写请先手工删掉。`);
    return;
  }

  const ctx = collectContext();
  const claude = findClaude();
  let body;
  if (!claude) {
    console.log('⚠ 没找到 claude 二进制 —— 改用机械汇总（提交列表 + 改动面）。');
    body = fallbackNotes(ctx);
  } else {
    console.log(`用 Claude 起草 v${version} 的发行说明…`);
    try {
      body = sanitizeNotes(
        execFileSync(claude, ['-p', '--model', 'sonnet'], {
          cwd: root,
          input: buildPrompt(version, ctx),
          encoding: 'utf-8',
          maxBuffer: 10 * 1024 * 1024,
          stdio: ['pipe', 'pipe', 'ignore'],
        }),
      );
      if (!body) throw new Error('模型返回为空');
    } catch (err) {
      console.log(`⚠ 调用失败（${err.message}）—— 改用机械汇总。`);
      body = fallbackNotes(ctx);
    }
  }

  // 插在标题之后、上一个版本之前 —— 最新版本永远在最上面
  const marker = changelog.indexOf('\n## ');
  const head = marker === -1 ? changelog.trimEnd() : changelog.slice(0, marker).trimEnd();
  const tail = marker === -1 ? '' : changelog.slice(marker + 1);
  writeFileSync(changelogPath, `${head}\n\n## v${version}\n\n${body}\n\n${tail}`.trimEnd() + '\n');

  console.log('\n' + '─'.repeat(60));
  console.log(`## v${version}\n\n${body}`);
  console.log('─'.repeat(60));
  console.log('\n草稿已写入 CHANGELOG.md。**先读一遍再发**，然后：');
  console.log('  git add -A && git commit -m "chore(release): v' + version + '"');
  console.log('  git tag v' + version + ' && git push origin main --tags');
}

main();
