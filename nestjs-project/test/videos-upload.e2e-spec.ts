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
import {
  PROCESS_VIDEO_JOB,
  VIDEO_PROCESSING_QUEUE,
} from '../src/video-processing/video-processing.constants';
import { Video } from '../src/videos/entities/video.entity';
import type { VideoResponse } from '../src/videos/video-response.mapper';
import type {
  InitiateUploadResult,
  SignedPartUrls,
  UploadedParts,
} from '../src/videos/videos.service';

const CLIP = { file_name: 'clip.mp4', mime_type: 'video/mp4', size: 1048576 };

describe('Videos upload (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let storage: StorageService;
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
    queue = moduleFixture.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
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
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
  });

  let userCounter = 0;
  async function registerConfirmAndLogin(): Promise<string> {
    const email = `videos_upload_${++userCounter}@example.com`;
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
  ): Promise<InitiateUploadResult & { id: string }> {
    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send(body)
      .expect(201);
    const result = res.body as InitiateUploadResult;
    const video = await videoRepository.findOneByOrFail({
      short_id: result.video.short_id,
    });
    openUploads.push({
      key: video.original_object_key,
      uploadId: video.upload_id,
    });
    return { ...result, id: video.id };
  }

  async function videoCount(): Promise<number> {
    return videoRepository.count();
  }

  // 1. POST /videos — iniciar upload
  it('initiate-without-token-returns-401', async () => {
    await request(app.getHttpServer()).post('/videos').send(CLIP).expect(401);

    expect(await videoCount()).toBe(0);
  });

  it('initiate-creates-uploading-draft', async () => {
    const token = await registerConfirmAndLogin();

    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send(CLIP)
      .expect(201);

    const { video, upload } = res.body as InitiateUploadResult;
    const row = await videoRepository.findOneByOrFail({
      short_id: video.short_id,
    });
    openUploads.push({ key: row.original_object_key, uploadId: row.upload_id });
    expect(video.processing_status).toBe('uploading');
    expect(video.publication_status).toBe('draft');
    expect(video.title).toBe('clip');
    expect(video.short_id).toMatch(/^[A-Za-z0-9_-]{11}$/);
    expect(upload).toEqual({ part_size: 67108864, part_count: 1 });
    for (const internal of [
      'id',
      'channel_id',
      'original_object_key',
      'upload_id',
      'thumbnail_object_key',
    ]) {
      expect(video).not.toHaveProperty(internal);
    }
  });

  it('initiate-rejects-too-large-and-unsupported-format', async () => {
    const token = await registerConfirmAndLogin();

    const tooLarge = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send({ ...CLIP, size: 10737418241 })
      .expect(422);
    expect(tooLarge.body).toEqual({
      statusCode: 422,
      error: 'VIDEO_TOO_LARGE',
      message: expect.any(String) as string,
    });
    expect(await videoCount()).toBe(0);

    const unsupported = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send({ file_name: 'clip.mov', mime_type: 'video/quicktime', size: 1 })
      .expect(415);
    expect((unsupported.body as ApiErrorEnvelope).error).toBe(
      'UNSUPPORTED_VIDEO_FORMAT',
    );
    expect(await videoCount()).toBe(0);
  });

  it('initiate-validation-wiring', async () => {
    const token = await registerConfirmAndLogin();

    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send({ file_name: CLIP.file_name, mime_type: CLIP.mime_type })
      .expect(400);

    const body = res.body as ApiErrorEnvelope;
    expect(body.error).toBe('VALIDATION_ERROR');
    expect(Array.isArray(body.message)).toBe(true);
  });

  // 2. POST /videos/:shortId/upload/part-urls — presign de parts
  it('part-urls-validation-wiring', async () => {
    const token = await registerConfirmAndLogin();
    const { video } = await initiate(token);

    const res = await request(app.getHttpServer())
      .post(`/videos/${video.short_id}/upload/part-urls`)
      .set('Authorization', `Bearer ${token}`)
      .send({ part_numbers: [] })
      .expect(400);

    expect((res.body as ApiErrorEnvelope).error).toBe('VALIDATION_ERROR');
  });

  it('part-urls-of-another-users-video-returns-404', async () => {
    const owner = await registerConfirmAndLogin();
    const other = await registerConfirmAndLogin();
    const { video } = await initiate(owner);

    const denied = await request(app.getHttpServer())
      .post(`/videos/${video.short_id}/upload/part-urls`)
      .set('Authorization', `Bearer ${other}`)
      .send({ part_numbers: [1] })
      .expect(404);
    expect((denied.body as ApiErrorEnvelope).error).toBe('VIDEO_NOT_FOUND');

    const allowed = await request(app.getHttpServer())
      .post(`/videos/${video.short_id}/upload/part-urls`)
      .set('Authorization', `Bearer ${owner}`)
      .send({ part_numbers: [1] })
      .expect(200);
    const body = allowed.body as SignedPartUrls;
    expect(body.parts).toHaveLength(1);
    expect(body.parts[0].part_number).toBe(1);
    expect(body.parts[0].url).toContain('X-Amz-Signature=');
    expect(new Date(body.expires_at).toISOString()).toBe(body.expires_at);
  });

  // 3. Upload das parts e POST /videos/:shortId/upload/complete
  it('complete-moves-video-to-processing', async () => {
    const token = await registerConfirmAndLogin();
    const bytes = Buffer.alloc(2048, 7);
    const { video, id } = await initiate(token, {
      ...CLIP,
      size: bytes.length,
    });
    enqueuedVideoIds.push(id);
    const signed = await request(app.getHttpServer())
      .post(`/videos/${video.short_id}/upload/part-urls`)
      .set('Authorization', `Bearer ${token}`)
      .send({ part_numbers: [1] })
      .expect(200);
    const put = await storageHttpRequest(
      (signed.body as SignedPartUrls).parts[0].url,
      { method: 'PUT', body: bytes },
    );
    expect(put.status).toBe(200);
    const etag = put.headers.etag as string;

    const listed = await request(app.getHttpServer())
      .get(`/videos/${video.short_id}/upload/parts`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(listed.body).toEqual({
      part_size: 67108864,
      part_count: 1,
      parts: [{ part_number: 1, etag, size: bytes.length }],
    } satisfies UploadedParts);

    const completed = await request(app.getHttpServer())
      .post(`/videos/${video.short_id}/upload/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send({ parts: [{ part_number: 1, etag }] })
      .expect(200);
    expect(['processing', 'ready']).toContain(
      (completed.body as VideoResponse).processing_status,
    );
    const jobs = await queue.getJobs(['waiting', 'prioritized']);
    const ownJobs = jobs.filter((j) => j.id === id);
    expect(ownJobs).toHaveLength(1);
    expect(ownJobs[0].name).toBe(PROCESS_VIDEO_JOB);
  });

  // 4. Rate limit e documentação OpenAPI
  it('video-endpoints-are-not-throttled', async () => {
    const token = await registerConfirmAndLogin();
    const { video } = await initiate(token);

    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await request(app.getHttpServer())
        .get(`/videos/${video.short_id}/upload/parts`)
        .set('Authorization', `Bearer ${token}`);
      statuses.push(res.status);
    }

    expect(statuses).not.toContain(429);
    expect(statuses.every((s) => s === 200)).toBe(true);
  });

  it('openapi-documents-upload-operations', () => {
    const document = buildSwaggerDocument(app);
    const errorRef = '#/components/schemas/ApiErrorEnvelope';
    const expected: Array<[string, 'get' | 'post', string[]]> = [
      ['/videos', 'post', ['201', '400', '401', '415', '422']],
      [
        '/videos/{shortId}/upload/part-urls',
        'post',
        ['200', '400', '401', '404', '409', '422'],
      ],
      [
        '/videos/{shortId}/upload/parts',
        'get',
        ['200', '401', '404', '409', '410'],
      ],
      [
        '/videos/{shortId}/upload/complete',
        'post',
        ['200', '400', '401', '404', '409', '410', '422', '503'],
      ],
    ];

    for (const [path, method, statuses] of expected) {
      const responses = document.paths[path]?.[method]?.responses ?? {};
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
