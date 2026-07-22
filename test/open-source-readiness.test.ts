import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (file: string) => readFile(path.join(root, file), 'utf8');

describe('open-source readiness', () => {
  it('keeps deployment-specific infrastructure out of tracked configuration', async () => {
    const [deployScript, gitignore] = await Promise.all([read('deploy/deploy.sh'), read('.gitignore')]);

    expect(deployScript).not.toMatch(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
    expect(deployScript).not.toMatch(/SSH_KEY=.*id_(?:rsa|ed25519)/);
    expect(deployScript).toContain('DEPLOY_HOST');
    expect(gitignore).toContain('.deploy.env');
    expect(gitignore).toContain('*.pem');
    expect(gitignore).toContain('data/');
  });

  it('publishes package metadata and the converter repository URL', async () => {
    const [packageText, publicHtml] = await Promise.all([read('package.json'), read('public/index.html')]);
    const packageJson = JSON.parse(packageText) as {
      private?: boolean;
      license?: string;
      repository?: { url?: string };
    };

    expect(packageJson.private).not.toBe(true);
    expect(packageJson.license).toBe('MIT');
    expect(packageJson.repository?.url).toContain('github.com/miloquinn/orsp-converter');
    expect(publicHtml).toContain('https://github.com/miloquinn/orsp-converter');
  });
});
