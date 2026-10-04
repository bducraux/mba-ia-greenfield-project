# phase-03-upload-processing — Progress

**Status:** in_progress
**SIs:** 4/15 completed

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
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.6 — VideosService: iniciar upload + consulta do dono + serialização
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.7 — Sessão de upload: URLs de parts, parts enviadas e complete (enfileirar → processing)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.8 — URLs de mídia: streaming e download
- **Status:** pending
- **Tests:** —
- **Observations:** none

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
