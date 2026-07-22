import { describe, expect, it } from 'vitest';
import { extractList, extractValue, parseHtml, selectNodes } from '../src/legado/selector.js';

describe('selectNodes + extractValue', () => {
  it('resolves nested tag/class/id steps with dot-index and bracket ranges', () => {
    const $ = parseHtml(`
      <div class="item">
        <h3><a href="/b/1.html">标题一</a></h3>
        <p><span>玄幻</span><span>连载中</span><span>忽略我</span></p>
      </div>
    `);
    const root = [$.root().get(0)!];
    expect(extractValue($, root, 'class.item.0@tag.h3.0@tag.a.0@text')).toBe('标题一');
    expect(extractValue($, root, 'class.item.0@tag.h3.0@tag.a.0@href')).toBe('/b/1.html');
    expect(extractList($, root, 'tag.p.0@tag.span[0:1]@text')).toEqual(['玄幻', '连载中']);
  });

  it('supports negative index (from end)', () => {
    const $ = parseHtml('<ul><li>a</li><li>b</li><li>c</li></ul>');
    const root = [$.root().get(0)!];
    expect(extractValue($, root, 'tag.li.-1@text')).toBe('c');
  });

  it('applies a trailing ##pattern##replacement regex', () => {
    const $ = parseHtml('<p>作者：墨白</p>');
    const root = [$.root().get(0)!];
    expect(extractValue($, root, 'tag.p.0@text##作者：')).toBe('墨白');
  });

  it('supports || fallback and && concatenation', () => {
    const $ = parseHtml('<div class="a"></div><div class="b">备用值</div>');
    const root = [$.root().get(0)!];
    expect(extractValue($, root, 'class.a.0@text||class.b.0@text')).toBe('备用值');
    expect(extractValue($, root, 'class.a.0@text&&class.b.0@text')).toBe('备用值');
  });

  it('resolves a mid-chain text.<literal> filter step (used for prev/next links)', () => {
    const $ = parseHtml(`
      <div class="prenext">
        <span><a href="/c/0.html">上一页</a></span>
        <span><a href="/c/2.html">下一页</a></span>
      </div>
    `);
    const root = [$.root().get(0)!];
    expect(extractValue($, root, 'class.prenext.0@tag.span.-1@text.下一页.0@href')).toBe('/c/2.html');
  });

  it('selectNodes returns node lists for list-context rules (bookList/chapterList)', () => {
    const $ = parseHtml('<div id="list"><a href="/1.html">一</a><a href="/2.html">二</a></div>');
    const nodes = selectNodes($, [$.root().get(0)!], 'id.list.0@tag.a');
    expect(nodes.map((n) => $(n).attr('href'))).toEqual(['/1.html', '/2.html']);
  });

  it('bare terminal rules (no selector step) read the scope node itself', () => {
    const $ = parseHtml('<a href="/x.html">章节标题</a>');
    const node = [$('a').get(0)!];
    expect(extractValue($, node, 'text')).toBe('章节标题');
    expect(extractValue($, node, 'href')).toBe('/x.html');
  });

  it('returns empty string for an empty rule', () => {
    const $ = parseHtml('<div></div>');
    expect(extractValue($, [$.root().get(0)!], '')).toBe('');
    expect(extractValue($, [$.root().get(0)!], undefined)).toBe('');
  });

  it('keeps the static selector before an @js suffix without executing it', () => {
    const $ = parseHtml('<a href="/book/1">书名</a>');
    const node = [$('a').get(0)!];
    expect(extractValue($, node, 'href@js:java.ajax(result)')).toBe('/book/1');
  });

  it('supports descendant CSS selectors used by shorthand Legado rules', () => {
    const $ = parseHtml(`
      <div class="bookbox">
        <h4 class="bookname"><a href="/47/">我真没想重生啊</a></h4>
        <div class="cat"><a href="/47/38307.html">最新章节</a></div>
      </div>
    `);
    const node = [$('.bookbox').get(0)!];

    expect(extractValue($, node, '.bookname a@text')).toBe('我真没想重生啊');
    expect(extractValue($, node, '.bookname a@href')).toBe('/47/');
    expect(extractValue($, node, '.cat a@text')).toBe('最新章节');
    expect(selectNodes($, node, '.bookname a')).toHaveLength(1);
  });

  it('treats space-separated class rules as multiple classes', () => {
    const $ = parseHtml('<div class="book clearfix">结果</div><div class="book">忽略</div>');
    const root = [$.root().get(0)!];
    expect(extractValue($, root, 'class.book clearfix@text')).toBe('结果');
    expect(selectNodes($, root, 'class.book clearfix')).toHaveLength(1);
  });

  it('uses the first matching || alternative for list selectors', () => {
    const $ = parseHtml('<div id="bookdetail"></div><table class="grid"><tr></tr></table>');
    const root = [$.root().get(0)!];
    expect(selectNodes($, root, 'class.missing@tag.tr||id.bookdetail')).toHaveLength(1);
    expect(selectNodes($, root, 'class.grid@tag.tr||id.bookdetail')[0]?.name).toBe('tr');
  });
});
