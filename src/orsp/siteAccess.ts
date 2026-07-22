import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import path from 'node:path';

const ACCESS_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const SCRYPT_KEY_LENGTH = 32;
export const SITE_ACCESS_COOKIE = 'orsp_site_access';

interface StoredAccessConfig {
  version: 1;
  salt: string;
  hash: string;
  updatedAt: string;
  updatedBy: string;
}

export class SiteAccessControl {
  private config: StoredAccessConfig | null = null;
  private sessions = new Map<string, number>();

  static ephemeral(): SiteAccessControl {
    return new SiteAccessControl(null);
  }

  constructor(private readonly filePath: string | null) {}

  async load(): Promise<void> {
    if (!this.filePath) return;
    try {
      const value = JSON.parse(await readFile(this.filePath, 'utf8')) as Partial<StoredAccessConfig>;
      if (
        value.version === 1 &&
        typeof value.salt === 'string' &&
        typeof value.hash === 'string' &&
        typeof value.updatedAt === 'string' &&
        typeof value.updatedBy === 'string'
      ) {
        this.config = value as StoredAccessConfig;
        return;
      }
      throw new Error('Site access configuration is malformed.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.config = null;
        return;
      }
      throw new Error('Failed to load site access configuration.', { cause: error });
    }
  }

  isConfigured(): boolean {
    return this.config !== null;
  }

  status(): { configured: boolean; updatedAt?: string; updatedBy?: string } {
    return {
      configured: this.isConfigured(),
      updatedAt: this.config?.updatedAt,
      updatedBy: this.config?.updatedBy,
    };
  }

  unlock(passphrase: string): string | null {
    if (!this.config) return null;
    const normalized = normalizePassphrase(passphrase);
    if (!isValidPassphrase(normalized)) return null;
    const actual = scryptSync(normalized, Buffer.from(this.config.salt, 'base64url'), SCRYPT_KEY_LENGTH);
    const expected = Buffer.from(this.config.hash, 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    const token = randomBytes(24).toString('base64url');
    this.sessions.set(token, Date.now() + ACCESS_SESSION_TTL_MS);
    return token;
  }

  isSessionValid(token: string | undefined): boolean {
    if (!this.config) return true;
    if (!token) return false;
    const expiresAt = this.sessions.get(token);
    if (!expiresAt) return false;
    if (expiresAt < Date.now()) {
      this.sessions.delete(token);
      return false;
    }
    return true;
  }

  async setPassphrase(passphrase: string, actor: string): Promise<void> {
    const normalized = normalizePassphrase(passphrase);
    if (normalized && !isValidPassphrase(normalized)) {
      throw new Error('Passphrase must be at most 128 characters and 512 UTF-8 bytes.');
    }
    if (!normalized) {
      if (this.filePath) await rm(this.filePath, { force: true });
      this.config = null;
      this.sessions.clear();
      return;
    }

    const salt = randomBytes(16);
    const nextConfig: StoredAccessConfig = {
      version: 1,
      salt: salt.toString('base64url'),
      hash: scryptSync(normalized, salt, SCRYPT_KEY_LENGTH).toString('base64url'),
      updatedAt: new Date().toISOString(),
      updatedBy: actor,
    };
    await this.persist(nextConfig);
    this.config = nextConfig;
    this.sessions.clear();
  }

  private async persist(config: StoredAccessConfig): Promise<void> {
    if (!this.filePath) return;
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, JSON.stringify(config, null, 2), 'utf8');
      await rename(temporaryPath, this.filePath);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

function normalizePassphrase(value: string): string {
  return typeof value === 'string' ? value.normalize('NFC').trim() : '';
}

function isValidPassphrase(value: string): boolean {
  return Boolean(value) && Array.from(value).length <= 128 && Buffer.byteLength(value, 'utf8') <= 512;
}

function decodeCookieValue(value: string): string {
  try { return decodeURIComponent(value); } catch { return ''; }
}

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  return Object.fromEntries(
    header.split(';').map((part) => {
      const idx = part.indexOf('=');
      return idx === -1 ? [part.trim(), ''] : [part.slice(0, idx).trim(), decodeCookieValue(part.slice(idx + 1).trim())];
    }),
  );
}

export function readSiteAccessCookie(cookieHeader: string | undefined): string | undefined {
  return parseCookies(cookieHeader)[SITE_ACCESS_COOKIE];
}
