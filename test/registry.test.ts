import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SourceRegistry } from '../src/orsp/registry.js';
import type { LegadoBookSource } from '../src/legado/types.js';

function minimalSource(url: string, name = '测试源'): LegadoBookSource {
  return {
    bookSourceName: name,
    bookSourceUrl: url,
    searchUrl: '/s?q={{key}}',
    ruleSearch: { bookList: 'class.item' },
    ruleToc: { chapterList: 'class.chapter' },
    ruleContent: { content: 'class.content@text' },
  };
}

let dataDir: string;
let registry: SourceRegistry;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'orsp-reg-'));
  registry = new SourceRegistry(dataDir);
  await registry.load();
});

afterEach(async () => {
  await registry.flushPendingWrites();
  await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

describe('SourceRegistry', () => {
  it('dedupes by bookSourceUrl without retaining converter identities', async () => {
    const a = await registry.add(minimalSource('https://a.example/'));
    expect(a.isNew).toBe(true);

    const b = await registry.add(minimalSource('https://a.example/', '别名'));
    expect(b.isNew).toBe(false);
    expect(b.record.id).toBe(a.record.id);
    expect(b.record.stats.convertRequests).toBe(2);
  });

  it('records anonymized successful reads without persisting raw IPs', async () => {
    const { record } = await registry.add(minimalSource('https://b.example/'));
    registry.recordRead(record.id, '8.8.8.8');
    registry.recordRead(record.id, '8.8.8.8');
    registry.recordRead(record.id, '9.9.9.9');

    // allow fire-and-forget persist
    await new Promise((r) => setTimeout(r, 30));

    const fresh = registry.get(record.id)!;
    expect(fresh.stats.readCount).toBe(3);
    expect(fresh.stats.readerKeys).toHaveLength(2);
    expect(JSON.stringify(fresh)).not.toContain('8.8.8.8');
    expect(JSON.stringify(fresh)).not.toContain('9.9.9.9');
  });

  it('ranks by successful reads through the legacy usage sort', async () => {
    const cold = await registry.add(minimalSource('https://cold.example/'));
    const hot = await registry.add(minimalSource('https://hot.example/'));
    registry.recordRead(hot.record.id, '1.1.1.1');
    registry.recordRead(hot.record.id, '1.1.1.1');
    await new Promise((r) => setTimeout(r, 20));

    const ranked = registry.listRanked('usage');
    expect(ranked[0].id).toBe(hot.record.id);
    expect(ranked[1].id).toBe(cold.record.id);
  });

  it('only returns sources with a passed audit to the public catalogue', async () => {
    const { record } = await registry.add(minimalSource('https://verified.example/'));
    expect(registry.listVerifiedRanked()).toHaveLength(0);

    await registry.setHealth(record.id, {
      checkedAt: '2026-07-22T00:00:00.000Z',
      status: 'parse_passed',
      discoveryChecked: true,
    });
    expect(registry.listVerifiedRanked().map((source) => source.id)).toEqual([record.id]);
    expect(registry.globalSummary(true).sourceCount).toBe(1);
  });

  it('one vote per IP', async () => {
    const { record } = await registry.add(minimalSource('https://v.example/'));
    expect(await registry.vote(record.id, '10.0.0.1')).toBe(1);
    expect(await registry.vote(record.id, '10.0.0.1')).toBeNull();
    expect(await registry.vote(record.id, '10.0.0.2')).toBe(2);
  });

  it('persists only same-origin cover assets behind non-reversible IDs', async () => {
    const { record } = await registry.add(minimalSource('https://covers.example/books'));
    const coverUrl = 'https://covers.example/assets/cover.jpg';
    const assetId = registry.registerCoverUrl(record.id, coverUrl);

    expect(assetId).toMatch(/^c-[A-Za-z0-9_-]+$/);
    expect(assetId).not.toContain('covers.example');
    expect(registry.resolveCoverUrl(record.id, assetId!)).toBe(coverUrl);
    expect(registry.registerCoverUrl(record.id, 'https://evil.example/cover.jpg')).toBeNull();
    expect(registry.resolveCoverUrl(record.id, 'c-unknown')).toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 30));
    const reloaded = new SourceRegistry(dataDir);
    await reloaded.load();
    expect(reloaded.resolveCoverUrl(record.id, assetId!)).toBe(coverUrl);
  });

  it('serializes concurrent cover persistence without corrupting the source JSON', async () => {
    const { record } = await registry.add(minimalSource('https://many-covers.example/books'));
    for (let index = 0; index < 200; index += 1) {
      registry.registerCoverUrl(record.id, `https://many-covers.example/assets/${index}.jpg`);
    }
    // setHealth persists the same record after all queued cover writes, which
    // also gives the fire-and-forget registrations a deterministic flush point.
    await registry.setHealth(record.id, {
      checkedAt: '2026-07-22T00:00:00.000Z',
      status: 'parse_passed',
    });

    const persisted = JSON.parse(await readFile(path.join(dataDir, `${record.id}.json`), 'utf8'));
    expect(Object.keys(persisted.coverAssets)).toHaveLength(200);
  });

  it('reloads audit health without overwriting live reader counters', async () => {
    const { record } = await registry.add(minimalSource('https://health.example/'));
    await registry.setHealth(record.id, {
      checkedAt: '2026-07-22T00:00:00.000Z',
      status: 'parse_passed',
      query: '西游记',
    });
    registry.recordRead(record.id, '8.8.8.8');
    await new Promise((resolve) => setTimeout(resolve, 30));

    const auditor = new SourceRegistry(dataDir);
    await auditor.load();
    await auditor.setHealthFromAudit(record.id, {
      checkedAt: '2026-07-22T01:00:00.000Z',
      status: 'parse_failed',
      stage: 'content',
      reason: 'empty content',
    });

    await registry.reloadHealthFromDisk(0);
    expect(registry.get(record.id)?.health?.status).toBe('parse_failed');
    expect(registry.get(record.id)?.stats.readCount).toBe(1);

    const restarted = new SourceRegistry(dataDir);
    await restarted.load();
    expect(restarted.get(record.id)?.health?.status).toBe('parse_failed');
    expect(restarted.get(record.id)?.stats.readCount).toBe(1);
  });

  it('recomputes compatibility metadata when loading legacy records', async () => {
    const { record } = await registry.add({
      ...minimalSource('https://session.example/'),
      enabledCookieJar: true,
    });
    const restarted = new SourceRegistry(dataDir);
    await restarted.load();

    expect(restarted.get(record.id)?.unsupported.cookieMode).toBe('http-session');
    expect(restarted.get(record.id)?.unsupported.cookieJar).toBe(false);
  });
});
