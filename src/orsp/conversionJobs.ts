import { randomBytes } from 'node:crypto';

export const conversionJobLimits = {
  maxChunkSize: 50,
  maxItems: 5_000,
  maxItemBytes: 512 * 1_024,
  maxChunkBytes: 1 * 1_024 * 1_024,
  maxJobBytes: 32 * 1_024 * 1_024,
  concurrency: 4,
  maxConcurrencyPerJob: 2,
  maxJobs: 8,
  maxActiveJobsPerOwner: 2,
  openRetentionMs: 60 * 60 * 1_000,
  maxRuntimeMs: 24 * 60 * 60 * 1_000,
  completedRetentionMs: 24 * 60 * 60 * 1_000,
} as const;

export type ConversionJobStatus = 'open' | 'running' | 'completed' | 'cancelled';
export type ConversionJobItemStatus = 'queued' | 'running' | 'succeeded' | 'failed';

interface ConversionJobItem<TResult> {
  index: number;
  input?: unknown;
  inputBytes: number;
  sourceName?: string;
  status: ConversionJobItemStatus;
  result?: TResult;
  error?: string;
}

interface ConversionJob<TResult> {
  id: string;
  owner: string;
  status: ConversionJobStatus;
  createdAt: string;
  updatedAt: string;
  expectedTotal: number;
  retainedInputBytes: number;
  activeWorkers: number;
  scheduled: boolean;
  startedAt?: number;
  items: Array<ConversionJobItem<TResult>>;
}

export interface ConversionJobSnapshot<TResult> {
  jobId: string;
  status: ConversionJobStatus;
  createdAt: string;
  updatedAt: string;
  progress: {
    expectedTotal: number;
    total: number;
    queued: number;
    running: number;
    succeeded: number;
    failed: number;
    completed: number;
    retainedInputBytes: number;
  };
  items: Array<{
    index: number;
    sourceName?: string;
    status: ConversionJobItemStatus;
    result?: TResult;
    error?: string;
  }>;
}

export class ConversionJobError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class ConversionJobManager<TResult> {
  private readonly jobs = new Map<string, ConversionJob<TResult>>();
  private readonly readyJobs: Array<ConversionJob<TResult>> = [];
  private activeWorkers = 0;
  private readonly now: () => number;
  private readonly maxJobs: number;
  private readonly openRetentionMs: number;
  private readonly completedRetentionMs: number;

  constructor(
    private readonly processItem: (input: unknown) => Promise<TResult>,
    options: { now?: () => number; maxJobs?: number; openRetentionMs?: number; completedRetentionMs?: number } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.maxJobs = options.maxJobs ?? conversionJobLimits.maxJobs;
    this.openRetentionMs = options.openRetentionMs ?? conversionJobLimits.openRetentionMs;
    this.completedRetentionMs = options.completedRetentionMs ?? conversionJobLimits.completedRetentionMs;
  }

  create(owner: string, expectedTotal: number): ConversionJobSnapshot<TResult> {
    this.cleanup(true);
    const activeForOwner = [...this.jobs.values()].filter(
      (job) => job.owner === owner && (job.status === 'open' || job.status === 'running'),
    ).length;
    if (activeForOwner >= conversionJobLimits.maxActiveJobsPerOwner) {
      throw new ConversionJobError(
        429,
        'TOO_MANY_ACTIVE_JOBS',
        `Each client may have at most ${conversionJobLimits.maxActiveJobsPerOwner} active conversion jobs.`,
      );
    }
    if (this.jobs.size >= this.maxJobs) {
      throw new ConversionJobError(
        503,
        'JOB_CAPACITY_REACHED',
        'The conversion queue is full. Try again after an active job completes.',
      );
    }
    const now = this.nowIso();
    const job: ConversionJob<TResult> = {
      id: randomBytes(24).toString('base64url'),
      owner,
      status: 'open',
      createdAt: now,
      updatedAt: now,
      expectedTotal,
      retainedInputBytes: 0,
      activeWorkers: 0,
      scheduled: false,
      items: [],
    };
    this.jobs.set(job.id, job);
    return this.snapshot(job);
  }

  append(id: string, owner: string, inputs: unknown[]): ConversionJobSnapshot<TResult> {
    const job = this.requireOwned(id, owner);
    if (job.status !== 'open') {
      throw new ConversionJobError(409, 'JOB_ALREADY_SEALED', 'This conversion job no longer accepts chunks.');
    }
    if (inputs.length < 1 || inputs.length > conversionJobLimits.maxChunkSize) {
      throw new ConversionJobError(
        400,
        'INVALID_CHUNK',
        `sources must contain between 1 and ${conversionJobLimits.maxChunkSize} items.`,
      );
    }
    if (job.items.length + inputs.length > job.expectedTotal) {
      throw new ConversionJobError(
        400,
        'JOB_TOO_LARGE',
        `This conversion job expects exactly ${job.expectedTotal} items.`,
      );
    }
    const sizedInputs = inputs.map((input) => ({ input, bytes: inputSize(input) }));
    const oversized = sizedInputs.find(({ bytes }) => bytes > conversionJobLimits.maxItemBytes);
    if (oversized) {
      throw new ConversionJobError(
        413,
        'SOURCE_TOO_LARGE',
        `Each source must be at most ${conversionJobLimits.maxItemBytes} bytes.`,
      );
    }
    const chunkBytes = sizedInputs.reduce((sum, item) => sum + item.bytes, 0);
    if (chunkBytes > conversionJobLimits.maxChunkBytes) {
      throw new ConversionJobError(
        413,
        'CHUNK_TOO_LARGE',
        `Each chunk must be at most ${conversionJobLimits.maxChunkBytes} bytes.`,
      );
    }
    if (job.retainedInputBytes + chunkBytes > conversionJobLimits.maxJobBytes) {
      throw new ConversionJobError(
        413,
        'JOB_PAYLOAD_TOO_LARGE',
        `Each conversion job may retain at most ${conversionJobLimits.maxJobBytes} bytes of source rules.`,
      );
    }
    for (const { input, bytes } of sizedInputs) {
      job.items.push({
        index: job.items.length,
        input,
        inputBytes: bytes,
        ...sourceName(input),
        status: 'queued',
      });
    }
    job.retainedInputBytes += chunkBytes;
    job.updatedAt = this.nowIso();
    return this.snapshot(job);
  }

  seal(id: string, owner: string): ConversionJobSnapshot<TResult> {
    const job = this.requireOwned(id, owner);
    if (job.status !== 'open') {
      throw new ConversionJobError(409, 'JOB_ALREADY_SEALED', 'This conversion job has already been sealed.');
    }
    if (job.items.length !== job.expectedTotal) {
      throw new ConversionJobError(
        409,
        'JOB_INCOMPLETE',
        `This conversion job expects ${job.expectedTotal} items but has ${job.items.length}.`,
      );
    }
    job.status = 'running';
    job.startedAt = this.now();
    job.updatedAt = this.nowIso();
    this.schedule(job);
    this.pump();
    return this.snapshot(job);
  }

  get(id: string, owner: string): ConversionJobSnapshot<TResult> {
    this.cleanup(false);
    return this.snapshot(this.requireOwned(id, owner));
  }

  retry(id: string, owner: string): ConversionJobSnapshot<TResult> {
    const job = this.requireOwned(id, owner);
    if (job.status !== 'completed') {
      throw new ConversionJobError(409, 'JOB_NOT_COMPLETED', 'Only a completed conversion job can be retried.');
    }
    const failed = job.items.filter((item) => item.status === 'failed');
    if (failed.length === 0) {
      throw new ConversionJobError(409, 'NO_FAILED_ITEMS', 'This conversion job has no failed items to retry.');
    }
    const otherActive = [...this.jobs.values()].filter(
      (candidate) =>
        candidate !== job &&
        candidate.owner === owner &&
        (candidate.status === 'open' || candidate.status === 'running'),
    ).length;
    if (otherActive >= conversionJobLimits.maxActiveJobsPerOwner) {
      throw new ConversionJobError(
        429,
        'TOO_MANY_ACTIVE_JOBS',
        'Finish the active conversion job before retrying this one.',
      );
    }
    job.status = 'running';
    job.startedAt = this.now();
    job.updatedAt = this.nowIso();
    for (const item of failed) {
      item.status = 'queued';
      delete item.error;
      delete item.result;
    }
    this.schedule(job);
    this.pump();
    return this.snapshot(job);
  }

  cancel(id: string, owner: string): ConversionJobSnapshot<TResult> {
    const job = this.requireOwned(id, owner);
    if (job.status === 'completed' || job.status === 'cancelled') {
      throw new ConversionJobError(409, 'JOB_NOT_ACTIVE', 'Only an open or running conversion job can be cancelled.');
    }
    job.status = 'cancelled';
    job.scheduled = false;
    job.updatedAt = this.nowIso();
    for (const item of job.items) {
      if (item.status !== 'queued') continue;
      item.status = 'failed';
      item.error = 'Conversion job was cancelled.';
      job.retainedInputBytes -= item.inputBytes;
      item.input = undefined;
      item.inputBytes = 0;
    }
    return this.snapshot(job);
  }

  private requireOwned(id: string, owner: string): ConversionJob<TResult> {
    const job = this.jobs.get(id);
    // Do not reveal whether a job exists to a client with a different IP.
    if (!job || job.owner !== owner) {
      throw new ConversionJobError(404, 'JOB_NOT_FOUND', 'Unknown conversion job.');
    }
    return job;
  }

  private pump(): void {
    this.expireRunningJobs();
    while (this.activeWorkers < conversionJobLimits.concurrency) {
      const work = this.nextWork();
      if (!work) break;
      const input = work.item.input;
      this.activeWorkers += 1;
      work.job.activeWorkers += 1;
      work.item.status = 'running';
      work.job.updatedAt = this.nowIso();
      void this.processItem(input)
        .then((result) => {
          work.item.result = result;
          work.item.status = 'succeeded';
          work.job.retainedInputBytes -= work.item.inputBytes;
          work.item.input = undefined;
          work.item.inputBytes = 0;
        })
        .catch((error: unknown) => {
          work.item.error = error instanceof Error ? error.message : 'Conversion failed.';
          work.item.status = 'failed';
        })
        .finally(() => {
          this.activeWorkers -= 1;
          work.job.activeWorkers -= 1;
          if (work.job.status === 'cancelled' && work.item.inputBytes > 0) {
            work.job.retainedInputBytes -= work.item.inputBytes;
            work.item.input = undefined;
            work.item.inputBytes = 0;
          }
          work.job.updatedAt = this.nowIso();
          if (
            work.job.status !== 'cancelled' &&
            work.job.items.every((item) => item.status === 'succeeded' || item.status === 'failed')
          ) {
            work.job.status = 'completed';
          }
          this.schedule(work.job);
          this.pump();
        });
    }
  }

  private nextWork(): { job: ConversionJob<TResult>; item: ConversionJobItem<TResult> } | null {
    const candidates = this.readyJobs.length;
    for (let attempt = 0; attempt < candidates; attempt += 1) {
      const job = this.readyJobs.shift()!;
      job.scheduled = false;
      if (job.status !== 'running') continue;
      const item = job.items.find((candidate) => candidate.status === 'queued');
      if (!item) continue;
      if (job.activeWorkers >= conversionJobLimits.maxConcurrencyPerJob) {
        this.schedule(job);
        continue;
      }
      if (job.items.some((candidate) => candidate !== item && candidate.status === 'queued')) this.schedule(job);
      return { job, item };
    }
    return null;
  }

  private schedule(job: ConversionJob<TResult>): void {
    if (
      job.status !== 'running' ||
      job.scheduled ||
      job.activeWorkers >= conversionJobLimits.maxConcurrencyPerJob ||
      !job.items.some((item) => item.status === 'queued')
    ) {
      return;
    }
    job.scheduled = true;
    this.readyJobs.push(job);
  }

  private expireRunningJobs(): void {
    const now = this.now();
    for (const job of this.jobs.values()) {
      if (job.status !== 'running' || job.startedAt === undefined || now - job.startedAt <= conversionJobLimits.maxRuntimeMs) {
        continue;
      }
      job.scheduled = false;
      for (const item of job.items) {
        if (item.status !== 'queued') continue;
        item.status = 'failed';
        item.error = 'Conversion job exceeded its execution deadline.';
        job.retainedInputBytes -= item.inputBytes;
        item.input = undefined;
        item.inputBytes = 0;
      }
      if (job.activeWorkers === 0) job.status = 'completed';
      job.updatedAt = this.nowIso();
    }
  }

  private snapshot(job: ConversionJob<TResult>): ConversionJobSnapshot<TResult> {
    const progress = {
      expectedTotal: job.expectedTotal,
      total: job.items.length,
      queued: 0,
      running: 0,
      succeeded: 0,
      failed: 0,
      completed: 0,
      retainedInputBytes: job.retainedInputBytes,
    };
    const items = job.items.map((item) => {
      progress[item.status] += 1;
      return {
        index: item.index,
        ...(item.sourceName ? { sourceName: item.sourceName } : {}),
        status: item.status,
        ...(item.result === undefined ? {} : { result: item.result }),
        ...(item.error === undefined ? {} : { error: item.error }),
      };
    });
    progress.completed = progress.succeeded + progress.failed;
    return {
      jobId: job.id,
      status: job.status,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      progress,
      items,
    };
  }

  private nowIso(): string {
    return new Date(this.now()).toISOString();
  }

  private cleanup(forCreate: boolean): void {
    this.expireRunningJobs();
    const now = this.now();
    const completedExpiry = now - this.completedRetentionMs;
    const openExpiry = now - this.openRetentionMs;
    for (const [id, job] of this.jobs) {
      const updatedAt = Date.parse(job.updatedAt);
      if (
        ((job.status === 'completed' || job.status === 'cancelled') && updatedAt <= completedExpiry) ||
        (job.status === 'open' && updatedAt <= openExpiry)
      ) {
        this.jobs.delete(id);
      }
    }
    if (!forCreate || this.jobs.size < this.maxJobs) return;
    const completed = [...this.jobs.values()]
      .filter((job) => job.status === 'completed' || job.status === 'cancelled')
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    for (const job of completed) {
      if (this.jobs.size < this.maxJobs) break;
      this.jobs.delete(job.id);
    }
  }
}

function sourceName(input: unknown): { sourceName?: string } {
  if (!input || typeof input !== 'object') return {};
  const value = (input as { bookSourceName?: unknown }).bookSourceName;
  if (typeof value !== 'string') return {};
  const normalized = value.trim().slice(0, 200);
  return normalized ? { sourceName: normalized } : {};
}

function inputSize(input: unknown): number {
  try {
    const serialized = JSON.stringify(input);
    return serialized === undefined ? 0 : Buffer.byteLength(serialized);
  } catch {
    throw new ConversionJobError(400, 'INVALID_SOURCE', 'Source entries must be JSON-serializable.');
  }
}
