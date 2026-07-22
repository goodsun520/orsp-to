import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import path from 'node:path';
import { detectUnsupportedFeatures, type LegadoBookSource, type UnsupportedFeatures } from '../legado/types.js';
import { cleanSourceBaseUrl } from '../legado/searchUrl.js';
import { decodeId, encodeId, isValidOpaqueId } from './ids.js';

function cleanUrlKey(url: string): string {
  return cleanSourceBaseUrl(url).replace(/\/+$/, '').toLowerCase();
}

const MAX_TRACKED_IDENTIFIERS = 1_000;
const MAX_COVER_ASSETS = 2_000;
export const MAX_COVER_URL_LENGTH = 8_192;

export interface SourceStats {
  /** Times someone submitted this bookSourceUrl for conversion (incl. dedup hits). */
  convertRequests: number;
  /** Successful, non-health-check chapter content responses. */
  readCount: number;
  votes: number;
  /** HMAC identifiers used only for one-vote-per-reader enforcement. */
  voterKeys: string[];
  /** HMAC identifiers of recent readers; raw IPs are never persisted. */
  readerKeys: string[];
}

export interface SourceHealth {
  checkedAt: string;
  status: 'parse_passed' | 'parse_failed';
  query?: string;
  stage?: string;
  reason?: string;
  discoveryChecked?: boolean;
  stages?: Record<string, { status: 'ok' | 'failed'; latencyMs?: number }>;
}

export interface StoredSource {
  id: string;
  createdAt: string;
  /** Last time legado rules / unsupported flags were refreshed from an import. */
  updatedAt?: string;
  legado: LegadoBookSource;
  unsupported: UnsupportedFeatures;
  /** Long upstream URLs keyed by compact ORSP IDs (short URLs use reversible base64url IDs). */
  urlIds?: Record<string, string>;
  /** Registered same-origin cover assets; clients only receive the opaque keys. */
  coverAssets?: Record<string, string>;
  /** Last bounded adapter audit. Only passed records enter the public catalogue. */
  health?: SourceHealth;
  stats: SourceStats;
}

export interface AddResult {
  record: StoredSource;
  isNew: boolean;
}

export type RankSort = 'usage' | 'votes' | 'converts' | 'newest';

function emptyStats(): SourceStats {
  return {
    convertRequests: 0,
    readCount: 0,
    votes: 0,
    voterKeys: [],
    readerKeys: [],
  };
}

/** Drops legacy IP/location telemetry instead of carrying it into the new model. */
function normalizeStats(raw: Partial<SourceStats> | undefined): SourceStats {
  const base = emptyStats();
  if (!raw || typeof raw !== 'object') return base;
  return {
    convertRequests: Number(raw.convertRequests) || 0,
    readCount: Number(raw.readCount) || 0,
    votes: Number(raw.votes) || 0,
    voterKeys: Array.isArray(raw.voterKeys) ? raw.voterKeys.map(String).slice(0, MAX_TRACKED_IDENTIFIERS) : [],
    readerKeys: Array.isArray(raw.readerKeys) ? raw.readerKeys.map(String).slice(0, MAX_TRACKED_IDENTIFIERS) : [],
  };
}

function pushCappedKey(list: string[], value: string): string[] {
  return [value, ...list.filter((entry) => entry !== value)].slice(0, MAX_TRACKED_IDENTIFIERS);
}

export class SourceRegistry {
  private sources = new Map<string, StoredSource>();
  private writeQueues = new Map<string, Promise<void>>();
  private lastHealthReloadAt = 0;
  private healthReloadPromise?: Promise<void>;

  static ephemeral(statsHashKey = 'ephemeral-audit-key'): SourceRegistry {
    return new SourceRegistry(null, statsHashKey);
  }

  constructor(
    private readonly dataDir: string | null,
    private readonly statsHashKey = process.env.STATS_HASH_KEY || 'development-only-stats-key',
  ) {}

  async load(): Promise<void> {
    if (this.dataDir === null) return;
    await mkdir(this.dataDir, { recursive: true });
    const files = await readdir(this.dataDir).catch(() => []);
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const raw = await readFile(path.join(this.dataDir, file), 'utf8');
        const record = JSON.parse(raw) as StoredSource;
        record.stats = normalizeStats(record.stats);
        record.unsupported = detectUnsupportedFeatures(record.legado);
        if (record.coverAssets && typeof record.coverAssets === 'object') {
          const entries = Object.entries(record.coverAssets)
            .filter(
              ([id, url]) =>
                isValidOpaqueId(id) &&
                typeof url === 'string' &&
                url.length <= MAX_COVER_URL_LENGTH,
            )
            .slice(-MAX_COVER_ASSETS);
          record.coverAssets = Object.fromEntries(entries);
        }
        const sidecar = await this.readHealthSidecar(record.id);
        if (sidecar) record.health = sidecar;
        this.sources.set(record.id, record);
      } catch (err) {
        console.error(`Failed to load stored source ${file}:`, err);
      }
    }
  }

  list(): StoredSource[] {
    return [...this.sources.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /**
   * Leaderboard order. The legacy `usage` sort means successful content reads.
   * Ties fall through: reads → votes → convertRequests → recency.
   */
  listRanked(sort: RankSort = 'usage'): StoredSource[] {
    return [...this.sources.values()].sort((a, b) => {
      if (sort === 'newest') return b.createdAt.localeCompare(a.createdAt);
      if (sort === 'votes') {
        if (b.stats.votes !== a.stats.votes) return b.stats.votes - a.stats.votes;
      } else if (sort === 'converts') {
        if (b.stats.convertRequests !== a.stats.convertRequests) {
          return b.stats.convertRequests - a.stats.convertRequests;
        }
      } else {
        // usage (default)
        if (b.stats.readCount !== a.stats.readCount) return b.stats.readCount - a.stats.readCount;
      }
      // shared tie-breakers
      if (b.stats.readCount !== a.stats.readCount) return b.stats.readCount - a.stats.readCount;
      if (b.stats.votes !== a.stats.votes) return b.stats.votes - a.stats.votes;
      if (b.stats.convertRequests !== a.stats.convertRequests) {
        return b.stats.convertRequests - a.stats.convertRequests;
      }
      return b.createdAt.localeCompare(a.createdAt);
    });
  }

  listVerifiedRanked(sort: RankSort = 'usage'): StoredSource[] {
    return this.listRanked(sort).filter((record) => record.health?.status === 'parse_passed');
  }

  get(id: string): StoredSource | undefined {
    return this.sources.get(id);
  }

  /** Resolves a runtime-owned path beside the persisted source records. */
  runtimePath(name: string): string | null {
    return this.dataDir === null ? null : path.join(this.dataDir, name);
  }

  /**
   * Converts an upstream URL into a valid ORSP opaque ID. Base64url remains
   * backwards-compatible for URLs that fit the 200-character wire limit;
   * longer URLs get a persisted per-source hash reference.
   */
  encodeUpstreamUrl(sourceId: string, url: string): string {
    const reversible = encodeId(url);
    if (isValidOpaqueId(reversible)) return reversible;

    const record = this.sources.get(sourceId);
    if (!record) throw new Error(`Unknown source ID: ${sourceId}`);
    const id = `u-${createHash('sha256').update(url).digest('base64url')}`;
    record.urlIds ??= {};
    if (record.urlIds[id] && record.urlIds[id] !== url) {
      throw new Error('Unexpected upstream URL identifier collision');
    }
    if (!record.urlIds[id]) {
      record.urlIds[id] = url;
      void this.persist(record).catch((err) => console.error('Failed to persist upstream URL ID:', err));
    }
    return id;
  }

  decodeUpstreamUrl(sourceId: string, id: string): string | null {
    if (!isValidOpaqueId(id)) return null;
    const reversible = decodeId(id);
    if (reversible) return reversible;
    return this.sources.get(sourceId)?.urlIds?.[id] ?? null;
  }

  /** Registers a source-owned cover and returns a non-reversible asset key. */
  registerCoverUrl(sourceId: string, url: string): string | null {
    const record = this.sources.get(sourceId);
    if (!record || url.length > MAX_COVER_URL_LENGTH) return null;
    let cover: URL;
    let source: URL;
    try {
      cover = new URL(url);
      source = new URL(cleanSourceBaseUrl(record.legado.bookSourceUrl));
    } catch {
      return null;
    }
    if (!['http:', 'https:'].includes(cover.protocol) || cover.origin !== source.origin) return null;

    const id = `c-${createHash('sha256').update(cover.toString()).digest('base64url')}`;
    record.coverAssets ??= {};
    if (!record.coverAssets[id]) {
      record.coverAssets[id] = cover.toString();
      const keys = Object.keys(record.coverAssets);
      while (keys.length > MAX_COVER_ASSETS) {
        const oldest = keys.shift();
        if (oldest) delete record.coverAssets[oldest];
      }
      void this.persist(record).catch((err) => console.error('Failed to persist cover asset:', err));
    }
    return id;
  }

  resolveCoverUrl(sourceId: string, assetId: string): string | null {
    if (!isValidOpaqueId(assetId) || !assetId.startsWith('c-')) return null;
    const url = this.sources.get(sourceId)?.coverAssets?.[assetId];
    return url && url.length <= MAX_COVER_URL_LENGTH ? url : null;
  }

  /**
   * Registers a Legado source, or — if the same `bookSourceUrl` was already
   * converted by anyone — reuses that existing entry instead of re-processing.
   */
  async add(legado: LegadoBookSource): Promise<AddResult> {
    const existing = [...this.sources.values()].find(
      (s) => cleanUrlKey(s.legado.bookSourceUrl) === cleanUrlKey(legado.bookSourceUrl),
    );
    if (existing) {
      // Refresh rules/metadata on re-import so engine upgrades take effect.
      existing.legado = legado;
      existing.unsupported = detectUnsupportedFeatures(legado);
      existing.updatedAt = new Date().toISOString();
      existing.stats.convertRequests += 1;
      await this.persist(existing);
      return { record: existing, isNew: false };
    }

    const now = new Date().toISOString();
    const id = this.slugFor(legado);
    const record: StoredSource = {
      id,
      createdAt: now,
      updatedAt: now,
      legado,
      unsupported: detectUnsupportedFeatures(legado),
      stats: {
        ...emptyStats(),
        convertRequests: 1,
      },
    };
    this.sources.set(id, record);
    await this.persist(record);
    return { record, isNew: true };
  }

  /** One vote per IP per source; returns the updated vote count, or null if this IP already voted / missing. */
  async vote(id: string, ip: string): Promise<number | null> {
    const record = this.sources.get(id);
    if (!record) return null;
    const voterKey = this.hashIdentifier(ip);
    if (record.stats.voterKeys.includes(voterKey)) return null;
    record.stats.votes += 1;
    record.stats.voterKeys = pushCappedKey(record.stats.voterKeys, voterKey);
    await this.persist(record);
    return record.stats.votes;
  }

  /** Records a successful user-visible chapter response without retaining raw IPs. */
  recordRead(id: string, ip: string): void {
    const record = this.sources.get(id);
    if (!record) return;
    record.stats.readCount += 1;
    record.stats.readerKeys = pushCappedKey(record.stats.readerKeys, this.hashIdentifier(ip));
    void this.persist(record).catch((err) => console.error('Failed to persist read stats:', err));
  }

  async remove(id: string): Promise<boolean> {
    if (!this.sources.has(id)) return false;
    this.sources.delete(id);
    if (this.dataDir !== null) {
      await Promise.all([
        rm(path.join(this.dataDir, `${id}.json`), { force: true }),
        rm(this.healthPath(id), { force: true }),
      ]);
    }
    return true;
  }

  /** Starts reader metrics fresh without changing the converted source rules. */
  async resetStats(id: string): Promise<boolean> {
    const record = this.sources.get(id);
    if (!record) return false;
    record.stats = emptyStats();
    await this.persist(record);
    return true;
  }

  async setHealth(id: string, health: SourceHealth): Promise<boolean> {
    const record = this.sources.get(id);
    if (!record) return false;
    record.health = health;
    await Promise.all([this.persist(record), this.persistHealth(id, health)]);
    return true;
  }

  /** Audit processes write only health sidecars, never stale stats/rules snapshots. */
  async setHealthFromAudit(id: string, health: SourceHealth): Promise<boolean> {
    const record = this.sources.get(id);
    if (!record) return false;
    record.health = health;
    await this.persistHealth(id, health);
    return true;
  }

  /** Makes external audit results visible without restarting or replacing counters. */
  async reloadHealthFromDisk(maxAgeMs = 5_000): Promise<void> {
    if (this.dataDir === null) return;
    if (Date.now() - this.lastHealthReloadAt < maxAgeMs) return;
    if (this.healthReloadPromise) return this.healthReloadPromise;
    this.healthReloadPromise = (async () => {
      await Promise.all(
        [...this.sources.values()].map(async (record) => {
          const health = await this.readHealthSidecar(record.id);
          if (health) record.health = health;
        }),
      );
      this.lastHealthReloadAt = Date.now();
    })().finally(() => {
      this.healthReloadPromise = undefined;
    });
    return this.healthReloadPromise;
  }

  /** Waits for fire-and-forget URL/cover/stat snapshots to reach disk. */
  async flushPendingWrites(): Promise<void> {
    let stableEmptyChecks = 0;
    while (stableEmptyChecks < 2) {
      const pending = [...this.writeQueues.values()];
      if (pending.length > 0) await Promise.allSettled(pending);
      await new Promise<void>((resolve) => setImmediate(resolve));
      stableEmptyChecks = this.writeQueues.size === 0 ? stableEmptyChecks + 1 : 0;
    }
  }

  /** Aggregate counters across all sources for the public dashboard header. */
  globalSummary(verifiedOnly = false): {
    sourceCount: number;
    totalReads: number;
    recentUniqueReaders: number;
    totalVotes: number;
    totalConverts: number;
  } {
    let totalReads = 0;
    const readerKeys = new Set<string>();
    let totalVotes = 0;
    let totalConverts = 0;
    const sources = verifiedOnly ? [...this.sources.values()].filter((source) => source.health?.status === 'parse_passed') : this.sources.values();
    for (const s of sources) {
      totalReads += s.stats.readCount;
      s.stats.readerKeys.forEach((key) => readerKeys.add(key));
      totalVotes += s.stats.votes;
      totalConverts += s.stats.convertRequests;
    }
    return {
      sourceCount: verifiedOnly ? [...this.sources.values()].filter((source) => source.health?.status === 'parse_passed').length : this.sources.size,
      totalReads,
      recentUniqueReaders: readerKeys.size,
      totalVotes,
      totalConverts,
    };
  }

  private async persist(record: StoredSource): Promise<void> {
    if (this.dataDir === null) return;
    await this.writeJson(path.join(this.dataDir, `${record.id}.json`), record);
  }

  private healthPath(id: string): string {
    if (this.dataDir === null) throw new Error('Ephemeral registries do not have health paths');
    return path.join(path.dirname(this.dataDir), 'health', `${id}.json`);
  }

  private async persistHealth(id: string, health: SourceHealth): Promise<void> {
    if (this.dataDir === null) return;
    await this.writeJson(this.healthPath(id), health);
  }

  /** Serialize and atomically replace each JSON file so concurrent cover/stat
   * updates cannot interleave and corrupt a persisted source record. */
  private async writeJson(filePath: string, value: unknown): Promise<void> {
    const contents = JSON.stringify(value, null, 2);
    const previous = this.writeQueues.get(filePath) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(async () => {
      await mkdir(path.dirname(filePath), { recursive: true });
      const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporaryPath, contents, 'utf8');
        await rename(temporaryPath, filePath);
      } catch (error) {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
        throw error;
      }
    });
    this.writeQueues.set(filePath, current);
    try {
      await current;
    } finally {
      if (this.writeQueues.get(filePath) === current) this.writeQueues.delete(filePath);
    }
  }

  private async readHealthSidecar(id: string): Promise<SourceHealth | null> {
    if (this.dataDir === null) return null;
    try {
      const value = JSON.parse(await readFile(this.healthPath(id), 'utf8')) as SourceHealth;
      if (
        value &&
        typeof value.checkedAt === 'string' &&
        (value.status === 'parse_passed' || value.status === 'parse_failed')
      ) {
        return value;
      }
    } catch {
      // A missing/partially-written sidecar leaves the last in-memory health intact.
    }
    return null;
  }

  private hashIdentifier(value: string): string {
    return createHmac('sha256', this.statsHashKey).update(value).digest('base64url');
  }

  private slugFor(legado: LegadoBookSource): string {
    let host: string;
    try {
      host = new URL(cleanUrlKey(legado.bookSourceUrl)).hostname;
    } catch {
      host = legado.bookSourceName;
    }
    const base =
      host
        .toLowerCase()
        .replace(/^www\./, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'source';

    let candidate = base;
    let n = 2;
    while (this.sources.has(candidate)) {
      candidate = `${base}-${n++}`;
    }
    return candidate;
  }
}
