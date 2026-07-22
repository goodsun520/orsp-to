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
});
