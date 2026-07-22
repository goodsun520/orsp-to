import type { LegadoBookSource } from '../legado/types.js';
import { UpstreamFetchError } from '../legado/fetchSource.js';
import { CatalogCache } from './catalogCache.js';
import { SourceRegistry } from './registry.js';
import { SourceRuntime, SourceRuntimeError } from './sourceRuntime.js';

export type AuditStage = 'discover' | 'search' | 'route_contract' | 'detail' | 'catalog' | 'content';
export type AuditStages = Record<string, { status: 'ok' | 'failed'; latencyMs?: number }>;

export interface SourceAuditPassed {
  status: 'parse_passed';
  query: string;
  catalogSize: number;
  contentBytes: number;
  discoveryChecked: boolean;
  stages: AuditStages;
}

export interface SourceAuditFailed {
  status: 'parse_failed';
  stage: AuditStage;
  reason: string;
  attempts: Array<{ query: string; stage: string; reason: string }>;
  stages: AuditStages;
}

export type SourceAuditOutcome = SourceAuditPassed | SourceAuditFailed;

const fallbackQueries = ['西游记', '斗破苍穹', '凡人修仙传', '重生', '总裁'];

/** Audits a candidate through the same runtime contract used by public routes. */
export async function auditLegadoSource(
  source: LegadoBookSource,
  options: { queries?: readonly string[] } = {},
): Promise<SourceAuditOutcome> {
  const registry = SourceRegistry.ephemeral();
  const { record } = await registry.add(source);
  const runtime = new SourceRuntime(registry, 'http://audit.invalid', new CatalogCache());
  const attempts: SourceAuditFailed['attempts'] = [];
  const stages: AuditStages = {};
  let discoveryChecked = false;
  let discoveredQuery: string | undefined;

  const discoverStarted = Date.now();
  try {
    const discovery = await runtime.discover(record);
    const firstItem = discovery.sections.flatMap((section) => section.items)[0];
    if (!firstItem) throw new SourceRuntimeError(503, 'UNAVAILABLE', 'No readable discovery sections', true);
    if (firstItem?.title?.trim()) discoveredQuery = firstItem.title.trim();
    stages.discover = { status: 'ok', latencyMs: Date.now() - discoverStarted };

    const categoriesStarted = Date.now();
    const categories = await runtime.categories(record);
    const firstCategory = categories.items[0];
    if (!firstCategory) throw new SourceRuntimeError(503, 'UNAVAILABLE', 'No readable discovery categories', true);
    stages.categories = { status: 'ok', latencyMs: Date.now() - categoriesStarted };

    const browseStarted = Date.now();
    const browse = await runtime.browse(record, {
      category: firstCategory.id,
      page: 1,
      pageSize: 1,
    });
    if (browse.items.length === 0) throw new SourceRuntimeError(503, 'UNAVAILABLE', 'No readable category books', true);
    stages.browse = { status: 'ok', latencyMs: Date.now() - browseStarted };
    discoveryChecked = true;
  } catch (error) {
    if (error instanceof SourceRuntimeError && error.status === 404) {
      // Discovery is optional for Core Reading sources.
    } else {
      const failedStage = !stages.discover ? 'discover' : !stages.categories ? 'categories' : 'browse';
      stages[failedStage] = { status: 'failed', latencyMs: Date.now() - discoverStarted };
      attempts.push({ query: '', stage: failedStage, reason: safeReason(error) });
    }
  }

  const queries = uniqueQueries([
    ...(options.queries ?? []),
    ...(discoveredQuery ? [discoveredQuery] : []),
    ...fallbackQueries,
  ]);
  for (const query of queries) {
    const searchStarted = Date.now();
    let search;
    try {
      search = await runtime.search(record, query, { page: 1, pageSize: 2 });
      if (search.items.length === 0) {
        attempts.push({ query, stage: 'search', reason: 'no parseable results' });
        continue;
      }
      stages.search = { status: 'ok', latencyMs: Date.now() - searchStarted };
    } catch (error) {
      attempts.push({ query, stage: 'search', reason: safeReason(error) });
      continue;
    }

    for (const book of search.items.slice(0, 2)) {
      try {
        const detailStarted = Date.now();
        const detail = await runtime.detail(record, book.id);
        stages.detail = { status: 'ok', latencyMs: Date.now() - detailStarted };
        if (!detail.title.trim()) return failed('detail', 'missing title', query, attempts, stages);
        if (!detail.author.trim()) return failed('detail', 'missing author', query, attempts, stages);
        if (!detail.description.trim()) return failed('detail', 'missing description', query, attempts, stages);
        if (!detail.coverUrl) return failed('detail', 'missing or unsafe cover URL', query, attempts, stages);

        const catalogStarted = Date.now();
        const catalog = await runtime.catalog(record, detail.id, { page: 1, pageSize: 2 });
        stages.catalog = { status: 'ok', latencyMs: Date.now() - catalogStarted };
        if (catalog.items.length === 0) return failed('catalog', 'no parseable chapters', query, attempts, stages);

        const contentStarted = Date.now();
        const content = await runtime.content(record, detail.id, catalog.items[0].id);
        stages.content = { status: 'ok', latencyMs: Date.now() - contentStarted };
        if (!content.content.trim()) return failed('content', 'empty content', query, attempts, stages);
        return {
          status: 'parse_passed',
          query,
          catalogSize: catalog.total,
          contentBytes: Buffer.byteLength(content.content),
          discoveryChecked,
          stages,
        };
      } catch (error) {
        const stage = contractStage(error);
        stages[stage] = { status: 'failed' };
        attempts.push({ query, stage, reason: safeReason(error) });
      }
    }
  }

  const last = attempts.at(-1) ?? { stage: 'search', reason: 'no audit query configured' };
  return failed(last.stage as AuditStage, last.reason, queries.at(-1) ?? '', attempts, stages);
}

function failed(
  stage: AuditStage,
  reason: string,
  query: string,
  attempts: SourceAuditFailed['attempts'],
  stages: AuditStages,
): SourceAuditFailed {
  stages[stage] ??= { status: 'failed' };
  if (!attempts.some((attempt) => attempt.query === query && attempt.stage === stage && attempt.reason === reason)) {
    attempts.push({ query, stage, reason });
  }
  return { status: 'parse_failed', stage, reason, attempts, stages };
}

function contractStage(error: unknown): AuditStage {
  if (
    error instanceof SourceRuntimeError &&
    ['BOOK_NOT_FOUND', 'CHAPTER_NOT_FOUND', 'INVALID_PARAMETER'].includes(error.code)
  ) {
    return 'route_contract';
  }
  if (error instanceof SourceRuntimeError && error.code === 'UNAVAILABLE') return 'content';
  return 'detail';
}

function safeReason(error: unknown): string {
  if (error instanceof SourceRuntimeError) return `${error.code}: ${error.message}`;
  if (error instanceof UpstreamFetchError) return 'upstream source is unavailable';
  return 'unexpected adapter failure';
}

function uniqueQueries(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
