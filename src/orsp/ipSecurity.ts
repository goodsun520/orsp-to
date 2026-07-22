import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import path from 'node:path';

const MAX_SECURITY_EVENTS = 1_000;

export type SecurityEventType = 'invalid_passphrase' | 'invalid_admin_password' | 'source_report';

export interface SecurityEvent {
  id: string;
  ip: string;
  type: SecurityEventType;
  details: string;
  createdAt: string;
}

export interface IpBan {
  ip: string;
  reason: string;
  bannedAt: string;
  bannedBy: string;
}

interface StoredIpSecurity {
  version: 1;
  events: SecurityEvent[];
  bans: IpBan[];
}

export class IpSecurityStore {
  private events: SecurityEvent[] = [];
  private bans = new Map<string, IpBan>();
  private mutationQueue: Promise<void> = Promise.resolve();

  static ephemeral(): IpSecurityStore {
    return new IpSecurityStore(null);
  }

  constructor(private readonly filePath: string | null) {}

  async load(): Promise<void> {
    if (!this.filePath) return;
    try {
      const value = JSON.parse(await readFile(this.filePath, 'utf8')) as Partial<StoredIpSecurity>;
      if (value.version !== 1 || !Array.isArray(value.events) || !Array.isArray(value.bans)) {
        throw new Error('IP security data is malformed.');
      }
      if (!value.events.every(isSecurityEvent) || !value.bans.every(isIpBan)) {
        throw new Error('IP security data contains malformed entries.');
      }
      this.events = value.events.slice(-MAX_SECURITY_EVENTS);
      this.bans = new Map(value.bans.map((ban) => [ban.ip, ban]));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw new Error('Failed to load IP security data.', { cause: error });
    }
  }

  isBanned(ip: string): boolean {
    return this.bans.has(ip);
  }

  listEvents(): SecurityEvent[] {
    return [...this.events].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  listBans(): IpBan[] {
    return [...this.bans.values()].sort((a, b) => b.bannedAt.localeCompare(a.bannedAt));
  }

  async recordEvent(ip: string, type: SecurityEventType, details: string): Promise<SecurityEvent> {
    return this.mutate(async () => {
      const event: SecurityEvent = {
        id: `se-${randomUUID()}`,
        ip,
        type,
        details: details.trim().slice(0, 240),
        createdAt: new Date().toISOString(),
      };
      const nextEvents = [...this.events, event].slice(-MAX_SECURITY_EVENTS);
      await this.persist(nextEvents, this.bans);
      this.events = nextEvents;
      return event;
    });
  }

  async ban(ip: string, actor: string, reason: string): Promise<IpBan> {
    if (!isBannableIp(ip)) throw new Error('A valid IPv4 or IPv6 address is required.');
    return this.mutate(async () => {
      const ban: IpBan = {
        ip,
        reason: reason.trim().slice(0, 240) || '管理员手动封禁',
        bannedAt: new Date().toISOString(),
        bannedBy: actor,
      };
      const nextBans = new Map(this.bans);
      nextBans.set(ip, ban);
      await this.persist(this.events, nextBans);
      this.bans = nextBans;
      return ban;
    });
  }

  async unban(ip: string): Promise<boolean> {
    return this.mutate(async () => {
      if (!this.bans.has(ip)) return false;
      const nextBans = new Map(this.bans);
      nextBans.delete(ip);
      await this.persist(this.events, nextBans);
      this.bans = nextBans;
      return true;
    });
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation);
    this.mutationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async persist(events: SecurityEvent[], bans: Map<string, IpBan>): Promise<void> {
    if (!this.filePath) return;
    const value: StoredIpSecurity = { version: 1, events, bans: [...bans.values()] };
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, JSON.stringify(value, null, 2), 'utf8');
      await rename(temporaryPath, this.filePath);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

export function isBannableIp(ip: string): boolean {
  return isIP(ip) !== 0;
}

function isSecurityEvent(value: unknown): value is SecurityEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Partial<SecurityEvent>;
  return (
    typeof event.id === 'string' &&
    typeof event.ip === 'string' &&
    ['invalid_passphrase', 'invalid_admin_password', 'source_report'].includes(String(event.type)) &&
    typeof event.details === 'string' &&
    typeof event.createdAt === 'string'
  );
}

function isIpBan(value: unknown): value is IpBan {
  if (!value || typeof value !== 'object') return false;
  const ban = value as Partial<IpBan>;
  return (
    typeof ban.ip === 'string' && isBannableIp(ban.ip) &&
    typeof ban.reason === 'string' &&
    typeof ban.bannedAt === 'string' &&
    typeof ban.bannedBy === 'string'
  );
}
