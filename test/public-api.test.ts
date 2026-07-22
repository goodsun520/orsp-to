import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/orsp/server.js';
import { SourceRegistry } from '../src/orsp/registry.js';
import { converterTermsVersion } from '../src/orsp/protocol.js';
import type { LegadoBookSource } from '../src/legado/types.js';

const conversionConsent = {
  acceptedTerms: true,
  rightsConfirmed: true,
  termsVersion: converterTermsVersion,
};

function source(url: string, name = '公开API测试源'): LegadoBookSource {
  return {
    bookSourceName: name,
    bookSourceUrl: url,
    searchUrl: '/s?q={{key}}',
    ruleSearch: { bookList: 'class.item', name: 'text', bookUrl: 'href' },
    ruleToc: { chapterList: 'class.c', chapterName: 'text', chapterUrl: 'href' },
    ruleContent: { content: 'class.content@text' },
  };
}

let appBaseUrl: string;
let dataDir: string;
let server: Server;
let registry: SourceRegistry;

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'orsp-public-'));
  registry = new SourceRegistry(dataDir);
  await registry.load();
  const app = createApp(registry, 'http://app.local');
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      appBaseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dataDir, { recursive: true, force: true });
});

describe('public convert + leaderboard API', () => {
  it('requires current terms acceptance and a lawful-access confirmation', async () => {
    const response = await fetch(`${appBaseUrl}/api/convert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: source('https://consent-required.example/') }),
    });
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error).toMatchObject({ code: 'TERMS_NOT_ACCEPTED', retryable: false });

    const outdated = await fetch(`${appBaseUrl}/api/convert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: source('https://outdated-terms.example/'),
        ...conversionConsent,
        termsVersion: 'outdated',
      }),
    });
    expect(outdated.status).toBe(403);
  });

  it('rejects a source that cannot pass a live reading audit', async () => {
    const payload = source('https://public-api.example/');
    const first = await fetch(`${appBaseUrl}/api/convert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: payload, ...conversionConsent }),
    });
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody.converted).toHaveLength(0);
    expect(firstBody.errors).toHaveLength(1);
    expect(firstBody.errors[0]).toContain('conversion failed at search');

    const list = await fetch(`${appBaseUrl}/api/sources?sort=usage`);
    const listBody = await list.json();
    expect(listBody.summary.sourceCount).toBe(0);
    expect(Array.isArray(listBody.items)).toBe(true);
    expect(listBody.summary).toMatchObject({ totalReads: 0, recentUniqueReaders: 0 });
  });

  it('rejects non-text Legado source types instead of publishing invalid text endpoints', async () => {
    const payload = { ...source('https://unsupported-type.example/'), bookSourceType: 2 };
    const response = await fetch(`${appBaseUrl}/api/convert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: payload, ...conversionConsent }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.converted).toHaveLength(0);
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0]).toContain('bookSourceType 0');
  });

  it('observes audit health changes without a service restart', async () => {
    const { record } = await registry.add(source('https://health-public.example/'));
    await registry.setHealth(record.id, {
      checkedAt: '2026-07-22T00:00:00.000Z',
      status: 'parse_passed',
    });
    const auditor = new SourceRegistry(dataDir);
    await auditor.load();
    await auditor.setHealthFromAudit(record.id, {
      checkedAt: '2026-07-22T01:00:00.000Z',
      status: 'parse_failed',
      stage: 'detail',
      reason: 'BOOK_NOT_FOUND',
    });
    await registry.reloadHealthFromDisk(0);

    const response = await fetch(`${appBaseUrl}/api/sources`);
    const body = await response.json();
    expect(body.items.find((item: { id: string }) => item.id === record.id)).toBeUndefined();
  });
});
