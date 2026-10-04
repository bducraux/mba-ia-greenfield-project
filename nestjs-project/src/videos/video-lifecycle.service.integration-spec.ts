import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import { generateShortId } from './short-id.util';
import {
  VideoLifecycleService,
  type ProcessedVideoMetadata,
} from './video-lifecycle.service';
import type { ProcessingStatus } from './video.types';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

const METADATA: ProcessedVideoMetadata = {
  duration_seconds: 12.5,
  width: 1280,
  height: 720,
  video_codec: 'h264',
  audio_codec: null,
  thumbnail_object_key: 'abc/thumb.jpg',
};

describe('VideoLifecycleService (integration)', () => {
  let module: TestingModule;
  let lifecycle: VideoLifecycleService;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let channel: Channel;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        TypeOrmModule.forFeature([Video]),
      ],
      providers: [VideoLifecycleService],
    }).compile();

    lifecycle = module.get(VideoLifecycleService);
    dataSource = module.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
  }, 30000);

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    const user = await dataSource
      .getRepository(User)
      .save({ email: 'lifecycle@example.com', password: 'hashed' });
    channel = await dataSource.getRepository(Channel).save({
      name: 'lifecycle',
      nickname: 'lifecycle',
      user_id: user.id,
    });
  });

  async function videoIn(status: ProcessingStatus): Promise<Video> {
    const shortId = generateShortId();
    return videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        short_id: shortId,
        title: 'clip',
        original_object_key: `${shortId}/source.mp4`,
        mime_type: 'video/mp4',
        size_bytes: 1024,
        upload_id: 'upload-id',
        processing_status: status,
        failure_reason: status === 'failed' ? 'PROCESSING_FAILED' : null,
      }),
    );
  }

  const reload = (video: Video): Promise<Video> =>
    videoRepository.findOneByOrFail({ id: video.id });

  describe('findById', () => {
    it('returns the video by id', async () => {
      const video = await videoIn('processing');

      await expect(lifecycle.findById(video.id)).resolves.toMatchObject({
        id: video.id,
        short_id: video.short_id,
        original_object_key: video.original_object_key,
        processing_status: 'processing',
      });
    });

    it('returns null for an unknown id', async () => {
      await expect(
        lifecycle.findById('00000000-0000-4000-8000-000000000000'),
      ).resolves.toBeNull();
    });
  });

  describe('markProcessing', () => {
    it('moves uploading to processing', async () => {
      const video = await videoIn('uploading');

      await expect(lifecycle.markProcessing(video.id)).resolves.toBe(true);
      expect((await reload(video)).processing_status).toBe('processing');
    });

    it.each(['processing', 'ready', 'failed'] as const)(
      'does not change a %s video',
      async (status) => {
        const video = await videoIn(status);

        await expect(lifecycle.markProcessing(video.id)).resolves.toBe(false);
        expect((await reload(video)).processing_status).toBe(status);
      },
    );
  });

  describe('markUploadRejected', () => {
    it('moves uploading to failed with UPLOAD_REJECTED', async () => {
      const video = await videoIn('uploading');

      await expect(lifecycle.markUploadRejected(video.id)).resolves.toBe(true);
      const after = await reload(video);
      expect(after.processing_status).toBe('failed');
      expect(after.failure_reason).toBe('UPLOAD_REJECTED');
    });

    it.each(['processing', 'ready'] as const)(
      'does not change a %s video',
      async (status) => {
        const video = await videoIn(status);

        await expect(lifecycle.markUploadRejected(video.id)).resolves.toBe(
          false,
        );
        expect((await reload(video)).processing_status).toBe(status);
      },
    );
  });

  describe('markReady', () => {
    it.each(['uploading', 'processing'] as const)(
      'moves %s to ready with metadata and processed_at',
      async (status) => {
        const video = await videoIn(status);

        await expect(lifecycle.markReady(video.id, METADATA)).resolves.toBe(
          true,
        );
        const after = await reload(video);
        expect(after).toMatchObject({
          ...METADATA,
          processing_status: 'ready',
          failure_reason: null,
        });
        expect(after.processed_at).toBeInstanceOf(Date);
      },
    );

    it('does not resurrect a failed video', async () => {
      const video = await videoIn('failed');

      await expect(lifecycle.markReady(video.id, METADATA)).resolves.toBe(
        false,
      );
      const after = await reload(video);
      expect(after.processing_status).toBe('failed');
      expect(after.thumbnail_object_key).toBeNull();
    });
  });

  describe('markFailed', () => {
    it.each(['uploading', 'processing'] as const)(
      'moves %s to failed with the given reason',
      async (status) => {
        const video = await videoIn(status);

        await expect(
          lifecycle.markFailed(video.id, 'UNSUPPORTED_FORMAT'),
        ).resolves.toBe(true);
        const after = await reload(video);
        expect(after.processing_status).toBe('failed');
        expect(after.failure_reason).toBe('UNSUPPORTED_FORMAT');
      },
    );

    it('does not overwrite a ready video', async () => {
      const video = await videoIn('ready');

      await expect(
        lifecycle.markFailed(video.id, 'PROCESSING_FAILED'),
      ).resolves.toBe(false);
      const after = await reload(video);
      expect(after.processing_status).toBe('ready');
      expect(after.failure_reason).toBeNull();
    });
  });
});
