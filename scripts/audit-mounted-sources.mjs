#!/usr/bin/env node

/**
 * Tests every mounted source through the full adapter path without exposing
 * chapter text. `--apply` removes only sources that fail every bounded probe.
 * Normal scheduled runs deliberately omit `--apply` and only refresh a report.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SourceRegistry } from '../dist/orsp/registry.js';
import { auditLegadoSource } from '../dist/orsp/sourceAudit.js';

const dataDir = process.env.DATA_DIR ?? path.resolve('data/sources');
const reportPath = process.env.AUDIT_REPORT_PATH ?? path.join(path.dirname(dataDir), 'audits', 'latest.json');
const queries = (process.env.AUDIT_QUERIES ?? '斗破苍穹,西游记')
  .split(',')
  .map((query) => query.trim())
  .filter(Boolean);
const apply = process.argv.includes('--apply');

const registry = new SourceRegistry(dataDir);
await registry.load();
const results = [];
const prunedSourceIds = [];
const auditedAt = new Date().toISOString();

for (const record of registry.list()) {
  const started = Date.now();
  const outcome = await auditLegadoSource(record.legado, { queries });
  const result = {
    sourceId: record.id,
    sourceName: record.legado.bookSourceName,
    elapsedMs: Date.now() - started,
    ...outcome,
  };
  results.push(result);
  await registry.setHealthFromAudit(record.id, {
    checkedAt: auditedAt,
    status: outcome.status,
    ...(outcome.query ? { query: outcome.query } : {}),
    stages: outcome.stages,
    ...(outcome.status === 'parse_failed' ? { stage: outcome.stage, reason: outcome.reason } : {}),
    ...(outcome.status === 'parse_passed' ? { discoveryChecked: outcome.discoveryChecked === true } : {}),
  });
  if (apply && outcome.status === 'parse_failed') {
    await registry.remove(record.id);
    prunedSourceIds.push(record.id);
  }
}

const summary = results.reduce(
  (accumulator, result) => {
    accumulator[result.status] = (accumulator[result.status] ?? 0) + 1;
    return accumulator;
  },
  { total: results.length, parse_passed: 0, parse_failed: 0 },
);
const report = {
  auditedAt,
  dataDir,
  queries,
  apply,
  summary,
  prunedSourceIds,
  results,
};

await mkdir(path.dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(report));
