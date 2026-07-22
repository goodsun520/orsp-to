import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SiteAccessControl } from '../src/orsp/siteAccess.js';

let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe('SiteAccessControl', () => {
  it('stores a unicode passphrase as a salted hash and invalidates sessions when changed', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'orsp-access-'));
    const filePath = path.join(tempDir, 'site-access.json');
    const access = new SiteAccessControl(filePath);
    await access.load();
    await access.setPassphrase('内部学习暗号', 'miloquinn');

    const token = access.unlock('内部学习暗号');
    expect(token).toBeTruthy();
    expect(access.isSessionValid(token!)).toBe(true);
    expect(access.unlock('错误暗号')).toBeNull();

    const restarted = new SiteAccessControl(filePath);
    await restarted.load();
    expect(restarted.isConfigured()).toBe(true);
    expect(restarted.unlock('内部学习暗号')).toBeTruthy();

    await access.setPassphrase('今日暗号-2026', 'miloquinn');
    expect(access.isSessionValid(token!)).toBe(false);
    expect(access.unlock('内部学习暗号')).toBeNull();
    expect(access.unlock('今日暗号-2026')).toBeTruthy();
  });

  it('fails closed when the persisted access configuration is malformed', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'orsp-access-broken-'));
    const filePath = path.join(tempDir, 'site-access.json');
    await writeFile(filePath, '{"version":1,"salt":"missing-fields"}', 'utf8');

    const access = new SiteAccessControl(filePath);
    await expect(access.load()).rejects.toThrow('Failed to load site access configuration');
  });
});
