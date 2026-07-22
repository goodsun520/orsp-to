#!/usr/bin/env node

/**
 * Resets aggregate adapter metrics without changing stored Legado rules.
 * Usage: DATA_DIR=... node scripts/reset-source-stats.mjs --apply [source-id]
 */

import path from 'node:path';
import { SourceRegistry } from '../dist/orsp/registry.js';

const dataDir = process.env.DATA_DIR ?? path.resolve('data/sources');
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const sourceId = args.find((arg) => arg !== '--apply' && !arg.startsWith('-'));

if (!apply) {
  throw new Error('Refusing to reset metrics without --apply.');
}

const registry = new SourceRegistry(dataDir);
await registry.load();
const ids = sourceId ? [sourceId] : registry.list().map((record) => record.id);
const resetIds = [];

for (const id of ids) {
  if (await registry.resetStats(id)) resetIds.push(id);
  else if (sourceId) throw new Error(`Unknown source: ${id}`);
}

console.log(JSON.stringify({ dataDir, resetIds, resetAt: new Date().toISOString() }));
