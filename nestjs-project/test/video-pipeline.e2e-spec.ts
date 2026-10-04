import { join } from 'node:path';
import request from 'supertest';
import type { ApiErrorEnvelope } from '../src/common/openapi/api-error-envelope.dto';
import { storageHttpRequest } from '../src/test/storage';
import type { MediaUrl } from '../src/videos/videos.service';
import { VideoPipeline } from './helpers/video-pipeline';

const FIXTURES = join(__dirname, 'fixtures', 'videos');
const H264_AAC = join(FIXTURES, 'h264-aac.mp4');
const MPEG4 = join(FIXTURES, 'mpeg4.mp4');
const MAX_VIDEO_SIZE = 10737418240; // 10 GiB

describe('Video upload & processing pipeline (e2e)', () => {
  let pipeline: VideoPipeline;

  beforeAll(async () => {
    pipeline = await VideoPipeline.start();
    await pipeline.reset();
  }, 60000);

  afterAll(async () => {
    await pipeline.close();
  }, 30000);

  afterEach(async () => {
    await pipeline.reset();
  });

  it('h264/aac upload reaches ready and serves thumbnail, playback and download', async () => {
    const token = await pipeline.registerConfirmAndLogin();
    const { shortId, complete } = await pipeline.uploadFile(token, H264_AAC);
    expect(complete.status).toBe(200);

    const video = await pipeline.waitForStatus(token, shortId, 'ready');
    expect(video).toMatchObject({
      failure_reason: null,
      width: 320,
      height: 240,
      video_codec: 'h264',
      audio_codec: 'aac',
    });
    expect(video.duration_seconds).toBeGreaterThan(0);
    expect(video.thumbnail_url).toEqual(expect.any(String));
    expect(video.processed_at).toEqual(expect.any(String));

    const thumbnail = await storageHttpRequest(video.thumbnail_url as string);
    expect(thumbnail.status).toBe(200);
    expect(thumbnail.headers['content-type']).toBe('image/jpeg');

    const playback = await request(pipeline.app.getHttpServer())
      .get(`/videos/${shortId}/playback-url`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const ranged = await storageHttpRequest((playback.body as MediaUrl).url, {
      headers: { Range: 'bytes=0-1023' },
    });
    expect(ranged.status).toBe(206);
    expect(ranged.body.length).toBe(1024);

    const download = await request(pipeline.app.getHttpServer())
      .get(`/videos/${shortId}/download-url`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const file = await storageHttpRequest((download.body as MediaUrl).url);
    expect(file.status).toBe(200);
    expect(file.headers['content-disposition']).toMatch(/^attachment/);
  }, 60000);

  it('mpeg-4 part 2 upload ends failed with UNSUPPORTED_FORMAT', async () => {
    const token = await pipeline.registerConfirmAndLogin();
    const { shortId, complete } = await pipeline.uploadFile(token, MPEG4);
    expect(complete.status).toBe(200);

    const video = await pipeline.waitForStatus(token, shortId, 'failed');
    expect(video.failure_reason).toBe('UNSUPPORTED_FORMAT');
    expect(video.thumbnail_url).toBeNull();
  }, 60000);

  it('declared size above the uploaded bytes is rejected on complete', async () => {
    const token = await pipeline.registerConfirmAndLogin();
    const { shortId, complete } = await pipeline.uploadFile(token, H264_AAC, {
      size: 40000, // fixture is ~31 KiB
    });

    expect(complete.status).toBe(422);
    expect((complete.body as ApiErrorEnvelope).error).toBe(
      'VIDEO_SIZE_MISMATCH',
    );
    const res = await pipeline.getVideo(token, shortId);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      processing_status: 'failed',
      failure_reason: 'UPLOAD_REJECTED',
    });
  }, 60000);

  it('initiate accepts exactly 10 GiB and rejects one byte more', async () => {
    const token = await pipeline.registerConfirmAndLogin();
    const body = { file_name: 'big.mp4', mime_type: 'video/mp4' };

    const atLimit = await pipeline.initiate(token, {
      ...body,
      size: MAX_VIDEO_SIZE,
    });
    expect(atLimit.status).toBe(201);

    const overLimit = await pipeline.initiate(token, {
      ...body,
      size: MAX_VIDEO_SIZE + 1,
    });
    expect(overLimit.status).toBe(422);
    expect((overLimit.body as ApiErrorEnvelope).error).toBe('VIDEO_TOO_LARGE');
  });

  it('uploads get distinct short ids and are hidden from other users', async () => {
    const owner = await pipeline.registerConfirmAndLogin();
    const other = await pipeline.registerConfirmAndLogin();
    const first = await pipeline.uploadFile(owner, H264_AAC);
    const second = await pipeline.uploadFile(owner, H264_AAC);
    expect(first.complete.status).toBe(200);
    expect(second.complete.status).toBe(200);
    expect(first.shortId).not.toBe(second.shortId);

    for (const { shortId } of [first, second]) {
      const res = await pipeline.getVideo(other, shortId);
      expect(res.status).toBe(404);
      expect((res.body as ApiErrorEnvelope).error).toBe('VIDEO_NOT_FOUND');
    }

    // Let processing finish so no job is still running when reset() runs.
    for (const { shortId } of [first, second]) {
      await pipeline.waitForStatus(owner, shortId, 'ready');
    }
  }, 60000);
});
