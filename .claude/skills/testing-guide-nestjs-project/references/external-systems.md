> Part of the `testing-guide-nestjs-project` skill (see `../SKILL.md`).

# External System Strategies

How each external system is handled in tests. These strategies were confirmed with the team.

---

## PostgreSQL — Real (Docker)

**Strategy:** Real database via the Docker `db` service (already in `compose.yaml`).

**Connection config for tests:**
```typescript
{
  type: 'postgres',
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? 5432),
  username: process.env.DB_USERNAME ?? 'streamtube',
  password: process.env.DB_PASSWORD ?? 'streamtube',
  database: process.env.DB_DATABASE ?? 'streamtube',
  synchronize: true, // auto-create tables in test setup
}
```

**Test isolation:**
- Use `dataSource.query('DELETE FROM "table_name"')` to clean tables between tests
- Do NOT use `repository.delete({})` — throws `Empty criteria(s) are not allowed`
- Alternative: `repository.clear()` (truncates the table)
- For complex foreign key chains, delete in reverse dependency order or use `TRUNCATE ... CASCADE`
- Use `beforeEach` for cleanup to ensure each test starts with a clean state

**Entity setup:**
- Use `synchronize: true` in test DataSource to auto-create tables from entities
- For integration tests, import only the entities needed by the test — not all entities
- For E2E tests, import `AppModule` which includes all entities via their domain modules

---

## Object Storage — Real S3 API (SeaweedFS in Docker)

**Strategy:** The S3 API everywhere. Development and tests run against the SeaweedFS S3 gateway (the `seaweedfs` service in `compose.yaml`, buckets provisioned by the one-shot `storage-init` service); production points the same client at any S3-compatible provider (see `docs/storage-provisioning.md`). There is no local-filesystem adapter: multipart uploads, presigned URLs, HTTP Range reads and bucket policies are S3 semantics a filesystem cannot reproduce (see `docs/decisions/technical-decisions-phase-03-upload-processing.md`, TD-01 and TD-02).

**Approach:**
- Services talk to storage only through `StorageService` (`src/storage/storage.service.ts`, AWS SDK v3), configured from the `STORAGE_*` env vars: `STORAGE_ENDPOINT=http://seaweedfs:8333` (Compose service name) for server-side calls, path-style addressing
- Integration and e2e tests use the real `seaweedfs` service — no mocking of the S3 client outside unit tests
- Use a unique key prefix per test run and delete what the test created in `afterAll` (abort open multipart uploads, `deleteObject` for assembled objects and thumbnails). Never wipe a bucket: the dev and test environments share it
- Unit tests (`*.spec.ts`) mock `StorageService`, never the network

**Presigned URLs inside the container — the public endpoint is NOT overridden.** Browser-facing URLs (part uploads, playback, download, thumbnails) are signed for `STORAGE_PUBLIC_ENDPOINT` (`http://localhost:8333`), which is not reachable from inside the `nestjs-api` container. Tests keep the real config and send those requests with `storageHttpRequest` (`src/test/storage.ts`): it opens the TCP connection to `STORAGE_ENDPOINT` but keeps the signed `Host` header, so the SigV4 signature stays valid. Do not use `fetch(url)` on a presigned URL in a test, and do not override `storageConfig.publicEndpoint` — that would stop testing the URLs the browser actually gets.

**Integration test** (pattern from `src/storage/storage.service.integration-spec.ts`):
```typescript
const prefix = `it-${randomUUID()}`;
const openUploads: Array<{ key: string; uploadId: string }> = [];

afterAll(async () => {
  for (const { key, uploadId } of openUploads) {
    await storage.abortMultipartUpload(key, uploadId).catch(() => undefined);
    await storage.deleteObject('videos', key);
  }
  await module.close();
});

it('assembles an object from a presigned part URL', async () => {
  const key = `${prefix}/source.mp4`;
  const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
  openUploads.push({ key, uploadId });

  const url = await storage.presignUploadPart(key, uploadId, 1, 600);
  const put = await storageHttpRequest(url, {
    method: 'PUT',
    body: Buffer.from('content'),
  });
  await storage.completeMultipartUpload(key, uploadId, [
    { partNumber: 1, etag: put.headers.etag as string },
  ]);

  const head = await storage.headObject('videos', key);
  expect(head.contentLength).toBe(7);
});
```

---

## Message Queue — Real (Docker)

**Strategy:** Real message broker in Docker — BullMQ on the `redis` Compose service, queue `video-processing` (Phase 03, TD-07).

**Configuration:**
- The `redis` service in `compose.yaml`; `REDIS_HOST=redis` (Compose service name), `REDIS_PORT=6379`
- The queue is shared with the dev environment, and the `video-worker` container consumes it whenever it is up. Never `drain`/`obliterate` it from a test
- Producer tests (and e2e suites that must keep jobs from being consumed): `queue.pause()` in `beforeAll`, remove only the jobs the suite created (`queue.remove(videoId)` — the job id is the video id), `queue.resume()` in `afterAll`. If a run is killed between pause and resume, restore it with `docker compose exec redis redis-cli HDEL bull:video-processing:meta paused`
- Consumer tests: build the module without starting a BullMQ Worker (`compile()` does not run `onModuleInit`) and call `process(job)` directly
- Full pipeline e2e (`test/video-pipeline.e2e-spec.ts`): the queue stays running; the suite starts a `WorkerModule` context in the same process (`test/helpers/video-pipeline.ts`). The `video-worker` container may consume the same jobs — both run the same code against the same DB and storage, so assertions hold either way

**Setup pattern (producer, from `src/video-processing/video-processing.producer.integration-spec.ts`):**
```typescript
const queue = module.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));

beforeAll(async () => {
  await queue.pause(); // a running video-worker must not consume test jobs
});

afterAll(async () => {
  await queue.resume();
  await module.close();
});

it('enqueues the processing job with jobId = videoId', async () => {
  const videoId = randomUUID();
  await producer.enqueue(videoId);

  const job = await queue.getJob(videoId);
  expect(job?.data).toEqual({ videoId });
  await job?.remove();
});
```

---

## Email — Mailpit (Real SMTP Capture)

**Strategy:** Mailpit — a local SMTP server that captures all emails for inspection via its API. No emails are actually delivered.

**Setup:**
- Add Mailpit to `compose.yaml`:
```yaml
mailpit:
  image: axllent/mailpit
  ports:
    - "1025:1025"   # SMTP
    - "8025:8025"   # Web UI / API
```

**NestJS configuration:**
```typescript
// In mail module or config
{
  transport: {
    host: process.env.SMTP_HOST ?? 'localhost',
    port: Number(process.env.SMTP_PORT ?? 1025),
  },
}
```

**Integration test:**
```typescript
describe('MailService (integration)', () => {
  beforeEach(async () => {
    // Clear all captured emails via Mailpit API
    await fetch('http://localhost:8025/api/v1/messages', { method: 'DELETE' });
  });

  it('should send confirmation email', async () => {
    await mailService.sendConfirmation('user@test.com', 'token-123');

    // Query Mailpit API for captured emails
    const response = await fetch('http://localhost:8025/api/v1/messages');
    const data = await response.json();

    expect(data.messages).toHaveLength(1);
    expect(data.messages[0].To[0].Address).toBe('user@test.com');
    expect(data.messages[0].Subject).toContain('confirm');
  });
});
```

**Key points:**
- Mailpit captures ALL emails — no mocking, no side effects
- Use Mailpit's REST API (`http://localhost:8025/api/v1/messages`) to inspect sent emails
- Clear captured emails in `beforeEach` to ensure test isolation
- Web UI at `http://localhost:8025` for manual debugging
- Tests the full SMTP transport path — if the SMTP config is wrong, the test fails
