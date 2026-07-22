import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pagesDir = path.join(__dirname, 'pages');
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

/**
 * Hand-authored HTML fixtures mimicking a deqixs.com-style novel site's DOM
 * shape (never real scraped content) — see test/fixtures/pages/*.html.
 */
const ROUTES: Record<string, string> = {
  '/tag/search.html': 'search.html',
  '/xiaoshuo/1001.html': 'book.html',
  '/xiaoshuo/1001_2.html': 'book_page2.html',
  '/xiaoshuo/1001/1.html': 'chapter1.html',
  '/xiaoshuo/1001/1b.html': 'chapter1b.html',
};

const JSON_ROUTES: Record<string, unknown> = {
  '/api/search': {
    data: [
      {
        book_id: '1001',
        title: '接口之书',
        author_name: 'API 作者',
        category_name: '科幻',
        cover_url: '/covers/1001.jpg',
      },
    ],
  },
  '/api/books/1001': {
    book_id: '1001',
    title: '接口之书',
    author_name: 'API 作者',
    intro: '来自 JSON API 的详情。',
    category_name: '科幻',
    cover_url: '/covers/1001.jpg',
  },
  '/api/books/1001/chapters': {
    data: [
      { book_id: '1001', chapter_id: 'c-1', chapter_title: '第一章 接口' },
      { book_id: '1001', chapter_id: 'c-2', chapter_title: '第二章 映射' },
    ],
  },
  '/api/books/1001/chapters/c-1': { data: { content: 'JSON 正文第一章。' } },
  '/api/books/1001/chapters/c-2': { data: { content: 'JSON 正文第二章。' } },
};

export interface FixtureStats {
  coverRequests: Record<string, number>;
  activeCoverRequests: number;
  maxActiveCoverRequests: number;
  connectionCount: number;
  abortedCoverRequests: number;
}

export async function startFixtureServer(): Promise<{ server: Server; baseUrl: string; stats: FixtureStats }> {
  let oneShotExploreRequests = 0;
  const stats: FixtureStats = {
    coverRequests: {},
    activeCoverRequests: 0,
    maxActiveCoverRequests: 0,
    connectionCount: 0,
    abortedCoverRequests: 0,
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://fixture.local');
    if (url.pathname === '/cross-origin-search') {
      const html = await readFile(path.join(pagesDir, 'search.html'), 'utf8');
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(
        html.replaceAll('href="/xiaoshuo/', `href="http://localhost:${port}/xiaoshuo/`),
      );
      return;
    }
    if (url.pathname === '/cookie-search') {
      const key = url.searchParams.get('key') ?? '';
      const expected = `session=${Buffer.from(key).toString('base64url')}`;
      if (!req.headers.cookie?.includes(expected)) {
        res.writeHead(403, {
          'Content-Type': 'text/html; charset=utf-8',
          'Set-Cookie': `${expected}; Path=/; HttpOnly`,
        }).end('session required');
        return;
      }
      const html = await readFile(path.join(pagesDir, 'search.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html);
      return;
    }
    if (url.pathname === '/browser-search') {
      res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' }).end(
        '<html><title>Just a moment...</title><body>Cloudflare challenge</body></html>',
      );
      return;
    }
    if (url.pathname === '/one-shot-explore') {
      oneShotExploreRequests += 1;
      if (oneShotExploreRequests > 1) {
        res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' }).end('rate limited');
        return;
      }
      const html = await readFile(path.join(pagesDir, 'search.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html);
      return;
    }
    if (url.pathname === '/covers/1001.jpg' || url.pathname === '/covers/1002.jpg') {
      stats.coverRequests[url.pathname] = (stats.coverRequests[url.pathname] ?? 0) + 1;
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': ONE_PIXEL_PNG.length }).end(ONE_PIXEL_PNG);
      return;
    }
    if (/^\/covers\/pool-\d+\.jpg$/.test(url.pathname)) {
      stats.coverRequests[url.pathname] = (stats.coverRequests[url.pathname] ?? 0) + 1;
      stats.activeCoverRequests += 1;
      stats.maxActiveCoverRequests = Math.max(stats.maxActiveCoverRequests, stats.activeCoverRequests);
      await new Promise((resolve) => setTimeout(resolve, 25));
      stats.activeCoverRequests -= 1;
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': ONE_PIXEL_PNG.length }).end(ONE_PIXEL_PNG);
      return;
    }
    if (url.pathname === '/covers/cache.jpg') {
      stats.coverRequests[url.pathname] = (stats.coverRequests[url.pathname] ?? 0) + 1;
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': ONE_PIXEL_PNG.length }).end(ONE_PIXEL_PNG);
      return;
    }
    if (url.pathname === '/covers/stale.jpg') {
      stats.coverRequests[url.pathname] = (stats.coverRequests[url.pathname] ?? 0) + 1;
      if (stats.coverRequests[url.pathname] > 1) {
        req.socket.destroy();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': ONE_PIXEL_PNG.length }).end(ONE_PIXEL_PNG);
      return;
    }
    if (url.pathname === '/covers/abort.jpg') {
      stats.coverRequests[url.pathname] = (stats.coverRequests[url.pathname] ?? 0) + 1;
      let completed = false;
      res.once('close', () => {
        if (!completed) stats.abortedCoverRequests += 1;
      });
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      if (res.destroyed) return;
      completed = true;
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': ONE_PIXEL_PNG.length }).end(ONE_PIXEL_PNG);
      return;
    }
    if (url.pathname === '/covers/not-image.jpg') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end('<html>challenge</html>');
      return;
    }
    if (url.pathname === '/covers/large.jpg') {
      res.writeHead(200, { 'Content-Type': 'image/jpeg' });
      res.write(Buffer.alloc(180, 1));
      res.end(Buffer.alloc(180, 2));
      return;
    }
    if (url.pathname === '/covers/slow.jpg') {
      await new Promise((resolve) => setTimeout(resolve, 200));
      res.writeHead(200, { 'Content-Type': 'image/png' }).end(ONE_PIXEL_PNG);
      return;
    }
    if (url.pathname === '/covers/redirect.jpg') {
      res.writeHead(302, { Location: '/covers/1001.jpg' }).end();
      return;
    }
    if (url.pathname === '/covers/cross-origin.jpg') {
      res.writeHead(302, { Location: 'http://127.0.0.1:1/metadata' }).end();
      return;
    }
    if (url.pathname === '/covers/fail.jpg') {
      req.socket.destroy();
      return;
    }
    const json = JSON_ROUTES[url.pathname];
    if (json) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(json));
      return;
    }
    const file = ROUTES[url.pathname];
    if (!file) {
      res.writeHead(404).end('not found');
      return;
    }
    const html = await readFile(path.join(pagesDir, file), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html);
  });
  server.on('connection', () => {
    stats.connectionCount += 1;
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { server, baseUrl: `http://127.0.0.1:${port}`, stats };
}
