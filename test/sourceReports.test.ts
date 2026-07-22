import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SourceReportStore } from '../src/orsp/sourceReports.js';

let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe('SourceReportStore', () => {
  it('persists reporter IPs for abuse handling and deduplicates an open report per source and reporter', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'orsp-reports-'));
    const filePath = path.join(tempDir, 'reports.json');
    const reports = new SourceReportStore(filePath, 'report-test-key');
    await reports.load();

    const first = await reports.create({
      sourceId: 'source-a',
      sourceName: '举报测试源',
      websiteUrl: 'https://reported.example/',
      reason: 'unavailable',
      details: '连续无法打开',
    }, '8.8.8.8');
    const duplicate = await reports.create({
      sourceId: 'source-a',
      sourceName: '举报测试源',
      websiteUrl: 'https://reported.example/',
      reason: 'unavailable',
      details: '再次举报',
    }, '8.8.8.8');

    expect(first.created).toBe(true);
    expect(duplicate).toMatchObject({ created: false, report: { id: first.report.id } });
    expect(reports.list()[0].reporterIp).toBe('8.8.8.8');

    const restarted = new SourceReportStore(filePath, 'report-test-key');
    await restarted.load();
    expect(restarted.list()).toHaveLength(1);
    expect(restarted.list()[0]).toMatchObject({ status: 'open', reason: 'unavailable' });
  });

  it('records ignored and hidden resolutions with the administrator identity', async () => {
    const reports = SourceReportStore.ephemeral();
    const ignored = await reports.create({
      sourceId: 'source-a', sourceName: 'A', websiteUrl: 'https://a.example/', reason: 'other', details: '误报',
    }, '1.1.1.1');
    const hidden = await reports.create({
      sourceId: 'source-b', sourceName: 'B', websiteUrl: 'https://b.example/', reason: 'malicious', details: '',
    }, '2.2.2.2');

    expect(await reports.resolve(ignored.report.id, 'ignored', 'miloquinn')).toMatchObject({
      status: 'ignored', resolvedBy: 'miloquinn',
    });
    expect(await reports.resolveOpenForSource('source-b', 'hidden', 'miloquinn')).toBe(1);
    expect(reports.get(hidden.report.id)).toMatchObject({ status: 'hidden', resolvedBy: 'miloquinn' });
  });
});
