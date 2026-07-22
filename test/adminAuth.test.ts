import { describe, expect, it, vi } from 'vitest';
import { AdminAuth, AdminAuthError } from '../src/orsp/adminAuth.js';

function githubFetch(login: string) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url === 'https://github.com/login/oauth/access_token') {
      return new Response(JSON.stringify({ access_token: 'github-token', token_type: 'bearer' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url === 'https://api.github.com/user') {
      return new Response(JSON.stringify({
        login,
        avatar_url: `https://avatars.example/${login}`,
        html_url: `https://github.com/${login}`,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
}

function githubAuth(login: string) {
  return new AdminAuth('', {
    clientId: 'client-id',
    clientSecret: 'client-secret',
    callbackUrl: 'http://app.local/api/admin/github/callback',
    allowedLogins: ['miloquinn'],
    fetchImpl: githubFetch(login),
  });
}

describe('AdminAuth GitHub OAuth', () => {
  it('creates a session only for the configured GitHub administrator', async () => {
    const auth = githubAuth('MiloQuinn');
    const attempt = auth.beginGitHubLogin();

    expect(attempt.authorizationUrl).toContain('https://github.com/login/oauth/authorize?');
    expect(attempt.authorizationUrl).toContain('client_id=client-id');
    expect(attempt.authorizationUrl).toContain(encodeURIComponent(attempt.state));

    const session = await auth.completeGitHubLogin('oauth-code', attempt.state, attempt.state);
    expect(session.identity).toMatchObject({ login: 'MiloQuinn' });
    expect(auth.current(session.token)).toMatchObject({ login: 'MiloQuinn' });
  });

  it('rejects mismatched OAuth state before contacting GitHub', async () => {
    const auth = githubAuth('miloquinn');
    const attempt = auth.beginGitHubLogin();

    await expect(auth.completeGitHubLogin('oauth-code', attempt.state, 'wrong-cookie')).rejects.toMatchObject({
      code: 'INVALID_OAUTH_STATE',
    });
  });

  it('rejects GitHub users outside the administrator allowlist', async () => {
    const auth = githubAuth('someone-else');
    const attempt = auth.beginGitHubLogin();

    await expect(auth.completeGitHubLogin('oauth-code', attempt.state, attempt.state)).rejects.toBeInstanceOf(AdminAuthError);
    await expect(
      (async () => {
        const retry = auth.beginGitHubLogin();
        return auth.completeGitHubLogin('oauth-code', retry.state, retry.state);
      })(),
    ).rejects.toMatchObject({ code: 'GITHUB_USER_FORBIDDEN' });
  });
});
