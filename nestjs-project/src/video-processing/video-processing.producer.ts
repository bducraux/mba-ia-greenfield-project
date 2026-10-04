import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';
import {
  ENQUEUE_TIMEOUT_MS,
  PROCESS_VIDEO_JOB,
  PROCESS_VIDEO_JOB_OPTIONS,
  VIDEO_PROCESSING_QUEUE,
  type ProcessVideoJobData,
} from './video-processing.constants';
import { QueueUnavailableError } from './video-processing.errors';

@Injectable()
export class VideoProcessingProducer {
  constructor(
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly queue: Queue<ProcessVideoJobData>,
  ) {}

  /**
   * Enqueues the processing job with `jobId = videoId`; adding an id that
   * already exists is a no-op in BullMQ, so retries never duplicate the job.
   */
  async enqueue(videoId: string): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new QueueUnavailableError(
              `Enqueue of video ${videoId} timed out after ${ENQUEUE_TIMEOUT_MS} ms`,
            ),
          ),
        ENQUEUE_TIMEOUT_MS,
      );
    });

    try {
      await Promise.race([
        this.queue.add(
          PROCESS_VIDEO_JOB,
          { videoId },
          { ...PROCESS_VIDEO_JOB_OPTIONS, jobId: videoId },
        ),
        timeout,
      ]);
    } catch (error) {
      if (error instanceof QueueUnavailableError) {
        throw error;
      }
      throw new QueueUnavailableError(`Failed to enqueue video ${videoId}`, {
        cause: error,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}
