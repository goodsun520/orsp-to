/** Legado (阅读 app) book source rule JSON — only the fields this adapter uses. */
export interface LegadoRuleSearch {
  bookList?: string;
  checkKeyWord?: string;
  name?: string;
  author?: string;
  kind?: string;
  wordCount?: string;
  lastChapter?: string;
  intro?: string;
  coverUrl?: string;
  bookUrl?: string;
}

/** Explore rules use the same book-list fields as search rules. */
export type LegadoRuleExplore = LegadoRuleSearch;

export interface LegadoRuleBookInfo {
  init?: string;
  name?: string;
  author?: string;
  kind?: string;
  wordCount?: string;
  lastChapter?: string;
  intro?: string;
  coverUrl?: string;
  tocUrl?: string;
}

export interface LegadoRuleToc {
  chapterList?: string;
  chapterName?: string;
  chapterUrl?: string;
  nextTocUrl?: string;
}

export interface LegadoRuleContent {
  content?: string;
  nextContentUrl?: string;
  replaceRegex?: string;
}

export interface LegadoBookSource {
  bookSourceName: string;
  bookSourceUrl: string;
  /** Legado 0=text, 1=audio, 2=comic. This adapter currently serves text only. */
  bookSourceType?: number;
  bookSourceGroup?: string;
  bookSourceComment?: string;
  enabled?: boolean;
  enabledCookieJar?: boolean;
  header?: string;
  jsLib?: string;
  searchUrl?: string;
  exploreUrl?: string;
  ruleSearch?: LegadoRuleSearch;
  ruleExplore?: LegadoRuleExplore;
  ruleBookInfo?: LegadoRuleBookInfo;
  ruleToc?: LegadoRuleToc;
  ruleContent?: LegadoRuleContent;
  [key: string]: unknown;
}

/** Feature flags this adapter cannot execute — surfaced to the user, not silently ignored. */
export interface UnsupportedFeatures {
  cookieJar: boolean;
  embeddedJs: boolean;
  humanVerification: boolean;
  cookieMode?: CookieMode;
  issues?: CompatibilityIssue[];
}

export function detectUnsupportedFeatures(source: LegadoBookSource): UnsupportedFeatures {
  const blob = JSON.stringify(source);
  const compatibility = assessSourceCompatibility(source);
  return {
    cookieJar:
      compatibility.cookieMode === 'interactive-unsupported' ||
      compatibility.cookieMode === 'browser-unsupported',
    embeddedJs: /<js>|@js:|java\./.test(blob),
    humanVerification: compatibility.cookieMode === 'browser-unsupported',
    cookieMode: compatibility.cookieMode,
    issues: compatibility.issues,
  };
}
import { assessSourceCompatibility, type CompatibilityIssue, type CookieMode } from '../orsp/sourceCompatibility.js';
