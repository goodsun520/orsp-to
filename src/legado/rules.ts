import { extractList, extractValue, parseHtml, selectNodes } from './selector.js';
import { resolveExploreRule } from './explore.js';
import { fetchPage, parseLegadoHeaders } from './fetchSource.js';
import { cookieScopeKey, jarForSource } from './cookieJar.js';
import { cleanSourceBaseUrl, parseSearchUrl } from './searchUrl.js';
import type { LegadoBookSource } from './types.js';
import {
  canUseZhulangCodec,
  getZhulangBookInfo,
  getZhulangChapterContent,
  getZhulangChapterList,
  searchZhulangBooks,
} from './zhulangSource.js';

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
  if (canUseZhulangCodec(source)) {
    return finalizeSearchItems(await searchZhulangBooks(source, query, page), baseUrlOf(source));
  }
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
      coverUrl: extractValue($, scope, rule.coverUrl),
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
    .map((item) => normalizeBookFields(item, responseUrl))
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
  if (canUseZhulangCodec(source)) {
    return normalizeBookFields(await getZhulangBookInfo(source, bookUrl), baseUrlOf(source));
  }
  const rule = source.ruleBookInfo ?? {};
  const base = fetchOpts(source, ctx);
  const { url, html } = await fetchPage(bookUrl, base);
  const json = parseJsonResponse(html);
  if (json !== null) {
    return normalizeBookFields({
      title: extractJsonValue(json, rule.name),
      author: extractJsonValue(json, rule.author),
      kind: extractJsonList(json, rule.kind),
      wordCount: extractJsonValue(json, rule.wordCount),
      lastChapter: extractJsonValue(json, rule.lastChapter),
      intro: extractJsonValue(json, rule.intro),
      coverUrl: extractJsonValue(json, rule.coverUrl),
      bookUrl: url,
      tocUrl: absolutize(extractJsonUrl(json, rule.tocUrl), url),
    }, url);
  }
  const $ = parseHtml(html);
  const scope = [$.root().get(0)!];
  const variables = extractBookInfoVariables($, scope, rule.init);
  const extract = (value: string | undefined) => extractBookInfoValue($, scope, value, variables);
  return normalizeBookFields({
    title: firstValue(
      extract(rule.name),
      extractValue($, scope, '@css:meta[property="og:novel:book_name"]@content'),
      extractValue($, scope, '@css:meta[property="og:title"]@content'),
      extractValue($, scope, 'tag.h1.0@text'),
    ),
    author: firstValue(
      extract(rule.author),
      extractValue($, scope, '@css:meta[property="og:novel:author"]@content'),
      extractValue($, scope, '@css:meta[name="author"]@content'),
    ),
    kind: extractBookInfoList($, scope, rule.kind, variables),
    wordCount: extract(rule.wordCount),
    lastChapter: extract(rule.lastChapter),
    intro: firstValue(
      extract(rule.intro),
      extractValue($, scope, '@css:meta[property="og:description"]@content'),
      extractValue($, scope, '@css:meta[name="description"]@content'),
    ),
    coverUrl: firstValue(
      extract(rule.coverUrl),
      extractValue($, scope, '@css:meta[property="og:image"]@content'),
    ),
    bookUrl: url,
    tocUrl: absolutize(extractHtmlUrl($, scope, rule.tocUrl), url),
  }, url);
}

function extractBookInfoVariables(
  $: ReturnType<typeof parseHtml>,
  scope: Parameters<typeof extractValue>[1],
  init: string | undefined,
): Map<string, string> {
  const variables = new Map<string, string>();
  const body = init?.trim().match(/^@put:\{([\s\S]*)\}$/i)?.[1];
  if (!body) return variables;
  const pair = /([A-Za-z_]\w*)\s*:\s*"((?:\\.|[^"\\])*)"/g;
  for (const match of body.matchAll(pair)) {
    let selector = match[2];
    try {
      selector = JSON.parse(`"${selector}"`) as string;
    } catch {
      // Keep the literal selector if the source used non-JSON escaping.
    }
    variables.set(match[1], extractValue($, scope, selector));
  }
  return variables;
}

function extractBookInfoValue(
  $: ReturnType<typeof parseHtml>,
  scope: Parameters<typeof extractValue>[1],
  rule: string | undefined,
  variables: Map<string, string>,
): string {
  const key = rule?.trim().match(/^@get:\{([A-Za-z_]\w*)\}$/i)?.[1];
  return key ? variables.get(key) ?? '' : extractValue($, scope, rule);
}

function extractBookInfoList(
  $: ReturnType<typeof parseHtml>,
  scope: Parameters<typeof extractValue>[1],
  rule: string | undefined,
  variables: Map<string, string>,
): string[] {
  const key = rule?.trim().match(/^@get:\{([A-Za-z_]\w*)\}$/i)?.[1];
  if (!key) return extractList($, scope, rule);
  return (variables.get(key) ?? '')
    .split(/[\n,]+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function firstValue(...values: string[]): string {
  return values.find((value) => value.trim()) ?? '';
}

/**
 * Cleans the common book fields used by search, discovery, browse, and detail.
 * Some imported sources accidentally put an `img@src` value in `intro` while
 * leaving `coverUrl` empty. Recover that unambiguous image reference here so
 * ORSP never exposes a cover path as a human-readable description.
 */
export function normalizeBookFields<T extends SearchResultItem>(item: T, responseUrl: string): T {
  const intro = cleanText(item.intro);
  const cover = cleanText(item.coverUrl);
  const introIsImage = isImageReference(intro);
  const coverIsUrl = isUrlReference(cover);
  const coverCandidate = coverIsUrl ? cover : introIsImage ? intro : '';
  const normalizedIntro = introIsImage ? (cover && !coverIsUrl ? cover : '') : intro;

  return {
    ...item,
    title: cleanText(item.title),
    author: cleanText(item.author),
    kind: item.kind.map(cleanText).filter(Boolean),
    lastChapter: cleanText(item.lastChapter),
    intro: normalizedIntro,
    coverUrl: resolveHttpUrl(coverCandidate, responseUrl),
    bookUrl: absolutize(cleanText(item.bookUrl), responseUrl),
  };
}

function cleanText(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

function resolveHttpUrl(value: string, baseUrl: string): string {
  if (!value) return '';
  try {
    const url = new URL(value, baseUrl);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : '';
  } catch {
    return '';
  }
}

function isImageReference(value: string): boolean {
  if (!value || /\s/.test(value)) return false;
  try {
    const url = new URL(value, 'https://image-reference.invalid/');
    return /\.(?:avif|bmp|gif|jpe?g|png|svg|webp)$/i.test(url.pathname);
  } catch {
    return false;
  }
}

function isUrlReference(value: string): boolean {
  if (!value || /\s/.test(value)) return false;
  return /^(?:https?:)?\/\//i.test(value)
    || value.startsWith('/')
    || value.startsWith('./')
    || value.startsWith('../')
    || value.includes('/')
    || isImageReference(value);
}

export async function getChapterList(source: LegadoBookSource, bookUrl: string, ctx?: RuleContext): Promise<TocChapter[]> {
  if (canUseZhulangCodec(source)) return getZhulangChapterList(source, bookUrl);
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
  if (canUseZhulangCodec(source)) return getZhulangChapterContent(source, chapterUrl);
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
  const orBranches = splitJsonRule(withoutJs, '||');
  for (const branch of orBranches) {
    const values = splitJsonRule(branch, '&&')
      .map((part) => evaluateJsonRulePart(root, part))
      .filter((value) => value.trim());
    if (values.length > 0) return values.join('\n');
  }
  return '';
}

function extractJsonList(root: unknown, rule: string | undefined): string[] {
  const value = extractJsonValue(root, rule);
  return value
    .split(/[\n,]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function extractJsonUrl(root: unknown, rule: string | undefined): string {
  return extractJsonValue(root, rule).trim();
}

function evaluateJsonRulePart(root: unknown, part: string): string {
  const normalized = stripRegexSuffix(part.trim());
  const value = containsJsonTemplate(normalized)
    ? interpolateJsonTemplate(normalized, root)
    : jsonPath(root, normalized);
  const text = value == null ? '' : Array.isArray(value) ? value.map(String).join('\n') : String(value);
  return applyRegexSuffix(part, text);
}

function containsJsonTemplate(value: string): boolean {
  return /\{\{\s*(?:\$|@json:)/i.test(value) || /(^|[^\{])\{\s*\$[^{}]*\}(?!\})/.test(value);
}

function interpolateJsonTemplate(template: string, root: unknown): string {
  const render = (match: string, path: string): string => {
    const value = jsonPath(root, path.trim());
    return value == null ? match : Array.isArray(value) ? value.map(String).join(',') : String(value);
  };
  return template
    .replace(/\{\{\s*@json:([^}]+)\s*\}\}/gi, (match, path: string) => render(match, path))
    .replace(/\{\{\s*(\$[^}]*)\s*\}\}/g, (match, path: string) => render(match, path))
    .replace(/(^|[^\{])\{\s*(\$[^{}]*)\s*\}(?!\})/g, (match, prefix: string, path: string) => {
      return `${prefix}${render(match.slice(prefix.length), path)}`;
    });
}

/** Split safe JSON rule combinators without interpreting source-supplied code. */
function splitJsonRule(rule: string, operator: '&&' | '||'): string[] {
  const parts: string[] = [];
  let inRegex = false;
  let last = 0;
  for (let i = 0; i < rule.length; i++) {
    if (rule[i] === '#' && rule[i + 1] === '#') {
      inRegex = !inRegex;
      i += 1;
      continue;
    }
    if (!inRegex && rule.startsWith(operator, i)) {
      parts.push(rule.slice(last, i));
      last = i + operator.length;
      i += operator.length - 1;
    }
  }
  parts.push(rule.slice(last));
  return parts;
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

type JsonPathStep =
  | { kind: 'key'; value: string }
  | { kind: 'index'; value: number }
  | { kind: 'wildcard' }
  | { kind: 'recursive'; value: string };

/**
 * Safe JSONPath subset for API sources. Supports direct keys, numeric indexes,
 * wildcards, quoted bracket keys, and recursive descent such as `$..list[*]`.
 * It intentionally excludes filters, expressions, functions, and scripts.
 */
function jsonPath(root: unknown, path: string): unknown {
  if (!path) return undefined;
  const trimmed = path.trim();
  if (trimmed === '$') return root;
  const steps = parseJsonPath(trimmed);
  if (!steps) return undefined;

  let values: unknown[] = [root];
  for (const step of steps) {
    values = values.flatMap((value) => applyJsonPathStep(value, step));
    if (values.length === 0) return undefined;
  }
  const lastStep = steps.at(-1);
  const expanded = lastStep?.kind === 'wildcard' || lastStep?.kind === 'recursive';
  if (values.length === 1 && (!expanded || Array.isArray(values[0]))) return values[0];
  return values;
}

function parseJsonPath(path: string): JsonPathStep[] | null {
  let source = path.startsWith('$') ? path.slice(1) : path;
  const steps: JsonPathStep[] = [];
  let index = 0;

  while (index < source.length) {
    if (source.startsWith('..', index)) {
      index += 2;
      const token = readJsonPathToken(source, index);
      if (!token || token.kind === 'index') return null;
      steps.push({ kind: 'recursive', value: token.kind === 'wildcard' ? '*' : token.value });
      index = token.next;
      continue;
    }
    if (source[index] === '.') index += 1;
    if (index >= source.length) break;

    if (source[index] === '[') {
      const closing = source.indexOf(']', index + 1);
      if (closing === -1) return null;
      const raw = source.slice(index + 1, closing).trim();
      if (raw === '*') steps.push({ kind: 'wildcard' });
      else if (/^\d+$/.test(raw)) steps.push({ kind: 'index', value: Number(raw) });
      else {
        const quoted = raw.match(/^(['"])(.*)\1$/);
        if (!quoted) return null;
        steps.push({ kind: 'key', value: quoted[2] });
      }
      index = closing + 1;
      continue;
    }

    const token = readJsonPathToken(source, index);
    if (!token) return null;
    if (token.kind === 'wildcard') steps.push({ kind: 'wildcard' });
    else if (token.kind === 'index') steps.push({ kind: 'index', value: Number(token.value) });
    else steps.push({ kind: 'key', value: token.value });
    index = token.next;
  }
  return steps;
}

function readJsonPathToken(
  source: string,
  start: number,
): { kind: 'key' | 'index' | 'wildcard'; value: string; next: number } | null {
  if (source[start] === '*') return { kind: 'wildcard', value: '*', next: start + 1 };
  let end = start;
  while (end < source.length && source[end] !== '.' && source[end] !== '[') end += 1;
  const value = source.slice(start, end).trim();
  if (!value || !/^[\w-]+$/.test(value)) return null;
  return { kind: /^\d+$/.test(value) ? 'index' : 'key', value, next: end };
}

function applyJsonPathStep(value: unknown, step: JsonPathStep): unknown[] {
  if (step.kind === 'recursive') return recursiveJsonValues(value, step.value);
  if (step.kind === 'wildcard') {
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object') return Object.values(value as Record<string, unknown>);
    return [];
  }
  if (step.kind === 'index') return Array.isArray(value) && step.value < value.length ? [value[step.value]] : [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return step.value in value ? [(value as Record<string, unknown>)[step.value]] : [];
}

function recursiveJsonValues(value: unknown, key: string): unknown[] {
  if (Array.isArray(value)) return value.flatMap((item) => recursiveJsonValues(item, key));
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  const matches = key === '*' ? Object.values(record) : key in record ? [record[key]] : [];
  return [...matches, ...Object.values(record).flatMap((item) => recursiveJsonValues(item, key))];
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
