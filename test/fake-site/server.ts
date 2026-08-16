/**
 * 假头条后台：本地静态站，复刻发布流程真正依赖的那几个 DOM 结构。
 *
 * **假站必须像真机** —— 这是飞燕 2026-08-14 的教训：mock 夹具凭想象编形状，
 * 于是「只挑 text 块丢掉 image 块」的 bug 测试全绿也照样漏。所以这里的编辑器
 * 是**真的监听 paste 事件并解析 text/html** 的 contenteditable（ProseMirror 的
 * 关键行为），而不是一个 textarea。
 *
 * 由 URL query 控制形态，测试据此断言：
 *   ?logged_in=0        首页重定向到登录页
 *   ?transfer=0         粘贴进来的外链图**不转存**（用于验证回落逻辑）
 *   ?fail=1             发布返回失败 toast
 *   ?no_response=1      发布不回 JSON（用于验证第二/三层判定）
 */
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';

export interface FakeSite {
  origin: string;
  close(): Promise<void>;
  /** 页面回填的状态：测试断言的主要依据 */
  state: FakeState;
}

export interface FakeState {
  loggedIn: boolean;
  title: string;
  bodyHtml: string;
  bodyText: string;
  coverFiles: string[];
  inlineFiles: string[];
  publishClicked: boolean;
  draftClicked: boolean;
  confirmClicks: number;
  alsoWeitoutiaoChecked: boolean;
  firstPublishChecked: boolean;
  declarations: string[];
  weitoutiaoText: string;
  weitoutiaoImages: string[];
}

export async function startFakeSite(
  options: { loggedIn?: boolean; transferImages?: boolean; failPublish?: boolean; publishResponse?: boolean } = {},
): Promise<FakeSite> {
  const state: FakeState = {
    loggedIn: options.loggedIn ?? true,
    title: '',
    bodyHtml: '',
    bodyText: '',
    coverFiles: [],
    inlineFiles: [],
    publishClicked: false,
    draftClicked: false,
    confirmClicks: 0,
    alsoWeitoutiaoChecked: true, // 平台默认勾选
    firstPublishChecked: false,
    declarations: [],
    weitoutiaoText: '',
    weitoutiaoImages: [],
  };

  const transfer = options.transferImages ?? true;
  const failPublish = options.failPublish ?? false;
  const withResponse = options.publishResponse ?? true;

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;

    // ── 页面状态回填：浏览器把填好的内容 POST 回来，测试从 state 读 ──
    if (req.method === 'POST' && path === '/__state') {
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c.toString('utf8')));
      req.on('end', () => {
        try {
          Object.assign(state, JSON.parse(raw));
        } catch {
          /* ignore */
        }
        res.writeHead(200).end('{}');
      });
      return;
    }

    // ── 发布接口：真机是 /mp/agw/article/publish 这一族，result.ts 按此匹配 ──
    if (req.method === 'POST' && path === '/mp/agw/article/publish') {
      state.publishClicked = true;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        withResponse
          ? JSON.stringify({ code: 0, data: { item_id: '7412345678901234567', article_url: 'https://www.toutiao.com/item/7412345678901234567/' } })
          : JSON.stringify({ code: 0 }),
      );
      return;
    }

    if (req.method === 'POST' && path === '/upload') {
      // 模拟平台把图转存到自家 CDN
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ url: `https://p3-sign.byteimg.com/${randomUUID()}.png` }));
      return;
    }

    const page = renderPage(path, { state, transfer, failPublish });
    if (page === null) {
      res.writeHead(302, { location: '/auth/page/login' }).end();
      return;
    }
    if (typeof page === 'object') {
      res.writeHead(302, { location: page.redirect }).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    origin: `http://127.0.0.1:${port}`,
    state,
    close: () => closeServer(server),
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

interface Redirect {
  redirect: string;
}

const REDIRECT = (location: string): Redirect => ({ redirect: location });

function renderPage(
  path: string,
  ctx: { state: FakeState; transfer: boolean; failPublish: boolean },
): string | Redirect | null {
  // 真站的 `/` 会重定向到 /profile_v4/index（未登录则到登录页）。假站也必须这么做 ——
  // 少了这一跳，settleOnHome 的 waitForURL 会每次都等满超时（发现于 2026-08-16：
  // 每个用例平白多花 15 秒），而真机上根本不会。假站不像真机，测出来的时序也是假的。
  if (path === '/') {
    return REDIRECT(ctx.state.loggedIn ? '/profile_v4/index' : '/auth/page/login');
  }

  if (path === '/profile_v4' || path.startsWith('/profile_v4/index')) {
    if (!ctx.state.loggedIn) return null;
    return shell(
      'dashboard',
      `<div class="sidebar"><a href="/profile_v4/graphic/publish">发布文章</a></div>
       <div class="user-name">测试头条号</div>
       <script>window.__media_id = "media_id: 1234567890";</script>`,
    );
  }

  if (path === '/auth/page/login') {
    return shell(
      'login',
      `<div class="qrcode-wrap"><canvas id="qr" width="180" height="180"></canvas></div>
       <script>
         const c = document.getElementById('qr').getContext('2d');
         c.fillStyle = '#000'; c.fillRect(0, 0, 180, 180);
         c.fillStyle = '#fff'; c.fillRect(20, 20, 140, 140);
       </script>`,
    );
  }

  if (path === '/profile_v4/graphic/publish') {
    if (!ctx.state.loggedIn) return null;
    return shell('article', articleEditor(ctx.transfer, ctx.failPublish));
  }

  if (path === '/profile_v4/weitoutiao/publish') {
    if (!ctx.state.loggedIn) return null;
    return shell('weitoutiao', weitoutiaoEditor(ctx.failPublish));
  }

  return shell('unknown', '<p>404</p>');
}

function shell(page: string, body: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>假头条后台 · ${page}</title>
<style>body{font-family:sans-serif;padding:16px} .editor{border:1px solid #ccc;min-height:200px;padding:8px}
button{margin:4px;padding:6px 12px} .byte-drawer-wrapper{border:2px solid #09f;padding:8px;margin-top:8px}</style>
</head><body data-page="${page}">${body}
<script>
  window.__report = (patch) => fetch('/__state', { method: 'POST', body: JSON.stringify(patch) });
</script>
</body></html>`;
}

/** 文章编辑器：标题框 + 会解析 paste 的 contenteditable + 封面抽屉 + 发布三连击 */
function articleEditor(transfer: boolean, failPublish: boolean): string {
  return `
<textarea placeholder="请输入文章标题（2-30个字）" id="title" rows="1" cols="60"></textarea>

<div class="ProseMirror editor" contenteditable="true" id="editor"></div>

<div class="cover-area">
  <span class="cover-mode">单图</span><span class="cover-mode">三图</span><span class="cover-mode">无封面</span>
  <div class="cover-add">＋ 添加封面</div>
</div>

<label><input type="checkbox" id="first"> 头条首发</label>
<label><input type="checkbox" id="also" checked> 同时发布微头条，发布得更多收益</label>
<label><input type="checkbox" class="decl" value="引用AI"> 引用AI</label>
<label><input type="checkbox" class="decl" value="个人观点"> 个人观点，仅供参考</label>

<div id="drawer" style="display:none" class="byte-drawer-wrapper">
  <span>本地上传</span>
  <input type="file" id="coverInput" accept="image/*" multiple style="opacity:0;width:1px;height:1px">
  <button id="drawerOk">确定</button>
</div>

<button id="publish">预览并发布</button>
<div id="preview" style="display:none"><button id="confirmPublish">确认发布</button></div>
<div id="toast" class="byte-message" style="display:none"></div>

<script>
const editor = document.getElementById('editor');
const TRANSFER = ${transfer};

// ProseMirror 的关键行为：吃 paste 事件里的 text/html
editor.addEventListener('paste', (e) => {
  e.preventDefault();
  const html = e.clipboardData.getData('text/html');
  const plain = e.clipboardData.getData('text/plain');
  const range = document.createRange();
  if (html) {
    const holder = document.createElement('div');
    holder.innerHTML = html;
    // 模拟平台转存：外链图被换成自家 CDN 地址
    if (TRANSFER) {
      holder.querySelectorAll('img').forEach((img, i) => {
        img.setAttribute('src', 'https://p3-sign.byteimg.com/fake-' + Date.now() + '-' + i + '.png');
      });
    }
    while (holder.firstChild) editor.appendChild(holder.firstChild);
  } else if (plain) {
    editor.appendChild(document.createTextNode(plain));
  }
  range.selectNodeContents(editor);
  report();
});
editor.addEventListener('input', report);

document.getElementById('title').addEventListener('input', report);
document.getElementById('first').addEventListener('change', report);
document.getElementById('also').addEventListener('change', report);
document.querySelectorAll('.decl').forEach((el) => el.addEventListener('change', report));

// 文案点击 → 勾选（真站是自定义组件，点的是文字不是 input）
document.querySelectorAll('label').forEach((label) => {
  label.addEventListener('click', (e) => {
    if (e.target.tagName !== 'INPUT') {
      const input = label.querySelector('input');
      input.checked = !input.checked;
      report();
    }
  });
});

// 封面：点 ＋ 打开抽屉 → 点「本地上传」触发 filechooser
document.querySelector('.cover-add').addEventListener('click', () => {
  document.getElementById('drawer').style.display = 'block';
});
document.querySelector('#drawer span').addEventListener('click', () => {
  document.getElementById('coverInput').click();
});
document.getElementById('coverInput').addEventListener('change', (e) => {
  window.__covers = Array.from(e.target.files).map((f) => f.name);
  report();
});
document.getElementById('drawerOk').addEventListener('click', () => {
  document.getElementById('drawer').style.display = 'none';
  report();
});

document.getElementById('publish').addEventListener('click', () => {
  document.getElementById('preview').style.display = 'block';
});
document.getElementById('confirmPublish').addEventListener('click', async () => {
  ${
    failPublish
      ? `const toast = document.getElementById('toast');
         toast.textContent = '发布失败：内容包含敏感信息';
         toast.style.display = 'block';
         report({ publishClicked: true });`
      : `await fetch('/mp/agw/article/publish', { method: 'POST', body: '{}' });
         const toast = document.getElementById('toast');
         toast.textContent = '发布成功';
         toast.style.display = 'block';
         report({ publishClicked: true });`
  }
});

function report(extra) {
  window.__report(Object.assign({
    title: document.getElementById('title').value,
    bodyHtml: editor.innerHTML,
    bodyText: editor.textContent,
    coverFiles: window.__covers || [],
    inlineFiles: window.__inline || [],
    firstPublishChecked: document.getElementById('first').checked,
    alsoWeitoutiaoChecked: document.getElementById('also').checked,
    declarations: Array.from(document.querySelectorAll('.decl')).filter((el) => el.checked).map((el) => el.value),
  }, extra || {}));
}
</script>`;
}

function weitoutiaoEditor(failPublish: boolean): string {
  return `
<div class="ProseMirror editor" contenteditable="true" id="editor"></div>
<span id="imageEntry">图片</span>
<input type="file" id="imgInput" accept="image/*" multiple style="opacity:0;width:1px;height:1px">
<div id="drawer" class="byte-drawer-wrapper" style="display:none"><button id="drawerOk">确定</button></div>
<label><input type="checkbox" id="first"> 头条首发</label>
<button id="publish">发布</button>
<button id="draft">存草稿</button>
<div id="toast" class="byte-message" style="display:none"></div>
<script>
const editor = document.getElementById('editor');
editor.addEventListener('input', report);
document.getElementById('imageEntry').addEventListener('click', () => document.getElementById('imgInput').click());
document.getElementById('imgInput').addEventListener('change', (e) => {
  window.__imgs = Array.from(e.target.files).map((f) => f.name);
  document.getElementById('drawer').style.display = 'block';
  report();
});
document.getElementById('drawerOk').addEventListener('click', () => {
  document.getElementById('drawer').style.display = 'none';
  report();
});
document.getElementById('publish').addEventListener('click', async () => {
  ${
    failPublish
      ? `const t = document.getElementById('toast'); t.textContent = '发布失败：请稍后重试'; t.style.display='block';
         report({ publishClicked: true });`
      : `await fetch('/mp/agw/article/publish', { method: 'POST', body: '{}' });
         const t = document.getElementById('toast'); t.textContent = '发布成功'; t.style.display='block';
         report({ publishClicked: true });`
  }
});
document.getElementById('draft').addEventListener('click', () => report({ draftClicked: true }));
function report(extra) {
  window.__report(Object.assign({
    weitoutiaoText: editor.textContent,
    weitoutiaoImages: window.__imgs || [],
    firstPublishChecked: document.getElementById('first').checked,
  }, extra || {}));
}
</script>`;
}
