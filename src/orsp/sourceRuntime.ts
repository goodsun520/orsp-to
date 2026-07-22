import { parseExploreEntries } from '../legado/explore.js';
import {
  exploreBooks,
  getBookInfo,
  getChapterContent,
  getChapterList,
  searchBooks,
  type SearchResultItem,
} from '../legado/rules.js';
import { cleanSourceBaseUrl } from '../legado/searchUrl.js';
import type { LegadoBookSource } from '../legado/types.js';
import { CatalogCache } from './catalogCache.js';
import { isValidOpaqueId } from './ids.js';
import { SourceRegistry, type StoredSource } from './registry.js';

export class SourceRuntimeError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

export interface RuntimePagination {
  page: number;
  pageSize: number;
}

export interface BrowseInput extends RuntimePagination {
  category?: string;
  sort?: 'latest' | 'popular';
}

const AVAILABLE_EXPLORE_TTL_MS = 10 * 60_000;
const UNAVAILABLE_EXPLORE_TTL_MS = 60_000;
const EXPLORE_PROBE_CONCURRENCY = 4;

export class SourceRuntime {
  private readonly explorePages = new Map<string, { items: SearchResultItem[]; expiresAt: number }>();
  private readonly exploreLoads = new Map<string, Promise<SearchResultItem[]>>();

  constructor(
    private readonly registry: SourceRegistry,
    private readonly publicOrigin: string,
    private readonly catalogCache = new CatalogCache(),
  ) {}

  async discover(record: StoredSource) {
    const entries = parseExploreEntries(record.legado);
    if (entries.length === 0) throw new SourceRuntimeError(404, 'ROUTE_NOT_FOUND', 'Discovery is not supported');
    const sections = await mapWithConcurrency(entries, EXPLORE_PROBE_CONCURRENCY, async (entry) => {
      try {
        const items = await this.loadExplorePage(record, entry.path, 1);
        return { id: entry.id, title: entry.title, items: items.slice(0, 12) };
      } catch {
        return null;
      }
    });
    return {
      sections: sections
        .filter((section): section is { id: string; title: string; items: SearchResultItem[] } => section !== null)
        .filter((section) => section.items.length > 0)
        .slice(0, 6)
        .map((section) => ({
          ...section,
          items: section.items.map((item) => this.bookSummary(record, item)),
        })),
    };
  }

  async categories(record: StoredSource) {
    const entries = parseExploreEntries(record.legado);
    if (entries.length === 0) throw new SourceRuntimeError(404, 'ROUTE_NOT_FOUND', 'Categories are not supported');
    const available = await mapWithConcurrency(entries, EXPLORE_PROBE_CONCURRENCY, async (entry) => {
      try {
        return (await this.loadExplorePage(record, entry.path, 1)).length > 0 ? entry : null;
      } catch {
        return null;
      }
    });
    const items = available
      .filter((entry): entry is (typeof entries)[number] => entry !== null)
      .map(({ id, title }) => ({ id, name: title }));
    if (items.length === 0) {
      throw new SourceRuntimeError(503, 'UNAVAILABLE', 'No browseable categories are currently available', true);
    }
    return { items };
  }

  async browse(record: StoredSource, input: BrowseInput) {
    const entries = parseExploreEntries(record.legado);
    if (entries.length === 0) throw new SourceRuntimeError(404, 'ROUTE_NOT_FOUND', 'Browse is not supported');
    const selected = input.category ? entries.filter((entry) => entry.id === input.category) : entries;
    if (selected.length === 0) throw new SourceRuntimeError(400, 'INVALID_PARAMETER', 'Unknown category');
    if (!input.category && input.page > 1) {
      throw new SourceRuntimeError(503, 'UNAVAILABLE', 'Browse pagination without a category is not supported', true);
    }

    const shelves = await Promise.allSettled(
      selected.map(async (entry) => {
        return this.loadExplorePage(record, entry.path, input.category ? input.page : 1);
      }),
    );
    const seenUrls = new Set<string>();
    const items = shelves.flatMap((shelf) => {
      if (shelf.status !== 'fulfilled') return [];
      return shelf.value.filter((item) => {
        if (seenUrls.has(item.bookUrl)) return false;
        seenUrls.add(item.bookUrl);
        return true;
      });
    });
    if (items.length === 0) {
      throw new SourceRuntimeError(503, 'UNAVAILABLE', 'No browseable books are currently available', true);
    }
    const pageItems = input.category
      ? items.slice(0, input.pageSize)
      : paginate(items, input).items;
    const hasMore = input.category
      ? selected.some((entry) => entry.path.includes('{{page}}')) && items.length >= input.pageSize
      : paginate(items, input).hasMore;
    return {
      items: pageItems.map((item) => this.bookSummary(record, item)),
      page: input.page,
      pageSize: input.pageSize,
      hasMore,
    };
  }

  async search(record: StoredSource, query: string, pagination: RuntimePagination) {
    const items = await searchBooks(record.legado, query, pagination.page, { sourceId: record.id });
    return {
      items: items.slice(0, pagination.pageSize).map((item) => this.bookSummary(record, item)),
      page: pagination.page,
      pageSize: pagination.pageSize,
      hasMore: items.length > pagination.pageSize,
    };
  }

  async detail(record: StoredSource, bookId: string) {
    const bookUrl = this.decodeBookUrl(record, bookId);
    const info = await getBookInfo(record.legado, bookUrl, { sourceId: record.id });
    return { ...this.bookSummary(record, info), id: bookId };
  }

  async catalog(record: StoredSource, bookId: string, pagination: RuntimePagination) {
    const bookUrl = this.decodeBookUrl(record, bookId);
    const chapters = await this.loadChapters(record, bookUrl);
    const page = paginate(chapters, pagination);
    return {
      items: page.items.map((chapter) => ({
        id: this.registry.encodeUpstreamUrl(record.id, chapter.url),
        title: chapter.title,
        order: chapter.order,
      })),
      page: pagination.page,
      pageSize: pagination.pageSize,
      total: chapters.length,
      hasMore: page.hasMore,
    };
  }

  async content(record: StoredSource, bookId: string, chapterId: string) {
    const bookUrl = this.decodeBookUrl(record, bookId);
    if (!isValidOpaqueId(chapterId)) {
      throw new SourceRuntimeError(400, 'INVALID_PARAMETER', 'Malformed chapter ID');
    }
    const chapterUrl = this.registry.decodeUpstreamUrl(record.id, chapterId);
    if (!chapterUrl || !isAllowedSourceUrl(record.legado, chapterUrl)) {
      throw new SourceRuntimeError(404, 'CHAPTER_NOT_FOUND', 'Unknown chapter ID');
    }
    const chapters = await this.loadChapters(record, bookUrl);
    const chapter = chapters.find((item) => item.url === chapterUrl);
    if (!chapter) throw new SourceRuntimeError(404, 'CHAPTER_NOT_FOUND', 'Unknown chapter ID');
    const content = await getChapterContent(record.legado, chapterUrl, { sourceId: record.id });
    return {
      bookId,
      chapterId,
      title: chapter.title,
      contentType: 'text/plain',
      content,
      baseUrl: chapterUrl,
    };
  }

  private decodeBookUrl(record: StoredSource, bookId: string): string {
    if (!isValidOpaqueId(bookId)) {
      throw new SourceRuntimeError(400, 'INVALID_PARAMETER', 'Malformed book ID');
    }
    const url = this.registry.decodeUpstreamUrl(record.id, bookId);
    if (!url || !isAllowedSourceUrl(record.legado, url)) {
      throw new SourceRuntimeError(404, 'BOOK_NOT_FOUND', 'Unknown book ID');
    }
    return url;
  }

  private loadChapters(record: StoredSource, bookUrl: string) {
    return this.catalogCache.getOrLoad(`${record.id}:${bookUrl}`, () =>
      getChapterList(record.legado, bookUrl, { sourceId: record.id }),
    );
  }

  private async loadExplorePage(record: StoredSource, explorePath: string, page: number): Promise<SearchResultItem[]> {
    const key = `${record.id}:${page}:${explorePath}`;
    const cached = this.explorePages.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.items;
    const pending = this.exploreLoads.get(key);
    if (pending) return pending;

    const load = exploreBooks(record.legado, explorePath, page, { sourceId: record.id })
      .then((items) => {
        this.explorePages.set(key, {
          items,
          expiresAt: Date.now() + (items.length > 0 ? AVAILABLE_EXPLORE_TTL_MS : UNAVAILABLE_EXPLORE_TTL_MS),
        });
        return items;
      })
      .catch((error) => {
        this.explorePages.set(key, { items: [], expiresAt: Date.now() + UNAVAILABLE_EXPLORE_TTL_MS });
        throw error;
      })
      .finally(() => {
        this.exploreLoads.delete(key);
      });
    this.exploreLoads.set(key, load);
    return load;
  }

  private bookSummary(record: StoredSource, item: SearchResultItem) {
    const coverAssetId = item.coverUrl ? this.registry.registerCoverUrl(record.id, item.coverUrl) : null;
    return {
      id: this.registry.encodeUpstreamUrl(record.id, item.bookUrl),
      title: item.title,
      author: item.author,
      description: item.intro ?? '',
      coverUrl: coverAssetId
        ? `${this.publicOrigin}/s/${encodeURIComponent(record.id)}/api/v1/assets/covers/${coverAssetId}`
        : undefined,
      categories: item.kind,
      latestChapter: item.lastChapter || undefined,
    };
  }
}

export function isAllowedSourceUrl(source: LegadoBookSource, value: string): boolean {
  try {
    const base = new URL(cleanSourceBaseUrl(source.bookSourceUrl));
    const target = new URL(value);
    if (!['http:', 'https:'].includes(target.protocol)) return false;
    if (normalizedSiteHost(base.hostname) !== normalizedSiteHost(target.hostname)) return false;
    const basePort = base.port || (base.protocol === 'https:' ? '443' : '80');
    const targetPort = target.port || (target.protocol === 'https:' ? '443' : '80');
    return basePort === targetPort || (['80', '443'].includes(basePort) && ['80', '443'].includes(targetPort));
  } catch {
    return false;
  }
}

function normalizedSiteHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^(?:www|m|wap)\./, '');
}

function paginate<T>(items: T[], pagination: RuntimePagination): { items: T[]; hasMore: boolean } {
  const start = (pagination.page - 1) * pagination.pageSize;
  const end = start + pagination.pageSize;
  return { items: items.slice(start, Math.min(end, items.length)), hasMore: end < items.length };
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await worker(items[index]);
      }
    }),
  );
  return results;
}
