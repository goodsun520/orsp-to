import { randomBytes } from 'node:crypto';

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h
export const ADMIN_SESSION_COOKIE = 'orsp_admin_session';

export class AdminAuth {
  private sessions = new Map<string, number>(); // token -> expiresAt

  constructor(private readonly password: string) {}

  login(candidate: string): string | null {
    if (!this.password || candidate !== this.password) return null;
    const token = randomBytes(24).toString('base64url');
    this.sessions.set(token, Date.now() + SESSION_TTL_MS);
    return token;
  }

  isValid(token: string | undefined): boolean {
    if (!token) return false;
    const expiresAt = this.sessions.get(token);
    if (!expiresAt) return false;
    if (expiresAt < Date.now()) {
      this.sessions.delete(token);
      return false;
    }
    return true;
  }

  logout(token: string | undefined): void {
    if (token) this.sessions.delete(token);
  }
}

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  return Object.fromEntries(
    header.split(';').map((part) => {
      const idx = part.indexOf('=');
      return idx === -1 ? [part.trim(), ''] : [part.slice(0, idx).trim(), decodeURIComponent(part.slice(idx + 1).trim())];
    }),
  );
}

export function readSessionCookie(cookieHeader: string | undefined): string | undefined {
  return parseCookies(cookieHeader)[ADMIN_SESSION_COOKIE];
}
