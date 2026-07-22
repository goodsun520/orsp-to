import { describe, expect, it } from 'vitest';
import { assessSourceCompatibility } from '../src/orsp/sourceCompatibility.js';
import type { LegadoBookSource } from '../src/legado/types.js';

function source(overrides: Partial<LegadoBookSource> = {}): LegadoBookSource {
  return {
    bookSourceName: '兼容性测试源',
    bookSourceUrl: 'https://example.com',
    searchUrl: '/search?q={{key}}',
    ruleSearch: { bookList: 'class.item' },
    ruleToc: { chapterList: 'class.chapter' },
    ruleContent: { content: 'class.content@text' },
    ...overrides,
  };
}

describe('source compatibility classification', () => {
  it.each([
    ['none', source()],
    ['static', source({ header: "{'Cookie':'session=ready'}" })],
    ['http-session', source({ enabledCookieJar: true })],
    ['interactive-unsupported', source({ loginUrl: 'https://example.com/login' })],
    ['browser-unsupported', source({ startBrowserAwait: 'Cloudflare challenge' })],
  ] as const)('classifies %s Cookie mode', (expected, input) => {
    expect(assessSourceCompatibility(input).cookieMode).toBe(expected);
  });

  it('fast-filters non-text, interactive, and browser-only sources', () => {
    expect(assessSourceCompatibility(source({ bookSourceType: 2 })).canAttemptConversion).toBe(false);
    expect(assessSourceCompatibility(source({ loginUi: '[]' })).canAttemptConversion).toBe(false);
    expect(assessSourceCompatibility(source({ startBrowserAwait: 'required' })).canAttemptConversion).toBe(false);
  });

  it('fast-filters executable JS/Java rules instead of auditing them', () => {
    const result = assessSourceCompatibility(source({ searchUrl: "@js:url='/search?q={{key}}'" }));
    expect(result.canAttemptConversion).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'embedded_code_unsupported', blocking: true }));
  });

  it('fast-filters sources explicitly marked unavailable by their maintainer', () => {
    const result = assessSourceCompatibility(source({ bookSourceComment: '// Error: timeout' }));
    expect(result.canAttemptConversion).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'source_marked_unavailable', blocking: true }));
  });

  it('does not treat a descriptive group label as an actual browser requirement', () => {
    const result = assessSourceCompatibility(source({ bookSourceGroup: '人机验证-全站' }));
    expect(result.cookieMode).toBe('none');
    expect(result.canAttemptConversion).toBe(true);
  });
});
