import express, { type Request, type Response } from 'express';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDiscoveryDocument } from './discovery.js';
import { internalError, invalidParameter, methodNotAllowed, notFound, unavailable } from './errors.js';
import { SourceRegistry, type RankSort, type StoredSource } from './registry.js';
import type { LegadoBookSource } from '../legado/types.js';
import { parseExploreEntries } from '../legado/explore.js';
import { cleanSourceBaseUrl } from '../legado/searchUrl.js';
import {
  ensureSafeTarget,
  fetchImage,
  parseLegadoHeaders,
  UnsafeTargetError,
  UpstreamFetchError,
  UpstreamInvalidContentError,
  UpstreamPayloadTooLargeError,
} from '../legado/fetchSource.js';
import { cookieScopeKey, jarForSource } from '../legado/cookieJar.js';
import { AdminAuth, ADMIN_SESSION_COOKIE, readSessionCookie } from './adminAuth.js';
import { RateLimiter, clientIp } from './rateLimit.js';
import { auditLegadoSource } from './sourceAudit.js';
import { SourceRuntime, SourceRuntimeError } from './sourceRuntime.js';
import { assessSourceCompatibility } from './sourceCompatibility.js';
import { converterTermsVersion } from './protocol.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface Pagination {
  page: number;
  pageSize: number;
}

function readPagination(req: Request, res: Response, opts: { defaultPageSize: number; maxPageSize: number }): Pagination | null {
  const pageRaw = req.query.page as string | undefined;
  const pageSizeRaw = req.query.pageSize as string | undefined;
  const page = pageRaw === undefined || !/^\d+$/.test(pageRaw) ? NaN : Number(pageRaw);
  const pageSize = pageSizeRaw === undefined || !/^\d+$/.test(pageSizeRaw) ? NaN : Number(pageSizeRaw);
  const resolvedPage = pageRaw === undefined ? 1 : page;
  const resolvedPageSize = pageSizeRaw === undefined ? opts.defaultPageSize : pageSize;
  if (!Number.isInteger(resolvedPage) || resolvedPage < 1) {
    invalidParameter(res, 'page must be at least 1');
    return null;
  }
  if (!Number.isInteger(resolvedPageSize) || resolvedPageSize < 1 || resolvedPageSize > opts.maxPageSize) {
    invalidParameter(res, `pageSize must be between 1 and ${opts.maxPageSize}`);
    return null;
  }
  return { page: resolvedPage, pageSize: resolvedPageSize };
}

function sendJson(req: Request, res: Response, body: unknown): void {
  const serialized = JSON.stringify(body);
  const etag = `"${createHash('sha256').update(serialized).digest('base64url')}"`;
  res.set({ ETag: etag, 'Cache-Control': 'no-cache', 'X-Open-Reading-Protocol': '1.4' });
  if (req.headers['if-none-match'] === etag) {
    res.status(304).end();
    return;
  }
  res.type('application/json').send(serialized);
}

export interface CoverProxyOptions {
  timeoutMs?: number;
  maxBytes?: number;
  /** Only test fixtures may set this; production leaves it false. */
  allowPrivateAddressesForTesting?: boolean;
}

function parseSort(raw: unknown): RankSort {
  if (raw === 'votes' || raw === 'converts' || raw === 'newest' || raw === 'usage') return raw;
  return 'usage';
}

export function createApp(
  registry: SourceRegistry,
  publicOrigin: string,
  adminPassword = '',
  coverProxyOptions: CoverProxyOptions = {},
) {
  const app = express();
  const adminAuth = new AdminAuth(adminPassword);
  const convertLimiter = new RateLimiter(60_000, 10);
  const voteLimiter = new RateLimiter(60_000, 30);
  const loginLimiter = new RateLimiter(60_000, 5);
  const runtime = new SourceRuntime(registry, publicOrigin);

  app.disable('x-powered-by');
  app.set('trust proxy', 1); // behind our own nginx reverse proxy: trust X-Forwarded-* for IP + req.secure
  app.use(express.json({ limit: '2mb' }));

  app.use((_req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.set(
      'Access-Control-Allow-Headers',
      'Accept, Content-Type, If-None-Match, X-Open-Reading-Protocol, X-Open-Reading-Request-Purpose',
    );
    next();
  });
  app.options('*', (_req, res) => res.sendStatus(204));

  app.get('/robots.txt', (_req, res) => {
    res.type('text/plain').send('User-agent: *\nDisallow: /\n');
  });

  app.use(express.static(path.join(__dirname, '..', '..', 'public')));

  function requireAdmin(req: Request, res: Response, next: () => void) {
    const token = readSessionCookie(req.headers.cookie);
    if (!adminAuth.isValid(token)) {
      sendUnauthorized(res);
      return;
    }
    next();
  }

  function isHealthCheck(req: Request): boolean {
    return req.get('X-Open-Reading-Request-Purpose')?.toLowerCase() === 'health-check';
  }

  function recordSuccessfulRead(req: Request, id: string): void {
    if (!isHealthCheck(req)) registry.recordRead(id, clientIp(req));
  }

  // ---- Public source list / convert / vote / stats ----

  /** Public catalogue with aggregate, non-identifying source statistics. */
  app.get('/api/sources', async (req: Request, res: Response) => {
    await registry.reloadHealthFromDisk();
    const sort = parseSort(req.query.sort);
    res.json({
      sort,
      summary: registry.globalSummary(true),
      items: registry.listVerifiedRanked(sort).map((record) => publicSourceDetail(record, publicOrigin)),
    });
  });

  app.get('/api/sources/:id', async (req: Request, res: Response) => {
    await registry.reloadHealthFromDisk();
    const record = registry.get(req.params.id);
    if (!record || record.health?.status !== 'parse_passed') return notFound(res, 'Unknown or unverified source id');
    res.json(publicSourceDetail(record, publicOrigin));
  });

  app.post('/api/convert', async (req: Request, res: Response) => {
    if (
      req.body?.acceptedTerms !== true ||
      req.body?.rightsConfirmed !== true ||
      req.body?.termsVersion !== converterTermsVersion
    ) {
      sendError(
        res,
        403,
        'TERMS_NOT_ACCEPTED',
        `Accept terms version ${converterTermsVersion} and confirm lawful access rights before converting.`,
      );
      return;
    }
    const ip = clientIp(req);
    if (!convertLimiter.check(ip)) {
      sendError(res, 429, 'RATE_LIMITED', 'Too many conversion requests, try again in a minute.', true);
      return;
    }
    try {
      let legado: unknown;
      if (typeof req.body?.url === 'string') {
        const url = new URL(req.body.url);
        await ensureSafeTarget(url);
        const response = await fetch(url);
        if (!response.ok) {
          invalidParameter(res, `Failed to fetch ${url}: HTTP ${response.status}`);
          return;
        }
        legado = await response.json();
      } else if (req.body?.source !== undefined) {
        legado = req.body.source;
      } else {
        invalidParameter(res, 'Provide either { url } or { source } in the request body.');
        return;
      }

      const list = Array.isArray(legado) ? legado : [legado];
      const results: Array<ReturnType<typeof publicSourceDetail> & { alreadyExisted: boolean }> = [];
      const errors: string[] = [];
      for (const entry of list) {
        const validation = validateLegadoSource(entry);
        if (!validation.ok) {
          errors.push(`${(entry as { bookSourceName?: string })?.bookSourceName ?? '(unnamed)'}: ${validation.reason}`);
          continue;
        }
        const candidate = entry as LegadoBookSource;
        const compatibility = assessSourceCompatibility(candidate);
        if (!compatibility.canAttemptConversion) {
          const issue = compatibility.issues.find((item) => item.blocking)!;
          errors.push(`${candidate.bookSourceName}: ${issue.code}: ${issue.message}`);
          continue;
        }
        const audit = await auditLegadoSource(candidate);
        if (audit.status === 'parse_failed') {
          const sessionIssue = compatibility.issues.find((item) =>
            ['browser_cookie_unsupported', 'interactive_login_unsupported'].includes(item.code),
          );
          errors.push(
            sessionIssue
              ? `${candidate.bookSourceName}: ${sessionIssue.code}: ${sessionIssue.message} Runtime validation failed at ${audit.stage}.`
              : `${candidate.bookSourceName}: conversion failed at ${audit.stage}: ${audit.reason}`,
          );
          continue;
        }
        const { record, isNew } = await registry.add(candidate);
        await registry.setHealth(record.id, {
          checkedAt: new Date().toISOString(),
          status: 'parse_passed',
          query: audit.query,
          discoveryChecked: audit.discoveryChecked,
          stages: audit.stages,
        });
        results.push({ ...publicSourceDetail(record, publicOrigin), alreadyExisted: !isNew });
      }
      res.json({ converted: results, errors });
    } catch (err) {
      if (err instanceof UnsafeTargetError) {
        invalidParameter(res, err.message);
        return;
      }
      invalidParameter(res, err instanceof Error ? err.message : 'Failed to parse source JSON.');
    }
  });

  app.post('/api/sources/:id/vote', async (req: Request, res: Response) => {
    const ip = clientIp(req);
    if (!voteLimiter.check(ip)) {
      sendError(res, 429, 'RATE_LIMITED', 'Too many votes, try again in a minute.', true);
      return;
    }
    const votes = await registry.vote(req.params.id, ip);
    if (votes === null) {
      const record = registry.get(req.params.id);
      if (!record) return notFound(res, 'Unknown source id');
      res.json({ votes: record.stats.votes, alreadyVoted: true });
      return;
    }
    res.json({ votes, alreadyVoted: false });
  });

  // Deleting a shared entry is admin-only (ops cleanup). Viewing stats is fully public.
  app.delete('/api/sources/:id', requireAdmin, async (req: Request, res: Response) => {
    const removed = await registry.remove(req.params.id);
    if (!removed) {
      notFound(res, 'Unknown source id');
      return;
    }
    res.status(204).end();
  });

  // ---- Admin (delete-only ops; dashboard data is public on the front page) ----

  app.post('/api/admin/login', (req: Request, res: Response) => {
    const ip = clientIp(req);
    if (!loginLimiter.check(ip)) {
      sendError(res, 429, 'RATE_LIMITED', 'Too many login attempts, try again in a minute.', true);
      return;
    }
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const token = adminAuth.login(password);
    if (!token) {
      sendUnauthorized(res);
      return;
    }
    res.cookie(ADMIN_SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: req.secure,
      maxAge: 12 * 60 * 60 * 1000,
    });
    res.json({ ok: true });
  });

  app.post('/api/admin/logout', (req: Request, res: Response) => {
    adminAuth.logout(readSessionCookie(req.headers.cookie));
    res.clearCookie(ADMIN_SESSION_COOKIE);
    res.json({ ok: true });
  });

  app.get('/api/admin/whoami', (req: Request, res: Response) => {
    res.json({ authenticated: adminAuth.isValid(readSessionCookie(req.headers.cookie)) });
  });

  app.get('/api/admin/sources', requireAdmin, async (_req: Request, res: Response) => {
    await registry.reloadHealthFromDisk();
    // Same payload as public list — kept so the optional /admin.html delete UI still works.
    res.json({ items: registry.list().map((record) => publicSourceDetail(record, publicOrigin)) });
  });

  // ---- Per-source ORSP endpoints ----

  app.get('/s/:id/.well-known/open-reading-source.json', async (req, res) => {
    await registry.reloadHealthFromDisk();
    const record = registry.get(req.params.id);
    if (!record) return notFound(res, 'Unknown source id');
    sendJson(req, res, buildDiscoveryDocument({
      id: record.id,
      origin: publicOrigin,
      legado: record.legado,
      unsupported: record.unsupported,
      exploreEntries: record.health?.discoveryChecked === true ? parseExploreEntries(record.legado) : [],
    }));
  });

  app.get('/s/:id/api/v1/discover', async (req, res) => {
    const record = registry.get(req.params.id);
    if (!record) return notFound(res);
    try {
      sendJson(req, res, await runtime.discover(record));
    } catch (error) {
      handleRuntimeError(res, error);
    }
  });

  app.get('/s/:id/api/v1/categories', async (req, res) => {
    const record = registry.get(req.params.id);
    if (!record) return notFound(res);
    try {
      sendJson(req, res, await runtime.categories(record));
    } catch (error) {
      handleRuntimeError(res, error);
    }
  });

  app.get('/s/:id/api/v1/assets/covers/:assetId', async (req, res) => {
    const record = registry.get(req.params.id);
    if (!record) return notFound(res, 'Unknown source id');
    const upstreamUrl = registry.resolveCoverUrl(record.id, req.params.assetId);
    if (!upstreamUrl) return notFound(res, 'Unknown cover asset');
    try {
      const sourceOrigin = new URL(cleanSourceBaseUrl(record.legado.bookSourceUrl)).origin;
      const headers = parseLegadoHeaders(record.legado.header);
      const cookie = headers.Cookie || headers.cookie;
      const jar = jarForSource(cookieScopeKey(record.legado));
      if (cookie) jar.seedFromHeader(new URL(sourceOrigin), cookie);
      const image = await fetchImage(new URL(upstreamUrl), {
        allowedOrigin: sourceOrigin,
        headers,
        cookieJar: jar,
        timeoutMs: coverProxyOptions.timeoutMs,
        maxBytes: coverProxyOptions.maxBytes,
        allowPrivateAddressesForTesting: coverProxyOptions.allowPrivateAddressesForTesting,
      });
      res.set({
        'Cache-Control': 'public, max-age=86400',
        'Content-Type': image.contentType,
        'Content-Length': String(image.body.length),
        'X-Content-Type-Options': 'nosniff',
        ...(image.etag ? { ETag: image.etag } : {}),
        ...(image.lastModified ? { 'Last-Modified': image.lastModified } : {}),
      });
      res.status(200).send(image.body);
    } catch (err) {
      if (err instanceof UpstreamPayloadTooLargeError) {
        sendError(res, 413, 'PAYLOAD_TOO_LARGE', 'Cover image exceeds the response limit');
        return;
      }
      if (err instanceof UnsafeTargetError || err instanceof UpstreamInvalidContentError || err instanceof UpstreamFetchError) {
        sendError(res, 502, 'UPSTREAM_ERROR', 'Cover image is temporarily unavailable', true);
        return;
      }
      sendError(res, 502, 'UPSTREAM_ERROR', 'Cover image is temporarily unavailable', true);
    }
  });

  app.get('/s/:id/api/v1/browse', async (req, res) => {
    const record = registry.get(req.params.id);
    if (!record) return notFound(res);
    const pagination = readPagination(req, res, { defaultPageSize: 20, maxPageSize: 100 });
    if (!pagination) return;
    const category = typeof req.query.category === 'string' ? req.query.category : undefined;
    const sort = req.query.sort;
    if (sort !== undefined && sort !== 'latest' && sort !== 'popular') {
      return invalidParameter(res, 'sort must be latest or popular');
    }
    try {
      sendJson(req, res, await runtime.browse(record, {
        ...pagination,
        category,
        sort: sort as 'latest' | 'popular' | undefined,
      }));
    } catch (error) {
      handleRuntimeError(res, error);
    }
  });

  app.get('/s/:id/api/v1/search', async (req, res) => {
    const record = registry.get(req.params.id);
    if (!record) return notFound(res);
    const q = (req.query.q as string | undefined)?.trim();
    if (!q || q.length > 200) return invalidParameter(res, 'q must contain 1 to 200 characters');
    const pagination = readPagination(req, res, { defaultPageSize: 20, maxPageSize: 100 });
    if (!pagination) return;
    try {
      sendJson(req, res, await runtime.search(record, q, pagination));
    } catch (error) {
      handleRuntimeError(res, error);
    }
  });

  app.get('/s/:id/api/v1/books/:bookId', async (req, res) => {
    const record = registry.get(req.params.id);
    if (!record) return notFound(res);
    try {
      sendJson(req, res, await runtime.detail(record, req.params.bookId));
    } catch (error) {
      handleRuntimeError(res, error);
    }
  });

  app.get('/s/:id/api/v1/books/:bookId/chapters', async (req, res) => {
    const record = registry.get(req.params.id);
    if (!record) return notFound(res);
    const pagination = readPagination(req, res, { defaultPageSize: 100, maxPageSize: 200 });
    if (!pagination) return;
    try {
      sendJson(req, res, await runtime.catalog(record, req.params.bookId, pagination));
    } catch (error) {
      handleRuntimeError(res, error);
    }
  });

  app.get('/s/:id/api/v1/books/:bookId/chapters/:chapterId', async (req, res) => {
    const record = registry.get(req.params.id);
    if (!record) return notFound(res);
    try {
      const content = await runtime.content(record, req.params.bookId, req.params.chapterId);
      recordSuccessfulRead(req, record.id);
      sendJson(req, res, content);
    } catch (error) {
      handleRuntimeError(res, error);
    }
  });

  app.all('/s/:id/*', (req, res) => {
    if (req.method === 'GET') return notFound(res);
    return methodNotAllowed(res);
  });

  app.use((_req, res) => notFound(res));

  return app;

}

/** Public payload: aggregate source metadata without visitor telemetry. */
function publicSourceDetail(record: StoredSource, origin: string) {
  return {
    id: record.id,
    name: record.legado.bookSourceName,
    websiteUrl: record.legado.bookSourceUrl,
    group: record.legado.bookSourceGroup || '',
    createdAt: record.createdAt,
    updatedAt: record.updatedAt || record.createdAt,
    discoveryUrl: `${origin}/s/${record.id}/.well-known/open-reading-source.json`,
    orspBaseUrl: `${origin}/s/${record.id}/`,
    unsupported: record.unsupported,
    health: record.health ?? { status: 'unverified' },
    votes: record.stats.votes,
    readCount: record.stats.readCount,
    convertRequests: record.stats.convertRequests,
    recentUniqueReaders: record.stats.readerKeys.length,
  };
}

function validateLegadoSource(value: unknown): { ok: true } | { ok: false; reason: string } {
  if (!value || typeof value !== 'object') return { ok: false, reason: 'not a JSON object' };
  const source = value as Partial<LegadoBookSource>;
  if (!source.bookSourceUrl || typeof source.bookSourceUrl !== 'string') {
    return { ok: false, reason: 'missing bookSourceUrl' };
  }
  if (!source.bookSourceName || typeof source.bookSourceName !== 'string') {
    return { ok: false, reason: 'missing bookSourceName' };
  }
  if (source.bookSourceType !== undefined && source.bookSourceType !== 0) {
    return { ok: false, reason: 'only text book sources (bookSourceType 0) are supported' };
  }
  try {
    const url = new URL(cleanSourceBaseUrl(source.bookSourceUrl));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { ok: false, reason: 'bookSourceUrl must use HTTP(S)' };
    }
  } catch {
    return { ok: false, reason: 'bookSourceUrl must be an absolute HTTP(S) URL' };
  }
  if (!source.ruleSearch?.bookList || !source.searchUrl) {
    return { ok: false, reason: 'missing searchUrl/ruleSearch.bookList' };
  }
  if (!source.ruleToc?.chapterList) {
    return { ok: false, reason: 'missing ruleToc.chapterList' };
  }
  if (!source.ruleContent?.content) {
    return { ok: false, reason: 'missing ruleContent.content' };
  }
  return { ok: true };
}

function sendError(res: Response, status: number, code: string, message: string, retryable = false): void {
  res.status(status).set('Cache-Control', 'no-store').json({ error: { code, message, retryable } });
}

function sendUnauthorized(res: Response): void {
  sendError(res, 401, 'UNAUTHORIZED', 'Invalid or missing admin session.');
}

function handleRuntimeError(res: Response, error: unknown): void {
  if (error instanceof SourceRuntimeError) {
    sendError(res, error.status, error.code, error.message, error.retryable);
    return;
  }
  handleRouteError(res, error);
}

/**
 * Logged server-side for debugging, but deliberately generic in the HTTP
 * response per SOURCE_POLICY-style guidance in the ORSP spec: never leak
 * upstream URLs/cookies/stack traces to the client. An unreachable/
 * misbehaving upstream site (network error, timeout, redirect loop, non-2xx)
 * is a retryable 503, distinct from an actual bug in this server (500).
 */
function handleRouteError(res: Response, err: unknown): void {
  console.error(err);
  if (err instanceof UpstreamFetchError) {
    unavailable(res, 'Upstream source is unreachable');
    return;
  }
  internalError(res, 'Unexpected source error');
}
