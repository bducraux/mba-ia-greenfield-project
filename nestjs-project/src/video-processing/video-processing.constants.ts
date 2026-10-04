import type { JobsOptions } from 'bullmq';

export const VIDEO_PROCESSING_QUEUE = 'video-processing';

export const PROCESS_VIDEO_JOB = 'process';

export type ProcessVideoJobData = { videoId: string };

// `jobId` is set per job (= videoId) by the producer.
export const PROCESS_VIDEO_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 1000 },
  removeOnComplete: true,
  removeOnFail: { age: 86400, count: 100 },
} as const satisfies JobsOptions;

// With Redis down, ioredis queues commands offline and `queue.add` never
// rejects on its own — the producer bounds it with this timeout.
export const ENQUEUE_TIMEOUT_MS = 5000;
