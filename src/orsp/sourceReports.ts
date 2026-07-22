import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHmac, randomUUID } from 'node:crypto';
import path from 'node:path';

export type SourceReportReason = 'infringement' | 'unavailable' | 'malicious' | 'other';
export type SourceReportStatus = 'open' | 'hidden' | 'ignored';

export interface SourceReport {
  id: string;
  sourceId: string;
  sourceName: string;
  websiteUrl: string;
  reason: SourceReportReason;
  details: string;
  status: SourceReportStatus;
  createdAt: string;
  reporterKey: string;
  reporterIp: string;
  resolvedAt?: string;
  resolvedBy?: string;
}

export interface NewSourceReport {
  sourceId: string;
  sourceName: string;
  websiteUrl: string;
  reason: SourceReportReason;
  details: string;
}

export class SourceReportStore {
  private reports: SourceReport[] = [];
  private mutationQueue: Promise<void> = Promise.resolve();

  static ephemeral(hashKey = 'ephemeral-report-key'): SourceReportStore {
    return new SourceReportStore(null, hashKey);
  }

  constructor(
    private readonly filePath: string | null,
    private readonly hashKey: string,
  ) {}

  async load(): Promise<void> {
    if (!this.filePath) return;
    try {
      const value = JSON.parse(await readFile(this.filePath, 'utf8')) as unknown;
      if (!Array.isArray(value)) throw new Error('Report data must be an array.');
      this.reports = value.filter(isStoredReport);
      if (this.reports.length !== value.length) throw new Error('Report data contains malformed entries.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.reports = [];
        return;
      }
      throw new Error('Failed to load source reports.', { cause: error });
    }
  }

  list(): SourceReport[] {
    return [...this.reports].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): SourceReport | undefined {
    return this.reports.find((report) => report.id === id);
  }

  async create(input: NewSourceReport, reporterIdentity: string): Promise<{ created: boolean; report: SourceReport }> {
    return this.mutate(async () => {
      const reporterKey = this.hashReporter(reporterIdentity);
      const duplicate = this.reports.find(
        (report) => report.sourceId === input.sourceId && report.reporterKey === reporterKey && report.status === 'open',
      );
      if (duplicate) return { created: false, report: duplicate };
      const report: SourceReport = {
        id: `r-${randomUUID()}`,
        ...input,
        details: input.details.trim(),
        status: 'open',
        createdAt: new Date().toISOString(),
        reporterKey,
        reporterIp: reporterIdentity,
      };
      const nextReports = [...this.reports, report];
      await this.persist(nextReports);
      this.reports = nextReports;
      return { created: true, report };
    });
  }

  async resolve(id: string, status: Exclude<SourceReportStatus, 'open'>, actor: string): Promise<SourceReport | null> {
    return this.mutate(async () => {
      const index = this.reports.findIndex((entry) => entry.id === id);
      const report = this.reports[index];
      if (!report || report.status !== 'open') return null;
      const resolved: SourceReport = {
        ...report,
        status,
        resolvedAt: new Date().toISOString(),
        resolvedBy: actor,
      };
      const nextReports = [...this.reports];
      nextReports[index] = resolved;
      await this.persist(nextReports);
      this.reports = nextReports;
      return resolved;
    });
  }

  async resolveOpenForSource(
    sourceId: string,
    status: Exclude<SourceReportStatus, 'open'>,
    actor: string,
  ): Promise<number> {
    return this.mutate(async () => {
      const openCount = this.reports.filter((report) => report.sourceId === sourceId && report.status === 'open').length;
      if (!openCount) return 0;
      const resolvedAt = new Date().toISOString();
      const nextReports = this.reports.map((report) => report.sourceId === sourceId && report.status === 'open'
        ? { ...report, status, resolvedAt, resolvedBy: actor }
        : report);
      await this.persist(nextReports);
      this.reports = nextReports;
      return openCount;
    });
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation);
    this.mutationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async persist(reports: SourceReport[]): Promise<void> {
    if (!this.filePath) return;
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, JSON.stringify(reports, null, 2), 'utf8');
      await rename(temporaryPath, this.filePath);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private hashReporter(value: string): string {
    return createHmac('sha256', this.hashKey).update(value).digest('base64url');
  }
}

function isStoredReport(value: unknown): value is SourceReport {
  if (!value || typeof value !== 'object') return false;
  const report = value as Partial<SourceReport>;
  return (
    typeof report.id === 'string' &&
    typeof report.sourceId === 'string' &&
    typeof report.sourceName === 'string' &&
    typeof report.websiteUrl === 'string' &&
    ['infringement', 'unavailable', 'malicious', 'other'].includes(String(report.reason)) &&
    typeof report.details === 'string' &&
    ['open', 'hidden', 'ignored'].includes(String(report.status)) &&
    typeof report.createdAt === 'string' &&
    typeof report.reporterKey === 'string'
    && typeof report.reporterIp === 'string'
  );
}
