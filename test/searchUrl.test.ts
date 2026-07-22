import { describe, expect, it } from 'vitest';
import { cleanSourceBaseUrl, parseSearchUrl, parseLegadoJsonObject } from '../src/legado/searchUrl.js';
import { extractValue, parseHtml, selectNodes } from '../src/legado/selector.js';
import { CookieJar } from '../src/legado/cookieJar.js';

describe('parseSearchUrl', () => {
  it('parses plain GET templates', () => {
    const p = parseSearchUrl('/tag/?key={{key}}&page={{page}}', { key: '书生', page: 2 });
    expect(p.kind).toBe('http');
    expect(p.method).toBe('GET');
    expect(p.path).toBe('/tag/?key=%E4%B9%A6%E7%94%9F&page=2');
  });

  it('supports safe page arithmetic in URL templates', () => {
    const p = parseSearchUrl('/search-{{key}}-{{page-1}}.html', { key: '书生', page: 2 });
    expect(p.path).toBe('/search-%E4%B9%A6%E7%94%9F-1.html');
  });

  it('parses POST body + charset + method with single-quoted options', () => {
    const p = parseSearchUrl(
      "/modules/article/search.php,{'charset':'gbk','body':'searchkey={{key}}','method':'POST'}",
      { key: '书生' },
    );
    expect(p.kind).toBe('http');
    expect(p.method).toBe('POST');
    expect(p.charset).toBe('gbk');
    expect(p.body).toBe('searchkey=书生');
    expect(p.path).toBe('/modules/article/search.php');
  });

  it('flags pure @js: searchUrls', () => {
    const p = parseSearchUrl('@js:\nfunction getUrl(key){ return baseUrl; }', { key: 'x' });
    expect(p.kind).toBe('js');
  });

  it('uses a static URL after a JS prelude without executing the prelude', () => {
    const p = parseSearchUrl('<js>java.startBrowserAwait(baseUrl)</js>/search/{{key}}/1.html', { key: '书生' });
    expect(p.kind).toBe('http');
    expect(p.path).toBe('/search/%E4%B9%A6%E7%94%9F/1.html');
  });

  it('extracts a literal URL assignment from a JS wrapper without running it', () => {
    const p = parseSearchUrl(
      '@js:url=baseUrl+"/so/{{key}}.html,{\'method\':\'GET\'}";java.ajax(url);result=url;',
      { key: '书生' },
    );
    expect(p.kind).toBe('http');
    expect(p.method).toBe('GET');
    expect(p.path).toBe('/so/%E4%B9%A6%E7%94%9F.html');
  });

  it('cleans ## suffix on bookSourceUrl', () => {
    expect(cleanSourceBaseUrl('https://novelapi.kpkpo.com##')).toBe('https://novelapi.kpkpo.com');
  });

  it('parses legado option objects', () => {
    const o = parseLegadoJsonObject("{'method':'POST','body':'s={{key}}'}");
    expect(o?.method).toBe('POST');
    expect(o?.body).toBe('s={{key}}');
  });

  it('parses string-encoded headers and a duplicated opening brace', () => {
    const p = parseSearchUrl(
      '/search,{{"charset":"gbk"}',
      { key: 'x' },
    );
    expect(p.charset).toBe('gbk');
    const withHeaders = parseSearchUrl(
      "/search,{'headers':\"{'User-Agent':'mobile'}\"}",
      { key: 'x' },
    );
    expect(withHeaders.headers['User-Agent']).toBe('mobile');
  });
});

describe('selector CSS dialect', () => {
  it('selects via @css: and .class shorthand', () => {
    const $ = parseHtml(`
      <div id="ListContents">
        <div style="margin:1px" class="row"><a href="/1">A</a></div>
        <div style="margin:1px" class="row"><a href="/2">B</a></div>
      </div>
      <div class="odd">作者甲</div>
    `);
    const root = [$.root().get(0)!];
    const nodes = selectNodes($, root, "@css:#ListContents>div[style*='margin']");
    expect(nodes.length).toBe(2);
    expect(extractValue($, root, '.odd.0@text')).toBe('作者甲');
  });

  it('supports #id@tbody@tr!0 exclusion style chains', () => {
    const $ = parseHtml(`
      <table id="author"><tbody>
        <tr><td>表头</td></tr>
        <tr class="odd"><td><a href="/b/1">书名</a></td><td class="odd">作者</td></tr>
      </tbody></table>
    `);
    const root = [$.root().get(0)!];
    const rows = selectNodes($, root, '#author@tbody@tr!0');
    expect(rows.length).toBe(1);
    expect(extractValue($, rows, 'a.0@text')).toBe('书名');
  });
});

describe('CookieJar', () => {
  it('stores Set-Cookie and emits Cookie header', () => {
    const jar = new CookieJar();
    const url = new URL('https://example.com/books/1');
    jar.absorbSetCookie(url, ['PHPSESSID=abc; Path=/', 'other=1; HttpOnly']);
    expect(jar.cookieHeader(url)?.split('; ').sort()).toEqual(['PHPSESSID=abc', 'other=1'].sort());
    jar.seedFromHeader(url, 'PHPSESSID=xyz; keep=2');
    expect(jar.cookieHeader(url)).toContain('PHPSESSID=xyz');
    expect(jar.cookieHeader(url)).toContain('keep=2');
  });

  it('honors Cookie domain, path, secure, and expiry attributes', () => {
    const jar = new CookieJar();
    const origin = new URL('https://www.example.com/account/login');
    jar.absorbSetCookie(origin, [
      'domainWide=1; Domain=example.com; Path=/',
      'accountOnly=1; Path=/account; Secure',
      'expired=1; Max-Age=0; Path=/',
    ]);

    expect(jar.cookieHeader(new URL('https://api.example.com/books'))).toBe('domainWide=1');
    expect(jar.cookieHeader(new URL('https://www.example.com/account/profile'))).toContain('accountOnly=1');
    expect(jar.cookieHeader(new URL('http://www.example.com/account/profile'))).not.toContain('accountOnly=1');
    expect(jar.cookieHeader(origin)).not.toContain('expired=1');
  });
});
