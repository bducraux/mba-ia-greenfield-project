import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import {
  type INestApplication,
  type INestApplicationContext,
  ValidationPipe,
} from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import type { Queue } from 'bullmq';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types';
import { DataSource, In, type Repository } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { DomainExceptionFilter } from '../../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../../src/common/filters/validation-exception.filter';
import { MailService } from '../../src/mail/mail.service';
import { StorageService } from '../../src/storage/storage.service';
import { cleanAllTables } from '../../src/test/create-test-data-source';
import { storageHttpRequest } from '../../src/test/storage';
import { VIDEO_PROCESSING_QUEUE } from '../../src/video-processing/video-processing.constants';
import { Video } from '../../src/videos/entities/video.entity';
import type { ProcessingStatus } from '../../src/videos/video.types';
import type { VideoResponse } from '../../src/videos/video-response.mapper';
import type {
  InitiateUploadResult,
  SignedPartUrls,
} from '../../src/videos/videos.service';
import { WorkerModule } from '../../src/worker.module';

const MIME_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};
const POLL_INTERVAL_MS = 250;
const DEFAULT_STATUS_TIMEOUT_MS = 30000;

export interface UploadedVideo {
  shortId: string;
  id: string;
  /** Response of POST /videos/:shortId/upload/complete (not asserted here). */
  complete: Response;
}

export interface UploadOptions {
  /** Declared size sent on initiate; defaults to the file's byte length. */
  size?: number;
}

/**
 * The API (AppModule with main.ts' global pipes/filters) plus a WorkerModule
 * context in the same process, so a completed upload is processed without any
 * external worker. Browser-facing presigned URLs are reached through
 * `storageHttpRequest` (connects to STORAGE_ENDPOINT, keeps the signed Host).
 */
export class VideoPipeline {
  private readonly videos: Repository<Video>;
  private readonly createdVideoIds: string[] = [];
  private userCounter = 0;

  private constructor(
    readonly app: INestApplication<App>,
    private readonly worker: INestApplicationContext,
    private readonly dataSource: DataSource,
    private readonly storage: StorageService,
    private readonly queue: Queue,
    private readonly throttlerStorage: ThrottlerStorageService,
  ) {
    this.videos = dataSource.getRepository(Video);
  }

  static async start(): Promise<VideoPipeline> {
    const apiModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const app = apiModule.createNestApplication<INestApplication<App>>();
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

    // init() runs onModuleInit, which starts the BullMQ Worker.
    const workerModule = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();
    const worker = await workerModule.init();

    return new VideoPipeline(
      app,
      worker,
      apiModule.get(DataSource),
      apiModule.get(StorageService),
      apiModule.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE)),
      apiModule.get<ThrottlerStorageService>(ThrottlerStorage),
    );
  }

  /**
   * Deletes what this suite created — open uploads, source objects,
   * thumbnails and queue jobs (jobId = video id) — then empties the tables.
   */
  async reset(): Promise<void> {
    const ids = this.createdVideoIds.splice(0);
    const videos = ids.length ? await this.videos.findBy({ id: In(ids) }) : [];
    for (const video of videos) {
      await this.storage
        .abortMultipartUpload(video.original_object_key, video.upload_id)
        .catch(() => undefined);
      await this.storage.deleteObject('videos', video.original_object_key);
      if (video.thumbnail_object_key) {
        await this.storage.deleteObject(
          'thumbnails',
          video.thumbnail_object_key,
        );
      }
    }
    for (const id of ids) {
      await this.queue.remove(id);
    }
    await cleanAllTables(this.dataSource);
    this.throttlerStorage.storage.clear();
  }

  async close(): Promise<void> {
    await this.reset();
    await this.worker.close();
    await this.app.close();
  }

  async registerConfirmAndLogin(): Promise<string> {
    const email = `video_pipeline_${++this.userCounter}@example.com`;
    const password = 'password123';
    let confirmationToken = '';
    jest
      .spyOn(this.app.get(MailService), 'sendConfirmationEmail')
      .mockImplementationOnce((_e: string, _n: string, t: string) => {
        confirmationToken = t;
        return Promise.resolve();
      });
    await request(this.app.getHttpServer())
      .post('/auth/register')
      .send({ email, password })
      .expect(201);
    await request(this.app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token: confirmationToken })
      .expect(204);
    const res = await request(this.app.getHttpServer())
      .post('/auth/login')
      .send({ email, password })
      .expect(200);
    return (res.body as { access_token: string }).access_token;
  }

  /** POST /videos, tracking the created video for cleanup. */
  async initiate(
    token: string,
    body: { file_name: string; mime_type: string; size: number },
  ): Promise<Response> {
    const res = await request(this.app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send(body);
    if (res.status === 201) {
      const { short_id } = (res.body as InitiateUploadResult).video;
      const video = await this.videos.findOneByOrFail({ short_id });
      this.createdVideoIds.push(video.id);
    }
    return res;
  }

  /** initiate → part-urls → PUT of every part → complete. */
  async uploadFile(
    token: string,
    path: string,
    options: UploadOptions = {},
  ): Promise<UploadedVideo> {
    const bytes = await readFile(path);
    const initiated = await this.initiate(token, {
      file_name: basename(path),
      mime_type: MIME_TYPES[extname(path)],
      size: options.size ?? bytes.length,
    });
    expect(initiated.status).toBe(201);
    const { video, upload } = initiated.body as InitiateUploadResult;
    const shortId = video.short_id;

    const partNumbers = Array.from(
      { length: upload.part_count },
      (_, i) => i + 1,
    );
    const signed = await request(this.app.getHttpServer())
      .post(`/videos/${shortId}/upload/part-urls`)
      .set('Authorization', `Bearer ${token}`)
      .send({ part_numbers: partNumbers })
      .expect(200);

    const parts: Array<{ part_number: number; etag: string }> = [];
    for (const { part_number, url } of (signed.body as SignedPartUrls).parts) {
      const start = (part_number - 1) * upload.part_size;
      const put = await storageHttpRequest(url, {
        method: 'PUT',
        body: bytes.subarray(start, start + upload.part_size),
      });
      expect(put.status).toBe(200);
      parts.push({ part_number, etag: put.headers.etag as string });
    }

    const complete = await request(this.app.getHttpServer())
      .post(`/videos/${shortId}/upload/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send({ parts });
    const { id } = await this.videos.findOneByOrFail({ short_id: shortId });
    return { shortId, id, complete };
  }

  async getVideo(token: string, shortId: string): Promise<Response> {
    return request(this.app.getHttpServer())
      .get(`/videos/${shortId}`)
      .set('Authorization', `Bearer ${token}`);
  }

  /** Polls GET /videos/:shortId until `status`, failing after `timeoutMs`. */
  async waitForStatus(
    token: string,
    shortId: string,
    status: ProcessingStatus,
    timeoutMs = DEFAULT_STATUS_TIMEOUT_MS,
  ): Promise<VideoResponse> {
    const deadline = Date.now() + timeoutMs;
    let last: VideoResponse | undefined;
    while (Date.now() < deadline) {
      const res = await this.getVideo(token, shortId);
      expect(res.status).toBe(200);
      last = res.body as VideoResponse;
      if (last.processing_status === status) {
        return last;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    throw new Error(
      `Video ${shortId} did not reach "${status}" within ${timeoutMs} ms ` +
        `(last: ${last?.processing_status}/${last?.failure_reason})`,
    );
  }
}
