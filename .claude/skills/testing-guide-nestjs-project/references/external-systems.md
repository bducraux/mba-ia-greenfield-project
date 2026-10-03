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

**Strategy:** The S3 API everywhere. Development and tests run against the SeaweedFS S3 gateway in `compose.yaml`; production points the same client at any S3-compatible provider. There is no local-filesystem adapter: multipart uploads, presigned URLs, HTTP Range reads and bucket policies are S3 semantics a filesystem cannot reproduce (see `docs/decisions/technical-decisions-phase-03-upload-processing.md`, TD-01 and TD-02).

**Approach:**
- Services talk to storage through the AWS SDK v3 S3 client, configured from `STORAGE_*` env vars (Compose service name as host, path-style addressing)
- Integration and e2e tests use the real `storage` service — no mocking of the S3 client outside unit tests
- Use a unique key prefix per test run (e.g., `test/<uuid>/`) and delete the objects it created in `afterAll`
- Unit tests (`*.spec.ts`) mock the storage service class, never the network

**Integration test:**
```typescript
describe('StorageService (integration)', () => {
  const prefix = `test/${randomUUID()}/`;

  afterAll(async () => {
    await storageService.deletePrefix(prefix);
  });

  it('should complete a multipart upload through presigned part URLs', async () => {
    const key = `${prefix}video.mp4`;
    const { uploadId } = await storageService.createMultipartUpload(key, 'video/mp4');
    const [url] = await storageService.presignUploadParts(key, uploadId, 1);

    const res = await fetch(url, { method: 'PUT', body: Buffer.from('content') });
    await storageService.completeMultipartUpload(key, uploadId, [
      { PartNumber: 1, ETag: res.headers.get('etag')! },
    ]);

    const head = await storageService.headObject(key);
    expect(head.ContentLength).toBe(7);
  });
});
```

---

## Message Queue — Real (Docker)

**Strategy:** Real message broker in Docker — BullMQ on the `redis` Compose service (Phase 03, TD-07).

**Configuration:**
- The `redis` service in `compose.yaml`; `REDIS_HOST` is the Compose service name
- Test isolation: use dedicated test queues or clean queues between tests
- For publisher tests: assert the job is enqueued with correct data
- For consumer tests: submit a job and assert the processing outcome

**Setup pattern (BullMQ example):**
```typescript
// In test module
BullModule.forRoot({
  connection: {
    host: process.env.REDIS_HOST ?? 'localhost',
    port: Number(process.env.REDIS_PORT ?? 6379),
  },
}),
BullModule.registerQueue({ name: 'video-processing' }),
```

```typescript
describe('VideoService (integration - queue)', () => {
  it('should enqueue a processing job on upload', async () => {
    await videoService.upload(videoData);

    const queue = module.get<Queue>(getQueueToken('video-processing'));
    const jobs = await queue.getJobs(['waiting']);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].data).toEqual(
      expect.objectContaining({ videoId: expect.any(String) }),
    );
  });
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
