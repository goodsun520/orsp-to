import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { IpSecurityStore } from '../src/orsp/ipSecurity.js';

let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe('IpSecurityStore', () => {
  it('persists security events and administrator-managed IP bans', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'orsp-ip-security-'));
    const filePath = path.join(tempDir, 'ip-security.json');
    const security = new IpSecurityStore(filePath);
    await security.load();

    await security.recordEvent('203.0.113.9', 'invalid_passphrase', '暗号错误');
    await security.ban('203.0.113.9', 'miloquinn', '重复攻击');
    expect(security.isBanned('203.0.113.9')).toBe(true);

    const restarted = new IpSecurityStore(filePath);
    await restarted.load();
    expect(restarted.listEvents()[0]).toMatchObject({ ip: '203.0.113.9', type: 'invalid_passphrase' });
    expect(restarted.listBans()[0]).toMatchObject({ ip: '203.0.113.9', bannedBy: 'miloquinn' });

    expect(await restarted.unban('203.0.113.9')).toBe(true);
    expect(restarted.isBanned('203.0.113.9')).toBe(false);
  });
});
