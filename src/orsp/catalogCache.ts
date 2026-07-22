import type { TocChapter } from '../legado/rules.js';

const DEFAULT_TTL_MS = 2 * 60 * 1000;
const MAX_ENTRIES = 16;

interface CachedCatalog {
  chapters: TocChapter[];
  expiresAt: number;
}

/**
 * A small per-process cache prevents a paginated ORSP client from re-fetching
 * the same complete upstream TOC for every page. It is deliberately short
 * lived because the adapter cannot observe upstream catalog invalidation.
 */
export class CatalogCache {
  private readonly entries = new Map<string, CachedCatalog>();
  private readonly inflight = new Map<string, Promise<TocChapter[]>>();

  constructor(
    private readonly ttlMs = DEFAULT_TTL_MS,
    private readonly now = () => Date.now(),
  ) {}

  async getOrLoad(key: string, loader: () => Promise<TocChapter[]>): Promise<TocChapter[]> {
    const cached = this.entries.get(key);
    if (cached && cached.expiresAt > this.now()) return cached.chapters;
    if (cached) this.entries.delete(key);

    const existing = this.inflight.get(key);
    if (existing) return existing;

    const request = loader()
      .then((chapters) => {
        this.prune();
        this.entries.set(key, { chapters, expiresAt: this.now() + this.ttlMs });
        return chapters;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, request);
    return request;
  }

  private prune(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
    while (this.entries.size >= MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (!oldest) return;
      this.entries.delete(oldest);
    }
  }
}
