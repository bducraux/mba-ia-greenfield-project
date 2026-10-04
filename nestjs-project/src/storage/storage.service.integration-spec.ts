import {
  GetBucketCorsCommand,
  GetBucketLifecycleConfigurationCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { randomBytes } from 'node:crypto';
import storageConfig from '../config/storage.config';
import { storageHttpRequest } from '../test/storage';
import {
  StorageInvalidPartsError,
  StorageObjectNotFoundError,
  StorageUploadNotFoundError,
} from './storage.errors';
import { StorageModule } from './storage.module';
import { type StorageBucket, StorageService } from './storage.service';

const MIN_PART_SIZE = 5 * 1024 * 1024;
const PRESIGN_TTL_SECONDS = 300;

describe('StorageService (integration)', () => {
  let module: TestingModule;
  let storage: StorageService;
  const runPrefix = `it-${Date.now()}-${randomBytes(4).toString('hex')}`;
  const createdObjects: Array<{ bucket: StorageBucket; key: string }> = [];
  const openUploads: Array<{ key: string; uploadId: string }> = [];

  const newKey = (name: string): string => `${runPrefix}/${name}`;

  const putPart = async (
    key: string,
    uploadId: string,
    partNumber: number,
    body: Buffer,
  ): Promise<string> => {
    const url = await storage.presignUploadPart(
      key,
      uploadId,
      partNumber,
      PRESIGN_TTL_SECONDS,
    );
    const res = await storageHttpRequest(url, { method: 'PUT', body });
    expect(res.status).toBe(200);
    expect(res.headers.etag).toBeDefined();
    return res.headers.etag as string;
  };

  const uploadSmallVideo = async (key: string, body: Buffer): Promise<void> => {
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
    const etag = await putPart(key, uploadId, 1, body);
    await storage.completeMultipartUpload(key, uploadId, [
      { partNumber: 1, etag },
    ]);
    createdObjects.push({ bucket: 'videos', key });
  };

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();
    storage = module.get(StorageService);
  });

  afterAll(async () => {
    for (const { key, uploadId } of openUploads) {
      await storage.abortMultipartUpload(key, uploadId).catch(() => undefined);
    }
    for (const { bucket, key } of createdObjects) {
      await storage.deleteObject(bucket, key).catch(() => undefined);
    }
    await module.close();
  });

  describe('multipart upload via presigned part URLs', () => {
    it('accepts PUT on a public presigned part URL, lists the parts and assembles the object', async () => {
      const key = newKey('multipart/source.mp4');
      const part1 = randomBytes(MIN_PART_SIZE);
      const part2 = randomBytes(1024);
      const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
      openUploads.push({ key, uploadId });

      const etag1 = await putPart(key, uploadId, 1, part1);
      const etag2 = await putPart(key, uploadId, 2, part2);

      const parts = await storage.listParts(key, uploadId);
      expect(parts.map((p) => p.partNumber)).toEqual([1, 2]);
      expect(parts.map((p) => p.etag)).toEqual([etag1, etag2]);
      expect(parts.map((p) => p.size)).toEqual([part1.length, part2.length]);

      await storage.completeMultipartUpload(key, uploadId, [
        { partNumber: 1, etag: etag1 },
        { partNumber: 2, etag: etag2 },
      ]);
      createdObjects.push({ bucket: 'videos', key });

      const head = await storage.headObject('videos', key);
      expect(head.contentLength).toBe(part1.length + part2.length);
      expect(head.contentType).toBe('video/mp4');
    }, 30000);

    it('signs part URLs for the public endpoint host', async () => {
      const key = newKey('multipart/host.mp4');
      const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
      openUploads.push({ key, uploadId });

      const url = new URL(
        await storage.presignUploadPart(key, uploadId, 1, PRESIGN_TTL_SECONDS),
      );

      expect(url.origin).toBe(
        new URL(process.env.STORAGE_PUBLIC_ENDPOINT as string).origin,
      );
      expect(url.searchParams.get('X-Amz-Expires')).toBe(
        String(PRESIGN_TTL_SECONDS),
      );
    });
  });

  describe('presigned GET', () => {
    const body = randomBytes(4096);
    const key = newKey('get/source.mp4');

    beforeAll(async () => {
      await uploadSmallVideo(key, body);
    });

    it('serves a byte range with 206 Partial Content', async () => {
      const url = await storage.presignGetObject('public', key, {
        expiresIn: PRESIGN_TTL_SECONDS,
      });

      const res = await storageHttpRequest(url, {
        headers: { Range: 'bytes=0-99' },
      });

      expect(res.status).toBe(206);
      expect(res.body.length).toBe(100);
      expect(res.body.equals(body.subarray(0, 100))).toBe(true);
    });

    it('returns the requested Content-Disposition override', async () => {
      const disposition = 'attachment; filename="my-video.mp4"';
      const url = await storage.presignGetObject('public', key, {
        expiresIn: PRESIGN_TTL_SECONDS,
        responseContentDisposition: disposition,
      });

      const res = await storageHttpRequest(url);

      expect(res.status).toBe(200);
      expect(res.headers['content-disposition']).toBe(disposition);
    });

    it('signs internal URLs reachable directly on the internal endpoint', async () => {
      const url = await storage.presignGetObject('internal', key, {
        expiresIn: PRESIGN_TTL_SECONDS,
      });

      expect(new URL(url).origin).toBe(
        new URL(process.env.STORAGE_ENDPOINT as string).origin,
      );
      const res = await fetch(url);
      expect(res.status).toBe(200);
      expect(Buffer.from(await res.arrayBuffer()).equals(body)).toBe(true);
    });

    it('rejects anonymous access to the private videos bucket', async () => {
      const res = await storageHttpRequest(
        `${process.env.STORAGE_ENDPOINT}/${process.env.STORAGE_BUCKET}/${key}`,
      );

      expect(res.status).toBe(403);
    });
  });

  describe('headObject / deleteObject', () => {
    it('deletes an object so a later head reports it missing', async () => {
      const key = newKey('delete/source.mp4');
      await uploadSmallVideo(key, randomBytes(128));
      await expect(storage.headObject('videos', key)).resolves.toMatchObject({
        contentLength: 128,
      });

      await storage.deleteObject('videos', key);

      await expect(storage.headObject('videos', key)).rejects.toBeInstanceOf(
        StorageObjectNotFoundError,
      );
    });
  });

  describe('public thumbnails', () => {
    it('serves a thumbnail anonymously at buildPublicObjectUrl with its cache headers', async () => {
      const key = newKey('thumb/abc123.jpg');
      const jpeg = randomBytes(256);
      await storage.putObject('thumbnails', key, jpeg, {
        contentType: 'image/jpeg',
        cacheControl: 'public, max-age=31536000, immutable',
      });
      createdObjects.push({ bucket: 'thumbnails', key });

      const url = storage.buildPublicObjectUrl('thumbnails', key);
      const res = await storageHttpRequest(url);

      expect(url).toBe(
        `${process.env.STORAGE_PUBLIC_ENDPOINT}/${process.env.STORAGE_THUMBNAILS_BUCKET}/${key}`,
      );
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('image/jpeg');
      expect(res.headers['cache-control']).toBe(
        'public, max-age=31536000, immutable',
      );
      expect(res.body.equals(jpeg)).toBe(true);
    });

    it('does not allow anonymous listing of the thumbnails bucket', async () => {
      const res = await storageHttpRequest(
        `${process.env.STORAGE_PUBLIC_ENDPOINT}/${process.env.STORAGE_THUMBNAILS_BUCKET}/`,
      );

      expect(res.status).toBe(403);
    });
  });

  describe('typed error mapping', () => {
    it('maps a missing key on headObject to StorageObjectNotFoundError', async () => {
      await expect(
        storage.headObject('videos', newKey('missing/source.mp4')),
      ).rejects.toBeInstanceOf(StorageObjectNotFoundError);
    });

    it('maps completing an aborted upload to StorageUploadNotFoundError', async () => {
      const key = newKey('aborted/source.mp4');
      const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
      const etag = await putPart(key, uploadId, 1, randomBytes(64));
      await storage.abortMultipartUpload(key, uploadId);

      await expect(
        storage.completeMultipartUpload(key, uploadId, [
          { partNumber: 1, etag },
        ]),
      ).rejects.toBeInstanceOf(StorageUploadNotFoundError);
    });

    it('maps listing parts of an aborted upload to StorageUploadNotFoundError', async () => {
      const key = newKey('aborted-list/source.mp4');
      const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
      await storage.abortMultipartUpload(key, uploadId);

      await expect(storage.listParts(key, uploadId)).rejects.toBeInstanceOf(
        StorageUploadNotFoundError,
      );
    });

    it('maps a part list that does not match the uploaded parts to StorageInvalidPartsError', async () => {
      const key = newKey('invalid-parts/source.mp4');
      const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
      openUploads.push({ key, uploadId });
      await putPart(key, uploadId, 1, randomBytes(64));

      await expect(
        storage.completeMultipartUpload(key, uploadId, [
          { partNumber: 1, etag: '"00000000000000000000000000000000"' },
        ]),
      ).rejects.toBeInstanceOf(StorageInvalidPartsError);
    });
  });

  describe('videos bucket provisioning (storage-init smoke)', () => {
    let s3: S3Client;

    beforeAll(() => {
      s3 = new S3Client({
        endpoint: process.env.STORAGE_ENDPOINT,
        region: process.env.STORAGE_REGION,
        forcePathStyle: true,
        credentials: {
          accessKeyId: process.env.STORAGE_ACCESS_KEY as string,
          secretAccessKey: process.env.STORAGE_SECRET_KEY as string,
        },
      });
    });

    afterAll(() => s3.destroy());

    it('has the upload CORS rule for the frontend origin', async () => {
      const cors = await s3.send(
        new GetBucketCorsCommand({ Bucket: process.env.STORAGE_BUCKET }),
      );

      expect(cors.CORSRules).toHaveLength(1);
      const [rule] = cors.CORSRules ?? [];
      expect(rule.AllowedOrigins).toEqual([process.env.STORAGE_CORS_ORIGIN]);
      expect([...(rule.AllowedMethods ?? [])].sort()).toEqual([
        'GET',
        'HEAD',
        'PUT',
      ]);
      expect(rule.AllowedHeaders).toEqual(['*']);
      expect(rule.ExposeHeaders).toEqual(['ETag']);
    });

    it('has the 1-day abort-incomplete-multipart lifecycle rule', async () => {
      const lifecycle = await s3.send(
        new GetBucketLifecycleConfigurationCommand({
          Bucket: process.env.STORAGE_BUCKET,
        }),
      );

      expect(lifecycle.Rules).toEqual([
        expect.objectContaining({
          Status: 'Enabled',
          AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
        }),
      ]);
    });
  });
});
