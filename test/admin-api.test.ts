import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/orsp/server.js';
import { SourceRegistry } from '../src/orsp/registry.js';
import { SourceReportStore } from '../src/orsp/sourceReports.js';
import type { LegadoBookSource } from '../src/legado/types.js';

function source(): LegadoBookSource {
  return {
    bookSourceName: '管理员测试源',
    bookSourceUrl: 'https://admin.example/',
    searchUrl: '/s?q={{key}}',
    ruleSearch: { bookList: 'class.item' },
    ruleToc: { chapterList: 'class.chapter' },
    ruleContent: { content: 'class.content@text' },
  };
}

let server: Server;
let baseUrl: string;
let registry: SourceRegistry;
let sourceId: string;
let reports: SourceReportStore;

beforeEach(async () => {
  registry = SourceRegistry.ephemeral();
  const added = await registry.add(source());
  sourceId = added.record.id;
  await registry.setHealth(sourceId, {
    checkedAt: '2026-07-22T00:00:00.000Z',
    status: 'parse_passed',
  });
  reports = SourceReportStore.ephemeral();
  const app = createApp(registry, 'http://app.local', 'test-password', {}, { sourceReports: reports });
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function adminCookie(): Promise<string> {
  const response = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'test-password' }),
  });
  expect(response.status).toBe(200);
  return response.headers.get('set-cookie')!.split(';', 1)[0];
}

describe('admin moderation API', () => {
  it('requires an administrator session for moderation actions', async () => {
    const hidden = await fetch(`${baseUrl}/api/admin/sources/${sourceId}/visibility`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hidden: true }),
    });
    const removed = await fetch(`${baseUrl}/api/admin/sources/${sourceId}`, { method: 'DELETE' });

    expect(hidden.status).toBe(401);
    expect(removed.status).toBe(401);
  });

  it('hides and restores a source without disabling its direct ORSP address', async () => {
    const cookie = await adminCookie();
    const hide = await fetch(`${baseUrl}/api/admin/sources/${sourceId}/visibility`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ hidden: true }),
    });
    expect(hide.status).toBe(200);

    const publicList = await (await fetch(`${baseUrl}/api/sources`)).json();
    expect(publicList.items).toHaveLength(0);
    expect(publicList.summary.sourceCount).toBe(0);
    expect((await fetch(`${baseUrl}/api/sources/${sourceId}`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/s/${sourceId}/.well-known/open-reading-source.json`)).status).toBe(200);

    const adminList = await (await fetch(`${baseUrl}/api/admin/sources`, { headers: { Cookie: cookie } })).json();
    expect(adminList.items[0]).toMatchObject({ id: sourceId, hiddenFromLeaderboard: true });

    const restore = await fetch(`${baseUrl}/api/admin/sources/${sourceId}/visibility`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ hidden: false }),
    });
    expect(restore.status).toBe(200);
    expect((await (await fetch(`${baseUrl}/api/sources`)).json()).items).toHaveLength(1);
  });

  it('permanently deletes a source from the admin namespace', async () => {
    const cookie = await adminCookie();
    const removed = await fetch(`${baseUrl}/api/admin/sources/${sourceId}`, {
      method: 'DELETE',
      headers: { Cookie: cookie },
    });

    expect(removed.status).toBe(204);
    expect((await fetch(`${baseUrl}/api/sources/${sourceId}`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/s/${sourceId}/.well-known/open-reading-source.json`)).status).toBe(404);
  });

  it('shows public reports to the administrator and resolves them by hiding the source', async () => {
    const report = await fetch(`${baseUrl}/api/sources/${sourceId}/reports`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'malicious', details: '疑似恶意跳转' }),
    });
    expect(report.status).toBe(201);

    const duplicate = await fetch(`${baseUrl}/api/sources/${sourceId}/reports`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'malicious', details: '重复提交' }),
    });
    expect(duplicate.status).toBe(200);
    expect((await duplicate.json()).alreadyReported).toBe(true);

    const cookie = await adminCookie();
    const queue = await (await fetch(`${baseUrl}/api/admin/reports`, { headers: { Cookie: cookie } })).json();
    expect(queue.items).toHaveLength(1);
    expect(queue.items[0]).toMatchObject({ sourceId, status: 'open', reason: 'malicious' });

    const resolved = await fetch(`${baseUrl}/api/admin/reports/${queue.items[0].id}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ action: 'hide' }),
    });
    expect(resolved.status).toBe(200);
    expect((await (await fetch(`${baseUrl}/api/sources`)).json()).items).toHaveLength(0);
    expect(reports.get(queue.items[0].id)).toMatchObject({ status: 'hidden', resolvedBy: 'local-admin' });
  });
});
