/** Minimal in-memory sliding-window rate limiter, keyed by caller-supplied string (usually an IP). */
export class RateLimiter {
  private hits = new Map<string, number[]>();

  constructor(private readonly windowMs: number, private readonly max: number) {}

  /** Returns true if the call is allowed (and records it); false if the caller is over the limit. */
  check(key: string): boolean {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    const existing = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (existing.length >= this.max) {
      this.hits.set(key, existing);
      return false;
    }
    existing.push(now);
    this.hits.set(key, existing);
    return true;
  }
}

/** Best-effort client IP. Express resolves `ip` using the configured one-hop trusted proxy. */
export function clientIp(req: { ip?: string; headers: Record<string, unknown>; socket: { remoteAddress?: string } }): string {
  if (typeof req.ip === 'string' && req.ip.trim()) return req.ip.trim();
  const forwarded = req.headers['x-forwarded-for'];
  const value = Array.isArray(forwarded) ? forwarded.at(-1) : forwarded;
  if (typeof value === 'string' && value.trim()) return value.split(',').at(-1)!.trim();
  return req.socket.remoteAddress ?? 'unknown';
}
