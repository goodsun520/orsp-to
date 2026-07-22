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

/** Best-effort client IP: trusts nginx's X-Forwarded-For (this app only ever sits behind our own reverse proxy). */
export function clientIp(req: { headers: Record<string, unknown>; socket: { remoteAddress?: string } }): string {
  const forwarded = req.headers['x-forwarded-for'];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (typeof first === 'string' && first.trim()) return first.split(',')[0].trim();
  return req.socket.remoteAddress ?? 'unknown';
}
