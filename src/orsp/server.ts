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
import { CoverResponseCache } from './coverCache.js';
import { cookieScopeKey, jarForSource } from '../legado/cookieJar.js';
import {
  AdminAuth,
  AdminAuthError,
  ADMIN_OAUTH_STATE_COOKIE,
  ADMIN_SESSION_COOKIE,
  readOAuthStateCookie,
  readSessionCookie,
} from './adminAuth.js';
import { RateLimiter, clientIp } from './rateLimit.js';
import { auditLegadoSource } from './sourceAudit.js';
import { SourceRuntime, SourceRuntimeError } from './sourceRuntime.js';
import { assessSourceCompatibility } from './sourceCompatibility.js';
import { converterTermsVersion } from './protocol.js';
import { SiteAccessControl, SITE_ACCESS_COOKIE, readSiteAccessCookie } from './siteAccess.js';
import { SourceReportStore, type SourceReportReason } from './sourceReports.js';
import { IpSecurityStore, isBannableIp } from './ipSecurity.js';
import {
  ConversionJobError,
  ConversionJobManager,
  ConversionJobSkippedError,
  conversionJobLimits,
} from './conversionJobs.js';

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
  maxConnectionsPerOrigin?: number;
  cacheDirectory?: string | null;
  cacheFreshMs?: number;
  cacheStaleMs?: number;
  cacheMaxBytes?: number;
  cacheMaxEntries?: number;
  /** Only test fixtures may set this; production leaves it false. */
  allowPrivateAddressesForTesting?: boolean;
}

export interface AdminPanelOptions {
  githubClientId?: string;
  githubClientSecret?: string;
  githubAdminLogins?: string[];
  githubFetchImpl?: typeof fetch;
  siteAccess?: SiteAccessControl;
  sourceReports?: SourceReportStore;
  ipSecurity?: IpSecurityStore;
}

function parseSort(raw: unknown): RankSort {
  if (raw === 'votes' || raw === 'converts' || raw === 'newest' || raw === 'usage') return raw;
  return 'usage';
}

function parseReportReason(value: unknown): SourceReportReason | null {
  if (value === 'infringement' || value === 'unavailable' || value === 'malicious' || value === 'other') {
    return value;
  }
  return null;
}

export function createApp(
  registry: SourceRegistry,
  publicOrigin: string,
  adminPassword = '',
  coverProxyOptions: CoverProxyOptions = {},
  adminPanelOptions: AdminPanelOptions = {},
) {
  const app = express();
  const githubConfigured = Boolean(adminPanelOptions.githubClientId && adminPanelOptions.githubClientSecret);
  const adminAuth = new AdminAuth(adminPassword, githubConfigured ? {
    clientId: adminPanelOptions.githubClientId!,
    clientSecret: adminPanelOptions.githubClientSecret!,
    callbackUrl: new URL('/api/admin/github/callback', publicOrigin).toString(),
    allowedLogins: [...new Set(['miloquinn', ...(adminPanelOptions.githubAdminLogins ?? [])])],
    fetchImpl: adminPanelOptions.githubFetchImpl,
  } : undefined);
  const siteAccess = adminPanelOptions.siteAccess ?? SiteAccessControl.ephemeral();
  const sourceReports = adminPanelOptions.sourceReports ?? SourceReportStore.ephemeral();
  const ipSecurity = adminPanelOptions.ipSecurity ?? IpSecurityStore.ephemeral();
  const convertLimiter = new RateLimiter(60_000, 10);
  const conversionChunkLimiter = new RateLimiter(60_000, 120);
  const voteLimiter = new RateLimiter(60_000, 30);
  const loginLimiter = new RateLimiter(60_000, 5);
  const accessLimiter = new RateLimiter(60_000, 10);
  const reportLimiter = new RateLimiter(60_000, 5);
  const runtime = new SourceRuntime(registry, publicOrigin);
  const conversionJobs = new ConversionJobManager(async (entry) => {
    const outcome = await convertLegadoSource(entry, registry, publicOrigin);
    if (!outcome.ok) {
      if (outcome.status === 'skipped') throw new ConversionJobSkippedError(outcome.error);
      throw new Error(outcome.error);
    }
    return outcome.converted;
  });
  const cacheDirectory = coverProxyOptions.cacheDirectory === undefined
    ? registry.runtimePath('.cover-cache')
    : coverProxyOptions.cacheDirectory;
  const coverCache = new CoverResponseCache(cacheDirectory, {
    freshMs: coverProxyOptions.cacheFreshMs,
    staleMs: coverProxyOptions.cacheStaleMs,
    maxBytes: coverProxyOptions.cacheMaxBytes,
    maxEntries: coverProxyOptions.cacheMaxEntries,
  });

  app.disable('x-powered-by');
  app.set('trust proxy', 1); // behind our own nginx reverse proxy: trust X-Forwarded-* for IP + req.secure
  app.use((req, res, next) => {
    if (ipSecurity.isBanned(clientIp(req))) {
      sendError(res, 403, 'IP_BANNED', 'This IP address has been blocked by the administrator.');
      return;
    }
    next();
  });
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

  function requireSiteAccess(req: Request, res: Response, next: () => void) {
    if (!siteAccess.isSessionValid(readSiteAccessCookie(req.headers.cookie))) {
      sendError(res, 401, 'ACCESS_REQUIRED', 'Enter the current site passphrase to continue.');
      return;
    }
    next();
  }

  function setAdminSessionCookie(req: Request, res: Response, token: string): void {
    res.cookie(ADMIN_SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: req.secure,
      maxAge: 12 * 60 * 60 * 1000,
    });
  }

  function isHealthCheck(req: Request): boolean {
    return req.get('X-Open-Reading-Request-Purpose')?.toLowerCase() === 'health-check';
  }

  function recordSuccessfulRead(req: Request, id: string): void {
    if (!isHealthCheck(req)) registry.recordRead(id, clientIp(req));
  }

  app.get('/api/access/status', (req: Request, res: Response) => {
    res.set('Cache-Control', 'no-store').json({
      required: siteAccess.isConfigured(),
      authenticated: siteAccess.isSessionValid(readSiteAccessCookie(req.headers.cookie)),
    });
  });

  app.post('/api/access/unlock', async (req: Request, res: Response) => {
    if (!accessLimiter.check(clientIp(req))) {
      sendError(res, 429, 'RATE_LIMITED', 'Too many passphrase attempts, try again in a minute.', true);
      return;
    }
    if (!siteAccess.isConfigured()) {
      res.json({ ok: true });
      return;
    }
    const passphrase = typeof req.body?.passphrase === 'string' ? req.body.passphrase : '';
    const token = siteAccess.unlock(passphrase);
    if (!token) {
      await ipSecurity.recordEvent(clientIp(req), 'invalid_passphrase', '网站暗号验证失败');
      sendError(res, 401, 'INVALID_PASSPHRASE', '暗号不正确。');
      return;
    }
    res.cookie(SITE_ACCESS_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: req.secure,
      maxAge: 24 * 60 * 60 * 1000,
    });
    res.json({ ok: true });
  });

  app.use(['/api/sources', '/api/convert', '/api/conversion-jobs'], requireSiteAccess);

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
    if (!requireConversionConsent(req, res)) return;
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
      const skipped: string[] = [];
      const items: Array<{
        index: number;
        sourceName: string;
        status: 'succeeded' | 'skipped' | 'failed';
        result?: ReturnType<typeof publicSourceDetail> & { alreadyExisted: boolean };
        error?: string;
      }> = [];
      for (const [index, entry] of list.entries()) {
        const sourceName = sourceDisplayName(entry, index);
        const outcome = await convertLegadoSource(entry, registry, publicOrigin);
        if (outcome.ok) {
          results.push(outcome.converted);
          items.push({ index, sourceName, status: 'succeeded', result: outcome.converted });
        } else if (outcome.status === 'skipped') {
          skipped.push(outcome.error);
          items.push({ index, sourceName, status: 'skipped', error: outcome.error });
        } else {
          errors.push(outcome.error);
          items.push({ index, sourceName, status: 'failed', error: outcome.error });
        }
      }
      res.json({ converted: results, skipped, errors, items });
    } catch (err) {
      if (err instanceof UnsafeTargetError) {
        invalidParameter(res, err.message);
        return;
      }
      invalidParameter(res, err instanceof Error ? err.message : 'Failed to parse source JSON.');
    }
  });

  app.use('/api/conversion-jobs', (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  app.post('/api/conversion-jobs', (req: Request, res: Response) => {
    if (!requireConversionConsent(req, res)) return;
    const expectedTotal = req.body?.expectedTotal;
    if (!Number.isInteger(expectedTotal) || expectedTotal < 1 || expectedTotal > conversionJobLimits.maxItems) {
      sendError(
        res,
        400,
        'INVALID_EXPECTED_TOTAL',
        `expectedTotal must be an integer between 1 and ${conversionJobLimits.maxItems}.`,
      );
      return;
    }
    const ip = clientIp(req);
    if (!convertLimiter.check(ip)) {
      sendError(res, 429, 'RATE_LIMITED', 'Too many conversion requests, try again in a minute.', true);
      return;
    }
    try {
      res.status(201).json({
        ...conversionJobs.create(ip, expectedTotal),
        limits: conversionJobLimits,
      });
    } catch (error) {
      handleConversionJobError(res, error);
    }
  });

  app.post('/api/conversion-jobs/:id/chunks', (req: Request, res: Response) => {
    try {
      if (!conversionChunkLimiter.check(clientIp(req))) {
        sendError(res, 429, 'RATE_LIMITED', 'Too many chunk uploads, try again in a minute.', true);
        return;
      }
      if (!Array.isArray(req.body?.sources)) {
        sendError(res, 400, 'INVALID_CHUNK', 'Provide a sources array.');
        return;
      }
      res.json(conversionJobs.append(req.params.id, clientIp(req), req.body.sources));
    } catch (error) {
      handleConversionJobError(res, error);
    }
  });

  app.post('/api/conversion-jobs/:id/seal', (req: Request, res: Response) => {
    try {
      res.status(202).json(conversionJobs.seal(req.params.id, clientIp(req)));
    } catch (error) {
      handleConversionJobError(res, error);
    }
  });

  app.post('/api/conversion-jobs/:id/retry', (req: Request, res: Response) => {
    if (!convertLimiter.check(clientIp(req))) {
      sendError(res, 429, 'RATE_LIMITED', 'Too many conversion requests, try again in a minute.', true);
      return;
    }
    try {
      res.status(202).json(conversionJobs.retry(req.params.id, clientIp(req)));
    } catch (error) {
      handleConversionJobError(res, error);
    }
  });

  app.post('/api/conversion-jobs/:id/cancel', (req: Request, res: Response) => {
    try {
      res.json(conversionJobs.cancel(req.params.id, clientIp(req)));
    } catch (error) {
      handleConversionJobError(res, error);
    }
  });

  app.get('/api/conversion-jobs/:id', (req: Request, res: Response) => {
    try {
      const snapshot = conversionJobs.get(req.params.id, clientIp(req));
      res.json(req.query.summary === '1' ? { ...snapshot, items: [] } : snapshot);
    } catch (error) {
      handleConversionJobError(res, error);
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

  app.post('/api/sources/:id/reports', async (req: Request, res: Response) => {
    const ip = clientIp(req);
    if (!reportLimiter.check(ip)) {
      sendError(res, 429, 'RATE_LIMITED', 'Too many reports, try again in a minute.', true);
      return;
    }
    const record = registry.get(req.params.id);
    if (!record || record.health?.status !== 'parse_passed') {
      notFound(res, 'Unknown or unverified source id');
      return;
    }
    const reason = parseReportReason(req.body?.reason);
    if (!reason) {
      invalidParameter(res, 'reason must be infringement, unavailable, malicious, or other');
      return;
    }
    const details = typeof req.body?.details === 'string' ? req.body.details.trim() : '';
    if (Array.from(details).length > 500) {
      invalidParameter(res, 'details must be at most 500 characters');
      return;
    }
    if (reason === 'other' && !details) {
      invalidParameter(res, 'details are required when reason is other');
      return;
    }
    try {
      const result = await sourceReports.create({
        sourceId: record.id,
        sourceName: record.legado.bookSourceName,
        websiteUrl: record.legado.bookSourceUrl,
        reason,
        details,
      }, ip);
      if (result.created) {
        await ipSecurity.recordEvent(ip, 'source_report', `举报书源 ${record.id}`);
      }
      res.status(result.created ? 201 : 200).json({
        ok: true,
        alreadyReported: !result.created,
        reportId: result.report.id,
      });
    } catch (error) {
      handleRouteError(res, error);
    }
  });

  async function deleteSource(req: Request, res: Response): Promise<void> {
    const removed = await registry.remove(req.params.id);
    if (!removed) {
      notFound(res, 'Unknown source id');
      return;
    }
    res.status(204).end();
  }

  // Backwards-compatible admin-only delete path. New dashboard calls the admin namespace below.
  app.delete('/api/sources/:id', requireAdmin, deleteSource);

  // ---- Admin moderation ----

  app.use('/api/admin', (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  app.get('/api/admin/github/start', (req: Request, res: Response) => {
    if (!loginLimiter.check(clientIp(req))) {
      sendError(res, 429, 'RATE_LIMITED', 'Too many login attempts, try again in a minute.', true);
      return;
    }
    try {
      const attempt = adminAuth.beginGitHubLogin();
      res.cookie(ADMIN_OAUTH_STATE_COOKIE, attempt.state, {
        httpOnly: true,
        sameSite: 'lax',
        secure: req.secure,
        maxAge: 10 * 60 * 1000,
        path: '/api/admin/github',
      });
      res.redirect(302, attempt.authorizationUrl);
    } catch (error) {
      if (error instanceof AdminAuthError && error.code === 'GITHUB_OAUTH_DISABLED') {
        res.redirect(303, '/admin.html?login=not-configured');
        return;
      }
      handleRouteError(res, error);
    }
  });

  app.get('/api/admin/github/callback', async (req: Request, res: Response) => {
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    try {
      const session = await adminAuth.completeGitHubLogin(
        code,
        state,
        readOAuthStateCookie(req.headers.cookie),
      );
      setAdminSessionCookie(req, res, session.token);
      res.clearCookie(ADMIN_OAUTH_STATE_COOKIE, { path: '/api/admin/github' });
      res.redirect(303, '/admin.html?login=success');
    } catch (error) {
      res.clearCookie(ADMIN_OAUTH_STATE_COOKIE, { path: '/api/admin/github' });
      if (error instanceof AdminAuthError) {
        const result = error.code === 'GITHUB_USER_FORBIDDEN' ? 'forbidden' : 'error';
        res.redirect(303, `/admin.html?login=${result}`);
        return;
      }
      console.error(error);
      res.redirect(303, '/admin.html?login=error');
    }
  });

  // Password login remains as a local recovery path for existing deployments.
  app.post('/api/admin/login', async (req: Request, res: Response) => {
    const ip = clientIp(req);
    if (!loginLimiter.check(ip)) {
      sendError(res, 429, 'RATE_LIMITED', 'Too many login attempts, try again in a minute.', true);
      return;
    }
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const token = adminAuth.login(password);
    if (!token) {
      await ipSecurity.recordEvent(ip, 'invalid_admin_password', '管理员恢复密码登录失败');
      sendUnauthorized(res);
      return;
    }
    setAdminSessionCookie(req, res, token);
    res.json({ ok: true });
  });

  app.post('/api/admin/logout', (req: Request, res: Response) => {
    adminAuth.logout(readSessionCookie(req.headers.cookie));
    res.clearCookie(ADMIN_SESSION_COOKIE);
    res.json({ ok: true });
  });

  app.get('/api/admin/whoami', (req: Request, res: Response) => {
    const identity = adminAuth.current(readSessionCookie(req.headers.cookie));
    res.json({
      authenticated: identity !== null,
      githubConfigured: adminAuth.githubConfigured(),
      user: identity,
    });
  });

  app.get('/api/admin/sources', requireAdmin, async (_req: Request, res: Response) => {
    await registry.reloadHealthFromDisk();
    res.json({ items: registry.list().map((record) => adminSourceDetail(record, publicOrigin)) });
  });

  app.get('/api/admin/access', requireAdmin, (_req: Request, res: Response) => {
    res.json(siteAccess.status());
  });

  app.post('/api/admin/access', requireAdmin, async (req: Request, res: Response) => {
    if (typeof req.body?.passphrase !== 'string') {
      invalidParameter(res, 'passphrase must be a string');
      return;
    }
    const identity = adminAuth.current(readSessionCookie(req.headers.cookie));
    try {
      await siteAccess.setPassphrase(req.body.passphrase, identity?.login ?? 'admin');
      res.json(siteAccess.status());
    } catch (error) {
      invalidParameter(res, error instanceof Error ? error.message : 'Invalid passphrase');
    }
  });

  app.post('/api/admin/sources/:id/visibility', requireAdmin, async (req: Request, res: Response) => {
    if (typeof req.body?.hidden !== 'boolean') {
      invalidParameter(res, 'hidden must be a boolean');
      return;
    }
    const identity = adminAuth.current(readSessionCookie(req.headers.cookie));
    const updated = await registry.setLeaderboardHidden(req.params.id, req.body.hidden, identity?.login ?? 'admin');
    if (!updated) {
      notFound(res, 'Unknown source id');
      return;
    }
    res.json(adminSourceDetail(registry.get(req.params.id)!, publicOrigin));
  });

  app.delete('/api/admin/sources/:id', requireAdmin, deleteSource);

  app.get('/api/admin/reports', requireAdmin, (_req: Request, res: Response) => {
    res.json({
      items: sourceReports.list().map((report) => adminReportDetail(report, registry)),
    });
  });

  app.post('/api/admin/reports/:id/resolve', requireAdmin, async (req: Request, res: Response) => {
    const action = req.body?.action;
    if (action !== 'hide' && action !== 'ignore') {
      invalidParameter(res, 'action must be hide or ignore');
      return;
    }
    const report = sourceReports.get(req.params.id);
    if (!report) {
      notFound(res, 'Unknown report id');
      return;
    }
    if (report.status !== 'open') {
      sendError(res, 409, 'REPORT_ALREADY_RESOLVED', 'This report has already been resolved.');
      return;
    }
    const identity = adminAuth.current(readSessionCookie(req.headers.cookie));
    const actor = identity?.login ?? 'admin';
    try {
      if (action === 'hide') {
        const hidden = await registry.setLeaderboardHidden(report.sourceId, true, actor);
        if (!hidden) {
          notFound(res, 'The reported source no longer exists');
          return;
        }
        await sourceReports.resolveOpenForSource(report.sourceId, 'hidden', actor);
      } else {
        await sourceReports.resolve(report.id, 'ignored', actor);
      }
      res.json(adminReportDetail(sourceReports.get(report.id)!, registry));
    } catch (error) {
      handleRouteError(res, error);
    }
  });

  app.get('/api/admin/security', requireAdmin, (req: Request, res: Response) => {
    res.json({
      currentIp: clientIp(req),
      events: ipSecurity.listEvents(),
      bans: ipSecurity.listBans(),
    });
  });

  app.post('/api/admin/security/bans', requireAdmin, async (req: Request, res: Response) => {
    const ip = typeof req.body?.ip === 'string' ? req.body.ip.trim() : '';
    if (!isBannableIp(ip)) {
      invalidParameter(res, 'ip must be a valid IPv4 or IPv6 address');
      return;
    }
    if (ip === clientIp(req)) {
      sendError(res, 409, 'CANNOT_BAN_CURRENT_IP', 'You cannot ban the IP used by your current admin session.');
      return;
    }
    const identity = adminAuth.current(readSessionCookie(req.headers.cookie));
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : '';
    try {
      res.json(await ipSecurity.ban(ip, identity?.login ?? 'admin', reason));
    } catch (error) {
      invalidParameter(res, error instanceof Error ? error.message : 'Invalid IP ban');
    }
  });

  app.post('/api/admin/security/unban', requireAdmin, async (req: Request, res: Response) => {
    const ip = typeof req.body?.ip === 'string' ? req.body.ip.trim() : '';
    if (!await ipSecurity.unban(ip)) {
      notFound(res, 'IP ban not found');
      return;
    }
    res.json({ ok: true });
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
    const clientAbort = new AbortController();
    const abortForClosedClient = () => {
      if (!res.writableEnded) clientAbort.abort();
    };
    res.once('close', abortForClosedClient);
    try {
      const sourceOrigin = new URL(cleanSourceBaseUrl(record.legado.bookSourceUrl)).origin;
      const coverUrl = new URL(upstreamUrl);
      const headers = parseLegadoHeaders(record.legado.header);
      const cookie = headers.Cookie || headers.cookie;
      const jar = jarForSource(cookieScopeKey(record.legado));
      if (cookie) jar.seedFromHeader(new URL(sourceOrigin), cookie);
      const image = await coverCache.getOrFetch(
        [
          coverProxyOptions.allowPrivateAddressesForTesting ? 'private-test' : 'public',
          record.id,
          req.params.assetId,
          upstreamUrl,
        ].join('\0'),
        clientAbort.signal,
        (signal) => fetchImage(coverUrl, {
          allowedOrigin: sourceOrigin,
          headers,
          cookieJar: jar,
          signal,
          timeoutMs: coverProxyOptions.timeoutMs,
          maxBytes: coverProxyOptions.maxBytes,
          maxConnectionsPerOrigin: coverProxyOptions.maxConnectionsPerOrigin,
          allowPrivateAddressesForTesting: coverProxyOptions.allowPrivateAddressesForTesting,
        }),
      );
      if (clientAbort.signal.aborted || res.destroyed) return;
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
      if (clientAbort.signal.aborted || res.destroyed) return;
      if (err instanceof UpstreamPayloadTooLargeError) {
        sendError(res, 413, 'PAYLOAD_TOO_LARGE', 'Cover image exceeds the response limit');
        return;
      }
      if (err instanceof UnsafeTargetError || err instanceof UpstreamInvalidContentError || err instanceof UpstreamFetchError) {
        sendError(res, 502, 'UPSTREAM_ERROR', 'Cover image is temporarily unavailable', true);
        return;
      }
      sendError(res, 502, 'UPSTREAM_ERROR', 'Cover image is temporarily unavailable', true);
    } finally {
      res.off('close', abortForClosedClient);
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

function adminSourceDetail(record: StoredSource, origin: string) {
  return {
    ...publicSourceDetail(record, origin),
    hiddenFromLeaderboard: record.moderation?.hiddenFromLeaderboard === true,
    hiddenAt: record.moderation?.hiddenAt,
    hiddenBy: record.moderation?.hiddenBy,
  };
}

function adminReportDetail(report: ReturnType<SourceReportStore['list']>[number], registry: SourceRegistry) {
  const { reporterKey: _reporterKey, ...visible } = report;
  const source = registry.get(report.sourceId);
  return {
    ...visible,
    sourceExists: source !== undefined,
    sourceHidden: source?.moderation?.hiddenFromLeaderboard === true,
  };
}

function validateLegadoSource(value: unknown): { ok: true } | { ok: false; error: string } {
  if (!value || typeof value !== 'object') {
    return {
      ok: false,
      error: '输入无效（invalid_source）：该项目不是书源对象。处理建议：检查合集 JSON，删除空项或损坏项。',
    };
  }
  const source = value as Partial<LegadoBookSource>;
  if (!source.bookSourceUrl || typeof source.bookSourceUrl !== 'string') {
    return {
      ok: false,
      error: '缺少地址（missing_bookSourceUrl）：没有 bookSourceUrl。处理建议：补充原网站的 HTTP(S) 根地址。',
    };
  }
  if (!source.bookSourceName || typeof source.bookSourceName !== 'string') {
    return {
      ok: false,
      error: '缺少名称（missing_bookSourceName）：没有 bookSourceName。处理建议：补充书源名称后再试。',
    };
  }
  if (source.bookSourceType !== undefined && source.bookSourceType !== 0) {
    return {
      ok: false,
      error: `类型不支持（non_text_source）：bookSourceType=${source.bookSourceType}，当前只支持文本书源（0）。处理建议：移除该项或换用文本书源。`,
    };
  }
  try {
    const url = new URL(cleanSourceBaseUrl(source.bookSourceUrl));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return {
        ok: false,
        error: '地址无效（invalid_bookSourceUrl）：bookSourceUrl 必须使用 HTTP(S)。处理建议：检查协议和域名。',
      };
    }
  } catch {
    return {
      ok: false,
      error: '地址无效（invalid_bookSourceUrl）：bookSourceUrl 不是完整的 HTTP(S) 地址。处理建议：填写包含协议和域名的绝对地址。',
    };
  }
  if (!source.ruleSearch?.bookList || !source.searchUrl) {
    return {
      ok: false,
      error: '缺少搜索规则（missing_search_rule）：需要 searchUrl 和 ruleSearch.bookList。处理建议：补齐搜索规则；没有搜索能力的书源无法转换。',
    };
  }
  if (!source.ruleToc?.chapterList) {
    return {
      ok: false,
      error: '缺少目录规则（missing_toc_rule）：没有 ruleToc.chapterList。处理建议：补齐章节列表规则。',
    };
  }
  if (!source.ruleContent?.content) {
    return {
      ok: false,
      error: '缺少正文规则（missing_content_rule）：没有 ruleContent.content。处理建议：补齐正文提取规则。',
    };
  }
  return { ok: true };
}

type ConvertedSource = ReturnType<typeof publicSourceDetail> & { alreadyExisted: boolean };

function sourceDisplayName(entry: unknown, index = 0): string {
  if (entry && typeof entry === 'object') {
    const name = (entry as { bookSourceName?: unknown }).bookSourceName;
    if (typeof name === 'string' && name.trim()) return name.trim().slice(0, 200);
  }
  return `第 ${index + 1} 项`;
}

async function convertLegadoSource(
  entry: unknown,
  registry: SourceRegistry,
  publicOrigin: string,
): Promise<
  { ok: true; converted: ConvertedSource } |
  { ok: false; status: 'skipped' | 'failed'; error: string }
> {
  const validation = validateLegadoSource(entry);
  if (!validation.ok) {
    return { ok: false, status: 'skipped', error: validation.error };
  }

  const candidate = entry as LegadoBookSource;
  const compatibility = assessSourceCompatibility(candidate);
  if (!compatibility.canAttemptConversion) {
    const issue = compatibility.issues.find((item) => item.blocking)!;
    return { ok: false, status: 'skipped', error: `无法自动转换（${issue.code}）：${issue.message}` };
  }

  const audit = await auditLegadoSource(candidate);
  if (audit.status === 'parse_failed') {
    return {
      ok: false,
      status: 'failed',
      error: formatAuditFailure(audit.stage, audit.reason),
    };
  }

  const { record, isNew } = await registry.add(candidate);
  await registry.setHealth(record.id, {
    checkedAt: new Date().toISOString(),
    status: 'parse_passed',
    query: audit.query,
    discoveryChecked: audit.discoveryChecked,
    stages: audit.stages,
  });
  return {
    ok: true,
    converted: { ...publicSourceDetail(record, publicOrigin), alreadyExisted: !isNew },
  };
}

function formatAuditFailure(stage: string, reason: string): string {
  if (reason === 'upstream source is unavailable') {
    return '实测失败（upstream_unavailable）：目标网站连接失败、超时或返回服务器错误。处理建议：先直接访问原站确认是否恢复，恢复后可“仅重试失败项”。';
  }
  if (stage === 'search' && reason === 'no parseable results') {
    return '实测失败（search_no_results）：已尝试常见关键词，但没有解析到书籍。可能是网站改版、规则过期或站内无匹配结果。处理建议：先在阅读 App 中确认该源还能搜索，再决定是否修规则。';
  }
  if (stage === 'route_contract') {
    return `实测失败（route_contract）：搜索结果生成的详情或章节地址无效/超出允许范围。处理建议：检查 bookUrl、tocUrl、chapterUrl。技术信息：${reason}`;
  }
  const stageLabels: Record<string, string> = {
    discover: '发现页',
    search: '搜索',
    detail: '详情',
    catalog: '目录',
    content: '正文',
  };
  return `实测失败（${stage}）：${stageLabels[stage] ?? stage}链路未通过。处理建议：原站可访问时，检查对应规则是否已过期。技术信息：${reason}`;
}

function requireConversionConsent(req: Request, res: Response): boolean {
  if (
    req.body?.acceptedTerms === true &&
    req.body?.rightsConfirmed === true &&
    req.body?.termsVersion === converterTermsVersion
  ) {
    return true;
  }
  sendError(
    res,
    403,
    'TERMS_NOT_ACCEPTED',
    `Accept terms version ${converterTermsVersion} and confirm lawful access rights before converting.`,
  );
  return false;
}

function handleConversionJobError(res: Response, error: unknown): void {
  if (error instanceof ConversionJobError) {
    sendError(res, error.status, error.code, error.message);
    return;
  }
  handleRouteError(res, error);
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
