import { describe, expect, it } from 'vitest';
import { CatalogCache } from '../src/orsp/catalogCache.js';

describe('CatalogCache', () => {
  it('shares an upstream catalog between sequential and concurrent readers', async () => {
    const cache = new CatalogCache();
    let calls = 0;
    const load = async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return [{ title: '第一章', url: 'https://example.com/chapter/1', order: 0 }];
    };

    const [first, second] = await Promise.all([
      cache.getOrLoad('source:book', load),
      cache.getOrLoad('source:book', load),
    ]);
    const third = await cache.getOrLoad('source:book', load);

    expect(calls).toBe(1);
    expect(first).toEqual(second);
    expect(third).toEqual(first);
  });

  it('keeps an actively read catalog alive past its original expiry', async () => {
    let now = 0;
    let calls = 0;
    const cache = new CatalogCache(100, () => now);
    const load = async () => {
      calls += 1;
      return [{ title: '第一章', url: 'https://example.com/chapter/1', order: 0 }];
    };

    await cache.getOrLoad('source:book', load);
    now = 90;
    await cache.getOrLoad('source:book', load);
    now = 150;
    await cache.getOrLoad('source:book', load);

    expect(calls).toBe(1);
  });

  it('evicts the least recently used catalog instead of an active download', async () => {
    const cache = new CatalogCache(1_000, () => 0);
    const calls = new Map<string, number>();
    const load = (key: string) => async () => {
      calls.set(key, (calls.get(key) ?? 0) + 1);
      return [{ title: key, url: `https://example.com/${key}`, order: 0 }];
    };

    for (let index = 0; index < 16; index += 1) {
      const key = `book-${index}`;
      await cache.getOrLoad(key, load(key));
    }
    await cache.getOrLoad('book-0', load('book-0'));
    await cache.getOrLoad('book-16', load('book-16'));
    await cache.getOrLoad('book-0', load('book-0'));
    await cache.getOrLoad('book-1', load('book-1'));

    expect(calls.get('book-0')).toBe(1);
    expect(calls.get('book-1')).toBe(2);
  });
});
