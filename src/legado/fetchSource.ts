import dns from 'node:dns/promises';
import net from 'node:net';
import iconv from 'iconv-lite';
import {
  Agent,
  fetch as undiciFetch,
  type Dispatcher,
  type RequestInit as UndiciRequestInit,
} from 'undici';
import type { CookieJar } from './cookieJar.js';

// Novel sites often ship incomplete cert chains; this adapter is intentionally a
// scraper, so we tolerate bad TLS. Only used for upstream page fetches.
const SCRAPE_TLS = { rejectUnauthorized: false } as const;

// Production fetches are deliberately direct. The former Hong Kong relay was
// removed after direct end-to-end audits showed no parsing benefit.
const scrapeDispatcher = new Agent({ connect: SCRAPE_TLS });
const coverDispatchers = new Map<string, Agent>();
const DEFAULT_COVER_CONNECTIONS_PER_ORIGIN = 6;

export class UnsafeTargetError extends Error {}

// Link-local only (incl. cloud metadata 169.254.169.254) + multicast +
// unspecified. Loopback and RFC1918 private ranges remain legal for ordinary
// source parsing; the public cover proxy applies the stricter ranges below.
const BLOCKED_V4_RANGES: Array<[string, number]> = [
  ['169.254.0.0', 16],
  ['224.0.0.0', 4],
];

const PRIVATE_V4_RANGES: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

function ipToInt(ip: string): number {
  return ip.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

function isBlockedIpv4(ip: string): boolean {
  if (ip === '0.0.0.0') return true;
  const value = ipToInt(ip);
  return BLOCKED_V4_RANGES.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (value & mask) === (ipToInt(base) & mask);
  });
}

function isBlockedIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  return lower === '::' || lower.startsWith('fe80:') || lower.startsWith('ff');
}

function isPrivateIpv4(ip: string): boolean {
  const value = ipToInt(ip);
  return PRIVATE_V4_RANGES.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (value & mask) === (ipToInt(base) & mask);
  });
}

function isPrivateIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::1' || isBlockedIpv6(lower) || lower.startsWith('fc') || lower.startsWith('fd')) return true;
  if (lower.startsWith('::ffff:')) {
    const mapped = lower.slice('::ffff:'.length);
    return net.isIPv4(mapped) && isPrivateIpv4(mapped);
  }
  return false;
}

/**
 * Mirrors `BookSourceClient.ensureSafeTarget` in the Flutter client
 * (lib/book_sources/services/book_source_client.dart): reject link-local
 * (incl. the cloud metadata endpoint 169.254.169.254), multicast, and
 * unspecified (0.0.0.0 / ::) targets before this server makes an outbound
 * request on a user's behalf. Loopback and private-network addresses are
 * deliberately left legal, matching the client's own comment: local test
 * sources and self-hosted intranet sources are a supported use case, not
 * something to block.
 */
export async function ensureSafeTarget(url: URL): Promise<void> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UnsafeTargetError(`Unsupported protocol: ${url.protocol}`);
  }
  const host = url.hostname;
  if (net.isIP(host) === 4 && isBlockedIpv4(host)) {
    throw new UnsafeTargetError(`Blocked target address: ${host}`);
  }
  if (net.isIP(host) === 6 && isBlockedIpv6(host)) {
    throw new UnsafeTargetError(`Blocked target address: ${host}`);
  }
  if (net.isIP(host) === 0) {
    // Hostname — resolve and check every address DNS returns.
    const records = await dns.lookup(host, { all: true }).catch(() => []);
    for (const record of records) {
      if (record.family === 4 && isBlockedIpv4(record.address)) {
        throw new UnsafeTargetError(`Blocked target address: ${host} -> ${record.address}`);
      }
      if (record.family === 6 && isBlockedIpv6(record.address)) {
        throw new UnsafeTargetError(`Blocked target address: ${host} -> ${record.address}`);
      }
    }
  }
}

/** Strict SSRF boundary for public proxy endpoints. Unlike source parsing,
 * public proxies must never be able to reach the host's local/private network. */
export async function ensurePublicTarget(url: URL): Promise<void> {
  await resolvePublicTarget(url);
}

async function resolvePublicTarget(url: URL): Promise<ResolvedAddress[]> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UnsafeTargetError('Cover target must use HTTP(S)');
  }
  // Node retains brackets in URL.hostname for IPv6 literals (e.g. [::1]).
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw new UnsafeTargetError('Cover target is not publicly routable');
  }

  const directFamily = net.isIP(host);
  if (directFamily === 4 && isPrivateIpv4(host)) {
    throw new UnsafeTargetError('Cover target is not publicly routable');
  }
  if (directFamily === 6 && isPrivateIpv6(host)) {
    throw new UnsafeTargetError('Cover target is not publicly routable');
  }
  if (directFamily === 4 || directFamily === 6) {
    return [{ address: host, family: directFamily }];
  }
  if (directFamily === 0) {
    return resolvePublicHost(host);
  }
  throw new UnsafeTargetError('Cover target is not publicly routable');
}

async function resolvePublicHost(host: string, family: 0 | 4 | 6 = 0): Promise<ResolvedAddress[]> {
  const records = await dns.lookup(host, { all: true, family }).catch(() => []);
  if (records.length === 0) throw new UnsafeTargetError('Cover target could not be resolved');
  for (const record of records) {
    if (
      (record.family === 4 && isPrivateIpv4(record.address)) ||
      (record.family === 6 && isPrivateIpv6(record.address))
    ) {
      throw new UnsafeTargetError('Cover target is not publicly routable');
    }
  }
  return records.map((record) => ({ address: record.address, family: record.family as 4 | 6 }));
}

/** Parses Legado's loose `{'Key':'Value'}` header string into a plain object. */
export function parseLegadoHeaders(header?: string): Record<string, string> {
  if (!header) return {};
  try {
    const jsonish = header.replace(/'/g, '"');
    const parsed = JSON.parse(jsonish);
    if (parsed && typeof parsed === 'object') {
      return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v)]));
    }
  } catch {
    // Fall through to default headers below.
  }
  return {};
}

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export interface FetchOptions {
  baseUrl: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  method?: 'GET' | 'POST' | 'PUT';
  /** Already-templated body string (not yet charset-encoded). */
  body?: string;
  /** e.g. gbk / gb2312 / utf-8 — used for request body encoding and response decode. */
  charset?: string;
  cookieJar?: CookieJar;
}

/** Upstream site is unreachable/misbehaving (network error, timeout, non-2xx,
 * redirect loop) — distinct from a bug in this server, so callers can map it
 * to a retryable 503 instead of 500. */
export class UpstreamFetchError extends Error {}

export class UpstreamPayloadTooLargeError extends Error {}
export class UpstreamInvalidContentError extends Error {}

export interface FetchImageOptions {
  allowedOrigin: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxBytes?: number;
  cookieJar?: CookieJar;
  signal?: AbortSignal;
  maxConnectionsPerOrigin?: number;
  /** Test-only escape hatch for a hand-authored loopback fixture server. */
  allowPrivateAddressesForTesting?: boolean;
}

export interface FetchedImage {
  body: Buffer;
  contentType: string;
  etag?: string;
  lastModified?: string;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_IMAGE_REDIRECTS = 5;
const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** Fetches a same-origin image with bounded streaming and per-hop SSRF checks. */
export async function fetchImage(url: URL, options: FetchImageOptions): Promise<FetchedImage> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  const abortFromCaller = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abortFromCaller();
  else options.signal?.addEventListener('abort', abortFromCaller, { once: true });
  const allowedOrigin = new URL(options.allowedOrigin).origin;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_IMAGE_BYTES;
  let current = url;

  try {
    for (let redirectCount = 0; redirectCount <= MAX_IMAGE_REDIRECTS; redirectCount++) {
      if (current.origin !== allowedOrigin) {
        throw new UnsafeTargetError('Cover redirect left the source origin');
      }
      if (!options.allowPrivateAddressesForTesting) await ensurePublicTarget(current);
      const requestDispatcher = coverDispatcher(
        options.allowPrivateAddressesForTesting === true,
        options.maxConnectionsPerOrigin,
      );

      const headers = safeProxyRequestHeaders(options.headers);
      if (options.cookieJar) {
        const cookie = options.cookieJar.cookieHeader(current);
        if (cookie) headers.Cookie = cookie;
      }

      let response: Response;
      try {
        response = (await undiciFetch(current, {
          method: 'GET',
          headers,
          signal: controller.signal,
          redirect: 'manual',
          dispatcher: requestDispatcher,
        })) as unknown as Response;
      } catch (error) {
        throw new UpstreamFetchError('Cover upstream request failed', { cause: error });
      }

      absorbResponseCookies(response, current, options.cookieJar);
      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location || redirectCount === MAX_IMAGE_REDIRECTS) {
          throw new UpstreamFetchError('Cover upstream redirect failed');
        }
        current = new URL(location, current);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new UpstreamFetchError('Cover upstream returned an error');
      }

      const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() ?? '';
      if (!contentType.startsWith('image/')) {
        await response.body?.cancel();
        throw new UpstreamInvalidContentError('Cover upstream did not return an image');
      }
      const contentLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        await response.body?.cancel();
        throw new UpstreamPayloadTooLargeError('Cover image exceeds the response limit');
      }

      const body = await readLimitedBody(response, maxBytes);
      if (!looksLikeRasterImage(body)) {
        throw new UpstreamInvalidContentError('Cover upstream returned invalid image bytes');
      }
      return {
        body,
        contentType,
        etag: response.headers.get('etag') ?? undefined,
        lastModified: response.headers.get('last-modified') ?? undefined,
      };
    }
    throw new UpstreamFetchError('Cover upstream redirect failed');
  } catch (error) {
    if (
      error instanceof UnsafeTargetError ||
      error instanceof UpstreamPayloadTooLargeError ||
      error instanceof UpstreamInvalidContentError ||
      error instanceof UpstreamFetchError
    ) {
      throw error;
    }
    throw new UpstreamFetchError('Cover upstream request failed', { cause: error });
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abortFromCaller);
  }
}

function coverDispatcher(allowPrivateAddressesForTesting: boolean, requestedConnections?: number): Dispatcher {
  const connections = requestedConnections !== undefined && Number.isInteger(requestedConnections) && requestedConnections > 0
    ? Math.min(requestedConnections, 32)
    : DEFAULT_COVER_CONNECTIONS_PER_ORIGIN;
  const key = `${allowPrivateAddressesForTesting ? 'test' : 'public'}:${connections}`;
  const existing = coverDispatchers.get(key);
  if (existing) return existing;

  const lookup = allowPrivateAddressesForTesting ? undefined : publicLookup;
  const dispatcher = new Agent({
    connections,
    pipelining: 1,
    keepAliveTimeout: 15_000,
    keepAliveMaxTimeout: 60_000,
    connect: { ...SCRAPE_TLS, ...(lookup ? { lookup } : {}) },
  });
  coverDispatchers.set(key, dispatcher);
  return dispatcher;
}

const publicLookup: net.LookupFunction = (hostname, rawOptions, callback) => {
  const options = typeof rawOptions === 'number' ? { family: rawOptions } : rawOptions;
  const requestedFamily = options.family === 4 || options.family === 6 ? options.family : 0;
  void resolvePublicHost(hostname, requestedFamily).then(
    (addresses) => {
      if (options.all) {
        callback(null, addresses);
        return;
      }
      const selected = addresses[0];
      callback(null, selected.address, selected.family);
    },
    (error: unknown) => callback(error as NodeJS.ErrnoException, '', 0),
  );
};

function looksLikeRasterImage(body: Buffer): boolean {
  if (body.length >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) return true;
  if (
    body.length >= 8 &&
    body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return true;
  }
  if (body.length >= 6) {
    const signature = body.subarray(0, 6).toString('ascii');
    if (signature === 'GIF87a' || signature === 'GIF89a') return true;
  }
  if (
    body.length >= 12 &&
    body.subarray(0, 4).toString('ascii') === 'RIFF' &&
    body.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return true;
  }
  return (
    body.length >= 12 &&
    body.subarray(4, 8).toString('ascii') === 'ftyp' &&
    /avif|avis/.test(body.subarray(8, 12).toString('ascii'))
  );
}

function safeProxyRequestHeaders(input: Record<string, string> = {}): Record<string, string> {
  const blocked = new Set(['host', 'content-length', 'connection', 'transfer-encoding', 'accept-encoding']);
  const headers = Object.fromEntries(Object.entries(input).filter(([name]) => !blocked.has(name.toLowerCase())));
  return {
    'User-Agent': DEFAULT_USER_AGENT,
    ...headers,
    Accept: 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8,*/*;q=0.1',
  };
}

function absorbResponseCookies(response: Response, url: URL, cookieJar?: CookieJar): boolean {
  if (!cookieJar) return false;
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const setCookies =
    typeof headers.getSetCookie === 'function'
      ? headers.getSetCookie()
      : response.headers.get('set-cookie')
        ? [response.headers.get('set-cookie')!]
        : [];
  return cookieJar.absorbSetCookie(url, setCookies);
}

async function readLimitedBody(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new UpstreamPayloadTooLargeError('Cover image exceeds the response limit');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

export async function fetchPage(path: string, options: FetchOptions): Promise<{ url: string; html: string }> {
  const url = new URL(path, options.baseUrl);
  await ensureSafeTarget(url);

  const method = options.method ?? 'GET';
  const headers: Record<string, string> = {
    'User-Agent': DEFAULT_USER_AGENT,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    ...options.headers,
  };

  if ((headers.Cookie || headers.cookie) && options.cookieJar) {
    options.cookieJar.seedFromHeader(url, headers.Cookie || headers.cookie);
    delete headers.Cookie;
    delete headers.cookie;
  }

  let body: Buffer | string | undefined;
  if (method !== 'GET' && options.body !== undefined) {
    const charset = (options.charset || 'utf-8').toLowerCase();
    if (charset === 'utf-8' || charset === 'utf8') {
      body = options.body;
      headers['Content-Type'] ??= 'application/x-www-form-urlencoded; charset=UTF-8';
    } else {
      // gbk / gb2312 common on old Chinese novel sites
      const encoding = charset === 'gb2312' ? 'gbk' : charset;
      body = iconv.encode(options.body, encoding);
      headers['Content-Type'] ??= `application/x-www-form-urlencoded; charset=${charset}`;
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 15000);
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const requestHeaders = { ...headers };
      const requestCookie = options.cookieJar?.cookieHeader(url);
      if (requestCookie) requestHeaders.Cookie = requestCookie;

      let response: Response;
      try {
        const init: UndiciRequestInit = {
          method,
          headers: requestHeaders,
          body: body instanceof Buffer ? new Uint8Array(body) : body,
          signal: controller.signal,
          redirect: 'follow',
          dispatcher: scrapeDispatcher,
        };
        response = (await undiciFetch(url, init)) as unknown as Response;
      } catch (err) {
        throw new UpstreamFetchError(`Failed to reach ${url.origin}`, { cause: err });
      }

      const finalUrl = new URL(response.url || url.toString());
      const cookieChanged = absorbResponseCookies(response, finalUrl, options.cookieJar);
      const buf = Buffer.from(await response.arrayBuffer());
      const html = decodeBody(buf, response.headers.get('content-type'), options.charset);

      const retryableSessionGate =
        attempt === 0 &&
        cookieChanged &&
        [401, 403, 429].includes(response.status) &&
        !looksLikeBrowserChallenge(html);
      if (retryableSessionGate) continue;

      // 4xx often means empty search / soft block pages — return HTML so selectors
      // yield empty items instead of a hard 503 to the reader. 5xx = upstream down.
      if (!response.ok && response.status >= 500) {
        throw new UpstreamFetchError(`Upstream ${url} responded ${response.status}`);
      }

      return { url: response.url || url.toString(), html };
    }
    throw new UpstreamFetchError(`Failed to establish upstream session for ${url.origin}`);
  } finally {
    clearTimeout(timeout);
  }
}

function looksLikeBrowserChallenge(html: string): boolean {
  return /Cloudflare|Just a moment|cf-chl-|startBrowserAwait|人机验证|验证码/i.test(html);
}

function decodeBody(buf: Buffer, contentType: string | null, forceCharset?: string): string {
  const fromHeader = contentType?.match(/charset=([^\s;]+)/i)?.[1]?.replace(/["']/g, '');
  // Sniff HTML meta charset if header missing.
  let charset = (forceCharset || fromHeader || '').toLowerCase();
  if (!charset || charset === 'utf-8' || charset === 'utf8') {
    const head = buf.subarray(0, Math.min(buf.length, 4096)).toString('latin1');
    const meta =
      head.match(/charset\s*=\s*["']?([a-zA-Z0-9_-]+)/i) ||
      head.match(/encoding\s*=\s*["']?([a-zA-Z0-9_-]+)/i);
    if (meta) charset = meta[1].toLowerCase();
  }
  if (!charset || charset === 'utf-8' || charset === 'utf8') {
    return buf.toString('utf8');
  }
  const encoding = charset === 'gb2312' ? 'gbk' : charset;
  if (iconv.encodingExists(encoding)) {
    return iconv.decode(buf, encoding);
  }
  return buf.toString('utf8');
}

/** Substitutes Legado's `{{key}}` / `{{page}}` search-URL template tokens. */
export function templateUrl(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name: string) => {
    const value = vars[name];
    return value === undefined ? '' : encodeURIComponent(String(value));
  });
}
