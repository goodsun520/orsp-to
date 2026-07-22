import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './orsp/server.js';
import { SourceRegistry } from './orsp/registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const port = Number.parseInt(process.env.PORT ?? '8790', 10);
const publicOrigin = process.env.PUBLIC_ORIGIN ?? `http://127.0.0.1:${port}`;
const dataDir = process.env.DATA_DIR ?? path.join(__dirname, '..', 'data', 'sources');
const adminPassword = process.env.ADMIN_PASSWORD ?? '';
const statsHashKey = process.env.STATS_HASH_KEY;

function positiveEnv(name: string): number | undefined {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

async function main() {
  if (!adminPassword) {
    console.warn('ADMIN_PASSWORD not set — /admin is disabled (all admin logins will fail).');
  }
  if (!statsHashKey) {
    console.warn('STATS_HASH_KEY not set — use a stable secret in production before collecting reader metrics.');
  }
  const registry = new SourceRegistry(dataDir, statsHashKey);
  await registry.load();
  const cacheFreshHours = positiveEnv('COVER_CACHE_FRESH_HOURS');
  const cacheStaleHours = positiveEnv('COVER_CACHE_STALE_HOURS');
  const cacheMaxMb = positiveEnv('COVER_CACHE_MAX_MB');
  const app = createApp(registry, publicOrigin, adminPassword, {
    timeoutMs: positiveEnv('COVER_FETCH_TIMEOUT_MS'),
    maxConnectionsPerOrigin: positiveEnv('COVER_UPSTREAM_CONNECTIONS'),
    cacheDirectory: process.env.COVER_CACHE_DIR?.trim() || undefined,
    cacheFreshMs: cacheFreshHours === undefined ? undefined : cacheFreshHours * 60 * 60 * 1_000,
    cacheStaleMs: cacheStaleHours === undefined ? undefined : cacheStaleHours * 60 * 60 * 1_000,
    cacheMaxBytes: cacheMaxMb === undefined ? undefined : cacheMaxMb * 1024 * 1024,
  });
  app.listen(port, '127.0.0.1', () => {
    console.log(`orsp-converter listening on http://127.0.0.1:${port}`);
    console.log(`Public origin: ${publicOrigin}`);
    console.log(`Loaded ${registry.list().length} stored source(s) from ${dataDir}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
