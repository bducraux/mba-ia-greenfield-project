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

/** Presigned internal GET the worker hands to ffprobe/ffmpeg (Range reads). */
export const SOURCE_URL_TTL_SECONDS = 3600;

export const THUMBNAIL_CONTENT_TYPE = 'image/jpeg';

// Thumbnail keys are random per processing run, so the object never changes.
export const THUMBNAIL_CACHE_CONTROL = 'public, max-age=31536000, immutable';

export const THUMBNAIL_KEY_RANDOM_BYTES = 8;

// With Redis down, ioredis queues commands offline and `queue.add` never
// rejects on its own — the producer bounds it with this timeout.
export const ENQUEUE_TIMEOUT_MS = 5000;
