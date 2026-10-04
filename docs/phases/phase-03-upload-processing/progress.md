# phase-03-upload-processing — Progress

**Status:** in_progress
**SIs:** 8/15 completed

### SI-03.1 — Infra: Redis + configuração raiz da fila
- **Status:** completed
- **Tests:** 8 passing (env.validation.integration-spec 7, queue.module.spec 1); tsc + eslint of touched files clean
- **Observations:**
  - `@nestjs/bullmq` pinned at `11.0.5` instead of latest `12.0.0`: 12.0.0 ships ESM-only (`dist/index.js` uses `export`), which Jest (CJS, no node_modules transform) cannot load. 11.0.5 is the latest CJS release with peers `@nestjs/common ^11` + `bullmq ^6` (approved by reviewer).
  - `bullmq` pinned at `6.3.11`; in v6 `ioredis` became an optional peer and is no longer installed, so `ioredis@5.11.1` was added as an explicit pinned dependency (reviewer option A). Latest `ioredis@6.0.0` was rejected by npm ERESOLVE because `typeorm@0.3.28` declares peerOptional `ioredis@^5.0.4`; 5.11.1 is the latest 5.x and satisfies both.
  - All three queue deps pinned exactly (no caret) per library-refs "pin the resolved versions".
  - Existing `env.validation.integration-spec.ts` shared `requiredEnv` gained `REDIS_HOST` so the pre-existing SWAGGER_ENABLED cases keep validating now that `REDIS_HOST` is required.
  - `QueueModule` is not yet imported by `AppModule` (plan wires it through the producer/VideosModule in later SIs); only `queueConfig` was added to `ConfigModule.forRoot({ load })`.

### SI-03.2 — Infra: SeaweedFS + provisionamento dos buckets (storage-init)
- **Status:** completed
- **Tests:** no tests (Infra; ACs verified manually — see observations)
- **Observations:**
  - Pinned images: `chrislusf/seaweedfs:4.48` (latest release tag, 2026-09-28) and `amazon/aws-cli:2.37.9`.
  - Identity file coexists with `weed mini`'s embedded IAM (`-s3.config` accepted, "Starting S3 API Server with standard IAM"); the TD-16 `weed shell s3.anonymous.set` fallback was not needed. The file is rendered from env at container start by `docker/seaweedfs/entrypoint.sh` (writes `/tmp/s3.json`, then execs the image's `/entrypoint.sh mini -s3.config=…`), since the identity JSON cannot read env vars itself.
  - Healthcheck uses `wget` on the S3 gateway's `/healthz` (`curl`/`wget` both exist in the image).
  - No data volume on `seaweedfs` (matches the existing `db` service, which has none); objects are lost on container removal, buckets are re-created by `storage-init`.
  - ACs verified: storage-init exit 0 on first run (buckets created) and on two re-runs (bucket list, CORS and lifecycle identical before/after); anonymous GET of a thumbnail object → 200; anonymous list of thumbnails bucket → 403; anonymous GET/list on videos bucket → 403; anonymous PUT on thumbnails → 403; app credentials can put/list on both buckets and cannot `CreateBucket`. Probe objects were deleted afterwards.
  - AC "only then starts nestjs-api" verified only at the Compose level (`depends_on: storage-init: service_completed_successfully` + `docker compose up -d` waited for storage-init to exit 0); the already-running `nestjs-api` container was not force-recreated to avoid restarting the reviewer's dev container.
  - SeaweedFS limitation (emulator, not in TD-16): bucket-scoped `Write:<bucket>` on the app identity also authorizes `PutBucketCors` (verified — a probe overwrote the CORS, restored by re-running storage-init). On SeaweedFS there is no finer-grained action than `Write` to separate object writes from bucket-config writes; prod contract (SI-03.15) should still scope the app's IAM to object-level actions only.

### SI-03.3 — StorageService com clientes S3 interno e público
- **Status:** completed
- **Tests:** 33 passing (storage.service.integration-spec 14, env.validation.integration-spec 18, storage.module.spec 1); tsc + eslint of touched files clean
- **Observations:**
  - `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` pinned exactly at `3.1146.0` (same v3 release, latest at install; CJS build present).
  - Bucket selection is a typed logical name, `StorageBucket = 'videos' | 'thumbnails'`, on `headObject`/`deleteObject`/`putObject`/`buildPublicObjectUrl(bucket, key)`; multipart ops and `presignGetObject` always target the private videos bucket (the only bucket they apply to). Callers never handle raw bucket names.
  - Both `S3Client`s set `requestChecksumCalculation`/`responseChecksumValidation: 'WHEN_REQUIRED'` so presigned part URLs don't carry SDK flexible-checksum parameters a browser PUT cannot satisfy (defensive; SDK default since 3.731.0 is `WHEN_SUPPORTED`). Not separately proven necessary against SeaweedFS.
  - Typed errors live in `src/storage/storage.errors.ts` (`StorageObjectNotFoundError`, `StorageUploadNotFoundError`, `StorageInvalidPartsError`, base `StorageError`), mapped by SDK error `name` from `storage.constants.ts`. `listParts`, `abortMultipartUpload` and `deleteObject` are also mapped (not only head/complete). SeaweedFS returns `InvalidPart` for a wrong ETag — verified by test.
  - New test helper `src/test/storage.ts` (`storageHttpRequest`): browser-facing URLs are signed for `STORAGE_PUBLIC_ENDPOINT` (`localhost:8333`), unreachable from inside the `nestjs-api` container, so the helper connects to `STORAGE_ENDPOINT` while preserving the signed `Host` header. Reusable by later integration/e2e tests that exercise presigned URLs.
  - `STORAGE_ADMIN_*` keys are intentionally NOT in the API Joi schema (used only by storage-init, per TD-16).
  - Integration spec uses a unique per-run key prefix and cleans up created objects / open uploads in `afterAll`.

### SI-03.4 — Entidade Video + migration da tabela videos + gerador de short ID
- **Status:** completed
- **Tests:** 22 passing (short-id.util.spec, video.entity.integration-spec, migrations.integration-spec); channel/user entity integration specs re-run green (10) after the shared cleanup helper change; tsc + eslint of touched files clean
- **Observations:**
  - The migration was produced with `npm run migration:generate` (not `migration:create` + hand-written SQL), per `.claude/rules/typeorm-migrations.md` "never write migration SQL by hand". The output matches `### Data Model`; `migration:generate --check` reports no drift between the entity and the migrations.
  - The CHECK constraints are declared on the entity with named `@Check` decorators (`CHK_videos_processing_status`, `CHK_videos_publication_status`, `CHK_videos_failure_reason`). That way suites using `synchronize: true` enforce them too, and the generated migration uses stable names. Phase 04 widens `CHK_videos_publication_status` by name.
  - The `Video → Channel` relation is unidirectional as TD-11 / the SI require. This goes against `.claude/rules/nestjs-entities.md` ("always define both sides"), so the plan took precedence and `Channel` was not changed.
  - Shared helper `cleanAllTables` (`src/test/create-test-data-source.ts`) now runs `DELETE FROM "videos"` first, because the FK to `channels` would block `DELETE FROM channels`. The delete is guarded with `to_regclass`, so suites whose DataSource does not include `Video` still work on a DB that has no `videos` table yet.
  - The status/reason literal sets are also exported as `as const` arrays (`PROCESSING_STATUSES`, `PUBLICATION_STATUSES`, `FAILURE_REASONS`) next to the types in `video.types.ts`, so later DTO/OpenAPI enums can reuse them.
  - CLI ACs were checked against the dev DB: `migration:revert` removed only `videos`, and `migration:run` recreated it.

### SI-03.5 — Producer da fila video-processing
- **Status:** completed
- **Tests:** 4 passing (video-processing.producer.integration-spec 3, video-processing-producer.module.spec 1); no open handles; tsc + eslint of touched files clean
- **Observations:**
  - `QueueUnavailableError` lives in `src/video-processing/video-processing.errors.ts`, following the `storage.errors.ts` pattern. `ENQUEUE_TIMEOUT_MS = 5000` is a named constant in `video-processing.constants.ts`. `PROCESS_VIDEO_JOB_OPTIONS` uses `as const satisfies JobsOptions`.
  - The integration spec runs against the real `video-processing` queue on the dev Redis. It pauses the queue in `beforeAll` and resumes it in `afterAll`, so a running `video-worker` (from SI-03.13) cannot consume and auto-remove the test jobs mid-assertion. Each test uses a random `videoId` and removes only its own job, never `drain`/`obliterate`, so other jobs on the shared broker are left alone. After the run the queue was confirmed unpaused with no leftover jobs. If a run is killed between `pause` and `resume`, the dev queue stays paused (`redis-cli HDEL bull:video-processing:meta paused` restores it).
  - The "Redis unreachable" case overrides the `queueConfig.KEY` provider with port `1` on the `redis` host. The rejection comes from the 5 s timeout path (the suite takes about 6 s).
  - BullMQ v6 has no `paused` job state (paused jobs stay in `wait`), so the duplicate-enqueue assertion reads `waiting` + `prioritized`.
  - `VideoProcessingProducerModule` is not imported anywhere yet; `VideosModule` wires it in SI-03.7.

### SI-03.6 — VideosService: iniciar upload + consulta do dono + serialização
- **Status:** completed
- **Tests:** 33 passing (videos.service.spec, videos.service.integration-spec, channels.service.integration-spec, videos.module.spec); tsc + eslint of touched files clean
- **Observations:**
  - The object key contains the `short_id`, so each `short_id` collision retry aborts the multipart upload of the colliding key and creates a new one under the new id. The SI's "abort when the insert fails" rule is applied on every attempt: any insert failure aborts that attempt's upload, and only `23505` on `short_id` retries (up to 3 attempts, then the original error propagates → 500).
  - Upload constants and the extension↔mime allowlist live in `src/videos/videos.constants.ts` (`UPLOAD_PART_SIZE`, `MAX_VIDEO_SIZE_BYTES`, `PART_URL_TTL_SECONDS` for SI-03.7, `MAX_TITLE_LENGTH`, `SHORT_ID_MAX_ATTEMPTS`, `VIDEO_EXTENSION_MIME_TYPES`).
  - `title` is truncated by code point (`Array.from`), matching Postgres `varchar(100)` character semantics and never splitting a surrogate pair. Extension matching is case-insensitive (`clip.WEBM` is accepted). A dotfile name like `.mp4` counts as having no extension → 415, so an empty title is impossible.
  - `initiateUpload` returns the serialized `{ video: VideoResponse, upload }`. `findOwnedByShortId` returns the `Video` entity (later SIs need the internal fields for storage calls), and `VideosService.toResponse(video)` exposes the mapper. `video-response.mapper.ts` is a pure function `toVideoResponse(video, storage)` that also exports the `VideoResponse` interface (SI-03.9 can build the Swagger DTO from it).
  - A user without a channel: `initiateUpload` throws a plain `Error` (broken invariant → 500); `findOwnedByShortId` throws `VideoNotFoundException`.
  - `isShortIdUniqueViolation` duplicates the shape of `ChannelsService`'s private `isPgUniqueViolationOnColumn`. A follow-up could extract a shared `src/common/database/pg-errors.ts` helper; it was not refactored here (out of scope).
  - `VideosModule` is not yet imported by `AppModule`; that is expected with the controller in SI-03.9.
  - The test runner showed the pg warning "Calling client.query() when the client is already executing a query is deprecated". It already appears when running the TypeORM CLI (seen in SI-03.4), so it comes from TypeORM/pg internals and not from this SI's code. It will matter when pg is upgraded to v9.

### SI-03.7 — Sessão de upload: URLs de parts, parts enviadas e complete (enfileirar → processing)
- **Status:** completed
- **Tests:** 65 passing (video-lifecycle.service.integration-spec, videos.service.spec, videos.service.integration-spec, videos.module.spec); tsc + eslint of touched files clean. 1 fix attempt: the "duplicated part" unit case had wrong test data (`ALL_PARTS` is ordered 3,1,2, so `slice(0,2)` plus part 2 was a complete set); the service logic was correct.
- **Observations:**
  - `VideoLifecycleService` uses `repository.update({ id, processing_status: In(from) }, changes)` and returns `affected > 0`. TypeORM's `update()` also bumps `updated_at`. `markReady` sets `processed_at` via `() => 'CURRENT_TIMESTAMP'` and takes a typed `ProcessedVideoMetadata`. It is provided and exported by `VideosModule`, so the worker (SI-03.12) can import it.
  - `completeUpload` step 3 always runs its own `HeadObject` after assembly, including after the `NoSuchUpload` fallback, which already did a `HeadObject` to decide between continuing and 410. That costs one extra HEAD on the rare retry path in exchange for a single linear size-check path.
  - Part-set validation for complete (`length === part_count`, unique, every number in 1..`part_count`) runs before any storage call. `signPartUrls` deduplicates and sorts the requested numbers; uniqueness and the 1–160 bounds are DTO concerns (SI-03.9), and the service only enforces `≤ part_count` (422).
  - The `VideosService` integration spec pauses the real `video-processing` queue in `beforeAll` and resumes it in `afterAll` (same approach as SI-03.5). It removes only the jobs of its own video ids. In `afterAll` it aborts open uploads, ignoring `NoSuchUpload` for uploads already completed or aborted, and deletes the assembled objects. After the run the queue was confirmed unpaused with an empty wait list.
  - AC "complete with enqueue failing → 503, video stays `uploading`, retry after Redis is back → `processing` with one job": the 503 / no-`markProcessing` half is covered by the unit spec. The retry half rests on the `NoSuchUpload` → `HeadObject` fallback (unit) plus `jobId` idempotency (SI-03.5 integration). No integration test stops Redis mid-suite.

### SI-03.8 — URLs de mídia: streaming e download
- **Status:** completed
- **Tests:** 70 passing (content-disposition.util.spec 6, videos.service.spec 54, videos.service.integration-spec 10); tsc + eslint of touched files clean; queue confirmed unpaused after the run
- **Observations:**
  - The ASCII `filename` fallback applies `NFKD` normalization before stripping non-ASCII, so `Férias "2026"` becomes `Ferias 2026.mp4` instead of `Frias 2026.mp4`. Non-ASCII characters are still removed, as the contract requires. Control characters (including CR/LF) are also stripped. If nothing printable is left (for example `日本語`), the fallback is `video.{ext}`.
  - `filename*` uses RFC 5987 encoding, which adds percent-encoding for `'()*` (characters `encodeURIComponent` leaves unescaped). The AC string `F%C3%A9rias%20%222026%22.mp4` is matched exactly.
  - TTLs are named constants `PLAYBACK_URL_TTL_SECONDS = 14400` and `DOWNLOAD_URL_TTL_SECONDS = 3600` in `videos.constants.ts`. `expires_at` is computed from a timestamp taken before signing, the same approach as `signPartUrls`. The return type `MediaUrl { url, expires_at }` is exported from `videos.service.ts` for SI-03.10's DTO.
  - The integration spec builds a `ready` video directly: `initiate` + `storage.putObject` on `original_object_key` + `repository.update` to `ready`. It does not go through complete/worker, so no queue job is created. Cleanup reuses the existing `openUploads` abort/delete in `afterAll`. Range and download are checked through `src/test/storage.ts` (`storageHttpRequest`).

### SI-03.9 — VideosController: endpoints de upload
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.10 — VideosController: consulta do vídeo e URLs de mídia
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.11 — MediaProbeService: ffprobe, gate de compatibilidade e thumbnail via ffmpeg
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.12 — VideoProcessingConsumer: metadados, thumbnail e falhas
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.13 — Infra: entrypoint do worker + serviço video-worker
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.14 — E2E do pipeline: upload → processamento → ready
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.15 — Documentação: CLAUDE.md, contrato de storage em produção e guia de testes
- **Status:** pending
- **Tests:** —
- **Observations:** none
