import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CoverResponseCache } from '../src/orsp/coverCache.js';

const directories: string[] = [];
const image = {
  body: Buffer.from('cached-image'),
  contentType: 'image/png',
};

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('persistent cover cache', () => {
  it('survives a new cache instance without calling the upstream fetcher again', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'orsp-cover-cache-'));
    directories.push(directory);
    const first = new CoverResponseCache(directory);
    expect(await first.getOrFetch('cover-key', undefined, async () => image)).toEqual(image);

    const restarted = new CoverResponseCache(directory);
    let upstreamCalls = 0;
    const cached = await restarted.getOrFetch('cover-key', undefined, async () => {
      upstreamCalls += 1;
      return image;
    });

    expect(cached).toEqual(image);
    expect(upstreamCalls).toBe(0);
  });

  it('removes oldest entries when the configured entry bound is exceeded', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'orsp-cover-cache-bound-'));
    directories.push(directory);
    const cache = new CoverResponseCache(directory, { maxEntries: 1 });
    await cache.getOrFetch('first', undefined, async () => image);
    await waitFor(async () => (await metadataFiles(directory)).length === 1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await cache.getOrFetch('second', undefined, async () => image);
    await waitFor(async () => (await metadataFiles(directory)).length === 1);

    expect(await metadataFiles(directory)).toHaveLength(1);
  });

  it('keeps a shared fetch alive while another subscriber is still waiting', async () => {
    const cache = new CoverResponseCache(null);
    const firstClient = new AbortController();
    const secondClient = new AbortController();
    let upstreamCalls = 0;
    let upstreamAborted = false;
    let releaseUpstream!: () => void;
    const upstreamReady = new Promise<void>((resolve) => {
      releaseUpstream = resolve;
    });
    const fetcher = async (signal: AbortSignal) => {
      upstreamCalls += 1;
      signal.addEventListener('abort', () => {
        upstreamAborted = true;
      });
      await upstreamReady;
      return image;
    };

    const first = cache.getOrFetch('shared-cover', firstClient.signal, fetcher);
    const second = cache.getOrFetch('shared-cover', secondClient.signal, fetcher);
    await waitForValue(() => upstreamCalls === 1);
    firstClient.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    expect(upstreamAborted).toBe(false);

    releaseUpstream();
    await expect(second).resolves.toEqual(image);
    expect(upstreamCalls).toBe(1);
  });

  it('starts a fresh fetch when a new caller arrives during aborted cleanup', async () => {
    const cache = new CoverResponseCache(null);
    const firstClient = new AbortController();
    let upstreamCalls = 0;
    const fetcher = (signal: AbortSignal) => {
      upstreamCalls += 1;
      if (upstreamCalls > 1) return Promise.resolve(image);
      return new Promise<typeof image>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          setTimeout(() => reject(new DOMException('aborted', 'AbortError')), 20);
        });
      });
    };

    const first = cache.getOrFetch('replaced-cover', firstClient.signal, fetcher);
    await waitForValue(() => upstreamCalls === 1);
    firstClient.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });

    const [second, third] = await Promise.all([
      cache.getOrFetch('replaced-cover', undefined, fetcher),
      cache.getOrFetch('replaced-cover', undefined, fetcher),
    ]);
    expect(second).toEqual(image);
    expect(third).toEqual(image);
    expect(upstreamCalls).toBe(2);
  });
});

async function metadataFiles(directory: string): Promise<string[]> {
  return (await readdir(directory)).filter((file) => file.endsWith('.json'));
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for cache cleanup');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForValue(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
