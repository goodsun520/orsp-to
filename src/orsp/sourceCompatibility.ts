import type { LegadoBookSource } from '../legado/types.js';

export type CookieMode =
  | 'none'
  | 'static'
  | 'http-session'
  | 'interactive-unsupported'
  | 'browser-unsupported';

export interface CompatibilityIssue {
  code: string;
  message: string;
  blocking: boolean;
}

export interface SourceCompatibility {
  cookieMode: CookieMode;
  issues: CompatibilityIssue[];
  canAttemptConversion: boolean;
}

const explicitUnavailableMarker =
  /(?:^|[\s【[(])(?:已失效|网站失效|书源失效|失效源|已停用|已废弃|停止维护|域名失效)(?:$|[\s】)\]])|(?:^|\s)(?:\/\/\s*)?error\s*:\s*(?:connection|timeout|unable to resolve host|enotfound|econn)/i;

function hasValue(value: unknown): boolean {
  return value !== undefined && value !== null && String(value).trim().length > 0;
}

/** Classifies execution requirements without running source-supplied code. */
export function assessSourceCompatibility(source: LegadoBookSource): SourceCompatibility {
  const executableBlob = JSON.stringify({
    searchUrl: source.searchUrl,
    exploreUrl: source.exploreUrl,
    ruleSearch: source.ruleSearch,
    ruleExplore: source.ruleExplore,
    ruleBookInfo: source.ruleBookInfo,
    ruleToc: source.ruleToc,
    ruleContent: source.ruleContent,
    loginUrl: source.loginUrl,
    loginUi: source.loginUi,
    loginCheckJs: source.loginCheckJs,
    startBrowserAwait: source.startBrowserAwait,
  });
  const browserOnly =
    hasValue(source.startBrowserAwait) ||
    /startBrowserAwait|webView|Cloudflare|Just a moment/i.test(executableBlob);
  const interactive =
    hasValue(source.loginUrl) || hasValue(source.loginUi) || hasValue(source.loginCheckJs);
  const staticCookie = /["']?Cookie["']?\s*:/i.test(String(source.header ?? ''));
  const cookieMode: CookieMode = browserOnly
    ? 'browser-unsupported'
    : interactive
      ? 'interactive-unsupported'
      : staticCookie
        ? 'static'
        : source.enabledCookieJar === true
          ? 'http-session'
          : 'none';

  const issues: CompatibilityIssue[] = [];
  if (source.bookSourceType !== undefined && source.bookSourceType !== 0) {
    issues.push({
      code: 'non_text_source',
      message: '这是音频或漫画书源，当前只支持文本书源。处理建议：从合集移除该项，或换用对应的文本书源。',
      blocking: true,
    });
  }
  if (cookieMode === 'browser-unsupported') {
    issues.push({
      code: 'browser_cookie_unsupported',
      message: '该书源需要浏览器/WebView、人机验证或动态 Cookie，服务器无法安全自动完成。处理建议：请在阅读 App 内使用，或换用无需验证的书源。',
      blocking: true,
    });
  } else if (cookieMode === 'interactive-unsupported') {
    issues.push({
      code: 'interactive_login_unsupported',
      message: '该书源需要人工登录，服务器不会代替用户登录。处理建议：请在阅读 App 内使用，或改用无需登录的公开书源。',
      blocking: true,
    });
  }
  if (/<js>|@js:|java\./.test(executableBlob)) {
    issues.push({
      code: 'embedded_code_unsupported',
      message: '规则包含需要执行的 JavaScript/Java。为避免执行上传代码，转换器只接受纯静态 URL 和选择器规则。处理建议：改成静态规则后再试。',
      blocking: true,
    });
  }
  if (explicitUnavailableMarker.test(`${source.bookSourceName ?? ''}\n${source.bookSourceComment ?? ''}`)) {
    issues.push({
      code: 'source_marked_unavailable',
      message: '书源名称或备注已明确标记失效、停用或连接错误。处理建议：先确认原网站已经恢复，再单独提交该书源。',
      blocking: true,
    });
  }

  return {
    cookieMode,
    issues,
    canAttemptConversion: !issues.some((issue) => issue.blocking),
  };
}
