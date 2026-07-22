import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { converterTermsVersion } from '../src/orsp/protocol.js';

const publicIndexPath = path.join(process.cwd(), 'public', 'index.html');

describe('public ORSP converter UI', () => {
  it('uses the ORSP-only public brand and includes the repository callout', async () => {
    const html = await readFile(publicIndexPath, 'utf8');

    expect(html).not.toMatch(/legado/i);
    expect(html).toContain('ORSP 转换器');
    expect(html).toContain('将书源转换为 ORSP 格式');
    expect(html).toContain('https://github.com/miloquinn/orsp-converter');
    expect(html).toContain('https://api.github.com/repos/miloquinn/open-reading');
    expect(html).toContain('这么好的仓库不点 Star，你良心过得去吗？');
    expect(html).toContain('本项目不提供任何书籍内容，也不提供、销售或推荐任何书源');
    expect(html).toContain('测试后请尽快删除临时获取、缓存或导出的内容');
    expect(html).toContain('open-reading 权利反馈');
  });

  it('requires explicit terms and lawful-access confirmation before conversion', async () => {
    const html = await readFile(publicIndexPath, 'utf8');

    expect(html).toContain('role="dialog"');
    expect(html).toContain('id="rights-confirmed"');
    expect(html).toContain('id="terms-confirmed"');
    expect(html).toContain('id="accept-terms" type="button" disabled');
    expect(html).toContain(`const TERMS_VERSION = '${converterTermsVersion}'`);
    expect(html).toContain('acceptedTerms: true');
    expect(html).toContain('rightsConfirmed: true');
  });

  it('uploads collection files through bounded asynchronous conversion jobs', async () => {
    const html = await readFile(publicIndexPath, 'utf8');

    expect(html).toContain("const ACTIVE_JOB_KEY = 'orsp_active_conversion_job'");
    expect(html).toContain('const BATCH_CHUNK_SIZE = 25');
    expect(html).toContain('const BATCH_CHUNK_MAX_BYTES = 900 * 1024');
    expect(html).toContain('const BATCH_JOB_MAX_BYTES = 32 * 1024 * 1024');
    expect(html).toContain('buildBatchChunks(sources)');
    expect(html).toContain("requestJson('/api/conversion-jobs'");
    expect(html).toContain('expectedTotal: sources.length');
    expect(html).toContain('/chunks`');
    expect(html).toContain('JSON.stringify({ sources: chunk })');
    expect(html).toContain('/seal`');
    expect(html).toContain('pollBatchJob(jobId)');
    expect(html).toContain('localStorage.setItem(ACTIVE_JOB_KEY, jobId)');
    expect(html).toContain('?summary=1`');
    expect(html).toContain('/cancel`');
    expect(html).toContain('data?.progress?.expectedTotal ?? data?.progress?.total');
    expect(html).toContain('id="batch-skipped"');
    expect(html).toContain('const terminalCount = succeeded + skipped + failed');
    expect(html).toContain('复制全部成功地址');
    expect(html).toContain('导出 JSON');
    expect(html).toContain('导出 CSV');
    expect(html).toContain("if (/^[\\t\\r ]*[=+\\-@]/.test(text))");
    expect(html).toContain('失败项目');
    expect(html).toContain('跳过项目（不计为失败）');
    expect(html).toContain('items.filter(batchItemSkipped)');
  });

  it('offers retry after a completed batch retains failed source items', async () => {
    const html = await readFile(publicIndexPath, 'utf8');

    expect(html).toContain("snapshot.status === 'completed' && snapshot.failed > 0");
    expect(html).toContain('仅重试失败项');
    expect(html).toContain('/retry`');
    expect(html).toContain("{ method: 'POST' }");
    expect(html).toContain('pollBatchJob(jobId)');
  });

  it('keeps single objects and URL input on the synchronous route while batching pasted arrays', async () => {
    const html = await readFile(publicIndexPath, 'utf8');

    expect(html).toContain('if (Array.isArray(parsed))');
    expect(html.match(/if \(Array\.isArray\(parsed\)\)/g)).toHaveLength(2);
    expect(html).toContain('await startBatchConversion(parsed)');
    expect(html).toContain("requestJson('/api/convert'");
    expect(html).toContain('body = { url: urlInput.value.trim() }');
    expect(html).toContain('const parsed = JSON.parse(pasteInput.value)');
    expect(html).toContain('body = { source: parsed }');
    expect(html).toContain('const items = Array.isArray(data.items) ? data.items : []');
    expect(html).toContain("items.filter((item) => item?.status === 'failed')");
    expect(html).toContain("items.filter((item) => item?.status === 'skipped')");
  });
});
