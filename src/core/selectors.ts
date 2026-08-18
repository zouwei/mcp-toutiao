/**
 * 头条后台的所有 URL 与选择器 —— **唯一出处**。
 *
 * 前端改版是必然事件，不是意外。集中一处 + 假站测试，改版时只改这个文件，
 * 跑一遍 test/flows 就知道有没有改错。
 *
 * 纪律：
 * 1. 每个定位点写成**候选数组**，任一命中即可 —— 单一选择器等于把维护成本押在
 *    头条不改 class 名上，而 byte-* 这类样式类名恰恰是最爱变的。
 * 2. 语义定位（placeholder / 文案）优先于结构定位（class 前缀）—— 文案比 class 稳。
 * 3. 只放定位信息，不放行为。行为在 flows/。
 */

export const DEFAULT_BASE_URL = 'https://mp.toutiao.com';

export interface SiteUrls {
  home: string;
  login: string;
  articlePublish: string;
  weitoutiaoPublish: string;
}

/**
 * 站点 URL 按 baseUrl 拼。
 *
 * 做成函数而不是常量，是为了给测试一个接缝（对着本地假站跑流程，不碰真站）；
 * 顺带也扛住「头条哪天换域名」这种事。路径本身仍然是硬编码 —— 它们才是真正的耦合点。
 */
export function buildUrls(baseUrl: string = DEFAULT_BASE_URL): SiteUrls {
  const base = baseUrl.replace(/\/+$/, '');
  return {
    home: `${base}/`,
    login: `${base}/auth/page/login`,
    articlePublish: `${base}/profile_v4/graphic/publish`,
    weitoutiaoPublish: `${base}/profile_v4/weitoutiao/publish`,
  };
}

export const URLS = buildUrls();

/** 路径片段：用于判断当前所处状态（比整串 URL 稳） */
export const PATHS = {
  login: '/auth/page/login',
  ssoHost: 'sso.toutiao.com',
  dashboard: '/profile_v4',
} as const;

/** 逗号连接成一个 CSS 选择器串；Playwright 原生支持多选择器取首个命中 */
export const css = (...list: string[]): string => list.join(', ');

export const SELECTORS = {
  /** 已登录后台的特征元素（URL 判定不确定时的第二判据） */
  dashboardMarker: css(
    'a[href*="graphic/publish"]',
    '[class*="sidebar"]',
    '[class*="sider"]',
    '[class*="left-menu"]',
  ),

  /**
   * 头条编辑器右侧的 **AI 助手抽屉**。它不是弹窗、没有遮罩层，而是一块常驻面板，
   * `byte-drawer-wrapper` 的子树会**盖住「预览并发布」按钮并拦截点击**
   * （2026-08-17 实测：Playwright 报 `<div class="ai-conversation in-tab-pane"> …
   * subtree intercepts pointer events`，点击重试到超时）。
   *
   * ⚠ 只匹配 ai-* 那几个类名，**不能笼统地关掉所有 drawer** ——
   * 封面上传走的正是另一个 `byte-drawer-wrapper`（封面抽屉），关掉它封面就传不成了。
   */
  aiAssistantDrawer: css('[class*="ai-assistant"]', '[class*="ai-conversation"]'),

  /**
   * 「同时发布微头条」整行。真站结构（2026-08-17 实测 dump）：
   *
   *   <div class="pgc-edit-cell edit-cell form-tuwen_wtt_trans">
   *     <div class="edit-label">同时发布微头条</div>          ← 左列，点它没有任何作用
   *     <div class="edit-input"><label class="byte-checkbox …">
   *        <input type="checkbox" checked>
   *        <span class="byte-checkbox-inner-text">发布得更多收益</span>
   *
   * 两条选择器并列：先认业务类名，再按左列文案兜底（类名改版时还能活）。
   */
  weitoutiaoRow: '.pgc-edit-cell.form-tuwen_wtt_trans, .pgc-edit-cell:has(.edit-label:text-is("同时发布微头条"))',
  /**
   * 真正可点的目标：`<input>` 被 `.byte-checkbox-mask` 盖着，直接点会被拦截，
   * 点它外层的 label（或 label 里那句文案）才有效。
   */
  weitoutiaoToggle: 'label.byte-checkbox',

  /** 登录页二维码。截图对象要尽量小 —— 截整页的话二维码在里面太小，手机扫不出来 */
  loginQrcode: css(
    '[class*="qrcode"] canvas',
    '[class*="qrcode"] img',
    '[class*="qr-code"] canvas',
    '[class*="qr-code"] img',
    'canvas',
  ),
  loginQrcodeContainer: css('[class*="qrcode"]', '[class*="qr-code"]', '[class*="scan"]'),

  /** 文章：标题输入框 */
  articleTitle: css(
    'textarea[placeholder*="标题"]',
    'input[placeholder*="标题"]',
    '[class*="title"] textarea',
    '[class*="title"] input',
  ),
  /** 文章/微头条：富文本编辑区（ProseMirror） */
  editor: css('[class*="ProseMirror"]', '[contenteditable="true"]'),

  /** 封面区域：点它打开上传抽屉 */
  /**
   * 「替换」封面。正文里有图时，**头条会拿首图自动填充封面** ——
   * 这时「添加封面」按钮不存在，页面上是缩略图 + 「编辑 | 替换」
   * （2026-08-18 实测：不处理这一支，带正文插图的文章会卡在封面步骤超时）。
   */
  coverReplaceButton: css('[class*="cover"] [class*="replace"]'),

  coverAddButton: css(
    '[class*="cover"] [class*="add"]',
    '[class*="cover"] [class*="upload"]',
    '[class*="cover"] [class*="plus"]',
    '[class*="cover-upload"]',
  ),
  /** 抽屉/弹层里的确认按钮 */
  drawerConfirm: css(
    '.byte-drawer-wrapper button:has-text("确定")',
    '.byte-modal-wrapper button:has-text("确定")',
    '[class*="drawer"] button:has-text("确定")',
    '[class*="modal"] button:has-text("确定")',
  ),
  drawerCancel: css(
    '.byte-drawer-wrapper button:has-text("取消")',
    '[class*="drawer"] button:has-text("取消")',
  ),

  /** 图片上传的 file input（微头条与编辑器插图都用它） */
  fileInput: 'input[type="file"][accept*="image"]',
  fileInputAny: 'input[type="file"]',

  /** 编辑器工具栏里的「图片」按钮（editor-upload 策略用） */
  editorImageButton: css(
    '[class*="toolbar"] [class*="image"]',
    '[class*="toolbar"] [aria-label*="图片"]',
    '[class*="tool"] [title*="图片"]',
  ),

  /** 提示/错误 toast */
  toast: css(
    '.byte-message',
    '[class*="message-content"]',
    '[class*="toast"]',
    '[class*="notification"]',
  ),

  /** 风控：滑块/验证码 */
  captcha: css(
    '[class*="captcha"]',
    '[class*="verify"] [class*="slider"]',
    '[class*="secsdk"]',
    'iframe[src*="captcha"]',
  ),
} as const;

/** 按文案定位的控件（Playwright `getByText` / `button:has-text`） */
export const TEXTS = {
  articlePublishButton: '预览并发布',
  confirmPublishButton: '确认发布',
  genericConfirm: ['确定', '确认'],
  weitoutiaoPublishButton: '发布',
  weitoutiaoDraftButton: '存草稿',
  localUpload: '本地上传',
  /** 封面已存在时的替换入口（正文有图 → 平台自动填充封面） */
  coverReplace: '替换',
  firstPublish: '头条首发',
  addToCollection: '添加至合集',
  /**
   * 「同时发布微头条」。真站的结构是**两列**：左列是行标签「同时发布微头条」，
   * 右列才是复选框 + 文案「发布得更多收益」——点左列那个标签毫无作用。
   */
  alsoWeitoutiao: ['同时发布微头条', '发布得更多收益'],
  /** 点得动的那个（复选框旁边的文案） */
  alsoWeitoutiaoToggle: '发布得更多收益',
  imageEntry: '图片',
  coverModes: { single: '单图', triple: '三图', none: '无封面' },
  /** 作品声明：短名 → 页面上的完整文案 */
  declarations: {
    取材网络: '取材网络',
    引用站内: '引用站内',
    个人观点: '个人观点，仅供参考',
    引用AI: '引用AI',
    虚构演绎: '虚构演绎，故事经历',
    投资观点: '投资观点，仅供参考',
    健康医疗: '健康医疗分享，仅供参考',
  } as Record<string, string>,
  /** 遮挡物上的关闭类文案 */
  dismiss: ['我知道了', '已知悉', '知道了', '关闭', '一律不允许', '不再提示', '稍后再说', '跳过'],
} as const;

/** 平台硬限制（Phase 0 真机复核后回填确认） */
export const LIMITS = {
  articleTitleMin: 2,
  articleTitleMax: 30,
  weitoutiaoContentMax: 2000,
  weitoutiaoImagesMax: 9,
  /** 文章正文没有实测到硬上限（编辑器上限约 10 万字），给一个防呆值 */
  articleContentMax: 100_000,
} as const;
