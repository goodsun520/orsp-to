import { extractList, extractValue, parseHtml, selectNodes } from './selector.js';
import { resolveExploreRule } from './explore.js';
import { fetchPage, parseLegadoHeaders } from './fetchSource.js';
import { cookieScopeKey, jarForSource } from './cookieJar.js';
import { cleanSourceBaseUrl, parseSearchUrl } from './searchUrl.js';
import type { LegadoBookSource } from './types.js';

const MAX_PAGINATION_HOPS = 40;
const MAX_CHAPTERS = 30_000;

export interface SearchResultItem {
  title: string;
  author: string;
  kind: string[];
  lastChapter: string;
  intro: string;
  coverUrl: string;
  bookUrl: string;
}

export interface BookInfo {
  title: string;
  author: string;
  kind: string[];
  wordCount: string;
  lastChapter: string;
  intro: string;
  coverUrl: string;
  bookUrl: string;
  tocUrl: string;
}

export interface TocChapter {
  title: string;
  url: string;
  order: number;
}

export interface RuleContext {
  /** Stable source id — used for cookie jar isolation. */
  sourceId?: string;
}

function baseUrlOf(source: LegadoBookSource): string {
  return cleanSourceBaseUrl(source.bookSourceUrl);
}

function headersFor(source: LegadoBookSource) {
  return parseLegadoHeaders(source.header);
}

function cookieJarFor(source: LegadoBookSource, ctx?: RuleContext) {
  void ctx;
  return jarForSource(cookieScopeKey(source));
}

function fetchOpts(source: LegadoBookSource, ctx?: RuleContext) {
  const jar = cookieJarFor(source, ctx);
  // Seed static Cookie from source.header once.
  const headers = headersFor(source);
  if (headers.Cookie || headers.cookie) {
    try {
      jar.seedFromHeader(new URL(baseUrlOf(source)), headers.Cookie || headers.cookie);
    } catch {
      /* ignore */
    }
  }
  return {
    baseUrl: baseUrlOf(source),
    headers,
    cookieJar: jar,
  };
}

export async function searchBooks(
  source: LegadoBookSource,
  query: string,
  page: number,
  ctx?: RuleContext,
): Promise<SearchResultItem[]> {
  const rule = source.ruleSearch;
  if (!rule?.bookList || !source.searchUrl) return [];
  if (page > 1 && !source.searchUrl.includes('{{page}}')) return [];

  return fetchBookList(source, source.searchUrl, rule, { key: query, page }, ctx);
}

/** Fetches a Legado explore shelf through the same safe rule subset as search. */
export async function exploreBooks(
  source: LegadoBookSource,
  exploreUrl: string,
  page: number,
  ctx?: RuleContext,
): Promise<SearchResultItem[]> {
  const rule = resolveExploreRule(source);
  if (!rule) return [];
  if (page > 1 && !exploreUrl.includes('{{page}}')) return [];
  return fetchBookList(source, exploreUrl, rule, { page }, ctx, true);
}

async function fetchBookList(
  source: LegadoBookSource,
  requestUrl: string,
  rule: NonNullable<LegadoBookSource['ruleSearch']>,
  variables: Record<string, string | number>,
  ctx?: RuleContext,
  allowTitleFallback = false,
): Promise<SearchResultItem[]> {

  const parsed = parseSearchUrl(requestUrl, variables);
  if (parsed.kind === 'js' || !parsed.path) {
    // Cannot evaluate JS search URLs — return empty rather than 500.
    return [];
  }

  const base = fetchOpts(source, ctx);
  const { url, html } = await fetchPage(parsed.path, {
    ...base,
    headers: { ...base.headers, ...parsed.headers },
    method: parsed.method,
    body: parsed.body,
    charset: parsed.charset,
  });

  // Prefer JSON parse when content looks like JSON (API sources).
  const trimmed = html.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const jsonItems = tryExtractJsonSearch(html, rule);
    if (jsonItems) return finalizeSearchItems(jsonItems, url);
  }

  const $ = parseHtml(html);
  const items = selectNodes($, [$.root().get(0)!], rule.bookList);
  return finalizeSearchItems(items.map((node) => {
    const scope = [node];
    const bookUrl = extractValue($, scope, rule.bookUrl);
    return {
      title: extractValue($, scope, rule.name) || (allowTitleFallback ? fallbackBookTitle($, scope) : ''),
      author: extractValue($, scope, rule.author),
      kind: extractList($, scope, rule.kind),
      lastChapter: extractValue($, scope, rule.lastChapter),
      intro: extractValue($, scope, rule.intro),
      coverUrl: absolutize(extractValue($, scope, rule.coverUrl), url),
      bookUrl: absolutize(bookUrl, url),
    };
  }), url);
}

function fallbackBookTitle($: ReturnType<typeof parseHtml>, scope: Parameters<typeof extractValue>[1]): string {
  for (const rule of [
    'tag.h1.0@text',
    'tag.h2.0@text',
    'tag.h3.0@text',
    'tag.h4.0@text',
    'tag.img.0@alt',
    'tag.a.0@title',
    'tag.a@text',
  ]) {
    const value = extractValue($, scope, rule).trim();
    if (value) return value.split(/\r?\n/, 1)[0].trim();
  }
  return '';
}

function finalizeSearchItems(items: SearchResultItem[], responseUrl: string): SearchResultItem[] {
  return items
    .map((item) => ({
      ...item,
      title: item.title.trim(),
      coverUrl: absolutize(item.coverUrl, responseUrl),
      bookUrl: absolutize(item.bookUrl, responseUrl),
    }))
    .filter((item) => item.title.length > 0 && isHttpUrl(item.bookUrl));
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export async function getBookInfo(source: LegadoBookSource, bookUrl: string, ctx?: RuleContext): Promise<BookInfo> {
  const rule = source.ruleBookInfo ?? {};
  const base = fetchOpts(source, ctx);
  const { url, html } = await fetchPage(bookUrl, base);
  const json = parseJsonResponse(html);
  if (json !== null) {
    return {
      title: extractJsonValue(json, rule.name),
      author: extractJsonValue(json, rule.author),
      kind: extractJsonList(json, rule.kind),
      wordCount: extractJsonValue(json, rule.wordCount),
      lastChapter: extractJsonValue(json, rule.lastChapter),
      intro: extractJsonValue(json, rule.intro),
      coverUrl: absolutize(extractJsonValue(json, rule.coverUrl), url),
      bookUrl: url,
      tocUrl: absolutize(extractJsonUrl(json, rule.tocUrl), url),
    };
  }
  const $ = parseHtml(html);
  const scope = [$.root().get(0)!];
  return {
    title: extractValue($, scope, rule.name),
    author: extractValue($, scope, rule.author),
    kind: extractList($, scope, rule.kind),
    wordCount: extractValue($, scope, rule.wordCount),
    lastChapter: extractValue($, scope, rule.lastChapter),
    intro: extractValue($, scope, rule.intro),
    coverUrl: absolutize(extractValue($, scope, rule.coverUrl), url),
    bookUrl: url,
    tocUrl: absolutize(extractHtmlUrl($, scope, rule.tocUrl), url),
  };
}

export async function getChapterList(source: LegadoBookSource, bookUrl: string, ctx?: RuleContext): Promise<TocChapter[]> {
  const bookInfoRule = source.ruleBookInfo ?? {};
  const tocRule = source.ruleToc ?? {};
  if (!tocRule.chapterList) return [];

  const bookInfo = bookInfoRule.tocUrl ? await getBookInfo(source, bookUrl, ctx) : undefined;
  const startPath = bookInfo?.tocUrl || bookUrl;
  const chapters: TocChapter[] = [];
  const seenUrls = new Set<string>();
  let currentPath: string | undefined = startPath;
  let order = 0;
  const base = fetchOpts(source, ctx);

  for (let hop = 0; hop < MAX_PAGINATION_HOPS && currentPath; hop++) {
    const { url, html } = await fetchPage(currentPath, base);
    if (seenUrls.has(url)) break;
    seenUrls.add(url);

    const json = parseJsonResponse(html);
    let next = '';
    if (json !== null) {
      const items = jsonPath(json, tocRule.chapterList ?? '');
      if (Array.isArray(items)) {
        for (const item of items) {
          const title = extractJsonValue(item, tocRule.chapterName);
          const chapterUrl = absolutize(extractJsonUrl(item, tocRule.chapterUrl), url);
          if (!title || !chapterUrl) continue;
          chapters.push({ title, url: chapterUrl, order: order++ });
          if (chapters.length >= MAX_CHAPTERS) break;
        }
      }
      next = extractJsonUrl(json, tocRule.nextTocUrl);
    } else {
      const $ = parseHtml(html);
      const nodes = selectNodes($, [$.root().get(0)!], tocRule.chapterList);
      for (const node of nodes) {
        const scope = [node];
        const title = extractValue($, scope, tocRule.chapterName);
        const chapterUrl = absolutize(extractValue($, scope, tocRule.chapterUrl), url);
        if (!title || !chapterUrl) continue;
        chapters.push({ title, url: chapterUrl, order: order++ });
        if (chapters.length >= MAX_CHAPTERS) break;
      }
      next = tocRule.nextTocUrl ? extractValue($, [$.root().get(0)!], tocRule.nextTocUrl) : '';
    }
    if (chapters.length >= MAX_CHAPTERS) break;
    currentPath = next ? absolutize(next, url) : undefined;
  }
  return chapters;
}

export async function getChapterContent(source: LegadoBookSource, chapterUrl: string, ctx?: RuleContext): Promise<string> {
  const rule = source.ruleContent ?? {};
  const parts: string[] = [];
  const seenUrls = new Set<string>();
  let currentPath: string | undefined = chapterUrl;
  const base = fetchOpts(source, ctx);

  for (let hop = 0; hop < MAX_PAGINATION_HOPS && currentPath; hop++) {
    const { url, html } = await fetchPage(currentPath, base);
    if (seenUrls.has(url)) break;
    seenUrls.add(url);

    const json = parseJsonResponse(html);
    let content = '';
    let next = '';
    if (json !== null) {
      content = extractJsonValue(json, rule.content);
      next = extractJsonUrl(json, rule.nextContentUrl);
    } else {
      const $ = parseHtml(html);
      const scope = [$.root().get(0)!];
      content = extractValue($, scope, rule.content);
      next = rule.nextContentUrl ? extractValue($, scope, rule.nextContentUrl) : '';
    }
    if (content) parts.push(content);
    currentPath = next ? absolutize(next, url) : undefined;
  }

  let joined = parts.join('\n\n');
  if (rule.replaceRegex) {
    joined = applyReplaceRegex(joined, rule.replaceRegex);
  }
  return joined;
}

/**
 * Minimal JSONPath-ish for API sources: rules like `$.data.list` / `$.data[*].name`.
 * Only covers the common `$.a.b` / `$.a[*].b` patterns used by many Legado API sources.
 */
function tryExtractJsonSearch(
  raw: string,
  rule: NonNullable<LegadoBookSource['ruleSearch']>,
): SearchResultItem[] | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!rule.bookList || !rule.bookList.includes('$')) return null;
  const list = jsonPath(data, rule.bookList);
  if (!Array.isArray(list) || list.length === 0) return null;

  return list.map((item) => ({
    title: extractJsonValue(item, rule.name),
    author: extractJsonValue(item, rule.author),
    kind: extractJsonList(item, rule.kind),
    lastChapter: extractJsonValue(item, rule.lastChapter),
    intro: extractJsonValue(item, rule.intro),
    coverUrl: extractJsonValue(item, rule.coverUrl),
    bookUrl: extractJsonUrl(item, rule.bookUrl),
  }));
}

function parseJsonResponse(raw: string): unknown | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/**
 * Evaluates the non-executable JSON subset used by API-style Legado sources.
 * It deliberately supports paths and `{{$.field}}` interpolation only: `@js:`
 * suffixes are ignored instead of evaluating uploaded source code.
 */
function extractJsonValue(root: unknown, rule: string | undefined): string {
  if (!rule?.trim()) return '';
  const withoutJs = rule.split(/@js:/i, 1)[0]!.trim();
  const value = withoutJs.includes('{{')
    ? interpolateJsonTemplate(withoutJs, root)
    : jsonPath(root, stripRegexSuffix(withoutJs));
  return applyRegexSuffix(rule, value == null ? '' : Array.isArray(value) ? value.map(String).join('\n') : String(value));
}

function extractJsonList(root: unknown, rule: string | undefined): string[] {
  const value = extractJsonValue(root, rule);
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function extractJsonUrl(root: unknown, rule: string | undefined): string {
  return extractJsonValue(root, rule).trim();
}

function interpolateJsonTemplate(template: string, root: unknown): string {
  return template.replace(/\{\{\s*(\$[^}]*)\s*\}\}/g, (_match, path: string) => {
    const value = jsonPath(root, path.trim());
    return value == null ? '' : Array.isArray(value) ? value.map(String).join(',') : String(value);
  });
}

function extractHtmlUrl($: ReturnType<typeof parseHtml>, scope: Parameters<typeof extractValue>[1], rule: string | undefined): string {
  if (!rule?.trim()) return '';
  const trimmed = rule.trim();
  if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith('/')) return trimmed;
  return extractValue($, scope, trimmed);
}

function stripRegexSuffix(rule: string): string {
  const index = rule.indexOf('##');
  return index === -1 ? rule : rule.slice(0, index);
}

function applyRegexSuffix(rule: string, value: string): string {
  const index = rule.indexOf('##');
  if (index === -1) return value;
  const remainder = rule.slice(index + 2);
  const replacementIndex = remainder.indexOf('##');
  const pattern = replacementIndex === -1 ? remainder : remainder.slice(0, replacementIndex);
  const replacement = replacementIndex === -1 ? '' : remainder.slice(replacementIndex + 2);
  if (!pattern) return value;
  try {
    return value.replace(new RegExp(pattern, 'g'), replacement);
  } catch {
    return value;
  }
}

/** Very small JSONPath: `$.a.b`, `$.a[*]`, `$.a[*].b`, `$.a.0.b`, bare `name` relative. */
function jsonPath(root: unknown, path: string): unknown {
  if (!path) return undefined;
  let p = path.trim();
  if (p.startsWith('$.')) p = p.slice(2);
  else if (p === '$') return root;
  else if (p.startsWith('$')) p = p.slice(1);

  // Relative field name without $ (common inside list items).
  if (!p.includes('.') && !p.includes('[')) {
    if (root && typeof root === 'object' && !Array.isArray(root)) {
      return (root as Record<string, unknown>)[p];
    }
  }

  let cur: unknown = root;
  const tokens = p.split('.').filter(Boolean);
  for (const token of tokens) {
    if (cur == null) return undefined;
    const m = token.match(/^(\w+)?(?:\[(\*|\d+)\])?$/);
    if (!m) {
      // fallback: plain key
      if (typeof cur === 'object' && cur !== null && token in (cur as object)) {
        cur = (cur as Record<string, unknown>)[token];
        continue;
      }
      return undefined;
    }
    const key = m[1];
    const index = m[2];
    if (key) {
      if (typeof cur !== 'object' || cur === null) return undefined;
      cur = (cur as Record<string, unknown>)[key];
    }
    if (index === '*') {
      // Expand array; remaining path applied later via flatten — only valid as last list step.
      if (!Array.isArray(cur)) return undefined;
      // If more tokens remain, map them over elements (handled by recursive join).
      const rest = tokens.slice(tokens.indexOf(token) + 1).join('.');
      if (!rest) return cur;
      return cur.map((el) => jsonPath(el, rest.startsWith('$') ? rest : `$.${rest}`));
    }
    if (index !== undefined) {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[Number(index)];
    }
  }
  return cur;
}

function applyReplaceRegex(value: string, rule: string): string {
  const idx = rule.indexOf('##');
  if (idx === -1) return value;
  const rest = rule.slice(idx + 2);
  const secondIdx = rest.indexOf('##');
  const pattern = secondIdx === -1 ? rest : rest.slice(0, secondIdx);
  const replacement = secondIdx === -1 ? '' : rest.slice(secondIdx + 2);
  if (!pattern) return value;
  try {
    return value.replace(new RegExp(pattern, 'g'), replacement);
  } catch {
    return value;
  }
}

function absolutize(value: string, baseUrl: string): string {
  if (!value) return '';
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return value;
  }
}
