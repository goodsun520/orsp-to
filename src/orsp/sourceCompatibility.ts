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
      message: 'Only text book sources can be converted to the current ORSP adapter.',
      blocking: true,
    });
  }
  if (cookieMode === 'browser-unsupported') {
    issues.push({
      code: 'browser_cookie_unsupported',
      message: 'This source requires a browser, WebView, or human-verification Cookie flow.',
      blocking: false,
    });
  } else if (cookieMode === 'interactive-unsupported') {
    issues.push({
      code: 'interactive_login_unsupported',
      message: 'This source requires an interactive login flow that the server cannot perform.',
      blocking: false,
    });
  }
  if (/<js>|@js:|java\./.test(executableBlob)) {
    issues.push({
      code: 'embedded_js_partial',
      message: 'The source contains executable JavaScript/Java rules; only static URL wrappers are supported.',
      blocking: false,
    });
  }

  return {
    cookieMode,
    issues,
    canAttemptConversion: !issues.some((issue) => issue.blocking),
  };
}
