/**
 * Parses Legado `searchUrl` forms:
 *
 *   /path?q={{key}}
 *   /path,{'method':'POST','body':'k={{key}}','charset':'gbk','headers':{...}}
 *   https://host/path,{"method":"GET"}
 *
 * Also strips leading `<js>...</js>` / `@js:` wrappers when present — those
 * still won't *execute*, but if the remaining tail is a plain URL we can use
 * it. Pure-JS searchUrls return `{ kind: 'js' }` so callers can soft-fail.
 */

export interface ParsedSearchUrl {
  kind: 'http' | 'js';
  path: string;
  method: 'GET' | 'POST' | 'PUT';
  body?: string;
  charset?: string;
  headers: Record<string, string>;
  /** Original option object keys we recognized, for debugging. */
  rawOptions?: Record<string, unknown>;
}

/** Strip bookSourceUrl junk like `https://host.com##comment`. */
export function cleanSourceBaseUrl(url: string): string {
  if (!url) return url;
  const hashHash = url.indexOf('##');
  if (hashHash !== -1) return url.slice(0, hashHash);
  return url;
}

/**
 * Split `url,optionsJson` at the first top-level comma that starts a `{`.
 * Options may use single quotes (Legado style).
 */
export function parseSearchUrl(searchUrl: string, vars: Record<string, string | number>): ParsedSearchUrl {
  const trimmed = (searchUrl || '').trim();
  if (!trimmed) {
    return { kind: 'http', path: '', method: 'GET', headers: {} };
  }

  // Some sources run a browser-side check and then append a plain URL after
  // `</js>`. The check is deliberately not executed; the static tail is safe
  // to use as an ordinary request.
  if (/^<js>/i.test(trimmed)) {
    const closing = trimmed.toLowerCase().lastIndexOf('</js>');
    const tail = closing === -1 ? '' : trimmed.slice(closing + 5).trim();
    if (isPlainUrlOrPath(tail)) return parseSearchUrl(tail, vars);
  }

  // A common non-essential JS wrapper only assigns a literal URL to `url`.
  // Extract that literal without evaluating any source-supplied code.
  if (/^@js:/i.test(trimmed)) {
    const assigned = extractLiteralUrlAssignment(trimmed);
    if (assigned) return parseSearchUrl(assigned, vars);
  }

  // Pure JS rule — we cannot evaluate.
  if (/^@js:/i.test(trimmed) || /^<js>/i.test(trimmed)) {
    // Some sources wrap a plain URL: <js>...;url='/x,{}';...</js>  — too hard.
    // If after stripping tags the remainder is a simple URL template, use it.
    const unwrapped = unwrapJsIfPlain(trimmed);
    if (!unwrapped) {
      return { kind: 'js', path: '', method: 'GET', headers: {} };
    }
    return parseSearchUrl(unwrapped, vars);
  }

  const { urlPart, optionsPart } = splitUrlAndOptions(trimmed);
  const path = applyTemplate(urlPart, vars, /*encodePath*/ true);
  let method: 'GET' | 'POST' | 'PUT' = 'GET';
  let body: string | undefined;
  let charset: string | undefined;
  const headers: Record<string, string> = {};
  let rawOptions: Record<string, unknown> | undefined;

  if (optionsPart) {
    rawOptions = parseLegadoJsonObject(optionsPart);
    if (rawOptions) {
      const m = String(rawOptions.method || rawOptions.Method || 'GET').toUpperCase();
      if (m === 'POST' || m === 'PUT' || m === 'GET') method = m;
      if (typeof rawOptions.body === 'string') {
        body = applyTemplate(rawOptions.body, vars, /*encodePath*/ false);
      }
      if (typeof rawOptions.charset === 'string') charset = rawOptions.charset;
      const optionHeaders = typeof rawOptions.headers === 'string'
        ? parseLegadoJsonObject(rawOptions.headers)
        : rawOptions.headers;
      if (optionHeaders && typeof optionHeaders === 'object') {
        for (const [k, v] of Object.entries(optionHeaders as Record<string, unknown>)) {
          headers[k] = String(v);
        }
      }
      // Some sources put webView / webJs etc — ignore.
    }
  }

  return { kind: 'http', path, method, body, charset, headers, rawOptions };
}

function isPlainUrlOrPath(value: string): boolean {
  return /^https?:\/\//i.test(value) || value.startsWith('/');
}

function extractLiteralUrlAssignment(rule: string): string | null {
  const match = rule.match(/\burl\s*=\s*(?:baseUrl\s*\+\s*)?(["'])(.*?)\1/is);
  if (!match || !isPlainUrlOrPath(match[2])) return null;
  return match[2];
}

function unwrapJsIfPlain(rule: string): string | null {
  // Only unwrap when the *entire* content after stripping is a simple path/url template.
  let s = rule.trim();
  if (/^@js:/i.test(s)) s = s.slice(4).trim();
  if (/^<js>/i.test(s) && /<\/js>\s*$/i.test(s)) {
    s = s.replace(/^<js>/i, '').replace(/<\/js>\s*$/i, '').trim();
  }
  // If it still looks like code (function, java., var, if, cookie.) bail.
  if (/function\s|\bjava\.|\bvar\s|\blet\s|\bif\s*\(|cookie\.|ajax\(/i.test(s)) return null;
  // Accept a single URL/path line optionally ending with options object.
  if (/^https?:\/\/|^\/[\w.?=&{}%,'"{\s:\-}]+$/i.test(s.replace(/\s+/g, ' '))) return s;
  // Or last assignment-like: url = "..."
  const m = s.match(/(?:url\s*=\s*)(['"`])(.+?)\1\s*;?\s*$/i);
  if (m) return m[2];
  return null;
}

function splitUrlAndOptions(raw: string): { urlPart: string; optionsPart?: string } {
  // Find `,{'` or `,{ "` or `,{` that starts options.
  let inQuote: string | null = null;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (inQuote) {
      if (c === inQuote && raw[i - 1] !== '\\') inQuote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      inQuote = c;
      continue;
    }
    if (c === ',' && raw[i + 1] === '{') {
      return { urlPart: raw.slice(0, i).trim(), optionsPart: raw.slice(i + 1).trim() };
    }
  }
  return { urlPart: raw.trim() };
}

/**
 * Legado options often use single quotes. Convert to JSON carefully.
 * Also tolerates unquoted keys in rare cases by not being too clever —
 * we only need the common `{'method':'POST','body':'...'}` form.
 */
export function parseLegadoJsonObject(raw: string): Record<string, unknown> | undefined {
  let s = raw.trim();
  if (s.startsWith('{{') && !s.endsWith('}}')) s = s.slice(1);
  if (!s.startsWith('{')) return undefined;
  // Replace single-quoted strings with double-quoted, escaping interior doubles.
  try {
    const jsonish = s.replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_, inner: string) => {
      const escaped = inner.replace(/\\'/g, "'").replace(/"/g, '\\"');
      return `"${escaped}"`;
    });
    const parsed = JSON.parse(jsonish);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return undefined;
}

/**
 * Template substitution. For path/query we percent-encode; for POST body we
 * leave encoding to the charset step (so gbk body is encoded as bytes later).
 * When encodePath is true, values are encodeURIComponent'd.
 */
export function applyTemplate(
  template: string,
  vars: Record<string, string | number>,
  encodePath: boolean,
): string {
  return template.replace(
    /\{\{\s*(\w+)(?:\s*([+-])\s*(\d+))?\s*\}\}/g,
    (_, name: string, operator: string | undefined, rawOffset: string | undefined) => {
    const value = vars[name];
    if (value === undefined) return '';
    const offset = rawOffset === undefined ? 0 : Number(rawOffset) * (operator === '-' ? -1 : 1);
    const adjusted = offset === 0 ? value : Number(value) + offset;
    const str = String(adjusted);
    return encodePath ? encodeURIComponent(str) : str;
    },
  );
}
