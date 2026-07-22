import { createHash } from 'node:crypto';
import type { LegadoBookSource } from './types.js';
import { cleanSourceBaseUrl } from './searchUrl.js';

interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  hostOnly: boolean;
  path: string;
  secure: boolean;
  expiresAt?: number;
}

/** In-memory RFC6265 subset for ordinary upstream HTTP sessions. */
export class CookieJar {
  private cookies: StoredCookie[] = [];

  seedFromHeader(url: URL, cookieHeader: string | undefined): void {
    if (!cookieHeader) return;
    for (const part of cookieHeader.split(';')) {
      const separator = part.indexOf('=');
      if (separator <= 0) continue;
      const name = part.slice(0, separator).trim();
      const value = part.slice(separator + 1).trim();
      if (!name) continue;
      this.upsert({
        name,
        value,
        domain: url.hostname.toLowerCase(),
        hostOnly: true,
        path: '/',
        secure: url.protocol === 'https:',
      });
    }
  }

  /** Returns true when at least one stored Cookie changed. */
  absorbSetCookie(url: URL, setCookieHeaders: string[] | string | null | undefined): boolean {
    if (!setCookieHeaders) return false;
    const values = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
    let changed = false;
    for (const line of values) {
      const parts = line.split(';');
      const pair = parts.shift() ?? '';
      const separator = pair.indexOf('=');
      if (separator <= 0) continue;
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      if (!name) continue;

      let domain = url.hostname.toLowerCase();
      let hostOnly = true;
      let path = defaultCookiePath(url.pathname);
      let secure = false;
      let expiresAt: number | undefined;
      for (const rawAttribute of parts) {
        const [rawName, ...rawValue] = rawAttribute.trim().split('=');
        const attribute = rawName.toLowerCase();
        const attributeValue = rawValue.join('=').trim();
        if (attribute === 'domain' && attributeValue) {
          const candidate = attributeValue.toLowerCase().replace(/^\./, '');
          if (!domainMatches(url.hostname, candidate)) continue;
          domain = candidate;
          hostOnly = false;
        } else if (attribute === 'path' && attributeValue.startsWith('/')) {
          path = attributeValue;
        } else if (attribute === 'secure') {
          secure = true;
        } else if (attribute === 'max-age') {
          const seconds = Number(attributeValue);
          if (Number.isFinite(seconds)) expiresAt = Date.now() + seconds * 1000;
        } else if (attribute === 'expires' && expiresAt === undefined) {
          const parsed = Date.parse(attributeValue);
          if (Number.isFinite(parsed)) expiresAt = parsed;
        }
      }

      const keyMatches = (cookie: StoredCookie) =>
        cookie.name === name && cookie.domain === domain && cookie.path === path;
      const previous = this.cookies.find(keyMatches);
      if (expiresAt !== undefined && expiresAt <= Date.now()) {
        const before = this.cookies.length;
        this.cookies = this.cookies.filter((cookie) => !keyMatches(cookie));
        changed ||= this.cookies.length !== before;
        continue;
      }
      const next = { name, value, domain, hostOnly, path, secure, expiresAt };
      if (!previous || JSON.stringify(previous) !== JSON.stringify(next)) changed = true;
      this.upsert(next);
    }
    this.removeExpired();
    return changed;
  }

  cookieHeader(url: URL): string | undefined {
    this.removeExpired();
    const matches = this.cookies
      .filter((cookie) => {
        if (cookie.secure && url.protocol !== 'https:') return false;
        const hostMatches = cookie.hostOnly
          ? url.hostname.toLowerCase() === cookie.domain
          : domainMatches(url.hostname, cookie.domain);
        return hostMatches && pathMatches(url.pathname || '/', cookie.path);
      })
      .sort((left, right) => right.path.length - left.path.length);
    return matches.length > 0
      ? matches.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ')
      : undefined;
  }

  private upsert(next: StoredCookie): void {
    this.cookies = this.cookies.filter(
      (cookie) =>
        !(cookie.name === next.name && cookie.domain === next.domain && cookie.path === next.path),
    );
    this.cookies.push(next);
  }

  private removeExpired(): void {
    const now = Date.now();
    this.cookies = this.cookies.filter((cookie) => cookie.expiresAt === undefined || cookie.expiresAt > now);
  }
}

export function cookieScopeKey(source: LegadoBookSource): string {
  return createHash('sha256')
    .update(cleanSourceBaseUrl(source.bookSourceUrl).replace(/\/+$/, '').toLowerCase())
    .digest('base64url');
}

function domainMatches(hostname: string, domain: string): boolean {
  const host = hostname.toLowerCase();
  const normalized = domain.toLowerCase();
  return host === normalized || host.endsWith(`.${normalized}`);
}

function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || requestPath[cookiePath.length] === '/';
}

function defaultCookiePath(requestPath: string): string {
  if (!requestPath.startsWith('/') || requestPath === '/') return '/';
  const lastSlash = requestPath.lastIndexOf('/');
  return lastSlash <= 0 ? '/' : requestPath.slice(0, lastSlash);
}

const jarsBySource = new Map<string, CookieJar>();

export function jarForSource(sourceKey: string): CookieJar {
  let jar = jarsBySource.get(sourceKey);
  if (!jar) {
    jar = new CookieJar();
    jarsBySource.set(sourceKey, jar);
  }
  return jar;
}
