import { randomBytes } from 'node:crypto';

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000; // 10m
export const ADMIN_SESSION_COOKIE = 'orsp_admin_session';
export const ADMIN_OAUTH_STATE_COOKIE = 'orsp_admin_oauth_state';

export interface AdminIdentity {
  login: string;
  avatarUrl?: string;
  profileUrl?: string;
  provider: 'github' | 'password';
}

export interface GitHubAdminAuthOptions {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
  allowedLogins: string[];
  fetchImpl?: typeof fetch;
}

interface AdminSession {
  expiresAt: number;
  identity: AdminIdentity;
}

export class AdminAuthError extends Error {
  constructor(
    public readonly code:
      | 'GITHUB_OAUTH_DISABLED'
      | 'INVALID_OAUTH_STATE'
      | 'INVALID_OAUTH_CODE'
      | 'GITHUB_TOKEN_EXCHANGE_FAILED'
      | 'GITHUB_USER_LOOKUP_FAILED'
      | 'GITHUB_USER_FORBIDDEN',
    message: string,
  ) {
    super(message);
    this.name = 'AdminAuthError';
  }
}

export class AdminAuth {
  private sessions = new Map<string, AdminSession>();
  private oauthStates = new Map<string, number>();

  constructor(
    private readonly password: string,
    private readonly github?: GitHubAdminAuthOptions,
  ) {}

  login(candidate: string): string | null {
    if (!this.password || candidate !== this.password) return null;
    return this.createSession({ login: 'local-admin', provider: 'password' }).token;
  }

  githubConfigured(): boolean {
    return Boolean(this.github?.clientId && this.github.clientSecret);
  }

  beginGitHubLogin(): { state: string; authorizationUrl: string } {
    if (!this.githubConfigured()) {
      throw new AdminAuthError('GITHUB_OAUTH_DISABLED', 'GitHub OAuth is not configured.');
    }
    const state = randomBytes(24).toString('base64url');
    this.oauthStates.set(state, Date.now() + OAUTH_STATE_TTL_MS);
    this.pruneExpiredStates();
    const authorizationUrl = new URL('https://github.com/login/oauth/authorize');
    authorizationUrl.searchParams.set('client_id', this.github!.clientId);
    authorizationUrl.searchParams.set('redirect_uri', this.github!.callbackUrl);
    authorizationUrl.searchParams.set('state', state);
    return { state, authorizationUrl: authorizationUrl.toString() };
  }

  async completeGitHubLogin(
    code: string,
    state: string,
    cookieState: string | undefined,
  ): Promise<{ token: string; identity: AdminIdentity }> {
    if (!this.githubConfigured()) {
      throw new AdminAuthError('GITHUB_OAUTH_DISABLED', 'GitHub OAuth is not configured.');
    }
    if (!code) throw new AdminAuthError('INVALID_OAUTH_CODE', 'GitHub did not return an authorization code.');
    if (!this.consumeOAuthState(state, cookieState)) {
      throw new AdminAuthError('INVALID_OAUTH_STATE', 'The GitHub login state is invalid or expired.');
    }

    const fetchImpl = this.github!.fetchImpl ?? fetch;
    const tokenResponse = await fetchImpl('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'orsp-converter-admin',
      },
      body: new URLSearchParams({
        client_id: this.github!.clientId,
        client_secret: this.github!.clientSecret,
        code,
        redirect_uri: this.github!.callbackUrl,
      }),
    }).catch(() => null);
    if (!tokenResponse?.ok) {
      throw new AdminAuthError('GITHUB_TOKEN_EXCHANGE_FAILED', 'GitHub token exchange failed.');
    }
    const tokenBody = await tokenResponse.json().catch(() => null) as { access_token?: unknown } | null;
    const accessToken = typeof tokenBody?.access_token === 'string' ? tokenBody.access_token : '';
    if (!accessToken) {
      throw new AdminAuthError('GITHUB_TOKEN_EXCHANGE_FAILED', 'GitHub did not return an access token.');
    }

    const userResponse = await fetchImpl('https://api.github.com/user', {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': 'orsp-converter-admin',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    }).catch(() => null);
    if (!userResponse?.ok) {
      throw new AdminAuthError('GITHUB_USER_LOOKUP_FAILED', 'GitHub user lookup failed.');
    }
    const user = await userResponse.json().catch(() => null) as {
      login?: unknown;
      avatar_url?: unknown;
      html_url?: unknown;
    } | null;
    const login = typeof user?.login === 'string' ? user.login.trim() : '';
    if (!login) {
      throw new AdminAuthError('GITHUB_USER_LOOKUP_FAILED', 'GitHub user response did not include a login.');
    }
    const allowed = new Set(this.github!.allowedLogins.map((value) => value.trim().toLowerCase()).filter(Boolean));
    if (!allowed.has(login.toLowerCase())) {
      throw new AdminAuthError('GITHUB_USER_FORBIDDEN', 'This GitHub account is not an administrator.');
    }

    return this.createSession({
      login,
      avatarUrl: typeof user?.avatar_url === 'string' ? user.avatar_url : undefined,
      profileUrl: typeof user?.html_url === 'string' ? user.html_url : undefined,
      provider: 'github',
    });
  }

  current(token: string | undefined): AdminIdentity | null {
    if (!token) return null;
    const session = this.sessions.get(token);
    if (!session) return null;
    if (session.expiresAt < Date.now()) {
      this.sessions.delete(token);
      return null;
    }
    return session.identity;
  }

  isValid(token: string | undefined): boolean {
    return this.current(token) !== null;
  }

  logout(token: string | undefined): void {
    if (token) this.sessions.delete(token);
  }

  private createSession(identity: AdminIdentity): { token: string; identity: AdminIdentity } {
    const token = randomBytes(24).toString('base64url');
    this.sessions.set(token, { expiresAt: Date.now() + SESSION_TTL_MS, identity });
    return { token, identity };
  }

  private consumeOAuthState(state: string, cookieState: string | undefined): boolean {
    const expiresAt = this.oauthStates.get(state);
    if (state) this.oauthStates.delete(state);
    return Boolean(state && cookieState === state && expiresAt && expiresAt >= Date.now());
  }

  private pruneExpiredStates(): void {
    const now = Date.now();
    for (const [state, expiresAt] of this.oauthStates) {
      if (expiresAt < now) this.oauthStates.delete(state);
    }
  }
}

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  return Object.fromEntries(
    header.split(';').map((part) => {
      const idx = part.indexOf('=');
      let value = '';
      if (idx !== -1) {
        try { value = decodeURIComponent(part.slice(idx + 1).trim()); } catch { value = ''; }
      }
      return idx === -1 ? [part.trim(), ''] : [part.slice(0, idx).trim(), value];
    }),
  );
}

export function readSessionCookie(cookieHeader: string | undefined): string | undefined {
  return parseCookies(cookieHeader)[ADMIN_SESSION_COOKIE];
}

export function readOAuthStateCookie(cookieHeader: string | undefined): string | undefined {
  return parseCookies(cookieHeader)[ADMIN_OAUTH_STATE_COOKIE];
}
