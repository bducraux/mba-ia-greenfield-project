import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import type { Queue } from 'bullmq';
import {
  UploadSessionExpiredException,
  VideoNotFoundException,
  VideoNotReadyException,
  VideoSizeMismatchException,
} from '../common/exceptions/domain.exception';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { StorageObjectNotFoundError } from '../storage/storage.errors';
import { StorageService } from '../storage/storage.service';
import { storageHttpRequest } from '../test/storage';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { VIDEO_PROCESSING_QUEUE } from '../video-processing/video-processing.constants';
import { Video } from './entities/video.entity';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideosService (integration)', () => {
  let module: TestingModule;
  let service: VideosService;
  let storage: StorageService;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let queue: Queue;
  const openUploads: Array<{ key: string; uploadId: string }> = [];
  const enqueuedVideoIds: string[] = [];

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, queueConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        VideosModule,
      ],
    }).compile();

    service = module.get(VideosService);
    storage = module.get(StorageService);
    dataSource = module.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
    queue = module.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
    // Keep any running worker from consuming (and removing) the test jobs.
    await queue.pause();
  }, 30000);

  afterAll(async () => {
    // Completed or aborted uploads are gone (NoSuchUpload); assembled objects
    // are deleted (S3 DeleteObject is a no-op for missing keys).
    for (const { key, uploadId } of openUploads) {
      await storage.abortMultipartUpload(key, uploadId).catch(() => undefined);
      await storage.deleteObject('videos', key);
    }
    for (const id of enqueuedVideoIds) {
      await queue.remove(id);
    }
    await queue.resume();
    await cleanAllTables(dataSource);
    await module.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let userCounter = 0;
  async function createUserWithChannel(): Promise<User> {
    const n = ++userCounter;
    const user = await dataSource.getRepository(User).save({
      email: `videos_svc_${n}@example.com`,
      password: 'hashed',
    });
    await dataSource.getRepository(Channel).save({
      name: `videos_svc_${n}`,
      nickname: `videos_svc_${n}`,
      user_id: user.id,
    });
    return user;
  }

  async function initiate(userId: string, size = 1048576): Promise<Video> {
    const result = await service.initiateUpload(userId, {
      file_name: 'clip.mp4',
      mime_type: 'video/mp4',
      size,
    });
    const video = await videoRepository.findOneByOrFail({
      short_id: result.video.short_id,
    });
    openUploads.push({
      key: video.original_object_key,
      uploadId: video.upload_id,
    });
    return video;
  }

  describe('initiateUpload', () => {
    it('persists an uploading draft whose upload_id is a live multipart upload', async () => {
      const user = await createUserWithChannel();

      const result = await service.initiateUpload(user.id, {
        file_name: 'clip.mp4',
        mime_type: 'video/mp4',
        size: 1048576,
      });

      const video = await videoRepository.findOneByOrFail({
        short_id: result.video.short_id,
      });
      openUploads.push({
        key: video.original_object_key,
        uploadId: video.upload_id,
      });
      expect(video.processing_status).toBe('uploading');
      expect(video.publication_status).toBe('draft');
      expect(video.title).toBe('clip');
      expect(video.original_object_key).toBe(`${video.short_id}/source.mp4`);
      await expect(
        storage.listParts(video.original_object_key, video.upload_id),
      ).resolves.toEqual([]);

      expect(result.video).toMatchObject({
        short_id: video.short_id,
        processing_status: 'uploading',
        publication_status: 'draft',
        size_bytes: 1048576,
        thumbnail_url: null,
      });
      expect(result.upload).toEqual({ part_size: 67108864, part_count: 1 });
    });
  });

  describe('findOwnedByShortId', () => {
    it('returns the video to its owner', async () => {
      const owner = await createUserWithChannel();
      const video = await initiate(owner.id);

      const found = await service.findOwnedByShortId(owner.id, video.short_id);

      expect(found.id).toBe(video.id);
    });

    it('hides the video from another channel', async () => {
      const owner = await createUserWithChannel();
      const other = await createUserWithChannel();
      const video = await initiate(owner.id);

      await expect(
        service.findOwnedByShortId(other.id, video.short_id),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });
  });

  describe('upload session', () => {
    const BYTES = Buffer.alloc(1024, 7);

    /** Uploads `body` as part 1 through a presigned URL, like the browser. */
    async function uploadPart(
      userId: string,
      video: Video,
      body: Buffer,
    ): Promise<string> {
      const { parts } = await service.signPartUrls(userId, video.short_id, [1]);
      const res = await storageHttpRequest(parts[0].url, {
        method: 'PUT',
        body,
      });
      expect(res.status).toBe(200);
      return res.headers.etag as string;
    }

    it('lists the uploaded part for resume', async () => {
      const owner = await createUserWithChannel();
      const video = await initiate(owner.id, BYTES.length);
      const etag = await uploadPart(owner.id, video, BYTES);

      await expect(
        service.listUploadedParts(owner.id, video.short_id),
      ).resolves.toEqual({
        part_size: 67108864,
        part_count: 1,
        parts: [{ part_number: 1, etag, size: BYTES.length }],
      });
    });

    it('completes into processing with exactly one job keyed by the video id, idempotently', async () => {
      const owner = await createUserWithChannel();
      const video = await initiate(owner.id, BYTES.length);
      enqueuedVideoIds.push(video.id);
      const etag = await uploadPart(owner.id, video, BYTES);
      const parts = [{ part_number: 1, etag }];

      const first = await service.completeUpload(
        owner.id,
        video.short_id,
        parts,
      );
      const replay = await service.completeUpload(
        owner.id,
        video.short_id,
        parts,
      );

      expect(first.processing_status).toBe('processing');
      expect(replay).toEqual(first);
      const head = await storage.headObject(
        'videos',
        video.original_object_key,
      );
      expect(head.contentLength).toBe(BYTES.length);
      const job = await queue.getJob(video.id);
      expect(job?.data).toEqual({ videoId: video.id });
      const jobs = await queue.getJobs(['waiting', 'prioritized']);
      expect(jobs.filter((j) => j.id === video.id)).toHaveLength(1);
    });

    it('rejects a declared size larger than the bytes sent: object deleted, failed, no job', async () => {
      const owner = await createUserWithChannel();
      const video = await initiate(owner.id, BYTES.length * 2);
      enqueuedVideoIds.push(video.id);
      const etag = await uploadPart(owner.id, video, BYTES);

      await expect(
        service.completeUpload(owner.id, video.short_id, [
          { part_number: 1, etag },
        ]),
      ).rejects.toBeInstanceOf(VideoSizeMismatchException);

      const after = await videoRepository.findOneByOrFail({ id: video.id });
      expect(after.processing_status).toBe('failed');
      expect(after.failure_reason).toBe('UPLOAD_REJECTED');
      await expect(
        storage.headObject('videos', video.original_object_key),
      ).rejects.toBeInstanceOf(StorageObjectNotFoundError);
      await expect(queue.getJob(video.id)).resolves.toBeUndefined();
    });

    it('maps an upload aborted by storage to UPLOAD_SESSION_EXPIRED and keeps it uploading', async () => {
      const owner = await createUserWithChannel();
      const video = await initiate(owner.id);
      await storage.abortMultipartUpload(
        video.original_object_key,
        video.upload_id,
      );

      await expect(
        service.listUploadedParts(owner.id, video.short_id),
      ).rejects.toBeInstanceOf(UploadSessionExpiredException);
      const after = await videoRepository.findOneByOrFail({ id: video.id });
      expect(after.processing_status).toBe('uploading');
    });
  });

  describe('media URLs', () => {
    const BYTES = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 256));

    /** A `ready` video whose source object holds `BYTES`. */
    async function readyVideo(userId: string, title: string): Promise<Video> {
      const video = await initiate(userId, BYTES.length);
      await storage.putObject('videos', video.original_object_key, BYTES, {
        contentType: 'video/mp4',
      });
      await videoRepository.update(
        { id: video.id },
        { processing_status: 'ready', title },
      );
      return videoRepository.findOneByOrFail({ id: video.id });
    }

    it('issues a playback URL that storage serves with HTTP Range', async () => {
      const owner = await createUserWithChannel();
      const video = await readyVideo(owner.id, 'clip');

      const { url } = await service.getPlaybackUrl(owner.id, video.short_id);
      const res = await storageHttpRequest(url, {
        headers: { Range: 'bytes=0-1023' },
      });

      expect(res.status).toBe(206);
      expect(res.body).toHaveLength(1024);
      expect(res.body.equals(BYTES.subarray(0, 1024))).toBe(true);
    });

    it('issues a download URL whose response is an attachment named after the title', async () => {
      const owner = await createUserWithChannel();
      const video = await readyVideo(owner.id, 'Férias "2026"');

      const { url } = await service.getDownloadUrl(owner.id, video.short_id);
      const res = await storageHttpRequest(url);

      expect(res.status).toBe(200);
      const disposition = res.headers['content-disposition'] as string;
      expect(disposition).toMatch(/^attachment;/);
      expect(disposition).toContain(
        `filename*=UTF-8''F%C3%A9rias%20%222026%22.mp4`,
      );
      const fallback = /filename="([^"]*)"/.exec(disposition)?.[1];
      expect(fallback).toBe('Ferias 2026.mp4');
      expect(fallback).toMatch(/^[\x20-\x7e]+$/);
    });

    it('refuses media URLs while the video is still uploading', async () => {
      const owner = await createUserWithChannel();
      const video = await initiate(owner.id);

      await expect(
        service.getPlaybackUrl(owner.id, video.short_id),
      ).rejects.toBeInstanceOf(VideoNotReadyException);
    });
  });
});
