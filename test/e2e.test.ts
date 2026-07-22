import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/orsp/server.js';
import { SourceRegistry } from '../src/orsp/registry.js';
import type { LegadoBookSource } from '../src/legado/types.js';
import { startFixtureServer, type FixtureStats } from './fixtures/server.js';
import { ensurePublicTarget, UnsafeTargetError } from '../src/legado/fetchSource.js';
import { converterTermsVersion } from '../src/orsp/protocol.js';

const conversionConsent = {
  acceptedTerms: true,
  rightsConfirmed: true,
  termsVersion: converterTermsVersion,
};

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for fixture state');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

let fixtureServer: Server;
let appServer: Server;
let strictServer: Server;
let fixtureBaseUrl: string;
let fixtureStats: FixtureStats;
let appBaseUrl: string;
let strictAppBaseUrl: string;
let dataDir: string;
let sourceId: string;
let apiSourceId: string;
let staleExploreSourceId: string;
let misassignedCoverSourceId: string;
let registry: SourceRegistry;

function fixtureSource(bookSourceUrl: string): LegadoBookSource {
  return {
    bookSourceName: '示例小说站（fixture）',
    bookSourceUrl,
    enabled: true,
    searchUrl: '/tag/search.html?key={{key}}',
    ruleSearch: {
      bookList: 'class.item',
      name: 'tag.h3.0@tag.a.0@text',
      author: 'tag.p.1@tag.a.0@text##作者：',
      kind: 'tag.p.0@tag.span[0:1]@text',
      lastChapter: 'tag.li.0@tag.a.0@text',
      bookUrl: 'tag.a.0@href',
      coverUrl: 'tag.img.0@src',
    },
    ruleBookInfo: {
      name: 'class.itemtxt.0@tag.h1.0@tag.a.0@text',
      author: 'class.itemtxt.0@tag.p.1@tag.a.0@text',
      coverUrl: 'class.item.0@tag.img.0@src',
      intro: 'class.des.0@tag.p.0@text',
      kind: 'class.itemtxt.0@tag.p.0@tag.span[0:1]@text',
      lastChapter: 'class.itemtxt.0@tag.li.0@tag.a.0@text',
      wordCount: 'class.itemtxt.0@tag.h1.0@tag.i.0@text',
    },
    ruleToc: {
      chapterList: 'id.list.0@tag.a',
      chapterName: 'text',
      chapterUrl: 'href',
      nextTocUrl: 'id.pages.0@class.gr.0@href',
    },
    ruleContent: {
      content: 'class.con.0@tag.p@text',
      nextContentUrl: 'class.prenext.0@tag.span.-1@text.下一页.0@href',
    },
    // Several real Legado sources use relative explore paths and leave
    // ruleExplore empty because Legado reuses the search list selectors.
    exploreUrl: [
      '推荐::tag/search.html?key=遨游&page={{page}}',
      '限频分类::/one-shot-explore?page={{page}}',
      '失效分类::/empty-explore?page={{page}}',
    ].join('\n'),
    ruleExplore: {},
  };
}

function apiFixtureSource(bookSourceUrl: string): LegadoBookSource {
  return {
    bookSourceName: '示例 JSON API 源',
    bookSourceUrl,
    searchUrl: '/api/search?key={{key}}&page={{page}}',
    ruleSearch: {
      bookList: '$..data[*]',
      name: '$.title',
      author: '$.author_name',
      kind: '$.category_name&&$.status',
      coverUrl: '$.cover_url',
      bookUrl: '/api/books/{$.book_id}',
    },
    ruleBookInfo: {
      name: '$.title',
      author: '$.author_name',
      kind: '$.category_name',
      intro: '$.intro',
      coverUrl: '$.cover_url',
      tocUrl: '/api/books/{{@json:book_id}}/chapters',
    },
    ruleToc: {
      chapterList: '$..data[*]',
      chapterName: '$.chapter_title',
      chapterUrl: '/api/books/{$.book_id}/chapters/{{@json:chapter_id}}',
    },
    ruleContent: { content: '$.data.content' },
  };
}

function staleExploreFixtureSource(bookSourceUrl: string): LegadoBookSource {
  const source = fixtureSource(bookSourceUrl);
  return {
    ...source,
    bookSourceName: '过期发现标题规则测试源',
    exploreUrl: '推荐::/tag/search.html?key=遨游&page={{page}}',
    ruleExplore: {
      ...source.ruleSearch,
      // The wrapper no longer exists upstream; discovery should recover a
      // heading title without changing core search/detail selector behavior.
      name: 'class.removed-wrapper@tag.h3@text',
    },
  };
}

function emptyDiscoveryFixtureSource(bookSourceUrl: string): LegadoBookSource {
  return {
    ...fixtureSource(bookSourceUrl),
    bookSourceName: '发现空壳测试源',
    exploreUrl: '空分类::/empty-explore?page={{page}}',
    ruleExplore: {},
  };
}

function crossOriginFixtureSource(bookSourceUrl: string): LegadoBookSource {
  return {
    ...fixtureSource(bookSourceUrl),
    bookSourceName: '跨域详情测试源',
    searchUrl: '/cross-origin-search?key={{key}}',
    exploreUrl: undefined,
    ruleExplore: undefined,
  };
}

function cookieFixtureSource(bookSourceUrl: string): LegadoBookSource {
  return {
    ...fixtureSource(bookSourceUrl),
    bookSourceName: '普通 Cookie 会话测试源',
    searchUrl: '/cookie-search?key={{key}}',
    enabledCookieJar: true,
    exploreUrl: undefined,
    ruleExplore: undefined,
  };
}

function redirectCookieFixtureSource(bookSourceUrl: string): LegadoBookSource {
  return {
    ...fixtureSource(bookSourceUrl),
    bookSourceName: '重定向 Cookie 会话测试源',
    searchUrl: '/redirect-cookie-search?key={{key}}',
    enabledCookieJar: true,
    exploreUrl: undefined,
    ruleExplore: undefined,
  };
}

function browserChallengeFixtureSource(bookSourceUrl: string): LegadoBookSource {
  return {
    ...fixtureSource(bookSourceUrl),
    bookSourceName: '浏览器 Cookie 测试源',
    searchUrl: '/browser-search?key={{key}}',
    exploreUrl: undefined,
    ruleExplore: undefined,
    startBrowserAwait: '需要浏览器完成 Cloudflare 人机验证',
  };
}

function misassignedCoverFixtureSource(bookSourceUrl: string): LegadoBookSource {
  const source = fixtureSource(bookSourceUrl);
  return {
    ...source,
    bookSourceName: '封面误写入简介测试源',
    ruleSearch: {
      ...source.ruleSearch,
      intro: 'tag.img.0@src',
      coverUrl: undefined,
    },
    ruleBookInfo: {
      ...source.ruleBookInfo,
      intro: undefined,
    },
    exploreUrl: '推荐::/tag/search.html?key=遨游&page={{page}}',
  };
}

beforeAll(async () => {
  const fixture = await startFixtureServer();
  fixtureServer = fixture.server;
  fixtureBaseUrl = fixture.baseUrl;
  fixtureStats = fixture.stats;

  dataDir = await mkdtemp(path.join(os.tmpdir(), 'orsp-legado-test-'));
  registry = new SourceRegistry(dataDir);
  await registry.load();
  const { record } = await registry.add(fixtureSource(fixtureBaseUrl));
  sourceId = record.id;
  await registry.setHealth(sourceId, {
    checkedAt: '2026-07-22T00:00:00.000Z',
    status: 'parse_passed',
    discoveryChecked: true,
  });
  const apiBase = new URL('/api-source', fixtureBaseUrl).toString();
  const { record: apiRecord } = await registry.add(apiFixtureSource(apiBase));
  apiSourceId = apiRecord.id;
  const staleExploreBase = new URL('/stale-explore/', fixtureBaseUrl).toString();
  const { record: staleExploreRecord } = await registry.add(staleExploreFixtureSource(staleExploreBase));
  staleExploreSourceId = staleExploreRecord.id;
  const misassignedCoverBase = new URL('/misassigned-cover/', fixtureBaseUrl).toString();
  const { record: misassignedCoverRecord } = await registry.add(
    misassignedCoverFixtureSource(misassignedCoverBase),
  );
  misassignedCoverSourceId = misassignedCoverRecord.id;

  const app = createApp(registry, 'http://app.local', '', {
    allowPrivateAddressesForTesting: true,
    maxBytes: 256,
    timeoutMs: 150,
    maxConnectionsPerOrigin: 3,
    cacheFreshMs: 100,
    cacheStaleMs: 5_000,
    cacheMaxBytes: 1024 * 1024,
  });
  await new Promise<void>((resolve) => {
    appServer = app.listen(0, '127.0.0.1', () => {
      const address = appServer.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      appBaseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });

  const strictApp = createApp(registry, 'http://app.local');
  await new Promise<void>((resolve) => {
    strictServer = strictApp.listen(0, '127.0.0.1', () => {
      const address = strictServer.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      strictAppBaseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise((resolve) => strictServer.close(resolve));
  await new Promise((resolve) => appServer.close(resolve));
  await new Promise((resolve) => fixtureServer.close(resolve));
  await registry.flushPendingWrites();
  await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

describe('ORSP adapter against a self-authored fixture site', () => {
  it('serves a spec-shaped discovery document', async () => {
    const res = await fetch(`${appBaseUrl}/s/${sourceId}/.well-known/open-reading-source.json`);
    expect(res.status).toBe(200);
    const doc = await res.json();
    expect(doc.protocol).toBe('open-reading-source');
    expect(doc.protocolVersion).toMatch(/^1\.\d+$/);
    expect(doc.id).toBe(sourceId);
    expect(doc.apiBaseUrl).toBe(`http://app.local/s/${sourceId}/api/`);
    expect(doc.capabilities).toEqual(expect.arrayContaining(['search', 'detail', 'catalog', 'content']));
    expect(doc.capabilities).toEqual(expect.arrayContaining(['discover', 'categories', 'browse']));
    expect(doc.supportedVersions).toEqual(['1.4']);
    expect(doc.maxCatalogPageSize).toBe(200);
    expect(doc.contentLicense).toContain('Unknown / third-party');
    expect(doc.rightsStatement).toContain('合法访问和使用权限');
    expect(doc.rightsStatement).toContain('尽快删除');
    expect(doc.contactUrl).toContain('rights_report.yml');
  });

  it('maps a Legado explore shelf to discover, categories, and browse', async () => {
    const discoverRes = await fetch(`${appBaseUrl}/s/${sourceId}/api/v1/discover`);
    expect(discoverRes.status).toBe(200);
    const discover = await discoverRes.json();
    expect(discover.sections).toHaveLength(2);
    const recommended = discover.sections.find((section: { title: string }) => section.title === '推荐');
    expect(recommended.items).toHaveLength(2);
    expect(recommended.items[0].coverUrl).toMatch(
      new RegExp(`^http://app\\.local/s/${sourceId}/api/v1/assets/covers/c-`),
    );

    const categoriesRes = await fetch(`${appBaseUrl}/s/${sourceId}/api/v1/categories`);
    const categories = await categoriesRes.json();
    expect(categories.items).toHaveLength(2);
    expect(categories.items[0].name).toBe('推荐');

    const browseRes = await fetch(
      `${appBaseUrl}/s/${sourceId}/api/v1/browse?category=${encodeURIComponent(categories.items[0].id)}&pageSize=1`,
    );
    expect(browseRes.status).toBe(200);
    const browse = await browseRes.json();
    expect(browse.items).toHaveLength(1);
    expect(browse.hasMore).toBe(true);
    expect(browse.items[0].coverUrl).toMatch(
      new RegExp(`^http://app\\.local/s/${sourceId}/api/v1/assets/covers/c-`),
    );

    const fullBrowseRes = await fetch(
      `${appBaseUrl}/s/${sourceId}/api/v1/browse?category=${encodeURIComponent(categories.items[0].id)}&pageSize=2`,
    );
    const fullBrowse = await fullBrowseRes.json();
    expect(fullBrowse.items).toHaveLength(2);
    expect(fullBrowse.hasMore).toBe(true);

    const rateLimitedCategory = categories.items.find((item: { name: string }) => item.name === '限频分类');
    const cachedBrowseRes = await fetch(
      `${appBaseUrl}/s/${sourceId}/api/v1/browse?category=${encodeURIComponent(rateLimitedCategory.id)}&pageSize=2`,
    );
    expect(cachedBrowseRes.status).toBe(200);
    expect((await cachedBrowseRes.json()).items).toHaveLength(2);

    const ungroupedPageTwo = await fetch(`${appBaseUrl}/s/${sourceId}/api/v1/browse?page=2`);
    expect(ungroupedPageTwo.status).toBe(503);
  });

  it('recovers discovery titles when only the explore title selector is stale', async () => {
    const response = await fetch(`${appBaseUrl}/s/${staleExploreSourceId}/api/v1/discover`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.sections[0].items.map((item: { title: string }) => item.title)).toEqual([
      '遨游星海',
      '星海遨游番外',
    ]);
  });

  it('only reports conversion success after complete metadata and reading checks', async () => {
    const response = await fetch(`${appBaseUrl}/api/convert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: fixtureSource(fixtureBaseUrl), ...conversionConsent }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.errors).toEqual([]);
    expect(body.converted).toHaveLength(1);
    expect(body.converted[0]).toMatchObject({
      id: sourceId,
      alreadyExisted: true,
      health: {
        status: 'parse_passed',
        discoveryChecked: true,
        stages: {
          discover: { status: 'ok' },
          categories: { status: 'ok' },
          browse: { status: 'ok' },
        },
      },
    });
  });

  it('does not advertise discovery capabilities when only core reading passes', async () => {
    const candidateBase = new URL('/empty-discovery/', fixtureBaseUrl).toString();
    const response = await fetch(`${appBaseUrl}/api/convert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: emptyDiscoveryFixtureSource(candidateBase), ...conversionConsent }),
    });
    const body = await response.json();

    expect(body.errors).toEqual([]);
    expect(body.converted).toHaveLength(1);
    expect(body.converted[0].health).toMatchObject({ status: 'parse_passed', discoveryChecked: false });

    const manifest = await (
      await fetch(`${appBaseUrl}/s/${body.converted[0].id}/.well-known/open-reading-source.json`)
    ).json();
    expect(manifest.capabilities).toEqual(expect.arrayContaining(['search', 'detail', 'catalog', 'content']));
    expect(manifest.capabilities).not.toEqual(expect.arrayContaining(['discover', 'categories', 'browse']));
  });

  it('rejects a candidate whose direct audit passes but public detail URL scope would fail', async () => {
    const response = await fetch(`${appBaseUrl}/api/convert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: crossOriginFixtureSource(fixtureBaseUrl), ...conversionConsent }),
    });
    const body = await response.json();

    expect(body.converted).toEqual([]);
    expect(body.errors[0]).toContain('route_contract');
    expect(registry.get(sourceId)?.legado.bookSourceName).toBe('示例小说站（fixture）');
  });

  it('retries an ordinary Set-Cookie session gate within the same search request', async () => {
    const response = await fetch(`${appBaseUrl}/api/convert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: cookieFixtureSource(fixtureBaseUrl), ...conversionConsent }),
    });
    const body = await response.json();

    expect(body.errors).toEqual([]);
    expect(body.converted).toHaveLength(1);
  });

  it('keeps cookies set on redirects during an ordinary HTTP session', async () => {
    const response = await fetch(`${appBaseUrl}/api/convert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: redirectCookieFixtureSource(new URL('/redirect-session/', fixtureBaseUrl).toString()),
        ...conversionConsent,
      }),
    });
    const body = await response.json();

    expect(body.errors).toEqual([]);
    expect(body.converted).toHaveLength(1);
  });

  it('reports mixed collection outcomes by index and source name', async () => {
    const mixedBaseUrl = new URL('/mixed-collection/', fixtureBaseUrl).toString();
    const valid = fixtureSource(mixedBaseUrl);
    valid.bookSourceName = '合集成功源';
    const invalid = { ...fixtureSource(mixedBaseUrl), bookSourceName: '合集失败源', bookSourceUrl: '不是网址' };
    const response = await fetch(`${appBaseUrl}/api/convert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: [valid, invalid], ...conversionConsent }),
    });
    const body = await response.json();

    expect(body.items).toHaveLength(2);
    expect(body.items[0]).toMatchObject({ index: 0, sourceName: '合集成功源', status: 'succeeded' });
    expect(body.items[0].result.discoveryUrl).toContain('/.well-known/open-reading-source.json');
    expect(body.items[1]).toMatchObject({ index: 1, sourceName: '合集失败源', status: 'failed' });
    expect(body.items[1].error).toContain('absolute HTTP(S) URL');
    expect(body.converted).toHaveLength(1);
    expect(body.errors).toHaveLength(1);
  });

  it('completes a successful source through the asynchronous batch API', async () => {
    const candidate = fixtureSource(new URL('/async-batch/', fixtureBaseUrl).toString());
    candidate.bookSourceName = '异步合集成功源';
    const created = await fetch(`${appBaseUrl}/api/conversion-jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedTotal: 1, ...conversionConsent }),
    });
    const job = await created.json();
    expect(created.status).toBe(201);

    const appended = await fetch(`${appBaseUrl}/api/conversion-jobs/${job.jobId}/chunks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sources: [candidate] }),
    });
    expect(appended.status).toBe(200);
    expect((await appended.json()).items[0].sourceName).toBe('异步合集成功源');
    expect((await fetch(`${appBaseUrl}/api/conversion-jobs/${job.jobId}/seal`, { method: 'POST' })).status).toBe(202);

    let snapshot: any;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      snapshot = await (await fetch(`${appBaseUrl}/api/conversion-jobs/${job.jobId}`)).json();
      if (snapshot.status === 'completed') break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(snapshot.status).toBe('completed');
    expect(snapshot.progress).toMatchObject({ succeeded: 1, failed: 0, retainedInputBytes: 0 });
    expect(snapshot.items[0].result.discoveryUrl).toContain('/.well-known/open-reading-source.json');
  });

  it('rejects browser-managed Cookie sources before publishing them', async () => {
    const response = await fetch(`${appBaseUrl}/api/convert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: browserChallengeFixtureSource(fixtureBaseUrl), ...conversionConsent }),
    });
    const body = await response.json();

    expect(body.converted).toEqual([]);
    expect(body.errors[0]).toContain('browser_cookie_unsupported');
    expect(registry.get(sourceId)?.legado.bookSourceName).toBe('普通 Cookie 会话测试源');
  });

  it('search returns fixture books with the right fields', async () => {
    const res = await fetch(`${appBaseUrl}/s/${sourceId}/api/v1/search?q=遨游`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.page).toBe(1);
    expect(body.hasMore).toBe(false);
    expect(body.items).toHaveLength(2);
    const first = body.items[0];
    expect(first.title).toBe('遨游星海');
    expect(first.author).toBe('墨白');
    expect(first.categories).toEqual(['玄幻', '连载中']);
    expect(first.latestChapter).toBe('第99章 最新章节');
    expect(typeof first.id).toBe('string');
    expect(first.id.length).toBeGreaterThan(0);
    expect(first.coverUrl).toMatch(
      new RegExp(`^http://app\\.local/s/${sourceId}/api/v1/assets/covers/c-`),
    );
    expect(first.coverUrl).not.toContain(new URL(fixtureBaseUrl).host);
  });

  it('repairs a list cover stored in intro across search, discover, browse, and detail', async () => {
    const searchResponse = await fetch(
      `${appBaseUrl}/s/${misassignedCoverSourceId}/api/v1/search?q=遨游`,
    );
    const search = await searchResponse.json();
    expect(searchResponse.status).toBe(200);
    expect(search.items[0].description).toBe('');
    expect(search.items[0].coverUrl).toMatch(
      new RegExp(`^http://app\\.local/s/${misassignedCoverSourceId}/api/v1/assets/covers/c-`),
    );

    const discover = await (
      await fetch(`${appBaseUrl}/s/${misassignedCoverSourceId}/api/v1/discover`)
    ).json();
    const discoveredBook = discover.sections[0].items[0];

    const categories = await (
      await fetch(`${appBaseUrl}/s/${misassignedCoverSourceId}/api/v1/categories`)
    ).json();
    const browse = await (
      await fetch(
        `${appBaseUrl}/s/${misassignedCoverSourceId}/api/v1/browse?category=${encodeURIComponent(categories.items[0].id)}`,
      )
    ).json();
    const browsedBook = browse.items[0];

    const detailResponse = await fetch(
      `${appBaseUrl}/s/${misassignedCoverSourceId}/api/v1/books/${search.items[0].id}`,
    );
    const detail = await detailResponse.json();
    expect(detailResponse.status).toBe(200);

    for (const item of [discoveredBook, browsedBook, detail]) {
      expect(item.description).toBe(search.items[0].description);
      expect(item.coverUrl).toBe(search.items[0].coverUrl);
    }

    const coverResponse = await fetch(search.items[0].coverUrl.replace('http://app.local', appBaseUrl));
    expect(coverResponse.status).toBe(200);
    expect(coverResponse.headers.get('content-type')).toMatch(/^image\//);
  });

  it('a second search page is empty since the fixture has no {{page}} support', async () => {
    const res = await fetch(`${appBaseUrl}/s/${sourceId}/api/v1/search?q=遨游&page=2`);
    const body = await res.json();
    expect(body.items).toHaveLength(0);
    expect(body.hasMore).toBe(false);
  });

  it('book detail round-trips through the encoded id', async () => {
    const searchRes = await fetch(`${appBaseUrl}/s/${sourceId}/api/v1/search?q=遨游`);
    const { items } = await searchRes.json();
    const bookId = items[0].id;

    const detailRes = await fetch(`${appBaseUrl}/s/${sourceId}/api/v1/books/${bookId}`);
    expect(detailRes.status).toBe(200);
    const detail = await detailRes.json();
    expect(detail.id).toBe(bookId);
    expect(detail.title).toBe('遨游星海');
    expect(detail.author).toBe('墨白');
    expect(detail.description).toContain('更详细的简介');
    expect(detail.categories).toEqual(['玄幻', '连载中']);
    expect(detail.coverUrl).toMatch(
      new RegExp(`^http://app\\.local/s/${sourceId}/api/v1/assets/covers/c-`),
    );

    return { bookId };
  });

  it('chapter catalog paginates via nextTocUrl and sorts by order', async () => {
    const searchRes = await fetch(`${appBaseUrl}/s/${sourceId}/api/v1/search?q=遨游`);
    const { items } = await searchRes.json();
    const bookId = items[0].id;

    const chaptersRes = await fetch(`${appBaseUrl}/s/${sourceId}/api/v1/books/${bookId}/chapters`);
    expect(chaptersRes.status).toBe(200);
    const body = await chaptersRes.json();
    expect(body.total).toBe(4);
    expect(body.items.map((c: { title: string }) => c.title)).toEqual([
      '第1章 启程',
      '第2章 风暴',
      '第3章 归途',
      '第4章 终章',
    ]);
    expect(body.items.map((c: { order: number }) => c.order)).toEqual([0, 1, 2, 3]);
  });

  it('chapter content concatenates pages followed via nextContentUrl', async () => {
    const searchRes = await fetch(`${appBaseUrl}/s/${sourceId}/api/v1/search?q=遨游`);
    const { items } = await searchRes.json();
    const bookId = items[0].id;
    const chaptersRes = await fetch(`${appBaseUrl}/s/${sourceId}/api/v1/books/${bookId}/chapters`);
    const { items: chapters } = await chaptersRes.json();
    const firstChapterId = chapters[0].id;

    const contentRes = await fetch(`${appBaseUrl}/s/${sourceId}/api/v1/books/${bookId}/chapters/${firstChapterId}`);
    expect(contentRes.status).toBe(200);
    const content = await contentRes.json();
    expect(content.bookId).toBe(bookId);
    expect(content.chapterId).toBe(firstChapterId);
    expect(content.title).toBe('第1章 启程');
    expect(content.contentType).toBe('text/plain');
    expect(content.baseUrl).toBe(`${fixtureBaseUrl}/xiaoshuo/1001/1.html`);
    expect(content.content).toBe('示例正文第一段。\n示例正文第二段。\n\n示例正文第三段（续页）。');
  });

  it('does not count an explicitly marked health check as a reader', async () => {
    const searchRes = await fetch(`${appBaseUrl}/s/${sourceId}/api/v1/search?q=遨游`);
    const { items } = await searchRes.json();
    const chaptersRes = await fetch(`${appBaseUrl}/s/${sourceId}/api/v1/books/${items[0].id}/chapters`);
    const { items: chapters } = await chaptersRes.json();
    const before = registry.get(sourceId)!.stats.readCount;

    const contentRes = await fetch(
      `${appBaseUrl}/s/${sourceId}/api/v1/books/${items[0].id}/chapters/${chapters[0].id}`,
      { headers: { 'X-Open-Reading-Request-Purpose': 'health-check' } },
    );
    expect(contentRes.status).toBe(200);
    expect(registry.get(sourceId)!.stats.readCount).toBe(before);
  });

  it('rejects a cross-source chapter id (same-origin guard)', async () => {
    const foreignId = Buffer.from('https://evil.example/whatever', 'utf8').toString('base64url');
    const searchRes = await fetch(`${appBaseUrl}/s/${sourceId}/api/v1/search?q=遨游`);
    const { items } = await searchRes.json();
    const bookId = items[0].id;
    const res = await fetch(`${appBaseUrl}/s/${sourceId}/api/v1/books/${bookId}/chapters/${foreignId}`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('CHAPTER_NOT_FOUND');
  });

  it('proxies registered cover images with bounded image headers and bytes', async () => {
    const searchRes = await fetch(`${appBaseUrl}/s/${sourceId}/api/v1/search?q=遨游`);
    const search = await searchRes.json();
    const proxy = new URL(search.items[0].coverUrl);
    const response = await fetch(`${appBaseUrl}${proxy.pathname}`);
    const body = Buffer.from(await response.arrayBuffer());

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('cache-control')).toBe('public, max-age=86400');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(body.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  });

  it('bounds and reuses upstream connections for concurrent distinct covers', async () => {
    fixtureStats.maxActiveCoverRequests = 0;
    const connectionsBefore = fixtureStats.connectionCount;
    const assetIds = Array.from({ length: 9 }, (_, index) =>
      registry.registerCoverUrl(sourceId, `${fixtureBaseUrl}/covers/pool-${index}.jpg`),
    );

    const responses = await Promise.all(
      assetIds.map((assetId) => fetch(`${appBaseUrl}/s/${sourceId}/api/v1/assets/covers/${assetId}`)),
    );
    expect(responses.map((response) => response.status)).toEqual(Array(9).fill(200));
    await Promise.all(responses.map((response) => response.arrayBuffer()));
    expect(fixtureStats.maxActiveCoverRequests).toBeLessThanOrEqual(3);
    expect(fixtureStats.connectionCount - connectionsBefore).toBeLessThanOrEqual(3);

    const connectionsAfterFirstWave = fixtureStats.connectionCount;
    const reusedIds = Array.from({ length: 3 }, (_, index) =>
      registry.registerCoverUrl(sourceId, `${fixtureBaseUrl}/covers/pool-${index + 9}.jpg`),
    );
    const reused = await Promise.all(
      reusedIds.map((assetId) => fetch(`${appBaseUrl}/s/${sourceId}/api/v1/assets/covers/${assetId}`)),
    );
    expect(reused.map((response) => response.status)).toEqual(Array(3).fill(200));
    await Promise.all(reused.map((response) => response.arrayBuffer()));
    expect(fixtureStats.connectionCount).toBe(connectionsAfterFirstWave);
  });

  it('coalesces concurrent cover misses and persists successful cache hits', async () => {
    const pathName = '/covers/cache.jpg';
    const before = fixtureStats.coverRequests[pathName] ?? 0;
    const assetId = registry.registerCoverUrl(sourceId, `${fixtureBaseUrl}${pathName}`)!;
    const proxyUrl = `${appBaseUrl}/s/${sourceId}/api/v1/assets/covers/${assetId}`;

    const firstWave = await Promise.all(Array.from({ length: 6 }, () => fetch(proxyUrl)));
    expect(firstWave.map((response) => response.status)).toEqual(Array(6).fill(200));
    await Promise.all(firstWave.map((response) => response.arrayBuffer()));
    expect(fixtureStats.coverRequests[pathName] - before).toBe(1);

    const cached = await fetch(proxyUrl);
    expect(cached.status).toBe(200);
    await cached.arrayBuffer();
    expect(fixtureStats.coverRequests[pathName] - before).toBe(1);
    const cacheFiles = await readdir(path.join(dataDir, '.cover-cache'));
    expect(cacheFiles.some((file) => file.endsWith('.bin'))).toBe(true);
    expect(cacheFiles.some((file) => file.endsWith('.json'))).toBe(true);
  });

  it('serves a validated stale cover when refresh has a transient upstream failure', async () => {
    const pathName = '/covers/stale.jpg';
    const assetId = registry.registerCoverUrl(sourceId, `${fixtureBaseUrl}${pathName}`)!;
    const proxyUrl = `${appBaseUrl}/s/${sourceId}/api/v1/assets/covers/${assetId}`;

    const initial = await fetch(proxyUrl);
    expect(initial.status).toBe(200);
    const initialBody = Buffer.from(await initial.arrayBuffer());
    await new Promise((resolve) => setTimeout(resolve, 120));

    const stale = await fetch(proxyUrl);
    expect(stale.status).toBe(200);
    expect(Buffer.from(await stale.arrayBuffer())).toEqual(initialBody);
    expect(fixtureStats.coverRequests[pathName]).toBe(2);
  });

  it('cancels the upstream cover request when the downstream client disconnects', async () => {
    const pathName = '/covers/abort.jpg';
    const assetId = registry.registerCoverUrl(sourceId, `${fixtureBaseUrl}${pathName}`)!;
    const controller = new AbortController();
    const request = fetch(`${appBaseUrl}/s/${sourceId}/api/v1/assets/covers/${assetId}`, {
      signal: controller.signal,
    });
    await waitFor(() => (fixtureStats.coverRequests[pathName] ?? 0) > 0);
    controller.abort();
    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
    await waitFor(() => fixtureStats.abortedCoverRequests > 0);

    const health = await fetch(`${appBaseUrl}/api/sources`);
    expect(health.status).toBe(200);
  });

  it('returns 404 for unknown source and cover asset IDs', async () => {
    const missingSource = await fetch(`${appBaseUrl}/s/missing/api/v1/assets/covers/c-missing`);
    const missingAsset = await fetch(`${appBaseUrl}/s/${sourceId}/api/v1/assets/covers/c-missing`);

    expect(missingSource.status).toBe(404);
    expect(missingAsset.status).toBe(404);
    expect((await missingAsset.json()).error.message).not.toContain('http');
  });

  it('rejects non-image, oversized, failed, and slow cover responses', async () => {
    const cases = [
      { path: '/covers/not-image.jpg', status: 502, code: 'UPSTREAM_ERROR' },
      { path: '/covers/large.jpg', status: 413, code: 'PAYLOAD_TOO_LARGE' },
      { path: '/covers/fail.jpg', status: 502, code: 'UPSTREAM_ERROR' },
      { path: '/covers/slow.jpg', status: 502, code: 'UPSTREAM_ERROR' },
    ];
    for (const item of cases) {
      const assetId = registry.registerCoverUrl(sourceId, `${fixtureBaseUrl}${item.path}`)!;
      const response = await fetch(`${appBaseUrl}/s/${sourceId}/api/v1/assets/covers/${assetId}`);
      const error = await response.json();
      expect(response.status, item.path).toBe(item.status);
      expect(error.error.code, item.path).toBe(item.code);
      expect(JSON.stringify(error)).not.toContain(fixtureBaseUrl);
    }
  });

  it('follows only same-origin cover redirects and allows only GET', async () => {
    const redirectId = registry.registerCoverUrl(sourceId, `${fixtureBaseUrl}/covers/redirect.jpg`)!;
    const redirected = await fetch(`${appBaseUrl}/s/${sourceId}/api/v1/assets/covers/${redirectId}`);
    expect(redirected.status).toBe(200);
    expect(redirected.headers.get('content-type')).toBe('image/png');

    const crossOriginId = registry.registerCoverUrl(sourceId, `${fixtureBaseUrl}/covers/cross-origin.jpg`)!;
    const crossOrigin = await fetch(`${appBaseUrl}/s/${sourceId}/api/v1/assets/covers/${crossOriginId}`);
    expect(crossOrigin.status).toBe(502);
    expect((await crossOrigin.json()).error.code).toBe('UPSTREAM_ERROR');

    const post = await fetch(`${appBaseUrl}/s/${sourceId}/api/v1/assets/covers/${redirectId}`, { method: 'POST' });
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET, OPTIONS');
  });

  it('does not register cross-origin assets or permit private proxy targets', async () => {
    expect(registry.registerCoverUrl(sourceId, 'https://evil.example/cover.jpg')).toBeNull();
    expect(registry.registerCoverUrl(sourceId, `${fixtureBaseUrl}/${'x'.repeat(9_000)}`)).toBeNull();
    const localAsset = registry.registerCoverUrl(sourceId, `${fixtureBaseUrl}/covers/1001.jpg`)!;
    const strictResponse = await fetch(`${strictAppBaseUrl}/s/${sourceId}/api/v1/assets/covers/${localAsset}`);
    expect(strictResponse.status).toBe(502);
    expect((await strictResponse.json()).error.code).toBe('UPSTREAM_ERROR');

    const blocked = [
      'http://localhost/cover.jpg',
      'http://127.0.0.1/cover.jpg',
      'http://0.0.0.0/cover.jpg',
      'http://[::1]/cover.jpg',
      'http://10.0.0.1/cover.jpg',
      'http://172.16.0.1/cover.jpg',
      'http://192.168.1.1/cover.jpg',
      'http://169.254.169.254/latest/meta-data',
    ];
    for (const url of blocked) {
      await expect(ensurePublicTarget(new URL(url)), url).rejects.toBeInstanceOf(UnsafeTargetError);
    }
  });

  it('serves API-style Legado sources with JSON rules and URL templates', async () => {
    const searchRes = await fetch(`${appBaseUrl}/s/${apiSourceId}/api/v1/search?q=接口`);
    const search = await searchRes.json();
    expect(searchRes.status).toBe(200);
    expect(search.items).toHaveLength(1);
    expect(search.items[0].title).toBe('接口之书');
    expect(search.items[0].categories).toEqual(['科幻', '完结']);
    expect(search.items[0].coverUrl).toMatch(
      new RegExp(`^http://app\\.local/s/${apiSourceId}/api/v1/assets/covers/c-`),
    );

    const bookId = search.items[0].id;
    const detailRes = await fetch(`${appBaseUrl}/s/${apiSourceId}/api/v1/books/${bookId}`);
    expect((await detailRes.json()).description).toBe('来自 JSON API 的详情。');

    const catalogRes = await fetch(`${appBaseUrl}/s/${apiSourceId}/api/v1/books/${bookId}/chapters`);
    const catalog = await catalogRes.json();
    expect(catalog.items.map((item: { title: string }) => item.title)).toEqual(['第一章 接口', '第二章 映射']);

    const contentRes = await fetch(
      `${appBaseUrl}/s/${apiSourceId}/api/v1/books/${bookId}/chapters/${catalog.items[0].id}`,
    );
    const content = await contentRes.json();
    expect(contentRes.status).toBe(200);
    expect(content.title).toBe('第一章 接口');
    expect(content.content).toBe('JSON 正文第一章。');
  });

  it('supports conditional GET, strict pagination, and standard 405 responses', async () => {
    const discoveryUrl = `${appBaseUrl}/s/${sourceId}/.well-known/open-reading-source.json`;
    const first = await fetch(discoveryUrl);
    const etag = first.headers.get('etag');
    expect(etag).toBeTruthy();
    expect(first.headers.get('x-open-reading-protocol')).toBe('1.4');

    const unchanged = await fetch(discoveryUrl, { headers: { 'If-None-Match': etag! } });
    expect(unchanged.status).toBe(304);
    expect(await unchanged.text()).toBe('');

    const invalidPage = await fetch(`${appBaseUrl}/s/${sourceId}/api/v1/search?q=测试&page=1oops`);
    expect(invalidPage.status).toBe(400);

    const wrongMethod = await fetch(`${appBaseUrl}/s/${sourceId}/api/v1/search?q=测试`, { method: 'POST' });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get('allow')).toBe('GET, OPTIONS');
    expect((await wrongMethod.json()).error.code).toBe('METHOD_NOT_ALLOWED');
  });

  it('uses a persisted compact ID when an upstream URL exceeds the ORSP wire limit', async () => {
    const reloadedRegistry = new SourceRegistry(dataDir);
    await reloadedRegistry.load();
    const source = reloadedRegistry.get(sourceId)!;
    const longUrl = `${fixtureBaseUrl}/xiaoshuo/1001.html?token=${'a'.repeat(400)}`;
    const id = reloadedRegistry.encodeUpstreamUrl(source.id, longUrl);

    expect(id).toMatch(/^[A-Za-z0-9._~-]{1,200}$/);
    expect(id).not.toContain('=');
    expect(reloadedRegistry.decodeUpstreamUrl(source.id, id)).toBe(longUrl);
  });
});
