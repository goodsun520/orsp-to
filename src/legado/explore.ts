import { createHash } from 'node:crypto';
import { cleanSourceBaseUrl, parseSearchUrl } from './searchUrl.js';
import type { LegadoBookSource, LegadoRuleExplore } from './types.js';

export interface ExploreEntry {
  id: string;
  title: string;
  path: string;
}

/**
 * Legado treats an empty ruleExplore as “reuse the search list rule”. A large
 * share of real sources rely on that convention, so discovery must resolve the
 * effective rule the same way instead of silently dropping their categories.
 */
export function resolveExploreRule(source: LegadoBookSource): LegadoRuleExplore | undefined {
  if (source.ruleExplore?.bookList) return source.ruleExplore;
  if (source.ruleSearch?.bookList) return source.ruleSearch;
  return undefined;
}

/**
 * Parses Legado's newline `title::url` and JSON-array explore declarations.
 * Only static HTTP(S) URLs and source-relative paths are accepted; executable
 * explore expressions remain unsupported.
 */
export function parseExploreEntries(source: LegadoBookSource): ExploreEntry[] {
  const raw = source.exploreUrl?.trim();
  if (!raw || !resolveExploreRule(source)) return [];

  const candidates = parseJsonEntries(raw) ?? parseLineEntries(raw);
  const seen = new Set<string>();
  return candidates
    .map(({ title, path }) => ({ title: title.trim(), path: path.trim() }))
    .filter(({ title, path }) => title && isSafeExplorePath(source, path))
    .filter(({ path }) => {
      if (seen.has(path)) return false;
      seen.add(path);
      return true;
    })
    .map(({ title, path }) => ({
      id: `explore-${createHash('sha256').update(path).digest('base64url').slice(0, 24)}`,
      title,
      path,
    }));
}

function parseJsonEntries(raw: string): Array<{ title: string; path: string }> | null {
  try {
    const value = JSON.parse(raw);
    if (!Array.isArray(value)) return null;
    return value.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const record = entry as Record<string, unknown>;
      const title = record.title ?? record.name;
      const path = record.url ?? record.path;
      return typeof title === 'string' && typeof path === 'string' ? [{ title, path }] : [];
    });
  } catch {
    return null;
  }
}

function parseLineEntries(raw: string): Array<{ title: string; path: string }> {
  return raw.split(/\r?\n/).flatMap((line) => {
    const separator = line.indexOf('::');
    if (separator === -1) return [];
    return [{ title: line.slice(0, separator), path: line.slice(separator + 2) }];
  });
}

function isSafeExplorePath(source: LegadoBookSource, value: string): boolean {
  const trimmed = value.trim();
  if (/^<js>|^@js:/i.test(trimmed)) return false;
  const parsed = parseSearchUrl(trimmed, { page: 1 });
  if (parsed.kind === 'js' || !parsed.path) return false;

  try {
    const base = new URL(cleanSourceBaseUrl(source.bookSourceUrl));
    const target = new URL(parsed.path, base);
    if (!['http:', 'https:'].includes(target.protocol)) return false;
    if (normalizedSiteHost(base.hostname) !== normalizedSiteHost(target.hostname)) return false;
    const basePort = base.port || (base.protocol === 'https:' ? '443' : '80');
    const targetPort = target.port || (target.protocol === 'https:' ? '443' : '80');
    return basePort === targetPort || (['80', '443'].includes(basePort) && ['80', '443'].includes(targetPort));
  } catch {
    return false;
  }
}

function normalizedSiteHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^(?:www|m|wap)\./, '');
}
