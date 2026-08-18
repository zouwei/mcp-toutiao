# toutiao-mcp

今日头条创作者平台（[mp.toutiao.com](https://mp.toutiao.com/)）的 **MCP 服务**：扫码登录 + 图文文章 / 微头条发布。
走登录态浏览器自动化，**不需要官方 API**。

任意 MCP 客户端都能连（Claude Code、Cursor、n8n、自建 agent），也可作为 Docker 边车接入内容运营系统。

> ⚠️ **风险须知**：头条没有开放的发布 API，本服务模拟人在网页端操作。这**可能违反平台用户协议**，
> 账号存在风控甚至封禁的风险。请自行评估，建议先用小号验证。作者不对账号损失负责。

---

## 能做什么

| 工具 | 说明 |
|---|---|
| `check_login_status` | 查询登录状态 |
| `get_login_qrcode` | 取扫码登录二维码（立即返回图片，不阻塞等扫码） |
| `logout` | 退出登录 |
| `publish_article` | 发布图文文章：Markdown 正文 → 头条富文本、封面、正文插图、首发/合集/声明 |
| `publish_weitoutiao` | 发布微头条：纯文本 + 最多 9 张配图 + 话题 |

不做的事：不生成内容、不做排版主题、不逆向头条私有接口、不做定时与频控（那是调用方的职责）。

---

## 快速开始

### 方式一：桌面客户端（stdio）

Claude Code / Cursor 的 MCP 配置里加：

```json
{
  "mcpServers": {
    "toutiao": {
      "command": "npx",
      "args": ["-y", "@moraya/toutiao-mcp", "stdio"],
      "env": { "TOUTIAO_DATA_DIR": "~/.toutiao-mcp" }
    }
  }
}
```

首次使用先扫码登录（需要图形环境）：

```bash
npx -y @moraya/toutiao-mcp login
```

### 方式二：Docker（推荐用于服务器 / 接入自动化系统）

```bash
cp .env.example .env      # 至少设一个 AUTH_TOKEN
docker compose -f docker/docker-compose.yml up -d
curl http://127.0.0.1:18070/healthz
```

MCP 端点：`http://127.0.0.1:18070/mcp`（streamable-http，带 `Authorization: Bearer <AUTH_TOKEN>`）。

容器里没有图形环境，**登录靠 `get_login_qrcode` 工具**：让 agent 调用它、把返回的二维码图片展示给你，
用今日头条 App 扫一下，再调 `check_login_status` 确认。

### 方式三：源码运行

```bash
pnpm install
npx playwright install chromium
pnpm build
node dist/cli.js serve          # 或 stdio / login / doctor
```

---

## 典型对话

```
你：帮我把这篇稿子发到头条
Agent：（调 check_login_status → 未登录）
       （调 get_login_qrcode → 展示二维码）请用今日头条 App 扫码
你：（扫码）好了
Agent：（调 check_login_status → 已登录）
       （调 publish_article，2 分钟后）已发布，文章 ID 74123…，链接 https://www.toutiao.com/item/…
```

**给 agent 的提示**：发布耗时可达数分钟，请把客户端超时设到 300 秒以上。
返回体里 `verified: false` 表示没能从平台确认结果 —— 这时**内容很可能已经发出去了**，
请提示用户去后台核对，不要直接重发。

---

## 内容规则（服务端会拦，不会静默截断）

| 项 | 限制 |
|---|---|
| 文章标题 | 2–30 字 |
| 微头条正文 | ≤2000 字（Markdown 标记会先脱去再计数，`#话题` 保留） |
| 微头条配图 | ≤9 张，必须是本地文件 |
| 图片路径 | 本地**绝对路径**或 `http(s)` 链接。相对路径会被拒 —— 本服务的工作目录对调用方不可见 |
| 单张图片 | ≤10MB，png/jpg/jpeg/gif/webp/bmp |

超限一律返回 `CONTENT_LIMIT` 而不是截断：无人值守下，半截内容「发布成功」比失败糟糕得多。
压缩/改写请在调用侧完成。

**注意** `publish_article` 的 `also_weitoutiao` 默认为 `false`：头条发布页默认勾选「同时发布微头条」，
本服务会主动取消，避免一次调用发出两条内容。需要的话显式传 `true`。

---

## 配置

全部环境变量见 [.env.example](.env.example)。最常用的几个：

| 变量 | 默认 | 说明 |
|---|---|---|
| `AUTH_TOKEN` | 空 | http 模式的 Bearer Token，**生产必设** |
| `TOUTIAO_DATA_DIR` | `./data` | 浏览器 profile（登录态）所在目录 |
| `TOUTIAO_HEADLESS` | `true` | `false` = 有头模式，用于本机扫码或手动过验证码 |
| `TOUTIAO_IMAGE_STRATEGY` | `auto` | 正文插图策略，见下 |
| `TOUTIAO_PROXY` | — | `http(s)://` / `socks5://` |
| `TOUTIAO_BROWSER_PATH` | — | 换成系统 Chrome 或指纹浏览器 |

### 正文插图策略

头条编辑器对「粘贴进来的外链图」是否自动转存，随版本而变。所以做成可切换 + 自动回落：

| 策略 | 做法 |
|---|---|
| `paste-url` | 图片以 URL 形式随正文一起粘贴，指望平台自动转存 |
| `intercept-upload` | 先用编辑器自己的上传通道把图传上去、拿到平台地址，再整体粘贴 |
| `editor-upload` | 分段粘贴，遇图走 UI 上传插入（最慢，最不容易被拒） |
| `auto`（默认） | `paste-url` →（校验发现没转存）→ `intercept-upload` → `editor-upload` |

无论哪条路，发布前都会校验正文里的图是否已经是平台地址 —— 不校验就会出现
「发布成功但图是外链」，这种问题读者比你先发现。

---

## 排错

```bash
node dist/cli.js doctor    # 浏览器可用性 + 数据目录 + 登录态
docker logs toutiao-mcp    # 日志一律在 stderr
```

| 现象 | 多半是 |
|---|---|
| `NOT_LOGGED_IN` | cookie 过期，重新扫码 |
| `CAPTCHA_REQUIRED` | 触发风控。返回体里带现场截图；换出口 IP、降低频率，或用 `TOUTIAO_HEADLESS=false` 人工过一次 |
| `EDITOR_NOT_FOUND` | 头条前端改版了。请升级本服务（选择器集中在一个文件，修复通常很快） |
| `BUSY` | 同一账号的操作必须串行，稍后重试 |
| 容器里白屏 / target closed | `/dev/shm` 太小，compose 里已给 `shm_size: 512mb` |

---

## 构建镜像

```bash
FEIYAN_MCP_REGISTRY_MIRROR=<镜像源主机> NODE_IMAGE=docker.m.daocloud.io/library/node:22-slim \
  bash scripts/build-image.sh
```

**别直接 `docker build -t moraya/toutiao-mcp .`**：调用方（如飞雁）配了镜像源时，
它 inspect 的是**带前缀**的 ref（`<镜像源>/moraya/toutiao-mcp:latest`）。只打裸名 tag 的话
构建成功、容器也起得来，**跑的却是上一版镜像** —— 表现为"改了代码没生效"，而日志一切正常。
脚本会把两个 tag 一起打上，并自检它们指向同一个 image id。

## 开发

```bash
pnpm install && npx playwright install chromium
pnpm test        # 37 项：内容单测 + 假站流程测试 + MCP e2e，全程不碰真站
pnpm lint && pnpm check
```

测试用**本地假站**（`test/fake-site/`）复刻了头条后台的关键 DOM —— 编辑器是真的监听
`paste` 事件解析 `text/html` 的 contenteditable，而不是一个 textarea。假站不像真机，等于没测。

平台改版时：改 `src/core/selectors.ts`（所有 URL 与选择器的唯一出处）→ 跑 `pnpm test` → 发 patch 版本。

---

## 致谢

- [xpzouying/xiaohongshu-mcp](https://github.com/xpzouying/xiaohongshu-mcp) — 产品形态与工具契约的参考
- [jiulingyun/toutiao-ops](https://github.com/jiulingyun/toutiao-ops)（MIT）— 头条后台页面流程与选择器的重要参考

## License

[AGPL-3.0-only](LICENSE)
