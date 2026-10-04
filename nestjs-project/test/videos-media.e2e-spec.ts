import { INestApplication, ValidationPipe } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import type { Queue } from 'bullmq';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import type { ApiErrorEnvelope } from '../src/common/openapi/api-error-envelope.dto';
import { MailService } from '../src/mail/mail.service';
import { StorageService } from '../src/storage/storage.service';
import { buildSwaggerDocument } from '../src/swagger/swagger-document';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { storageHttpRequest } from '../src/test/storage';
import { VIDEO_PROCESSING_QUEUE } from '../src/video-processing/video-processing.constants';
import { Video } from '../src/videos/entities/video.entity';
import { VideoLifecycleService } from '../src/videos/video-lifecycle.service';
import type { VideoResponse } from '../src/videos/video-response.mapper';
import type {
  InitiateUploadResult,
  MediaUrl,
  SignedPartUrls,
} from '../src/videos/videos.service';

const CLIP = { file_name: 'clip.mp4', mime_type: 'video/mp4', size: 1048576 };

describe('Videos status & media URLs (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let storage: StorageService;
  let lifecycle: VideoLifecycleService;
  let queue: Queue;
  let throttlerStorage: ThrottlerStorageService;
  const openUploads: Array<{ key: string; uploadId: string }> = [];
  const enqueuedVideoIds: string[] = [];

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
    storage = moduleFixture.get(StorageService);
    lifecycle = moduleFixture.get(VideoLifecycleService);
    queue = moduleFixture.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
    // Keep any running worker from consuming the test jobs and advancing the
    // videos this suite drives by hand.
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
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
  });

  let userCounter = 0;
  async function registerConfirmAndLogin(): Promise<string> {
    const email = `videos_media_${++userCounter}@example.com`;
    const password = 'password123';
    let confirmationToken = '';
    jest
      .spyOn(app.get(MailService), 'sendConfirmationEmail')
      .mockImplementationOnce((_e: string, _n: string, t: string) => {
        confirmationToken = t;
        return Promise.resolve();
      });
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password })
      .expect(201);
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token: confirmationToken })
      .expect(204);
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password })
      .expect(200);
    return (res.body as { access_token: string }).access_token;
  }

  /** POST /videos as `token`, tracking the multipart upload for cleanup. */
  async function initiate(
    token: string,
    body: typeof CLIP = CLIP,
  ): Promise<{ shortId: string; id: string }> {
    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send(body)
      .expect(201);
    const shortId = (res.body as InitiateUploadResult).video.short_id;
    const video = await videoRepository.findOneByOrFail({ short_id: shortId });
    openUploads.push({
      key: video.original_object_key,
      uploadId: video.upload_id,
    });
    return { shortId, id: video.id };
  }

  /** Uploads `bytes` as a single part and completes: the video is `processing`. */
  async function uploadAndComplete(
    token: string,
    bytes: Buffer,
  ): Promise<{ shortId: string; id: string }> {
    const video = await initiate(token, { ...CLIP, size: bytes.length });
    enqueuedVideoIds.push(video.id);
    const signed = await request(app.getHttpServer())
      .post(`/videos/${video.shortId}/upload/part-urls`)
      .set('Authorization', `Bearer ${token}`)
      .send({ part_numbers: [1] })
      .expect(200);
    const put = await storageHttpRequest(
      (signed.body as SignedPartUrls).parts[0].url,
      { method: 'PUT', body: bytes },
    );
    expect(put.status).toBe(200);
    await request(app.getHttpServer())
      .post(`/videos/${video.shortId}/upload/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send({ parts: [{ part_number: 1, etag: put.headers.etag as string }] })
      .expect(200);
    return video;
  }

  async function markReady(id: string): Promise<void> {
    const advanced = await lifecycle.markReady(id, {
      duration_seconds: 1,
      width: 320,
      height: 240,
      video_codec: 'h264',
      audio_codec: 'aac',
      thumbnail_object_key: `${id}/thumbnail.jpg`,
    });
    expect(advanced).toBe(true);
  }

  function expectIsoDate(value: string): void {
    expect(new Date(value).toISOString()).toBe(value);
  }

  // 1. GET /videos/:shortId — consulta do dono
  it('get-video-as-owner-returns-video-response', async () => {
    const token = await registerConfirmAndLogin();
    const { shortId } = await initiate(token);

    const res = await request(app.getHttpServer())
      .get(`/videos/${shortId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const body = res.body as VideoResponse;
    expect(body).toMatchObject({
      short_id: shortId,
      processing_status: 'uploading',
      failure_reason: null,
      thumbnail_url: null,
    });
    for (const internal of [
      'id',
      'channel_id',
      'original_object_key',
      'upload_id',
      'thumbnail_object_key',
    ]) {
      expect(body).not.toHaveProperty(internal);
    }
  });

  it('get-video-not-owned-unknown-or-malformed-returns-404', async () => {
    const owner = await registerConfirmAndLogin();
    const other = await registerConfirmAndLogin();
    const { shortId } = await initiate(owner);

    for (const [path, token] of [
      [`/videos/${shortId}`, other],
      ['/videos/AAAAAAAAAAA', owner],
      ['/videos/abc', owner],
    ]) {
      const res = await request(app.getHttpServer())
        .get(path)
        .set('Authorization', `Bearer ${token}`)
        .expect(404);
      expect((res.body as ApiErrorEnvelope).error).toBe('VIDEO_NOT_FOUND');
    }
  });

  it('get-video-anonymous-returns-401', async () => {
    const token = await registerConfirmAndLogin();
    const { shortId } = await initiate(token);

    await request(app.getHttpServer()).get(`/videos/${shortId}`).expect(401);
  });

  // 2. URLs de mídia — playback e download
  it('playback-url-ready-vs-processing', async () => {
    const token = await registerConfirmAndLogin();
    const bytes = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 256));
    const { shortId, id } = await uploadAndComplete(token, bytes);

    const notReady = await request(app.getHttpServer())
      .get(`/videos/${shortId}/playback-url`)
      .set('Authorization', `Bearer ${token}`)
      .expect(409);
    expect((notReady.body as ApiErrorEnvelope).error).toBe('VIDEO_NOT_READY');

    await markReady(id);
    const ready = await request(app.getHttpServer())
      .get(`/videos/${shortId}/playback-url`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const { url, expires_at } = ready.body as MediaUrl;
    expectIsoDate(expires_at);
    const ranged = await storageHttpRequest(url, {
      headers: { Range: 'bytes=0-1023' },
    });
    expect(ranged.status).toBe(206);
    expect(ranged.body.equals(bytes.subarray(0, 1024))).toBe(true);
  });

  it('download-url-forces-attachment', async () => {
    const token = await registerConfirmAndLogin();
    const { shortId, id } = await uploadAndComplete(
      token,
      Buffer.alloc(2048, 3),
    );
    await markReady(id);

    const res = await request(app.getHttpServer())
      .get(`/videos/${shortId}/download-url`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const { url, expires_at } = res.body as MediaUrl;
    expectIsoDate(expires_at);

    const download = await storageHttpRequest(url);
    expect(download.status).toBe(200);
    const disposition = download.headers['content-disposition'] as string;
    expect(disposition).toMatch(/^attachment/);
    expect(disposition).toContain(`filename*=UTF-8''clip.mp4`);
  });

  // 3. Documentação OpenAPI
  it('openapi-documents-media-operations', () => {
    const document = buildSwaggerDocument(app);
    const errorRef = '#/components/schemas/ApiErrorEnvelope';
    const expected: Array<[string, string[]]> = [
      ['/videos/{shortId}', ['200', '401', '404']],
      ['/videos/{shortId}/playback-url', ['200', '401', '404', '409']],
      ['/videos/{shortId}/download-url', ['200', '401', '404', '409']],
    ];

    for (const [path, statuses] of expected) {
      const responses = document.paths[path]?.get?.responses ?? {};
      expect(Object.keys(responses).sort()).toEqual([...statuses].sort());
      for (const status of statuses.filter((s) => Number(s) >= 400)) {
        const schema = (
          responses[status] as {
            content?: Record<string, { schema?: { $ref?: string } }>;
          }
        ).content?.['application/json']?.schema;
        expect(schema?.$ref).toBe(errorRef);
      }
    }
  });
});
