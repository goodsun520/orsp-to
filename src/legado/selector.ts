import * as cheerio from 'cheerio';

type CheerioAPI = cheerio.CheerioAPI;
type Node = ReturnType<CheerioAPI>[number];

const LEAF_KEYWORDS = new Set(['text', 'ownText', 'textNodes', 'html', 'all']);

/**
 * Applies a Legado-style position spec (used both as the bracket form
 * `[0:1]` / `[!0]` and the dot form `.0` / `.-1`) to an ordered node list.
 * See mgz0227.github.io/The-tutorial-of-Legado/Rule/source.html for the
 * grammar this mirrors (index from 0, negative = from end, `!` = exclude,
 * `start:end[:step]` ranges).
 */
function applyPosition<T>(nodes: T[], raw?: string): T[] {
  if (!raw) return nodes;
  const exclude = raw.startsWith('!');
  const body = exclude ? raw.slice(1) : raw;
  const picked = new Set<number>();
  for (const token of body.split(',').map((t) => t.trim()).filter(Boolean)) {
    if (token.includes(':')) {
      const [rawStart, rawEnd, rawStep] = token.split(':');
      const norm = (i: number) => (i < 0 ? nodes.length + i : i);
      const start = norm(rawStart === '' || rawStart === undefined ? 0 : parseInt(rawStart, 10));
      const end = norm(rawEnd === '' || rawEnd === undefined ? nodes.length - 1 : parseInt(rawEnd, 10));
      const step = Math.max(1, Math.abs(rawStep ? parseInt(rawStep, 10) || 1 : 1));
      if (start <= end) {
        for (let i = start; i <= end; i += step) picked.add(i);
      } else {
        for (let i = start; i >= end; i -= step) picked.add(i);
      }
    } else {
      const idx = parseInt(token, 10);
      if (!Number.isNaN(idx)) picked.add(idx < 0 ? nodes.length + idx : idx);
    }
  }
  if (exclude) {
    return nodes.filter((_, i) => !picked.has(i));
  }
  return [...picked]
    .filter((i) => i >= 0 && i < nodes.length)
    .sort((a, b) => a - b)
    .map((i) => nodes[i]);
}

interface ParsedStep {
  kind: 'tag' | 'id' | 'class' | 'text' | 'children';
  name?: string;
  position?: string;
}

function parseStep(segment: string): ParsedStep {
  if (segment === 'children' || segment.startsWith('children[')) {
    const bracket = segment.match(/\[([^\]]*)\]$/);
    return { kind: 'children', position: bracket?.[1] };
  }
  const m = segment.match(/^(tag|id|class|text)\.(.+)$/);
  if (!m) {
    // CSS-style shorthand used by many real sources: `.odd.1`, `#author`, `a.0`
    if (segment.startsWith('.')) {
      // `.classname` or `.classname.0` / `.classname[0]`
      const body = segment.slice(1);
      const bracket = body.match(/^(.+?)\[([^\]]*)\]$/);
      if (bracket) return { kind: 'class', name: bracket[1], position: bracket[2] };
      const parts = body.split('.');
      // If last part is a pure index, treat as position.
      if (parts.length > 1 && /^-?\d+$/.test(parts[parts.length - 1]!)) {
        return { kind: 'class', name: parts.slice(0, -1).join('.'), position: parts[parts.length - 1] };
      }
      return { kind: 'class', name: body };
    }
    if (segment.startsWith('#')) {
      const body = segment.slice(1);
      const bracket = body.match(/^(.+?)\[([^\]]*)\]$/);
      if (bracket) return { kind: 'id', name: bracket[1], position: bracket[2] };
      const parts = body.split('.');
      if (parts.length > 1 && /^-?\d+$/.test(parts[parts.length - 1]!)) {
        return { kind: 'id', name: parts[0], position: parts.slice(1).join('.') };
      }
      return { kind: 'id', name: body };
    }
    // Bare selector step with no explicit type — treat as a tag name.
    const bracket = segment.match(/^(.+?)\[([^\]]*)\]$/);
    if (bracket) return { kind: 'tag', name: bracket[1], position: bracket[2] };
    // `a.0` / `tr!0` style: tag + position via `.N` or `!N`
    const excl = segment.match(/^([a-zA-Z][\w-]*)!(.+)$/);
    if (excl) return { kind: 'tag', name: excl[1], position: `!${excl[2]}` };
    const dotted = segment.match(/^([a-zA-Z][\w-]*)\.(.+)$/);
    if (dotted && /^-?\d/.test(dotted[2])) {
      return { kind: 'tag', name: dotted[1], position: dotted[2] };
    }
    return { kind: 'tag', name: segment };
  }
  const kind = m[1] as ParsedStep['kind'];
  let remainder = m[2];
  const bracket = remainder.match(/^(.+?)\[([^\]]*)\]$/);
  if (bracket) {
    return { kind, name: bracket[1], position: bracket[2] };
  }
  const parts = remainder.split('.');
  const name = parts[0];
  const position = parts.length > 1 ? parts.slice(1).join('.') : undefined;
  return { kind, name, position };
}

function findByStep($: CheerioAPI, scope: Node[], step: ParsedStep): Node[] {
  try {
    return findByStepUnsafe($, scope, step);
  } catch {
    // Uploaded sources may use a dialect this engine doesn't parse (raw
    // XPath, JSONPath, a bare tag name that isn't valid CSS, ...). Treat an
    // unparseable/invalid step as "no matches" rather than crashing the
    // whole request — the field just comes back empty.
    return [];
  }
}

function findByStepUnsafe($: CheerioAPI, scope: Node[], step: ParsedStep): Node[] {
  let matches: Node[];
  switch (step.kind) {
    case 'tag':
      matches = scope.flatMap((el) => $(el).find(step.name!).toArray());
      break;
    case 'id':
      matches = scope.flatMap((el) => $(el).find(`#${cssEscape(step.name!)}`).toArray());
      break;
    case 'class':
      matches = scope.flatMap((el) => $(el).find(`.${cssEscape(step.name!)}`).toArray());
      break;
    case 'children':
      matches = scope.flatMap((el) => $(el).children().toArray());
      break;
    case 'text': {
      // Mid-chain `text.<literal>` step: filter descendants of the current
      // scope by literal text-content match (not the scope node itself —
      // this is used to pick out e.g. a "下一页" link among sibling nodes).
      const needle = step.name ?? '';
      matches = scope.flatMap((el) =>
        $(el)
          .find('*')
          .toArray()
          .filter((node) => $(node).text().includes(needle)),
      );
      break;
    }
    default:
      matches = [];
  }
  return applyPosition(matches, step.position);
}

function cssEscape(value: string): string {
  return value.replace(/([ #.;?%&,:!"'()[\]])/g, '\\$1');
}

function extractLeaf($: CheerioAPI, node: Node, leaf: string): string {
  switch (leaf) {
    case 'text':
      return $(node).text().trim();
    case 'ownText':
      return $(node)
        .contents()
        .filter((_, c) => c.type === 'text')
        .text()
        .trim();
    case 'textNodes':
      return $(node).text().trim();
    case 'html':
      return $(node).html()?.trim() ?? '';
    case 'all':
      return $.html(node);
    default:
      return $(node).attr(leaf) ?? '';
  }
}

function isSelectorStep(segment: string): boolean {
  return (
    segment === 'children' ||
    segment.startsWith('children[') ||
    /^(tag|id|class|text)\./.test(segment) ||
    segment.startsWith('.') ||
    segment.startsWith('#') ||
    /^css:/i.test(segment) ||
    // bare tag with position: a.0 / tr!0
    /^[a-zA-Z][\w-]*(\.|!)/.test(segment)
  );
}

/** Splits on a top-level combinator (`&&` or `||`), ignoring occurrences inside `##...##...`. */
function splitTopLevel(rule: string, operator: '&&' | '||'): string[] {
  const parts: string[] = [];
  let depth = 0;
  let last = 0;
  for (let i = 0; i < rule.length; i++) {
    if (rule[i] === '#' && rule[i + 1] === '#') depth = depth === 0 ? 1 : 0;
    if (depth === 0 && rule.startsWith(operator, i)) {
      parts.push(rule.slice(last, i));
      last = i + operator.length;
      i += operator.length - 1;
    }
  }
  parts.push(rule.slice(last));
  return parts;
}

/** Strips a trailing `##pattern##replacement` (replacement optional) regex post-process. */
function applyRegexSuffix(rule: string, value: string): string {
  const idx = rule.indexOf('##');
  if (idx === -1) return value;
  const rest = rule.slice(idx + 2);
  const secondIdx = rest.indexOf('##');
  const pattern = secondIdx === -1 ? rest : rest.slice(0, secondIdx);
  const replacement = secondIdx === -1 ? '' : rest.slice(secondIdx + 2);
  if (!pattern) return value;
  try {
    return value.replace(new RegExp(pattern, 'g'), replacement);
  } catch {
    return value;
  }
}

function stripRegexSuffix(rule: string): string {
  const idx = rule.indexOf('##');
  return idx === -1 ? rule : rule.slice(0, idx);
}

/** Selects a list of DOM nodes for a Legado selector rule (used for bookList/chapterList). */
export function selectNodes($: CheerioAPI, scope: Node[], rule: string | undefined): Node[] {
  if (!rule || !rule.trim()) return [];
  const trimmed = stripNonExecutableJs(rule);
  if (!trimmed) return [];

  // Full-rule CSS dialect: `@css:.item` / `@css:#ListContents>div`
  // Optional trailing `@text` / `@href` is handled by extractValue, not here.
  const cssList = trimmed.match(/^@css:(.+?)(?:@(?!css:)(.*))?$/i);
  if (cssList && !trimmed.includes('##')) {
    // When used as bookList, ignore trailing leaf.
    return selectCss($, scope, stripRegexSuffix(cssList[1]));
  }
  // Also allow `##` after css rule: `@css:.x##pat##rep` — strip first.
  if (/^@css:/i.test(trimmed)) {
    const without = stripRegexSuffix(trimmed);
    const m = without.match(/^@css:(.+?)(?:@(?!css:)(.*))?$/i);
    if (m) return selectCss($, scope, m[1]);
  }

  const segments = stripRegexSuffix(trimmed).split('@');
  let current = scope;
  for (const segment of segments) {
    if (/^css:/i.test(segment)) {
      current = selectCss($, current, segment.slice(4));
      continue;
    }
    current = findByStep($, current, parseStep(segment));
  }
  return current;
}

function selectCss($: CheerioAPI, scope: Node[], css: string): Node[] {
  const selector = css.trim();
  if (!selector) return [];
  try {
    return scope.flatMap((el) => {
      // cheerio root: query from document; element: find descendants + maybe self
      if (el.type === 'root' || (el as { name?: string }).name === 'root') {
        return $(selector).toArray();
      }
      const self = $(el).is(selector) ? [el] : [];
      return [...self, ...$(el).find(selector).toArray()];
    });
  } catch {
    return [];
  }
}

/**
 * Evaluates a Legado value rule (e.g. book title, author, href) against a
 * scope of nodes, honoring `&&`/`||` combinators and `##` regex cleanup.
 * Multiple matched nodes are joined with newlines (e.g. chapter content
 * paragraphs).
 */
export function extractValue($: CheerioAPI, scope: Node[], rule: string | undefined): string {
  const list = extractList($, scope, rule);
  return list.join('\n');
}

/**
 * Like {@link extractValue}, but keeps each matched node's value as a
 * separate array entry instead of joining them — used for fields that map
 * to an ORSP array (e.g. `categories`).
 */
export function extractList($: CheerioAPI, scope: Node[], rule: string | undefined): string[] {
  if (!rule || !rule.trim()) return [];
  const normalized = stripNonExecutableJs(rule);
  if (!normalized) return [];
  const orBranches = splitTopLevel(normalized, '||');
  for (const orBranch of orBranches) {
    const andParts = splitTopLevel(orBranch, '&&');
    const values = andParts.flatMap((part) => evaluateSingle($, scope, part));
    if (values.some((v) => v.trim())) return values.filter((v) => v.trim());
  }
  return [];
}

/**
 * Legado uses `@js:` suffixes for optional presentation transforms and may
 * prepend `<js>...</js>` to an otherwise static selector. Never execute that
 * code; retain only the selector portion that can be interpreted safely.
 */
function stripNonExecutableJs(rule: string): string {
  let normalized = rule.trim();
  const closing = normalized.toLowerCase().lastIndexOf('</js>');
  if (/^<js>/i.test(normalized) && closing !== -1) {
    normalized = normalized.slice(closing + 5).trim();
  }
  const jsSuffix = normalized.search(/@js:/i);
  if (jsSuffix > 0) normalized = normalized.slice(0, jsSuffix).trim();
  return normalized;
}

function evaluateSingle($: CheerioAPI, scope: Node[], rule: string): string[] {
  const rawRule = rule.trim();
  const withoutRegex = stripRegexSuffix(rawRule);

  // `@css:selector@attr` or `@css:selector` (default text)
  if (/^@css:/i.test(withoutRegex)) {
    const body = withoutRegex.replace(/^@css:/i, '');
    const at = body.lastIndexOf('@');
    let css = body;
    let leaf = 'text';
    if (at > 0) {
      const maybeLeaf = body.slice(at + 1);
      // leaf is a simple attr/text token without spaces/css combinators
      if (/^[a-zA-Z_][\w-]*$/.test(maybeLeaf)) {
        css = body.slice(0, at);
        leaf = maybeLeaf;
      }
    }
    const nodes = selectCss($, scope, css);
    return nodes.map((node) => applyRegexSuffix(rawRule, extractLeaf($, node, leaf)));
  }

  const segments = withoutRegex.split('@').filter((s) => s.length > 0);
  let leaf = 'text';
  let selectorSegments = segments;
  if (segments.length > 0 && !isSelectorStep(segments[segments.length - 1]) && !/^css:/i.test(segments[segments.length - 1]!)) {
    leaf = segments[segments.length - 1]!;
    selectorSegments = segments.slice(0, -1);
  }
  let current = scope;
  for (const segment of selectorSegments) {
    if (/^css:/i.test(segment)) {
      current = selectCss($, current, segment.slice(4));
      continue;
    }
    current = findByStep($, current, parseStep(segment));
  }
  const rawValues = current.map((node) => extractLeaf($, node, leaf));
  return rawValues.map((raw) => applyRegexSuffix(rawRule, raw));
}

/** Convenience: parses raw HTML into a cheerio document. */
export function parseHtml(html: string) {
  return cheerio.load(html);
}
