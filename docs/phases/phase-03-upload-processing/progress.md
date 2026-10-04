# phase-03-upload-processing — Progress

**Status:** in_progress
**SIs:** 1/15 completed

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
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.3 — StorageService com clientes S3 interno e público
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.4 — Entidade Video + migration da tabela videos + gerador de short ID
- **Status:** pending
- **Tests:** —
- **Observations:** none

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
