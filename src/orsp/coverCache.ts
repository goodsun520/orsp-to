import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FetchedImage } from '../legado/fetchSource.js';
import { UpstreamFetchError } from '../legado/fetchSource.js';

const DEFAULT_FRESH_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_STALE_MS = 7 * 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 5_000;

interface CacheMetadata {
  storedAt: number;
  contentType: string;
  size: number;
  etag?: string;
  lastModified?: string;
}

interface CachedImage {
  image: FetchedImage;
  storedAt: number;
}

interface PendingFetch {
  controller: AbortController;
  promise: Promise<FetchedImage>;
  subscribers: number;
}

export interface CoverResponseCacheOptions {
  directory: string | null;
  freshMs?: number;
  staleMs?: number;
  maxBytes?: number;
  maxEntries?: number;
}

/** Persistent, bounded cover cache with request coalescing and stale-on-network-error fallback. */
export class CoverResponseCache {
  private readonly freshMs: number;
  private readonly staleMs: number;
  private readonly maxBytes: number;
  private readonly maxEntries: number;
  private readonly inFlight = new Map<string, PendingFetch>();
  private cleanupPromise?: Promise<void>;
  private cleanupRequested = false;

  constructor(private readonly directory: string | null, options: Omit<CoverResponseCacheOptions, 'directory'> = {}) {
    this.freshMs = positive(options.freshMs, DEFAULT_FRESH_MS);
    this.staleMs = Math.max(this.freshMs, positive(options.staleMs, DEFAULT_STALE_MS));
    this.maxBytes = positive(options.maxBytes, DEFAULT_MAX_BYTES);
    this.maxEntries = positive(options.maxEntries, DEFAULT_MAX_ENTRIES);
  }

  async getOrFetch(
    key: string,
    signal: AbortSignal | undefined,
    fetcher: (signal: AbortSignal) => Promise<FetchedImage>,
  ): Promise<FetchedImage> {
    const hash = createHash('sha256').update(key).digest('hex');
    const cached = await this.read(hash);
    if (signal?.aborted) throw abortError(signal.reason);
    if (cached && Date.now() - cached.storedAt <= this.freshMs) return cached.image;

    let pending = this.inFlight.get(hash);
    if (pending?.controller.signal.aborted && pending.subscribers === 0) {
      // The last subscriber cancelled, but the aborted fetch may not have
      // settled yet. A new caller must start a fresh request instead of
      // inheriting that already-cancelled promise.
      this.inFlight.delete(hash);
      pending = undefined;
    }
    if (!pending) {
      const controller = new AbortController();
      const promise = (async () => {
        try {
          const image = await fetcher(controller.signal);
          await this.write(hash, image).catch((error) => {
            console.error('Failed to persist cover cache entry:', error);
          });
          return image;
        } catch (error) {
          if (cached && error instanceof UpstreamFetchError && !controller.signal.aborted) {
            return cached.image;
          }
          throw error;
        }
      })().finally(() => {
        // An aborted fetch can be replaced before it settles. Do not let the
        // old completion remove the replacement from the coalescing map.
        if (this.inFlight.get(hash)?.promise === promise) {
          this.inFlight.delete(hash);
        }
      });
      pending = { controller, promise, subscribers: 0 };
      this.inFlight.set(hash, pending);
    }

    return subscribe(pending, signal);
  }

  private async read(hash: string): Promise<CachedImage | null> {
    if (this.directory === null) return null;
    try {
      const metadata = JSON.parse(await readFile(this.metadataPath(hash), 'utf8')) as CacheMetadata;
      if (!validMetadata(metadata) || Date.now() - metadata.storedAt > this.staleMs || metadata.size > this.maxBytes) {
        await this.remove(hash);
        return null;
      }
      const body = await readFile(this.bodyPath(hash));
      if (body.length !== metadata.size) {
        await this.remove(hash);
        return null;
      }
      return {
        storedAt: metadata.storedAt,
        image: {
          body,
          contentType: metadata.contentType,
          etag: metadata.etag,
          lastModified: metadata.lastModified,
        },
      };
    } catch {
      return null;
    }
  }

  private async write(hash: string, image: FetchedImage): Promise<void> {
    if (this.directory === null || image.body.length > this.maxBytes) return;
    await mkdir(this.directory, { recursive: true });
    const metadata: CacheMetadata = {
      storedAt: Date.now(),
      contentType: image.contentType,
      size: image.body.length,
      etag: image.etag,
      lastModified: image.lastModified,
    };
    const bodyPath = this.bodyPath(hash);
    const metadataPath = this.metadataPath(hash);
    const suffix = `${process.pid}.${randomUUID()}.tmp`;
    const temporaryBody = `${bodyPath}.${suffix}`;
    const temporaryMetadata = `${metadataPath}.${suffix}`;
    try {
      await writeFile(temporaryBody, image.body);
      await writeFile(temporaryMetadata, JSON.stringify(metadata), 'utf8');
      await rename(temporaryBody, bodyPath);
      await rename(temporaryMetadata, metadataPath);
    } catch (error) {
      await Promise.all([
        rm(temporaryBody, { force: true }).catch(() => undefined),
        rm(temporaryMetadata, { force: true }).catch(() => undefined),
      ]);
      throw error;
    }
    void this.cleanup().catch((error) => console.error('Failed to clean cover cache:', error));
  }

  private cleanup(): Promise<void> {
    this.cleanupRequested = true;
    if (this.cleanupPromise) return this.cleanupPromise;
    this.cleanupPromise = (async () => {
      while (this.cleanupRequested) {
        this.cleanupRequested = false;
        await this.performCleanup();
      }
    })().finally(() => {
      this.cleanupPromise = undefined;
    });
    return this.cleanupPromise;
  }

  private async performCleanup(): Promise<void> {
    if (this.directory === null) return;
    const files = await readdir(this.directory).catch(() => []);
    const entries: Array<{ hash: string; storedAt: number; size: number }> = [];
    for (const file of files) {
      const match = file.match(/^([a-f0-9]{64})\.json$/);
      if (!match) continue;
      const hash = match[1];
      try {
        const metadata = JSON.parse(await readFile(this.metadataPath(hash), 'utf8')) as CacheMetadata;
        const bodyInfo = await stat(this.bodyPath(hash));
        if (!validMetadata(metadata) || bodyInfo.size !== metadata.size || Date.now() - metadata.storedAt > this.staleMs) {
          await this.remove(hash);
          continue;
        }
        entries.push({ hash, storedAt: metadata.storedAt, size: metadata.size });
      } catch {
        await this.remove(hash);
      }
    }

    entries.sort((a, b) => a.storedAt - b.storedAt);
    let totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
    let totalEntries = entries.length;
    for (const entry of entries) {
      if (totalBytes <= this.maxBytes && totalEntries <= this.maxEntries) break;
      await this.remove(entry.hash);
      totalBytes -= entry.size;
      totalEntries -= 1;
    }
  }

  private async remove(hash: string): Promise<void> {
    if (this.directory === null) return;
    await Promise.all([
      rm(this.bodyPath(hash), { force: true }),
      rm(this.metadataPath(hash), { force: true }),
    ]);
  }

  private bodyPath(hash: string): string {
    return path.join(this.directory!, `${hash}.bin`);
  }

  private metadataPath(hash: string): string {
    return path.join(this.directory!, `${hash}.json`);
  }
}

function subscribe(pending: PendingFetch, signal?: AbortSignal): Promise<FetchedImage> {
  if (signal?.aborted) return Promise.reject(abortError(signal.reason));
  pending.subscribers += 1;
  return new Promise<FetchedImage>((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (settled) return false;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      pending.subscribers -= 1;
      return true;
    };
    const onAbort = () => {
      if (!finish()) return;
      if (pending.subscribers === 0) pending.controller.abort(signal?.reason);
      reject(abortError(signal?.reason));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    pending.promise.then(
      (image) => {
        if (finish()) resolve(image);
      },
      (error) => {
        if (finish()) reject(error);
      },
    );
  });
}

function validMetadata(value: CacheMetadata): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    Number.isFinite(value.storedAt) &&
    Number.isInteger(value.size) &&
    value.size >= 0 &&
    typeof value.contentType === 'string' &&
    value.contentType.startsWith('image/') &&
    (value.etag === undefined || typeof value.etag === 'string') &&
    (value.lastModified === undefined || typeof value.lastModified === 'string')
  );
}

function positive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function abortError(reason?: unknown): DOMException {
  return reason instanceof DOMException && reason.name === 'AbortError'
    ? reason
    : new DOMException('The operation was aborted', 'AbortError');
}
