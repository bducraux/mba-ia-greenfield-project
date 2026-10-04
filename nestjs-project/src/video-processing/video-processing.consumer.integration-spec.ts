import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UnrecoverableError, type Job } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import { StorageObjectNotFoundError } from '../storage/storage.errors';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { storageHttpRequest } from '../test/storage';
import { User } from '../users/entities/user.entity';
import { Video } from '../videos/entities/video.entity';
import { generateShortId } from '../videos/short-id.util';
import { VideoLifecycleService } from '../videos/video-lifecycle.service';
import type { ProcessingStatus } from '../videos/video.types';
import { MediaProbeService } from './media/media-probe.service';
import type { ProcessVideoJobData } from './video-processing.constants';
import { VideoProcessingConsumer } from './video-processing.consumer';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];
const FIXTURES = resolve(__dirname, '../../test/fixtures/videos');

const jobFor = (videoId: string): Job<ProcessVideoJobData> =>
  ({
    data: { videoId },
    attemptsMade: 0,
    opts: { attempts: 3 },
  }) as unknown as Job<ProcessVideoJobData>;

/**
 * `process()` is called directly: no BullModule is imported, so no Worker
 * is started and the shared `video-processing` queue is never touched.
 */
describe('VideoProcessingConsumer (integration)', () => {
  let module: TestingModule;
  let consumer: VideoProcessingConsumer;
  let storage: StorageService;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let channel: Channel;
  const createdObjects: Array<{
    bucket: 'videos' | 'thumbnails';
    key: string;
  }> = [];

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        TypeOrmModule.forFeature([Video]),
        StorageModule,
      ],
      providers: [
        VideoLifecycleService,
        MediaProbeService,
        VideoProcessingConsumer,
      ],
    }).compile();

    consumer = module.get(VideoProcessingConsumer);
    storage = module.get(StorageService);
    dataSource = module.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
  }, 30000);

  afterAll(async () => {
    // S3 DeleteObject is a no-op for missing keys.
    for (const { bucket, key } of createdObjects) {
      await storage.deleteObject(bucket, key);
    }
    await cleanAllTables(dataSource);
    await module.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    const user = await dataSource
      .getRepository(User)
      .save({ email: 'worker@example.com', password: 'hashed' });
    channel = await dataSource.getRepository(Channel).save({
      name: 'worker',
      nickname: 'worker',
      user_id: user.id,
    });
  });

  /** Creates a video row and, when `fixture` is given, uploads it as the source. */
  async function videoWithSource(
    fixture: string | null,
    status: ProcessingStatus = 'processing',
  ): Promise<Video> {
    const shortId = generateShortId();
    const key = `${shortId}/source${fixture ? fixture.slice(fixture.lastIndexOf('.')) : '.mp4'}`;
    if (fixture) {
      await storage.putObject(
        'videos',
        key,
        readFileSync(join(FIXTURES, fixture)),
        { contentType: fixture.endsWith('.webm') ? 'video/webm' : 'video/mp4' },
      );
      createdObjects.push({ bucket: 'videos', key });
    }
    return videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        short_id: shortId,
        title: 'clip',
        original_object_key: key,
        mime_type: 'video/mp4',
        size_bytes: 1024,
        upload_id: 'upload-id',
        processing_status: status,
      }),
    );
  }

  async function reload(video: Video): Promise<Video> {
    const fresh = await videoRepository.findOneByOrFail({ id: video.id });
    if (fresh.thumbnail_object_key) {
      createdObjects.push({
        bucket: 'thumbnails',
        key: fresh.thumbnail_object_key,
      });
    }
    return fresh;
  }

  it('should move an h264-aac.mp4 video to ready with metadata and a public thumbnail', async () => {
    const video = await videoWithSource('h264-aac.mp4');

    await consumer.process(jobFor(video.id));

    const processed = await reload(video);
    expect(processed).toMatchObject({
      processing_status: 'ready',
      failure_reason: null,
      width: 320,
      height: 240,
      video_codec: 'h264',
      audio_codec: 'aac',
    });
    expect(processed.duration_seconds).toBeCloseTo(2, 1);
    expect(processed.processed_at).toBeInstanceOf(Date);
    expect(processed.thumbnail_object_key).toMatch(
      new RegExp(`^${video.short_id}/[0-9a-f]{16}\\.jpg$`),
    );

    const thumbnail = await storageHttpRequest(
      storage.buildPublicObjectUrl(
        'thumbnails',
        processed.thumbnail_object_key as string,
      ),
    );
    expect(thumbnail.status).toBe(200);
    expect(thumbnail.headers['content-type']).toBe('image/jpeg');
    expect(thumbnail.headers['cache-control']).toBe(
      'public, max-age=31536000, immutable',
    );
    expect(thumbnail.body.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  }, 30000);

  it('should also process a video that is still uploading', async () => {
    const video = await videoWithSource('vp9-opus.webm', 'uploading');

    await consumer.process(jobFor(video.id));

    await expect(reload(video)).resolves.toMatchObject({
      processing_status: 'ready',
      video_codec: 'vp9',
      audio_codec: 'opus',
    });
  }, 30000);

  it('should fail an mpeg4.mp4 video as UNSUPPORTED_FORMAT without retries and keep the source', async () => {
    const video = await videoWithSource('mpeg4.mp4');

    await expect(consumer.process(jobFor(video.id))).rejects.toThrow(
      UnrecoverableError,
    );

    await expect(reload(video)).resolves.toMatchObject({
      processing_status: 'failed',
      failure_reason: 'UNSUPPORTED_FORMAT',
      thumbnail_object_key: null,
    });
    await expect(
      storage.headObject('videos', video.original_object_key),
    ).resolves.toMatchObject({ contentLength: expect.any(Number) as number });
  }, 30000);

  it('should fail a not-a-video.mp4 source as UNSUPPORTED_FORMAT without retries', async () => {
    const video = await videoWithSource('not-a-video.mp4');

    await expect(consumer.process(jobFor(video.id))).rejects.toThrow(
      UnrecoverableError,
    );

    await expect(reload(video)).resolves.toMatchObject({
      processing_status: 'failed',
      failure_reason: 'UNSUPPORTED_FORMAT',
    });
  }, 30000);

  it('should fail a video whose source object is missing as SOURCE_MISSING without retries', async () => {
    const video = await videoWithSource(null);
    await expect(
      storage.headObject('videos', video.original_object_key),
    ).rejects.toThrow(StorageObjectNotFoundError);

    await expect(consumer.process(jobFor(video.id))).rejects.toThrow(
      UnrecoverableError,
    );

    await expect(reload(video)).resolves.toMatchObject({
      processing_status: 'failed',
      failure_reason: 'SOURCE_MISSING',
    });
  });

  it('should leave a ready video untouched when its job is processed again', async () => {
    const video = await videoWithSource('h264-aac.mp4');
    await consumer.process(jobFor(video.id));
    const ready = await reload(video);
    const putObject = jest.spyOn(storage, 'putObject');

    await consumer.process(jobFor(video.id));

    expect(await reload(video)).toEqual(ready);
    expect(putObject).not.toHaveBeenCalled();
    putObject.mockRestore();
  }, 30000);
});
