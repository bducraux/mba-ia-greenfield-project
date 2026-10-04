import { randomBytes } from 'node:crypto';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { UnrecoverableError, type Job } from 'bullmq';
import { StorageObjectNotFoundError } from '../storage/storage.errors';
import { StorageService } from '../storage/storage.service';
import type { Video } from '../videos/entities/video.entity';
import { VideoLifecycleService } from '../videos/video-lifecycle.service';
import type { FailureReason, ProcessingStatus } from '../videos/video.types';
import { MediaUnsupportedContentError } from './media/media-probe.errors';
import { MediaProbeService } from './media/media-probe.service';
import {
  checkCompatibility,
  type ProbedVideoMetadata,
} from './media/video-compatibility';
import {
  SOURCE_URL_TTL_SECONDS,
  THUMBNAIL_CACHE_CONTROL,
  THUMBNAIL_CONTENT_TYPE,
  THUMBNAIL_KEY_RANDOM_BYTES,
  VIDEO_PROCESSING_QUEUE,
  type ProcessVideoJobData,
} from './video-processing.constants';

/** The API may enqueue before it commits `processing`, so both are processed. */
const PROCESSABLE_STATES: readonly ProcessingStatus[] = [
  'uploading',
  'processing',
];

/**
 * Consumes `video-processing` jobs: validates the source with ffprobe,
 * stores a thumbnail and moves the video to `ready` or `failed`.
 * Registered only in the worker process (phase-03-upload-processing/TD-08).
 * At-least-once delivery: every step is safe to repeat.
 */
@Processor(VIDEO_PROCESSING_QUEUE)
export class VideoProcessingConsumer extends WorkerHost {
  private readonly logger = new Logger(VideoProcessingConsumer.name);

  constructor(
    private readonly lifecycle: VideoLifecycleService,
    private readonly storage: StorageService,
    private readonly mediaProbe: MediaProbeService,
  ) {
    super();
  }

  async process(job: Job<ProcessVideoJobData>): Promise<void> {
    const video = await this.lifecycle.findById(job.data.videoId);
    if (!video || !PROCESSABLE_STATES.includes(video.processing_status)) {
      return;
    }

    await this.assertSourceExists(video);
    const sourceUrl = await this.storage.presignGetObject(
      'internal',
      video.original_object_key,
      { expiresIn: SOURCE_URL_TTL_SECONDS },
    );

    const metadata = await this.probeCompatible(video, sourceUrl);
    const thumbnailKey = await this.storeThumbnail(
      video,
      sourceUrl,
      metadata.duration_seconds,
    );

    await this.lifecycle.markReady(video.id, {
      ...metadata,
      thumbnail_object_key: thumbnailKey,
    });
  }

  /**
   * Fires on every failed attempt. Only the last attempt of a retryable error
   * marks `PROCESSING_FAILED`; `UnrecoverableError`s already set their reason.
   */
  @OnWorkerEvent('failed')
  async onFailed(
    job: Job<ProcessVideoJobData> | undefined,
    error: Error,
  ): Promise<void> {
    if (!job || isUnrecoverable(error)) {
      return;
    }
    if (job.attemptsMade < (job.opts.attempts ?? 1)) {
      return;
    }
    try {
      await this.lifecycle.markFailed(job.data.videoId, 'PROCESSING_FAILED');
    } catch (markError) {
      // Event handler: rethrowing would only surface as an unhandled rejection.
      this.logger.error(
        `Could not mark video ${job.data.videoId} as PROCESSING_FAILED`,
        markError instanceof Error ? markError.stack : String(markError),
      );
    }
  }

  private async assertSourceExists(video: Video): Promise<void> {
    try {
      await this.storage.headObject('videos', video.original_object_key);
    } catch (error) {
      if (error instanceof StorageObjectNotFoundError) {
        await this.failUnrecoverable(
          video,
          'SOURCE_MISSING',
          `source object ${video.original_object_key} does not exist`,
        );
      }
      throw error;
    }
  }

  private async probeCompatible(
    video: Video,
    sourceUrl: string,
  ): Promise<ProbedVideoMetadata> {
    const probe = await this.unsupportedContentGuard(video, () =>
      this.mediaProbe.probe(sourceUrl),
    );
    const result = checkCompatibility(probe);
    if (!result.compatible) {
      return this.failUnrecoverable(video, 'UNSUPPORTED_FORMAT', result.reason);
    }
    return result.metadata;
  }

  private async storeThumbnail(
    video: Video,
    sourceUrl: string,
    durationSeconds: number,
  ): Promise<string> {
    const jpeg = await this.unsupportedContentGuard(video, () =>
      this.mediaProbe.extractThumbnail(sourceUrl, durationSeconds),
    );
    const key = `${video.short_id}/${randomBytes(THUMBNAIL_KEY_RANDOM_BYTES).toString('hex')}.jpg`;
    await this.storage.putObject('thumbnails', key, jpeg, {
      contentType: THUMBNAIL_CONTENT_TYPE,
      cacheControl: THUMBNAIL_CACHE_CONTROL,
    });
    return key;
  }

  /** Unparsable bytes are a format problem, not a transient failure. */
  private async unsupportedContentGuard<T>(
    video: Video,
    run: () => Promise<T>,
  ): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof MediaUnsupportedContentError) {
        await this.failUnrecoverable(
          video,
          'UNSUPPORTED_FORMAT',
          error.message,
        );
      }
      throw error;
    }
  }

  private async failUnrecoverable(
    video: Video,
    reason: FailureReason,
    detail: string,
  ): Promise<never> {
    await this.lifecycle.markFailed(video.id, reason);
    throw new UnrecoverableError(`${reason}: ${detail}`);
  }
}

function isUnrecoverable(error: Error): boolean {
  return (
    error instanceof UnrecoverableError || error.name === 'UnrecoverableError'
  );
}
