import { randomUUID } from 'crypto';
import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import queueConfig from '../config/queue.config';
import { VideoProcessingProducerModule } from './video-processing-producer.module';
import {
  PROCESS_VIDEO_JOB,
  VIDEO_PROCESSING_QUEUE,
  type ProcessVideoJobData,
} from './video-processing.constants';
import { QueueUnavailableError } from './video-processing.errors';
import { VideoProcessingProducer } from './video-processing.producer';

async function createModule(
  queueOverride?: Partial<{ host: string; port: number }>,
): Promise<TestingModule> {
  const builder = Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
      VideoProcessingProducerModule,
    ],
  });
  if (queueOverride) {
    builder
      .overrideProvider(queueConfig.KEY)
      .useValue({ ...queueConfig(), ...queueOverride });
  }
  return builder.compile();
}

describe('VideoProcessingProducer (integration)', () => {
  describe('with Redis available', () => {
    let module: TestingModule;
    let producer: VideoProcessingProducer;
    let queue: Queue<ProcessVideoJobData>;
    let videoId: string;

    beforeAll(async () => {
      module = await createModule();
      producer = module.get(VideoProcessingProducer);
      queue = module.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
      // Keep any running worker from consuming (and removing) the test jobs.
      await queue.pause();
    });

    afterAll(async () => {
      await queue.resume();
      await module.close();
    });

    beforeEach(() => {
      videoId = randomUUID();
    });

    afterEach(async () => {
      await queue.remove(videoId);
    });

    it('should add a process job keyed by the video id with retry options', async () => {
      await producer.enqueue(videoId);

      const job = await queue.getJob(videoId);
      expect(job).toBeDefined();
      expect(job?.name).toBe(PROCESS_VIDEO_JOB);
      expect(job?.data).toEqual({ videoId });
      expect(job?.opts.attempts).toBe(3);
      expect(job?.opts.backoff).toEqual({ type: 'exponential', delay: 1000 });
      expect(job?.opts.removeOnComplete).toBe(true);
      expect(job?.opts.removeOnFail).toEqual({ age: 86400, count: 100 });
    });

    it('should not create a second job when the same video is enqueued twice', async () => {
      await producer.enqueue(videoId);
      await producer.enqueue(videoId);

      // A paused queue keeps its jobs in the wait list (BullMQ v6).
      const jobs = await queue.getJobs(['waiting', 'prioritized']);
      expect(jobs.filter((job) => job.data.videoId === videoId)).toHaveLength(
        1,
      );
    });
  });

  describe('with Redis unreachable', () => {
    let module: TestingModule;

    beforeAll(async () => {
      module = await createModule({ port: 1 });
      // Silence ioredis reconnect errors re-emitted by the queue.
      module
        .get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE))
        .on('error', () => undefined);
    });

    afterAll(async () => {
      await module.close();
    }, 15000);

    it('should reject with QueueUnavailableError', async () => {
      await expect(
        module.get(VideoProcessingProducer).enqueue(randomUUID()),
      ).rejects.toBeInstanceOf(QueueUnavailableError);
    }, 15000);
  });
});
