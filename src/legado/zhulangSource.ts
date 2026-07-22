import { cookieScopeKey, jarForSource } from './cookieJar.js';
import { fetchPage, parseLegadoHeaders } from './fetchSource.js';
import type { LegadoBookSource } from './types.js';
import {
  decodeZhulangJson,
  encryptZhulangText,
  hasKnownZhulangCodecFingerprint,
  isZhulangSource,
  rsaPublicDecryptZhulang,
  ZHULANG_SOURCE_ORIGIN,
} from './zhulangCodec.js';

interface ZhulangBookDetail {
  book_id?: number | string;
  title?: string;
  cover?: string;
  author_name?: string;
  tags?: Array<{ tag_name?: string }>;
  intro?: string;
  finish?: number;
  chapter_name?: string;
}

interface ZhulangSearchPayload {
  data?: { list?: Array<{ book_detail?: ZhulangBookDetail }> };
}

interface ZhulangDetailPayload {
  data?: {
    id?: number | string;
    name?: string;
    author_name?: string;
    jin_cate1_name?: string;
    word_count_cn?: string;
    word_count?: number | string;
    last_update_chapter?: { name?: string };
    description?: string;
    copyright?: string;
    cover?: string;
  };
}

interface ZhulangTocPayload {
  data?: { titles?: string[]; items?: unknown[][] };
}

interface ZhulangContentPayload {
  data?: { content?: string };
}

export interface ZhulangSearchItem {
  title: string;
  author: string;
  kind: string[];
  lastChapter: string;
  intro: string;
  coverUrl: string;
  bookUrl: string;
}

export interface ZhulangBookInfo extends ZhulangSearchItem {
  wordCount: string;
  tocUrl: string;
}

export interface ZhulangChapter {
  title: string;
  url: string;
  order: number;
}

export function canUseZhulangCodec(source: LegadoBookSource): boolean {
  return isZhulangSource(source) && hasKnownZhulangCodecFingerprint(source);
}

export function zhulangSearchPath(query: string, page: number): string {
  const params = new URLSearchParams({
    word: query,
    search_type: '2',
    related_type: '0',
    offset: String(Math.max(0, page - 1) * 20),
    limit: '20',
  });
  return `/v3/search/list?${params}`;
}

export function mapZhulangSearchPayload(payload: ZhulangSearchPayload): ZhulangSearchItem[] {
  const items = payload.data?.list ?? [];
  return items.flatMap((item) => {
    const book = item.book_detail;
    const id = positiveInteger(book?.book_id);
    const title = text(book?.title);
    if (!book || !id || !title) return [];
    const primaryTag = text(book.tags?.[0]?.tag_name);
    return [{
      title,
      author: text(book.author_name),
      kind: [primaryTag, book.finish === 1 ? '已完结' : '连载中'].filter(Boolean),
      lastChapter: text(book.chapter_name),
      intro: text(book.intro),
      coverUrl: httpUrl(book.cover),
      bookUrl: `${ZHULANG_SOURCE_ORIGIN}/v3/book/detail/${id}`,
    }];
  });
}

export function mapZhulangDetailPayload(payload: ZhulangDetailPayload): ZhulangBookInfo {
  const book = payload.data;
  const id = positiveInteger(book?.id);
  if (!book || !id || !text(book.name)) throw new Error('Zhulang detail response is missing a book');
  const description = text(book.description);
  const copyright = text(book.copyright);
  return {
    title: text(book.name),
    author: text(book.author_name),
    kind: [text(book.jin_cate1_name)].filter(Boolean),
    wordCount: text(book.word_count_cn) || text(book.word_count),
    lastChapter: text(book.last_update_chapter?.name),
    intro: [description, copyright ? `版权信息：${copyright}` : ''].filter(Boolean).join('\n\n'),
    coverUrl: httpUrl(book.cover),
    bookUrl: `${ZHULANG_SOURCE_ORIGIN}/v3/book/detail/${id}`,
    tocUrl: `${ZHULANG_SOURCE_ORIGIN}/v3/book/chapters/${id}?page=0&limit=1000000`,
  };
}

export function mapZhulangTocPayload(payload: ZhulangTocPayload, bookId: number): ZhulangChapter[] {
  const titles = payload.data?.titles ?? [];
  const items = payload.data?.items ?? [];
  return items.flatMap((row, order) => {
    if (!Array.isArray(row)) return [];
    const item = Object.fromEntries(titles.map((key, index) => [key, row[index]]));
    const chapterId = positiveInteger(item.chapter_id);
    const sequenceId = positiveInteger(item.seq_id);
    const title = text(item.name);
    if (!chapterId || !sequenceId || !title) return [];
    const params = new URLSearchParams({
      book_id: String(bookId),
      chapter_id: String(chapterId),
      seq_id: String(sequenceId),
    });
    return [{ title, order, url: `${ZHULANG_SOURCE_ORIGIN}/v3/book/read?${params}` }];
  });
}

export async function searchZhulangBooks(
  source: LegadoBookSource,
  query: string,
  page: number,
): Promise<ZhulangSearchItem[]> {
  const response = await fetchPage(zhulangSearchPath(query, page), fetchOptions(source));
  return mapZhulangSearchPayload(decodeZhulangJson<ZhulangSearchPayload>(response.html.trim()));
}

export async function getZhulangBookInfo(
  source: LegadoBookSource,
  bookUrl: string,
): Promise<ZhulangBookInfo> {
  const bookId = bookIdFromUrl(bookUrl);
  const response = await fetchPage(`/v3/book/detail/${bookId}`, fetchOptions(source));
  return mapZhulangDetailPayload(decodeZhulangJson<ZhulangDetailPayload>(response.html.trim()));
}

export async function getZhulangChapterList(
  source: LegadoBookSource,
  bookUrl: string,
): Promise<ZhulangChapter[]> {
  const bookId = bookIdFromUrl(bookUrl);
  const response = await fetchPage(
    `/v3/book/chapters/${bookId}?page=0&limit=1000000`,
    fetchOptions(source),
  );
  return mapZhulangTocPayload(decodeZhulangJson<ZhulangTocPayload>(response.html.trim()), bookId);
}

export async function getZhulangChapterContent(
  source: LegadoBookSource,
  chapterUrl: string,
): Promise<string> {
  const locator = new URL(chapterUrl);
  if (locator.origin !== ZHULANG_SOURCE_ORIGIN || locator.pathname !== '/v3/book/read') {
    throw new Error('Invalid Zhulang chapter locator');
  }
  const bookId = positiveInteger(locator.searchParams.get('book_id'));
  const chapterId = positiveInteger(locator.searchParams.get('chapter_id'));
  const sequenceId = positiveInteger(locator.searchParams.get('seq_id'));
  if (!bookId || !chapterId || !sequenceId) throw new Error('Invalid Zhulang chapter identifiers');
  const requestBody = encryptZhulangText(JSON.stringify({
    book_id: bookId,
    chapter_id: chapterId,
    seq_id: sequenceId,
  }));
  const options = fetchOptions(source);
  const response = await fetchPage('/v3/book/read', {
    ...options,
    method: 'POST',
    body: requestBody,
    headers: { ...options.headers, 'Content-Type': 'text/plain' },
  });
  const payload = decodeZhulangJson<ZhulangContentPayload>(normalizeEncryptedResponse(response.html));
  const encryptedContent = text(payload.data?.content);
  if (!encryptedContent) throw new Error('Zhulang content response is empty');
  return rsaPublicDecryptZhulang(encryptedContent).replaceAll('<p>&nbsp;</p>', '');
}

function fetchOptions(source: LegadoBookSource) {
  return {
    baseUrl: source.bookSourceUrl,
    headers: parseLegadoHeaders(source.header),
    cookieJar: jarForSource(cookieScopeKey(source)),
  };
}

function bookIdFromUrl(value: string): number {
  const url = new URL(value);
  if (url.origin !== ZHULANG_SOURCE_ORIGIN) throw new Error('Invalid Zhulang book URL');
  const match = url.pathname.match(/^\/v3\/book\/detail\/(\d+)$/);
  const id = positiveInteger(match?.[1]);
  if (!id) throw new Error('Invalid Zhulang book identifier');
  return id;
}

function normalizeEncryptedResponse(value: string): string {
  const trimmed = value.trim();
  if (/^[0-9a-f]+$/i.test(trimmed) && trimmed.length % 2 === 0) {
    return Buffer.from(trimmed, 'hex').toString('latin1');
  }
  return trimmed;
}

function positiveInteger(value: unknown): number | null {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function text(value: unknown): string {
  return value == null ? '' : String(value).trim();
}

function httpUrl(value: unknown): string {
  const candidate = text(value);
  if (!candidate) return '';
  try {
    const url = new URL(candidate, ZHULANG_SOURCE_ORIGIN);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : '';
  } catch {
    return '';
  }
}
