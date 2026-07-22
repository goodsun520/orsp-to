import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/orsp/server.js';
import { SourceRegistry } from '../src/orsp/registry.js';
import { SiteAccessControl } from '../src/orsp/siteAccess.js';
import { IpSecurityStore } from '../src/orsp/ipSecurity.js';
import type { LegadoBookSource } from '../src/legado/types.js';

const source: LegadoBookSource = {
  bookSourceName: '暗号测试源',
  bookSourceUrl: 'https://access.example/',
  searchUrl: '/s?q={{key}}',
  ruleSearch: { bookList: 'class.item' },
  ruleToc: { chapterList: 'class.chapter' },
  ruleContent: { content: 'class.content@text' },
};

let server: Server;
let baseUrl: string;
let access: SiteAccessControl;
let ipSecurity: IpSecurityStore;

beforeEach(async () => {
  const registry = SourceRegistry.ephemeral();
  const added = await registry.add(source);
  await registry.setHealth(added.record.id, {
    checkedAt: '2026-07-22T00:00:00.000Z',
    status: 'parse_passed',
  });
  access = SiteAccessControl.ephemeral();
  ipSecurity = IpSecurityStore.ephemeral();
  await access.setPassphrase('学习交流', 'miloquinn');
  const app = createApp(registry, 'http://app.local', 'admin-password', {}, { siteAccess: access, ipSecurity });
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

async function cookieFrom(response: Response): Promise<string> {
  return response.headers.get('set-cookie')!.split(';', 1)[0];
}

describe('site access API', () => {
  it('requires the current passphrase for website APIs while leaving direct ORSP routes available', async () => {
    const blocked = await fetch(`${baseUrl}/api/sources`);
    expect(blocked.status).toBe(401);
    expect((await blocked.json()).error.code).toBe('ACCESS_REQUIRED');

    const wrong = await fetch(`${baseUrl}/api/access/unlock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passphrase: '不对' }),
    });
    expect(wrong.status).toBe(401);

    const unlocked = await fetch(`${baseUrl}/api/access/unlock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passphrase: '学习交流' }),
    });
    const accessCookie = await cookieFrom(unlocked);
    expect(unlocked.status).toBe(200);
    expect((await fetch(`${baseUrl}/api/sources`, { headers: { Cookie: accessCookie } })).status).toBe(200);
    expect((await fetch(`${baseUrl}/s/access-example/.well-known/open-reading-source.json`)).status).toBe(200);
  });

  it('lets the administrator replace the passphrase and immediately invalidates old access', async () => {
    const oldUnlock = await fetch(`${baseUrl}/api/access/unlock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passphrase: '学习交流' }),
    });
    const oldCookie = await cookieFrom(oldUnlock);
    const login = await fetch(`${baseUrl}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'admin-password' }),
    });
    const adminCookie = await cookieFrom(login);

    const changed = await fetch(`${baseUrl}/api/admin/access`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ passphrase: '新的中文暗号' }),
    });
    expect(changed.status).toBe(200);
    expect((await fetch(`${baseUrl}/api/sources`, { headers: { Cookie: oldCookie } })).status).toBe(401);

    const newUnlock = await fetch(`${baseUrl}/api/access/unlock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passphrase: '新的中文暗号' }),
    });
    expect(newUnlock.status).toBe(200);
  });

  it('records failed authentication IPs and lets an administrator ban and unban them', async () => {
    const attackerIp = '203.0.113.9';
    await fetch(`${baseUrl}/api/access/unlock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': attackerIp },
      body: JSON.stringify({ passphrase: '错误暗号' }),
    });
    expect(ipSecurity.listEvents()[0]).toMatchObject({ ip: attackerIp, type: 'invalid_passphrase' });

    const login = await fetch(`${baseUrl}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'admin-password' }),
    });
    const adminCookie = await cookieFrom(login);
    const banned = await fetch(`${baseUrl}/api/admin/security/bans`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ ip: attackerIp, reason: '重复尝试暗号' }),
    });
    expect(banned.status).toBe(200);
    expect((await fetch(`${baseUrl}/api/access/status`, { headers: { 'X-Forwarded-For': attackerIp } })).status).toBe(403);

    const unbanned = await fetch(`${baseUrl}/api/admin/security/unban`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ ip: attackerIp }),
    });
    expect(unbanned.status).toBe(200);
    expect((await fetch(`${baseUrl}/api/access/status`, { headers: { 'X-Forwarded-For': attackerIp } })).status).toBe(200);
  });
});
