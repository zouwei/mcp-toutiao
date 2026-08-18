/**
 * 发行说明的清洗与提取 —— 被 summarize-release.mjs 与 CI 共用。
 *
 * 为什么单独一个文件：模型输出要清洗（它可能在正文外裹一层解释或代码围栏），
 * CI 又要从 CHANGELOG 里把某个版本那一段抠出来当 Release 正文。
 * 两处都不复杂，但都属于"错了会把奇怪内容发布出去"的地方，所以集中在一处并单测。
 */

/**
 * 去掉模型包在正文外的东西：代码围栏、以及正文开始之前的寒暄。
 * 认不出结构时**原样返回** —— 发一段不规整的说明，也好过发一段空的。
 *
 * @param {unknown} raw 模型原始输出
 * @returns {string}
 */
export function sanitizeNotes(raw) {
  let text = String(raw ?? '')
    .replace(/^```[\w]*\n?/, '')
    .replace(/\n?```$/, '')
    .trim();

  // 正文从第一个 markdown 标题或列表项开始；之前的都是模型的自言自语
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^\s*(#{1,4}\s|[-*]\s)/.test(l));
  if (start > 0) text = lines.slice(start).join('\n').trim();

  return text;
}

/**
 * 从 CHANGELOG 里抠出某个版本那一段（不含标题行本身）。
 * 找不到返回空串 —— 调用方据此回落到自动生成的记录，而不是发一段别的版本的说明。
 *
 * @param {string} changelog CHANGELOG.md 全文
 * @param {string} version 形如 `0.1.0` 或 `v0.1.0`
 * @returns {string}
 */
export function extractSection(changelog, version) {
  const v = String(version).replace(/^v/, '');
  const lines = String(changelog ?? '').split('\n');
  const isHeading = (l) => /^##\s+v?\d+\.\d+\.\d+/.test(l);
  const start = lines.findIndex((l) => isHeading(l) && l.includes(v));
  if (start === -1) return '';

  const rest = lines.slice(start + 1);
  const end = rest.findIndex(isHeading);
  return (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();
}
