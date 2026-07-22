import { describe, expect, it } from 'vitest';
import { parseExploreEntries, resolveExploreRule } from '../src/legado/explore.js';
import type { LegadoBookSource } from '../src/legado/types.js';

function source(overrides: Partial<LegadoBookSource> = {}): LegadoBookSource {
  return {
    bookSourceName: '发现规则测试源',
    bookSourceUrl: 'https://books.example.com',
    exploreUrl: '玄幻::category/玄幻/{{page}}',
    ruleSearch: {
      bookList: 'class.book',
      name: 'tag.a@text',
      bookUrl: 'tag.a@href',
    },
    ruleExplore: {},
    ...overrides,
  };
}

describe('Legado explore declarations', () => {
  it('falls back to ruleSearch when ruleExplore is empty', () => {
    const legado = source({
      exploreUrl: JSON.stringify([
        { title: '玄幻', url: '/category/fantasy/{{page}}', style: {} },
        { title: '都市', url: '/category/city/{{page}}', style: {} },
      ]),
    });

    expect(resolveExploreRule(legado)).toBe(legado.ruleSearch);
    expect(parseExploreEntries(legado).map(({ title, path }) => ({ title, path }))).toEqual([
      { title: '玄幻', path: '/category/fantasy/{{page}}' },
      { title: '都市', path: '/category/city/{{page}}' },
    ]);
  });

  it('accepts source-relative category paths without a leading slash', () => {
    expect(parseExploreEntries(source())).toEqual([
      expect.objectContaining({ title: '玄幻', path: 'category/玄幻/{{page}}' }),
    ]);
  });

  it('rejects executable, protocol-relative, and cross-source category targets', () => {
    const legado = source({
      exploreUrl: [
        '安全::/category/safe/{{page}}',
        '协议相对:://127.0.0.1/private',
        '跨站::https://evil.example/category',
        '脚本::@js:java.ajax("/category")',
      ].join('\n'),
    });

    expect(parseExploreEntries(legado).map((entry) => entry.title)).toEqual(['安全']);
  });

  it('prefers an explicit ruleExplore over ruleSearch', () => {
    const legado = source({
      ruleExplore: { bookList: 'class.explore', name: 'text', bookUrl: 'href' },
    });

    expect(resolveExploreRule(legado)).toBe(legado.ruleExplore);
  });
});
