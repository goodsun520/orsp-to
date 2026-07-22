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
});
