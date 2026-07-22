import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('administrator dashboard UI', () => {
  it('uses GitHub login and exposes reversible hide plus permanent delete controls', async () => {
    const html = await readFile(path.join(process.cwd(), 'public', 'admin.html'), 'utf8');

    expect(html).toContain('/api/admin/github/start');
    expect(html).toContain('使用 GitHub 登录');
    expect(html).toContain('miloquinn');
    expect(html).toContain('/visibility');
    expect(html).toContain('hiddenFromLeaderboard');
    expect(html).toContain('恢复显示');
    expect(html).toContain('永久删除');
    expect(html).toContain('/api/admin/access');
    expect(html).toContain('设置新暗号');
    expect(html).toContain('/api/admin/reports');
    expect(html).toContain('待处理举报');
    expect(html).toContain('下架排行榜');
    expect(html).toContain('忽略举报');
    expect(html).toContain('/api/admin/security');
    expect(html).toContain('IP 安全事件');
    expect(html).toContain('封禁 IP');
    expect(html).toContain('解除封禁');
  });
});
