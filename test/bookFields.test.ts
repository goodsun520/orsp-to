import { describe, expect, it } from 'vitest';
import { normalizeBookFields } from '../src/legado/rules.js';

const baseUrl = 'http://www.dongtanxs.com/s.php?ie=utf-8&q=%E7%89%9B';

function book(overrides: Partial<Parameters<typeof normalizeBookFields>[0]> = {}) {
  return {
    title: '  测试书  ',
    author: '  测试作者  ',
    kind: ['  玄幻  ', '', ' 连载 '],
    lastChapter: '  第一章  ',
    intro: '  真正的简介  ',
    coverUrl: '',
    bookUrl: '/dong84324/',
    ...overrides,
  };
}

describe('book field normalization', () => {
  it('resolves a relative cover path against the upstream response URL', () => {
    const result = normalizeBookFields(book({
      intro: '/files/article/image/84/84324/84324s.jpg',
    }), baseUrl);

    expect(result.coverUrl).toBe(
      'http://www.dongtanxs.com/files/article/image/84/84324/84324s.jpg',
    );
    expect(result.intro).toBe('');
  });

  it('preserves a complete cover URL and trims textual fields', () => {
    const result = normalizeBookFields(book({
      coverUrl: '  https://images.example/cover.jpg  ',
    }), baseUrl);

    expect(result.coverUrl).toBe('https://images.example/cover.jpg');
    expect(result.title).toBe('测试书');
    expect(result.author).toBe('测试作者');
    expect(result.intro).toBe('真正的简介');
    expect(result.kind).toEqual(['玄幻', '连载']);
    expect(result.lastChapter).toBe('第一章');
  });

  it('never leaves an image path in the description when a cover already exists', () => {
    const result = normalizeBookFields(book({
      intro: ' /files/article/image/84/84324/84324s.jpg ',
      coverUrl: ' /files/article/image/84/84324/84324s.jpg ',
    }), baseUrl);

    expect(result.intro).toBe('');
    expect(result.coverUrl).toBe(
      'http://www.dongtanxs.com/files/article/image/84/84324/84324s.jpg',
    );
  });

  it('returns an empty description when the upstream description is missing', () => {
    expect(normalizeBookFields(book({ intro: '   ' }), baseUrl).intro).toBe('');
  });

  it('does not invent a cover URL when the upstream cover is missing', () => {
    expect(normalizeBookFields(book({ coverUrl: '', intro: '' }), baseUrl).coverUrl).toBe('');
  });
});
