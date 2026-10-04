---
libs:
  "@aws-sdk/client-s3":
    version: "not installed — pin latest v3 at install"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-10-03T20:31:20-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "not installed — pin same v3 release as @aws-sdk/client-s3"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-10-03T20:31:20-03:00"
  "@nestjs/bullmq":
    version: "not installed — pin latest compatible with @nestjs/common ^11"
    context7_id: "/nestjs/docs.nestjs.com"
    fetched_at: "2026-10-03T20:31:20-03:00"
  "bullmq":
    version: "not installed — pin latest (peer of @nestjs/bullmq)"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-10-03T20:31:20-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-upload-processing.md: "2026-10-04T10:36:44-03:00"
---

# Library References — Phase 03 / upload-processing

None of these packages is in `nestjs-project/package.json` yet. Install them inside the container (`docker compose exec nestjs-api npm install ...`) and pin the resolved versions. Keep both `@aws-sdk/*` packages on the **same** v3 release.

### @aws-sdk/client-s3

Used by: TD-01 (S3 API everywhere), TD-02 (multipart), TD-04 (internal + public clients), TD-15 (two buckets).

**Client configuration (S3-compatible endpoint — SeaweedFS in dev/test).** Per TD-04 A, build **two** `S3Client` instances: one on `STORAGE_ENDPOINT` (server-side ops, worker) and one on `STORAGE_PUBLIC_ENDPOINT` (used only for presigning browser-facing URLs).

```typescript
import { S3Client } from '@aws-sdk/client-s3';

const internal = new S3Client({
  endpoint: cfg.endpoint,          // e.g. http://seaweedfs:8333 (Compose service name)
  region: cfg.region,
  forcePathStyle: cfg.forcePathStyle, // true for SeaweedFS/emulators
  credentials: { accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey },
});
// `endpoint` also accepts an async function returning { hostname, path, protocol, port }.
```

**Multipart commands (TD-02 A).** All of these are sent by the API through the internal client. The browser only PUTs parts via presigned `UploadPartCommand` URLs.

```typescript
// Initiate → returns UploadId (persist as the draft's upload_id)
const { UploadId } = await internal.send(new CreateMultipartUploadCommand({
  Bucket, Key, ContentType, // ContentType = declared mimeType (allowlist: video/mp4, video/webm)
}));

// UploadPart: PartNumber 1..10000; response carries ETag (needed for complete)
new UploadPartCommand({ Bucket, Key, UploadId, PartNumber });

// Resume / reconcile which parts exist
new ListPartsCommand({ Bucket, Key, UploadId });

// Complete with collected { PartNumber, ETag } list
new CompleteMultipartUploadCommand({
  Bucket, Key, UploadId,
  MultipartUpload: { Parts: [{ PartNumber: 1, ETag: '"..."' }] },
});

new AbortMultipartUploadCommand({ Bucket, Key, UploadId });

// Re-check size at complete (10 GiB cap) / existence before processing (SOURCE_MISSING)
const head = await internal.send(new HeadObjectCommand({ Bucket, Key })); // head.ContentLength
```

`HeadObjectCommand` throws `NotFound` (HTTP 404) when the object does not exist. The worker maps this to `failure_reason = SOURCE_MISSING`.

**Thumbnail write (TD-15 B).** The worker writes to `STORAGE_THUMBNAILS_BUCKET` with a versioned key and an immutable cache header:

```typescript
await internal.send(new PutObjectCommand({
  Bucket: thumbnailsBucket,
  Key: `${shortId}/${version}.jpg`,
  Body: jpegBuffer,
  ContentType: 'image/jpeg',
  CacheControl: 'public, max-age=31536000, immutable',
}));
```

**Testing:** per the testing guide, storage services use integration tests against the real SeaweedFS emulator, not mocks. `aws-sdk-client-mock` (`/m-radzikowski/aws-sdk-client-mock`) exists for unit tests of branching logic only, if needed.

### @aws-sdk/s3-request-presigner

Used by: TD-02 (presigned part URLs), TD-04 (signing on the public endpoint), TD-05 (presigned GET for streaming/download).

```typescript
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { GetObjectCommand, UploadPartCommand } from '@aws-sdk/client-s3';

// Part URL for the browser (TD-02: TTL ≈ 1h, re-signable on demand)
const partUrl = await getSignedUrl(
  publicClient, // client on STORAGE_PUBLIC_ENDPOINT — the host is part of the SigV4 signature
  new UploadPartCommand({ Bucket, Key, UploadId, PartNumber }),
  { expiresIn: 3600 },
);

// Streaming (owner only in Phase 03 — AMB-1)
const playUrl = await getSignedUrl(publicClient, new GetObjectCommand({ Bucket, Key }), { expiresIn });

// Download: force attachment via response header override
const downloadUrl = await getSignedUrl(
  publicClient,
  new GetObjectCommand({
    Bucket, Key,
    ResponseContentDisposition: `attachment; filename="${fileName}"`,
  }),
  { expiresIn },
);
```

- `expiresIn` is in seconds and **defaults to 900** (15 min) when omitted. Always pass it explicitly.
- Signing is local (no network call). Never rewrite the host of a signed URL, because that breaks the signature (the reason for TD-04's second client).

### @nestjs/bullmq

Used by: TD-07 (queue), TD-08 (worker entrypoint in the same codebase).

Install: `npm install --save @nestjs/bullmq bullmq`.

**Root config** (follow the project's `registerAs` + `ConfigType` convention instead of raw `ConfigService.get`):

```typescript
BullModule.forRootAsync({
  imports: [ConfigModule],
  inject: [queueConfig.KEY],
  useFactory: (cfg: ConfigType<typeof queueConfig>) => ({
    connection: { host: cfg.host, port: cfg.port }, // Compose service name, e.g. redis
    defaultJobOptions: { /* see bullmq section */ },
  }),
});
BullModule.registerQueue({ name: 'video-processing' });
```

`forRoot` options (`connection`, `prefix` (default `bull`), `defaultJobOptions`, `settings`) pass straight through to the BullMQ `Queue` constructor. `defaultJobOptions` does not apply to jobs added via a `FlowProducer`.

**Producer (API):**

```typescript
constructor(@InjectQueue('video-processing') private readonly queue: Queue) {}
```

**Consumer (worker entrypoint only):** register the processor only in the worker's module, so the API process does not consume jobs.

```typescript
@Processor('video-processing')
export class VideoProcessingConsumer extends WorkerHost {
  async process(job: Job<{ videoId: string }>): Promise<void> { /* ffprobe → metadata → thumbnail */ }

  @OnWorkerEvent('failed')
  onFailed(job: Job, error: Error) { /* final-failure handling, see below */ }
}
```

Consumers must be registered as providers. `process()`'s return value is stored on the job.

### bullmq

Used by: TD-07 (retry/backoff, idempotent enqueue), AMB-2 (failure semantics).

**Job options for the processing job (AMB-2: attempts 3, exponential backoff):**

```typescript
await queue.add('process', { videoId }, {
  jobId: videoId,               // idempotency: add() is ignored if the id already exists
  attempts: 3,
  backoff: { type: 'exponential', delay: 1000 },
  removeOnComplete: true,
  removeOnFail: { age: 86400, count: 100 }, // default keeps failed jobs forever
});
```

- Custom `jobId` must **not contain `:`** and must not be purely numeric (UUIDs are fine).
- `throw new UnrecoverableError(msg)` moves the job straight to failed with no retries. Use it for deterministic rejections (ffprobe `UNSUPPORTED_FORMAT`, `SOURCE_MISSING`) so they don't burn retries.
- The worker `failed` event fires on **every** failed attempt. Treat it as final only when `job.attemptsMade >= (job.opts.attempts ?? 1)` (or the error is `UnrecoverableError`). Only then set `processing_status = failed` + `failure_reason = PROCESSING_FAILED`.
- A manually created ioredis connection for Workers must set `maxRetriesPerRequest: null`, or BullMQ throws. Passing `{ host, port }` options lets BullMQ create connections correctly.
