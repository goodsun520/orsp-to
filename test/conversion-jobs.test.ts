import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ConversionJobError,
  ConversionJobManager,
  ConversionJobSkippedError,
  conversionJobLimits,
} from '../src/orsp/conversionJobs.js';
import { converterTermsVersion } from '../src/orsp/protocol.js';
import { SourceRegistry } from '../src/orsp/registry.js';
import { createApp } from '../src/orsp/server.js';

async function waitFor<T>(read: () => T, done: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for conversion job.');
}

describe('ConversionJobManager', () => {
  it('processes every item independently with at most four active workers', async () => {
    let active = 0;
    let maxActive = 0;
    const manager = new ConversionJobManager<number>(async (input) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      if (input === 'bad') throw new Error('bad source');
      return Number(input) * 2;
    });

    const created = manager.create('owner', 4);
    const second = manager.create('second-owner', 4);
    manager.append(created.jobId, 'owner', [1, 2, 'bad', 4]);
    manager.append(second.jobId, 'second-owner', [5, 6, 7, 8]);
    manager.seal(created.jobId, 'owner');
    manager.seal(second.jobId, 'second-owner');
    const completed = await waitFor(
      () => manager.get(created.jobId, 'owner'),
      (job) => job.status === 'completed',
    );
    const secondCompleted = await waitFor(
      () => manager.get(second.jobId, 'second-owner'),
      (job) => job.status === 'completed',
    );

    expect(maxActive).toBe(conversionJobLimits.concurrency);
    expect(completed.progress).toMatchObject({ total: 4, succeeded: 3, failed: 1, completed: 4 });
    expect(secondCompleted.progress).toMatchObject({ total: 4, succeeded: 4, failed: 0, completed: 4 });
    expect(completed.items[0]).toMatchObject({ index: 0, status: 'succeeded', result: 2 });
    expect(completed.items[2]).toMatchObject({ index: 2, status: 'failed', error: 'bad source' });
  });

  it('retains a safe source name for per-item reporting', async () => {
    const manager = new ConversionJobManager(async () => {
      throw new Error('cannot convert');
    });
    const created = manager.create('owner', 1);
    manager.append(created.jobId, 'owner', [{ bookSourceName: '失败书源' }]);
    manager.seal(created.jobId, 'owner');
    const completed = await waitFor(
      () => manager.get(created.jobId, 'owner'),
      (job) => job.status === 'completed',
    );

    expect(completed.items[0]).toMatchObject({ index: 0, sourceName: '失败书源', status: 'failed' });
  });

  it('retries only failed items and preserves a safe display name', async () => {
    let attempts = 0;
    const manager = new ConversionJobManager(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('temporary failure');
      return 'converted';
    });
    const created = manager.create('owner', 1);
    manager.append(created.jobId, 'owner', [{ bookSourceName: `  ${'书'.repeat(250)}  ` }]);
    manager.seal(created.jobId, 'owner');
    const failed = await waitFor(
      () => manager.get(created.jobId, 'owner'),
      (job) => job.status === 'completed',
    );
    expect(failed.items[0]).toMatchObject({ status: 'failed', sourceName: '书'.repeat(200) });

    manager.retry(created.jobId, 'owner');
    const succeeded = await waitFor(
      () => manager.get(created.jobId, 'owner'),
      (job) => job.status === 'completed',
    );
    expect(succeeded.items[0]).toMatchObject({ status: 'succeeded', result: 'converted' });
    expect(succeeded.items[0]).not.toHaveProperty('error');
  });

  it('counts deterministic incompatibilities as skipped and never retries them', async () => {
    let failedAttempts = 0;
    const manager = new ConversionJobManager(async (input) => {
      if (input === 'skip') throw new ConversionJobSkippedError('missing required content rule');
      failedAttempts += 1;
      if (failedAttempts === 1) throw new Error('temporary audit failure');
      return 'converted';
    });
    const created = manager.create('owner', 2);
    manager.append(created.jobId, 'owner', ['skip', 'fail']);
    manager.seal(created.jobId, 'owner');

    const completed = await waitFor(
      () => manager.get(created.jobId, 'owner'),
      (job) => job.status === 'completed',
    );
    expect(completed.progress).toMatchObject({ skipped: 1, failed: 1, completed: 2, retainedInputBytes: 6 });
    expect(completed.items[0]).toMatchObject({ status: 'skipped', error: 'missing required content rule' });

    manager.retry(created.jobId, 'owner');
    const retried = await waitFor(
      () => manager.get(created.jobId, 'owner'),
      (job) => job.status === 'completed',
    );
    expect(retried.progress).toMatchObject({ succeeded: 1, skipped: 1, failed: 0, completed: 2 });
    expect(retried.items[0]).toMatchObject({ status: 'skipped' });
    expect(failedAttempts).toBe(2);
  });

  it('expires completed jobs and never evicts active jobs for capacity', async () => {
    let now = 0;
    const expiring = new ConversionJobManager(async (input) => input, {
      now: () => now,
      openRetentionMs: 10,
      completedRetentionMs: 10,
    });
    const abandoned = expiring.create('owner', 1);
    const old = expiring.create('owner', 1);
    expiring.append(old.jobId, 'owner', [{}]);
    expiring.seal(old.jobId, 'owner');
    await waitFor(() => expiring.get(old.jobId, 'owner'), (job) => job.status === 'completed');
    now = 11;
    expect(() => expiring.get(old.jobId, 'owner')).toThrow(/Unknown conversion job/);
    expect(() => expiring.get(abandoned.jobId, 'owner')).toThrow(/Unknown conversion job/);

    const bounded = new ConversionJobManager(async (input) => input, { maxJobs: 2 });
    const first = bounded.create('owner-a', 1);
    const second = bounded.create('owner-b', 1);
    expect(() => bounded.create('owner-c', 1)).toThrow(/queue is full/);
    expect(bounded.get(first.jobId, 'owner-a').status).toBe('open');
    expect(bounded.get(second.jobId, 'owner-b').status).toBe('open');
  });

  it('cancels abandoned uploads and stops scheduling work after the execution deadline', async () => {
    let now = 0;
    const resolvers: Array<() => void> = [];
    const manager = new ConversionJobManager(
      async () => new Promise<string>((resolve) => resolvers.push(() => resolve('ok'))),
      { now: () => now },
    );

    const abandoned = manager.create('owner', 1);
    manager.append(abandoned.jobId, 'owner', [{ bookSourceName: '未完成上传' }]);
    const cancelled = manager.cancel(abandoned.jobId, 'owner');
    expect(cancelled).toMatchObject({ status: 'cancelled', progress: { failed: 1, retainedInputBytes: 0 } });

    const running = manager.create('owner', 3);
    manager.append(running.jobId, 'owner', [{}, {}, {}]);
    manager.seal(running.jobId, 'owner');
    expect(manager.get(running.jobId, 'owner').progress).toMatchObject({ running: 2, queued: 1 });
    now = conversionJobLimits.maxRuntimeMs + 1;
    expect(manager.get(running.jobId, 'owner').progress).toMatchObject({ running: 2, queued: 0, failed: 1 });
    resolvers.splice(0).forEach((resolve) => resolve());
    const completed = await waitFor(
      () => manager.get(running.jobId, 'owner'),
      (job) => job.status === 'completed',
    );
    expect(completed.progress).toMatchObject({ succeeded: 2, failed: 1, completed: 3 });
  });

  it('enforces ownership, chunk size, total size, and sealing', () => {
    const manager = new ConversionJobManager(async (input) => input);
    const incomplete = manager.create('owner', 2);
    manager.append(incomplete.jobId, 'owner', [{}]);
    expect(() => manager.seal(incomplete.jobId, 'owner')).toThrow(/expects 2 items but has 1/);

    const created = manager.create('owner', conversionJobLimits.maxItems);
    expect(() => manager.get(created.jobId, 'different-owner')).toThrowError(ConversionJobError);
    expect(() => manager.append(created.jobId, 'owner', [])).toThrow(/between 1 and 50/);
    expect(() => manager.append(created.jobId, 'owner', Array(51).fill({}))).toThrow(/between 1 and 50/);

    for (let offset = 0; offset < conversionJobLimits.maxItems; offset += conversionJobLimits.maxChunkSize) {
      manager.append(created.jobId, 'owner', Array(conversionJobLimits.maxChunkSize).fill({}));
    }
    expect(() => manager.append(created.jobId, 'owner', [{}])).toThrow(
      new RegExp(`expects exactly ${conversionJobLimits.maxItems}`),
    );
    manager.seal(created.jobId, 'owner');
    expect(() => manager.append(created.jobId, 'owner', [{}])).toThrow(/no longer accepts chunks/);

    const quotas = new ConversionJobManager(async (input) => input);
    const oversized = quotas.create('large-owner', 1);
    expect(() => quotas.append(oversized.jobId, 'large-owner', [{ blob: 'x'.repeat(600_000) }])).toThrow(
      new RegExp(`at most ${conversionJobLimits.maxItemBytes} bytes`),
    );
    const oversizedChunk = quotas.create('chunk-owner', 5);
    expect(() =>
      quotas.append(
        oversizedChunk.jobId,
        'chunk-owner',
        Array.from({ length: 5 }, () => ({ blob: 'x'.repeat(220_000) })),
      ),
    ).toThrow(/chunk must be at most 1048576 bytes/);
  });
});

describe('conversion job API', () => {
  let baseUrl: string;
  let dataDir: string;
  let server: Server;

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'orsp-conversion-jobs-'));
    const registry = new SourceRegistry(dataDir);
    await registry.load();
    const app = createApp(registry, 'http://app.local');
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dataDir, { recursive: true, force: true });
  });

  it('creates, fills, seals, and reports an IP-bound job', async () => {
    const ownerHeaders = { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.10' };
    const spoofedOwnerHeaders = {
      'Content-Type': 'application/json',
      'X-Forwarded-For': '203.0.113.99, 198.51.100.10',
    };
    const invalidTotal = await fetch(`${baseUrl}/api/conversion-jobs`, {
      method: 'POST',
      headers: spoofedOwnerHeaders,
      body: JSON.stringify({
        acceptedTerms: true,
        rightsConfirmed: true,
        termsVersion: converterTermsVersion,
        expectedTotal: 0,
      }),
    });
    expect(invalidTotal.status).toBe(400);

    const createdResponse = await fetch(`${baseUrl}/api/conversion-jobs`, {
      method: 'POST',
      headers: spoofedOwnerHeaders,
      body: JSON.stringify({
        acceptedTerms: true,
        rightsConfirmed: true,
        termsVersion: converterTermsVersion,
        expectedTotal: 3,
      }),
    });
    const created = await createdResponse.json();
    expect(createdResponse.status).toBe(201);
    expect(createdResponse.headers.get('cache-control')).toBe('no-store');
    expect(created.jobId).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(created.limits).toEqual(conversionJobLimits);
    expect(created.progress).toMatchObject({ expectedTotal: 3, total: 0 });

    const hidden = await fetch(`${baseUrl}/api/conversion-jobs/${created.jobId}`, {
      headers: { 'X-Forwarded-For': '198.51.100.11' },
    });
    expect(hidden.status).toBe(404);

    const appended = await fetch(`${baseUrl}/api/conversion-jobs/${created.jobId}/chunks`, {
      method: 'POST',
      headers: ownerHeaders,
      body: JSON.stringify({
        sources: [
          { bookSourceName: 'missing fields', bookSourceUrl: 'https://example.com' },
          {
            bookSourceName: 'browser-only',
            bookSourceUrl: 'https://example.com',
            searchUrl: '/search?q={{key}}',
            ruleSearch: { bookList: '.book' },
            ruleToc: { chapterList: '.chapter' },
            ruleContent: { content: '.content' },
            startBrowserAwait: 'Cloudflare challenge',
          },
          null,
        ],
      }),
    });
    expect(appended.status).toBe(200);
    expect((await appended.json()).progress.total).toBe(3);

    const sealed = await fetch(`${baseUrl}/api/conversion-jobs/${created.jobId}/seal`, {
      method: 'POST',
      headers: ownerHeaders,
    });
    expect(sealed.status).toBe(202);

    let job: any;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const response = await fetch(`${baseUrl}/api/conversion-jobs/${created.jobId}`, { headers: ownerHeaders });
      job = await response.json();
      if (job.status === 'completed') break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(job.status).toBe('completed');
    expect(job.progress).toMatchObject({ total: 3, skipped: 2, failed: 1, completed: 3 });
    expect(job.items[0]).toMatchObject({ index: 0, status: 'skipped' });
    expect(job.items[0].sourceName).toBe('missing fields');
    expect(job.items[0].error).toContain('missing searchUrl/ruleSearch.bookList');
    expect(job.items[1]).toMatchObject({ sourceName: 'browser-only', status: 'skipped' });
    expect(job.items[1].error).toContain('browser_cookie_unsupported');

    const retried = await fetch(`${baseUrl}/api/conversion-jobs/${created.jobId}/retry`, {
      method: 'POST',
      headers: ownerHeaders,
    });
    expect(retried.status).toBe(202);
    expect(['running', 'completed']).toContain((await retried.json()).status);

    const lateChunk = await fetch(`${baseUrl}/api/conversion-jobs/${created.jobId}/chunks`, {
      method: 'POST',
      headers: ownerHeaders,
      body: JSON.stringify({ sources: [{}] }),
    });
    expect(lateChunk.status).toBe(409);
  });
});
