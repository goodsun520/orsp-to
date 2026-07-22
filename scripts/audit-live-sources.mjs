#!/usr/bin/env node

/**
 * Bounded, read-only ORSP health audit for the adapter's mounted sources.
 * It mirrors the Open Reading client path without printing or persisting
 * chapter text. The default query is a public-domain title.
 *
 * Usage:
 *   node scripts/audit-live-sources.mjs
 *   AUDIT_QUERY=... AUDIT_CONCURRENCY=2 node scripts/audit-live-sources.mjs
 */

const origin = process.env.AUDIT_ORIGIN ?? 'https://book.openany.shop';
const query = process.env.AUDIT_QUERY ?? '西游记';
const concurrency = Math.max(1, Math.min(Number(process.env.AUDIT_CONCURRENCY ?? 2) || 2, 4));
const maxResponseBytes = 8 * 1024 * 1024;
const timeoutMs = 30_000;

class AuditError extends Error {
  constructor(stage, message, status) {
    super(message);
    this.stage = stage;
    this.status = status;
  }
}

async function getJson(url, stage) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'X-Open-Reading-Protocol': '1.4',
        'X-Open-Reading-Request-Purpose': 'health-check',
      },
      signal: controller.signal,
    });
    const contentLength = Number(response.headers.get('content-length') ?? 0);
    if (contentLength > maxResponseBytes) {
      throw new AuditError(stage, `response exceeds ${maxResponseBytes} bytes`, response.status);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxResponseBytes) {
      throw new AuditError(stage, `response exceeds ${maxResponseBytes} bytes`, response.status);
    }
    let body;
    try {
      body = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw new AuditError(stage, 'response is not valid JSON', response.status);
    }
    if (!response.ok) {
      const code = body?.error?.code;
      throw new AuditError(stage, code ? `${response.status} ${code}` : `HTTP ${response.status}`, response.status);
    }
    return { body, etag: response.headers.get('etag') };
  } catch (error) {
    if (error instanceof AuditError) throw error;
    const message = error?.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : String(error?.message ?? error);
    throw new AuditError(stage, message);
  } finally {
    clearTimeout(timer);
  }
}

function apiUrl(apiBaseUrl, path, params) {
  const url = new URL(path, apiBaseUrl.endsWith('/') ? apiBaseUrl : `${apiBaseUrl}/`);
  for (const [key, value] of Object.entries(params ?? {})) url.searchParams.set(key, String(value));
  return url.toString();
}

function requireString(value, label, stage) {
  if (typeof value !== 'string' || !value.trim()) throw new AuditError(stage, `missing ${label}`);
  return value;
}

async function auditSource(source) {
  const started = Date.now();
  const result = {
    id: source.id,
    name: source.name,
    unsupported: source.unsupported,
    outcome: 'unknown',
    elapsedMs: 0,
    stages: {},
  };
  try {
    const discovery = await getJson(source.discoveryUrl, 'discovery');
    const manifest = discovery.body;
    const apiBaseUrl = requireString(manifest.apiBaseUrl, 'apiBaseUrl', 'discovery');
    if (manifest.protocol !== 'open-reading-source' || !Array.isArray(manifest.capabilities)) {
      throw new AuditError('discovery', 'invalid ORSP discovery document');
    }
    result.stages.discovery = { ok: true, etag: Boolean(discovery.etag) };

    if (manifest.capabilities.includes('discover')) {
      const shelves = await getJson(apiUrl(apiBaseUrl, 'v1/discover'), 'discover');
      if (!Array.isArray(shelves.body.sections) || !shelves.body.sections.some((section) => Array.isArray(section?.items) && section.items.length > 0)) {
        throw new AuditError('discover', 'no readable discovery sections');
      }
      result.stages.discover = { ok: true, count: shelves.body.sections.length, etag: Boolean(shelves.etag) };
    }

    if (manifest.capabilities.includes('categories')) {
      const categories = await getJson(apiUrl(apiBaseUrl, 'v1/categories'), 'categories');
      if (!Array.isArray(categories.body.items) || categories.body.items.length === 0) {
        throw new AuditError('categories', 'no browseable categories');
      }
      result.stages.categories = { ok: true, count: categories.body.items.length, etag: Boolean(categories.etag) };

      if (manifest.capabilities.includes('browse')) {
        const categoryId = requireString(categories.body.items[0]?.id, 'category id', 'browse');
        const browse = await getJson(
          apiUrl(apiBaseUrl, 'v1/browse', { category: categoryId, page: 1, pageSize: 1 }),
          'browse',
        );
        if (!Array.isArray(browse.body.items) || browse.body.items.length === 0) {
          throw new AuditError('browse', 'no readable browse results');
        }
        result.stages.browse = { ok: true, count: browse.body.items.length, etag: Boolean(browse.etag) };
      }
    }

    const search = await getJson(apiUrl(apiBaseUrl, 'v1/search', { q: query, page: 1, pageSize: 1 }), 'search');
    if (!Array.isArray(search.body.items)) throw new AuditError('search', 'missing items array');
    result.stages.search = { ok: true, count: search.body.items.length, etag: Boolean(search.etag) };
    if (search.body.items.length === 0) {
      result.outcome = 'search_empty';
      return result;
    }

    const firstBook = search.body.items[0];
    const bookId = requireString(firstBook?.id, 'book id', 'search');
    const detail = await getJson(apiUrl(apiBaseUrl, `v1/books/${encodeURIComponent(bookId)}`), 'detail');
    requireString(detail.body?.title, 'book title', 'detail');
    result.stages.detail = { ok: true, etag: Boolean(detail.etag) };

    const pageSize = Math.min(Math.max(Number(manifest.maxCatalogPageSize) || 100, 1), 1000);
    const catalog = await getJson(
      apiUrl(apiBaseUrl, `v1/books/${encodeURIComponent(bookId)}/chapters`, { page: 1, pageSize }),
      'catalog',
    );
    if (!Array.isArray(catalog.body.items)) throw new AuditError('catalog', 'missing items array');
    result.stages.catalog = {
      ok: true,
      count: catalog.body.items.length,
      hasMore: catalog.body.hasMore === true,
      etag: Boolean(catalog.etag),
    };
    if (catalog.body.items.length === 0) {
      result.outcome = 'catalog_empty';
      return result;
    }

    const firstChapter = catalog.body.items[0];
    const chapterId = requireString(firstChapter?.id, 'chapter id', 'catalog');
    const content = await getJson(
      apiUrl(apiBaseUrl, `v1/books/${encodeURIComponent(bookId)}/chapters/${encodeURIComponent(chapterId)}`),
      'content',
    );
    requireString(content.body?.title, 'chapter title', 'content');
    if (typeof content.body?.content !== 'string') throw new AuditError('content', 'missing content string');
    result.stages.content = { ok: true, bytes: Buffer.byteLength(content.body.content), etag: Boolean(content.etag) };
    result.outcome = 'readable';
  } catch (error) {
    const failure = error instanceof AuditError ? error : new AuditError('unknown', String(error?.message ?? error));
    result.outcome = 'failed';
    result.failure = { stage: failure.stage, message: failure.message, status: failure.status ?? null };
  } finally {
    result.elapsedMs = Date.now() - started;
  }
  return result;
}

async function runPool(items, worker) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await worker(items[index]);
      }
    }),
  );
  return results;
}

const sources = (await getJson(apiUrl(origin, 'api/sources'), 'source-list')).body.items;
if (!Array.isArray(sources)) throw new Error('Source list does not contain items.');
const results = await runPool(sources, auditSource);
const summary = results.reduce(
  (accumulator, result) => {
    accumulator[result.outcome] = (accumulator[result.outcome] ?? 0) + 1;
    if (result.failure) {
      accumulator.failuresByStage[result.failure.stage] = (accumulator.failuresByStage[result.failure.stage] ?? 0) + 1;
    }
    return accumulator;
  },
  { total: results.length, failuresByStage: {} },
);

console.log(JSON.stringify({ auditedAt: new Date().toISOString(), origin, query, summary, results }, null, 2));
