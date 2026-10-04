import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { UnrecoverableError, type Job } from 'bullmq';
import { StorageObjectNotFoundError } from '../storage/storage.errors';
import { StorageService } from '../storage/storage.service';
import type { Video } from '../videos/entities/video.entity';
import { VideoLifecycleService } from '../videos/video-lifecycle.service';
import type { ProcessingStatus } from '../videos/video.types';
import {
  MediaProcessFailedError,
  MediaProcessTimeoutError,
  MediaUnsupportedContentError,
} from './media/media-probe.errors';
import { MediaProbeService } from './media/media-probe.service';
import type { FfprobeResult } from './media/media-probe.types';
import {
  PROCESS_VIDEO_JOB_OPTIONS,
  type ProcessVideoJobData,
} from './video-processing.constants';
import { VideoProcessingConsumer } from './video-processing.consumer';

const VIDEO_ID = '6f1c2a54-0d7e-4c43-9a51-2b7f0f1c9e10';
const SOURCE_URL = 'http://seaweedfs:8333/videos/abcDEF123_-/source.mp4?sig';
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

const COMPATIBLE_PROBE: FfprobeResult = {
  streams: [
    { codec_type: 'video', codec_name: 'h264', width: 1280, height: 720 },
    { codec_type: 'audio', codec_name: 'aac' },
  ],
  format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '10.000000' },
};

function videoIn(status: ProcessingStatus): Video {
  return {
    id: VIDEO_ID,
    short_id: 'abcDEF123_-',
    original_object_key: 'abcDEF123_-/source.mp4',
    processing_status: status,
  } as Video;
}

function job(
  attemptsMade = 0,
  attempts: number = PROCESS_VIDEO_JOB_OPTIONS.attempts,
): Job<ProcessVideoJobData> {
  return {
    data: { videoId: VIDEO_ID },
    attemptsMade,
    opts: { attempts },
  } as unknown as Job<ProcessVideoJobData>;
}

describe('VideoProcessingConsumer', () => {
  let consumer: VideoProcessingConsumer;
  let lifecycle: {
    findById: jest.Mock;
    markReady: jest.Mock;
    markFailed: jest.Mock;
  };
  let storage: {
    headObject: jest.Mock;
    presignGetObject: jest.Mock;
    putObject: jest.Mock;
  };
  let mediaProbe: { probe: jest.Mock; extractThumbnail: jest.Mock };

  beforeEach(async () => {
    lifecycle = {
      findById: jest.fn().mockResolvedValue(videoIn('processing')),
      markReady: jest.fn().mockResolvedValue(true),
      markFailed: jest.fn().mockResolvedValue(true),
    };
    storage = {
      headObject: jest.fn().mockResolvedValue({ contentLength: 1024 }),
      presignGetObject: jest.fn().mockResolvedValue(SOURCE_URL),
      putObject: jest.fn().mockResolvedValue(undefined),
    };
    mediaProbe = {
      probe: jest.fn().mockResolvedValue(COMPATIBLE_PROBE),
      extractThumbnail: jest.fn().mockResolvedValue(JPEG),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        VideoProcessingConsumer,
        { provide: VideoLifecycleService, useValue: lifecycle },
        { provide: StorageService, useValue: storage },
        { provide: MediaProbeService, useValue: mediaProbe },
      ],
    }).compile();

    consumer = moduleRef.get(VideoProcessingConsumer);
  });

  describe('process', () => {
    it.each<ProcessingStatus>(['ready', 'failed'])(
      'should do nothing for a %s video',
      async (status) => {
        lifecycle.findById.mockResolvedValue(videoIn(status));

        await consumer.process(job());

        expect(storage.headObject).not.toHaveBeenCalled();
        expect(storage.putObject).not.toHaveBeenCalled();
        expect(lifecycle.markReady).not.toHaveBeenCalled();
        expect(lifecycle.markFailed).not.toHaveBeenCalled();
      },
    );

    it('should do nothing when the video no longer exists', async () => {
      lifecycle.findById.mockResolvedValue(null);

      await consumer.process(job());

      expect(storage.headObject).not.toHaveBeenCalled();
      expect(lifecycle.markFailed).not.toHaveBeenCalled();
    });

    it.each<ProcessingStatus>(['uploading', 'processing'])(
      'should process a %s video to ready with metadata and thumbnail',
      async (status) => {
        lifecycle.findById.mockResolvedValue(videoIn(status));

        await consumer.process(job());

        expect(lifecycle.findById).toHaveBeenCalledWith(VIDEO_ID);
        expect(storage.presignGetObject).toHaveBeenCalledWith(
          'internal',
          'abcDEF123_-/source.mp4',
          { expiresIn: 3600 },
        );
        expect(mediaProbe.probe).toHaveBeenCalledWith(SOURCE_URL);
        expect(mediaProbe.extractThumbnail).toHaveBeenCalledWith(
          SOURCE_URL,
          10,
        );
        expect(storage.putObject).toHaveBeenCalledWith(
          'thumbnails',
          expect.stringMatching(/^abcDEF123_-\/[0-9a-f]{16}\.jpg$/) as string,
          JPEG,
          {
            contentType: 'image/jpeg',
            cacheControl: 'public, max-age=31536000, immutable',
          },
        );
        const [[, thumbnailKey]] = storage.putObject.mock.calls as [
          [string, string],
        ];
        expect(lifecycle.markReady).toHaveBeenCalledWith(VIDEO_ID, {
          duration_seconds: 10,
          width: 1280,
          height: 720,
          video_codec: 'h264',
          audio_codec: 'aac',
          thumbnail_object_key: thumbnailKey,
        });
      },
    );

    it('should use a new thumbnail key on every run', async () => {
      await consumer.process(job());
      await consumer.process(job());

      const keys = (storage.putObject.mock.calls as [string, string][]).map(
        ([, key]) => key,
      );
      expect(new Set(keys).size).toBe(2);
    });

    it('should mark SOURCE_MISSING and throw UnrecoverableError when the source object is gone', async () => {
      storage.headObject.mockRejectedValue(
        new StorageObjectNotFoundError('NotFound'),
      );

      await expect(consumer.process(job())).rejects.toThrow(UnrecoverableError);

      expect(lifecycle.markFailed).toHaveBeenCalledWith(
        VIDEO_ID,
        'SOURCE_MISSING',
      );
      expect(mediaProbe.probe).not.toHaveBeenCalled();
    });

    it('should propagate other storage errors on HEAD for a retry', async () => {
      const outage = new Error('socket hang up');
      storage.headObject.mockRejectedValue(outage);

      await expect(consumer.process(job())).rejects.toBe(outage);

      expect(lifecycle.markFailed).not.toHaveBeenCalled();
    });

    it('should mark UNSUPPORTED_FORMAT and throw UnrecoverableError when the gate rejects the probe', async () => {
      mediaProbe.probe.mockResolvedValue({
        ...COMPATIBLE_PROBE,
        streams: [
          { codec_type: 'video', codec_name: 'mpeg4', width: 320, height: 240 },
        ],
      });

      await expect(consumer.process(job())).rejects.toThrow(UnrecoverableError);

      expect(lifecycle.markFailed).toHaveBeenCalledWith(
        VIDEO_ID,
        'UNSUPPORTED_FORMAT',
      );
      expect(mediaProbe.extractThumbnail).not.toHaveBeenCalled();
      expect(lifecycle.markReady).not.toHaveBeenCalled();
    });

    it('should mark UNSUPPORTED_FORMAT and throw UnrecoverableError when ffprobe cannot parse the content', async () => {
      mediaProbe.probe.mockRejectedValue(
        new MediaUnsupportedContentError('Invalid data found'),
      );

      await expect(consumer.process(job())).rejects.toThrow(UnrecoverableError);

      expect(lifecycle.markFailed).toHaveBeenCalledWith(
        VIDEO_ID,
        'UNSUPPORTED_FORMAT',
      );
    });

    it('should mark UNSUPPORTED_FORMAT when ffmpeg cannot parse the content for the thumbnail', async () => {
      mediaProbe.extractThumbnail.mockRejectedValue(
        new MediaUnsupportedContentError('Invalid data found'),
      );

      await expect(consumer.process(job())).rejects.toThrow(UnrecoverableError);

      expect(lifecycle.markFailed).toHaveBeenCalledWith(
        VIDEO_ID,
        'UNSUPPORTED_FORMAT',
      );
      expect(storage.putObject).not.toHaveBeenCalled();
    });

    it.each([
      [
        'a failed ffprobe run',
        new MediaProcessFailedError('Server returned 5XX'),
      ],
      ['an ffprobe timeout', new MediaProcessTimeoutError('timed out')],
    ])(
      'should propagate %s as a retryable error without marking failed',
      async (_label, error) => {
        mediaProbe.probe.mockRejectedValue(error);

        const rejection = consumer.process(job());

        await expect(rejection).rejects.toBe(error);
        await expect(rejection).rejects.not.toBeInstanceOf(UnrecoverableError);
        expect(lifecycle.markFailed).not.toHaveBeenCalled();
      },
    );

    it('should propagate a thumbnail upload failure as retryable', async () => {
      const outage = new Error('PutObject failed');
      storage.putObject.mockRejectedValue(outage);

      await expect(consumer.process(job())).rejects.toBe(outage);

      expect(lifecycle.markReady).not.toHaveBeenCalled();
      expect(lifecycle.markFailed).not.toHaveBeenCalled();
    });
  });

  describe('onFailed', () => {
    const transient = new MediaProcessFailedError('Connection refused');

    it.each([1, 2])(
      'should keep the video as is after attempt %i of 3',
      async (attemptsMade) => {
        await consumer.onFailed(job(attemptsMade), transient);

        expect(lifecycle.markFailed).not.toHaveBeenCalled();
      },
    );

    it('should mark PROCESSING_FAILED after the last attempt', async () => {
      await consumer.onFailed(job(3), transient);

      expect(lifecycle.markFailed).toHaveBeenCalledWith(
        VIDEO_ID,
        'PROCESSING_FAILED',
      );
    });

    it('should treat a job without attempts as final after its first failure', async () => {
      const single = {
        data: { videoId: VIDEO_ID },
        attemptsMade: 1,
        opts: {},
      } as unknown as Job<ProcessVideoJobData>;

      await consumer.onFailed(single, transient);

      expect(lifecycle.markFailed).toHaveBeenCalledWith(
        VIDEO_ID,
        'PROCESSING_FAILED',
      );
    });

    it('should ignore an UnrecoverableError, whose reason is already set', async () => {
      await consumer.onFailed(
        job(1),
        new UnrecoverableError('UNSUPPORTED_FORMAT: mpeg4'),
      );

      expect(lifecycle.markFailed).not.toHaveBeenCalled();
    });

    it('should ignore an event without a job', async () => {
      await consumer.onFailed(undefined, transient);

      expect(lifecycle.markFailed).not.toHaveBeenCalled();
    });

    it('should log instead of throwing when marking the video fails', async () => {
      lifecycle.markFailed.mockRejectedValue(new Error('db down'));
      const logError = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);

      await expect(consumer.onFailed(job(3), transient)).resolves.toBe(
        undefined,
      );

      expect(logError).toHaveBeenCalledWith(
        expect.stringContaining(VIDEO_ID),
        expect.any(String),
      );
      logError.mockRestore();
    });
  });
});
