---
kind: phase
name: phase-03-upload-processing
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-upload-processing/context.md: "2026-10-04T10:38:45-03:00"
  docs/phases/phase-03-upload-processing/library-refs.md: "2026-10-04T10:38:40-03:00"
  docs/decisions/technical-decisions-phase-03-upload-processing.md: "2026-10-04T10:36:44-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-10-03T18:04:32-03:00"
  docs/decisions/technical-decisions-next-frontend-config-base.md: "2026-10-03T18:04:32-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Entregar o serviço de armazenamento de arquivos (vídeos e thumbnails) e o serviço de processamento em segundo plano (filas) para que o upload de vídeos de até 10GB funcione sem impacto na performance, com pré-cadastro automático do vídeo como rascunho ao iniciar o upload, processamento automático após o upload (extração de duração e metadados + geração de thumbnail a partir de um frame), URL única por vídeo sem conflito, reprodução via streaming e download do vídeo pelo usuário.

---

## Step Implementations

### SI-03.1 — Infra: Redis + configuração raiz da fila

**Description:** Sobe o broker Redis e a configuração raiz do BullMQ compartilhada pela API e pelo worker — base de toda a fila de processamento (`phase-03-upload-processing/TD-07`).

**Technical actions:**

1. Adicionar o serviço `redis` em `nestjs-project/compose.yaml` (imagem `redis:7.4-alpine`, porta `6379`, healthcheck `redis-cli ping`) e `depends_on: redis: condition: service_healthy` em `nestjs-api` (per `phase-03-upload-processing/TD-07`).
2. Instalar `@nestjs/bullmq` e `bullmq` no container (`docker compose exec nestjs-api npm install --save @nestjs/bullmq bullmq`), fixando as versões resolvidas (per library-refs → `@nestjs/bullmq`, `bullmq`).
3. Criar `src/config/queue.config.ts` — `registerAs('queue', () => ({ host, port }))` lendo `REDIS_HOST` / `REDIS_PORT` — e carregá-lo no `ConfigModule.forRoot({ load: [...] })` do `AppModule` (per `phase-01-configuracao-base/TD-03`).
4. Adicionar em `src/config/env.validation.ts` `REDIS_HOST: Joi.string().required()` e `REDIS_PORT: Joi.number().port().default(6379)`; adicionar `REDIS_HOST=redis` e `REDIS_PORT=6379` em `.env.example` e `.env` (Compose service name, nunca `localhost`) (per `phase-01-configuracao-base/TD-02`).
5. Criar `src/queue/queue.module.ts` — `BullModule.forRootAsync({ imports: [ConfigModule], inject: [queueConfig.KEY], useFactory: (cfg) => ({ connection: { host: cfg.host, port: cfg.port } }) })`, exportando `BullModule` (per `### Events/Messages` → Broker connection).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `envValidationSchema` (REDIS_*) | Integration: `REDIS_HOST` ausente rejeitado; `REDIS_PORT` default 6379 | `src/config/env.validation.integration-spec.ts` |
| `QueueModule` | Unit: compilation test com config real | `src/queue/queue.module.spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- `docker compose up -d` sobe `redis` e `docker compose ps` mostra o serviço `healthy`.
- `docker compose exec redis redis-cli ping` responde `PONG`.
- A aplicação recusa iniciar quando `REDIS_HOST` não está definido, com erro de validação de env citando `REDIS_HOST`.
- Com `REDIS_PORT` ausente, a configuração resolvida da fila usa a porta `6379`.

---

### SI-03.2 — Infra: SeaweedFS + provisionamento dos buckets (storage-init)

**Description:** Sobe o storage S3-compatível de dev/test e um container one-shot que provisiona os dois buckets (privado de vídeos + thumbnails public-read) com CORS e lifecycle antes da API iniciar (`phase-03-upload-processing/TD-01`, `TD-15`, `TD-16`).

**Technical actions:**

1. Adicionar o serviço `seaweedfs` em `compose.yaml` rodando `weed mini` com tag fixada (lifecycle worker embutido), porta S3 `8333` publicada no host (endpoint público do browser), healthcheck HTTP no gateway S3, e identidades carregadas de `docker/seaweedfs/` — admin (`STORAGE_ADMIN_ACCESS_KEY` / `STORAGE_ADMIN_SECRET_KEY`, usado só pelo init) e app (`STORAGE_ACCESS_KEY` / `STORAGE_SECRET_KEY`, ações object-level `Read`/`Write`/`List` nos dois buckets); se o arquivo de identidades não coexistir com o IAM embutido do `weed mini`, aplicar o fallback do TD (`weed shell s3.anonymous.set`) (per `phase-03-upload-processing/TD-16`).
2. Criar `docker/storage-init/init.sh` idempotente (AWS CLI contra `http://seaweedfs:8333` com credenciais admin): cria `STORAGE_BUCKET` e `STORAGE_THUMBNAILS_BUCKET` se ausentes; aplica no bucket de vídeos CORS `AllowedOrigins: [STORAGE_CORS_ORIGIN]`, `AllowedMethods: [PUT, GET, HEAD]`, `AllowedHeaders: ["*"]`, `ExposeHeaders: [ETag]` e lifecycle com uma regra `Filter: {}` + `AbortIncompleteMultipartUpload.DaysAfterInitiation: 1`; no bucket de thumbnails, leitura anônima `Read` apenas (sem `List`, sem CORS) (per `phase-03-upload-processing/TD-16`, `TD-15`).
3. Adicionar o serviço `storage-init` (`amazon/aws-cli` com tag fixada, `entrypoint` no script montado, `env_file: .env`, `depends_on: seaweedfs: condition: service_healthy`, `restart: "no"`) e `depends_on: storage-init: condition: service_completed_successfully` em `nestjs-api` (per `phase-03-upload-processing/TD-16`).
4. Adicionar em `.env.example` e `.env` as chaves `STORAGE_ENDPOINT=http://seaweedfs:8333`, `STORAGE_PUBLIC_ENDPOINT=http://localhost:8333`, `STORAGE_REGION=us-east-1`, `STORAGE_ACCESS_KEY`, `STORAGE_SECRET_KEY`, `STORAGE_BUCKET=streamtube-videos`, `STORAGE_THUMBNAILS_BUCKET=streamtube-thumbnails`, `STORAGE_FORCE_PATH_STYLE=true`, `STORAGE_CORS_ORIGIN=http://localhost:3001` (origem do `next-frontend` em dev) e as credenciais admin de dev (per `phase-03-upload-processing/TD-04` + revisão 2026-10-03).

**Tests:** _(empty — Infra; o smoke check de CORS/lifecycle/public-read vive no teste de integração do SI-03.3)_

**Dependencies:** none

**Acceptance criteria:**

- `docker compose up -d` termina `storage-init` com exit code `0` e só então inicia `nestjs-api`.
- Rodar `docker compose run --rm storage-init` uma segunda vez também termina com exit code `0` sem alterar a configuração existente (idempotência).
- Após o init, os buckets `STORAGE_BUCKET` e `STORAGE_THUMBNAILS_BUCKET` existem no SeaweedFS.
- `GET` anônimo de um objeto no bucket de thumbnails retorna `200`; `GET` anônimo da listagem desse bucket e de qualquer objeto do bucket de vídeos retornam `403`.

---

### SI-03.3 — StorageService com clientes S3 interno e público

**Description:** Encapsula todas as operações S3 (multipart, presign, head/delete/put, URL pública de thumbnail) num módulo de infraestrutura reutilizado pela API e pelo worker (`phase-03-upload-processing/TD-01`, `TD-04`, `TD-15`).

**Technical actions:**

1. Instalar `@aws-sdk/client-s3` e `@aws-sdk/s3-request-presigner` na mesma release v3 (`docker compose exec nestjs-api npm install --save ...`) (per library-refs → `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`).
2. Criar `src/config/storage.config.ts` — `registerAs('storage', ...)` com `endpoint`, `publicEndpoint`, `region`, `accessKey`, `secretKey`, `bucket`, `thumbnailsBucket`, `forcePathStyle`, `corsOrigin` — carregá-lo no `AppModule`, e adicionar as chaves `STORAGE_*` de `phase-03-upload-processing/TD-04` (lista canônica + `STORAGE_THUMBNAILS_BUCKET`) como `required()` no schema Joi (`STORAGE_FORCE_PATH_STYLE` como `Joi.boolean()`) (per `phase-01-configuracao-base/TD-03`).
3. Criar `src/storage/storage.service.ts` com dois `S3Client` (interno em `STORAGE_ENDPOINT`; público em `STORAGE_PUBLIC_ENDPOINT`, usado só para presign de URLs do browser) e os métodos `createMultipartUpload`, `presignUploadPart` (público, `expiresIn` explícito), `listParts`, `completeMultipartUpload`, `abortMultipartUpload`, `headObject`, `deleteObject`, `putObject`, `presignGetObject(client: 'internal' | 'public', key, { expiresIn, responseContentDisposition? })` e `buildPublicObjectUrl(bucket, key)` (path-style conforme `STORAGE_FORCE_PATH_STYLE`) (per `phase-03-upload-processing/TD-04`, `TD-15`; per `### Data Model` → Thumbnail URL composition).
4. Mapear erros do SDK para erros tipados do módulo (`StorageObjectNotFoundError` para `NotFound`/`NoSuchKey`, `StorageUploadNotFoundError` para `NoSuchUpload`, `StorageInvalidPartsError` para `InvalidPart`/`InvalidPartOrder`/`EntityTooSmall`), para que serviços de domínio não dependam de nomes de erro do SDK.
5. Criar `src/storage/storage.module.ts` exportando `StorageService`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageService` | Integration (SeaweedFS real, prefixo único por execução + cleanup): multipart via URL presignada de part + `ETag`, `listParts`, `headObject`/`deleteObject`, GET presignado com `Range` → `206`, `ResponseContentDisposition` → header `Content-Disposition`, objeto em thumbnails acessível anonimamente via `buildPublicObjectUrl`, mapeamento dos erros tipados, smoke de CORS e lifecycle presentes no bucket de vídeos | `src/storage/storage.service.integration-spec.ts` |
| `StorageModule` | Unit: compilation test | `src/storage/storage.module.spec.ts` |
| `envValidationSchema` (STORAGE_*) | Integration: chave obrigatória ausente rejeitada | `src/config/env.validation.integration-spec.ts` |

**Dependencies:** SI-03.2 — buckets, CORS, lifecycle e credenciais precisam existir no SeaweedFS.

**Acceptance criteria:**

- Uma URL de part presignada pelo cliente público aceita `PUT` com os bytes da part e devolve o header `ETag`.
- `completeMultipartUpload` com os `ETag`s coletados produz um objeto cujo `ContentLength` é a soma das parts.
- Um GET presignado com `Range: bytes=0-99` retorna `206` com exatamente 100 bytes.
- Um GET presignado com `ResponseContentDisposition: attachment; ...` retorna o header `Content-Disposition` com esse valor.
- `headObject` de uma chave inexistente lança `StorageObjectNotFoundError`; `completeMultipartUpload` de um `UploadId` abortado lança `StorageUploadNotFoundError`.
- A aplicação recusa iniciar sem `STORAGE_THUMBNAILS_BUCKET`, com erro de validação de env citando a chave.

---

### SI-03.4 — Entidade Video + migration da tabela videos + gerador de short ID

**Description:** Cria o modelo persistente do vídeo com o ciclo de vida de dois campos e o identificador público curto (`phase-03-upload-processing/TD-10`, `TD-11`).

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts` (`@Entity('videos')`) com todos os campos de `### Data Model` → `Video` verbatim (`short_id`, `processing_status`, `publication_status`, `failure_reason`, `original_object_key`, `mime_type`, `size_bytes`, `upload_id`, `duration_seconds`, `width`, `height`, `video_codec`, `audio_codec`, `thumbnail_object_key`, `processed_at`, `created_at`, `updated_at`) e `@ManyToOne(() => Channel)` + `@JoinColumn({ name: 'channel_id' })` (relação unidirecional — `Channel` não é alterado) (per `phase-03-upload-processing/TD-11`).
2. Criar `src/common/transformers/bigint-number.transformer.ts` (bigint ↔ `number`) e aplicá-lo em `size_bytes`; exportar os tipos literais `ProcessingStatus`, `PublicationStatus` e `FailureReason` de `src/videos/video.types.ts`.
3. Gerar a migration `src/database/migrations/{timestamp}-CreateVideos.ts` (`npm run migration:create`) com a tabela `videos`, `varchar` + `CHECK` para `processing_status` / `publication_status` / `failure_reason`, defaults `'uploading'` / `'draft'`, unique em `short_id`, índice em `channel_id`, FK `channel_id → channels(id)` com `ON DELETE` default, e `down` que remove tudo (per `### Data Model`).
4. Criar `src/videos/short-id.util.ts` — `generateShortId()` = `crypto.randomBytes(8).toString('base64url')` (11 chars `[A-Za-z0-9_-]`) e `isValidShortId(value)` com a regex `^[A-Za-z0-9_-]{11}$` (per `phase-03-upload-processing/TD-10`).
5. Atualizar `src/database/migrations.integration-spec.ts` para esperar a tabela `videos` após `migration:run` e sua remoção após `migration:revert`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: unique `short_id`, `CHECK`s rejeitam valores fora do conjunto, defaults `uploading`/`draft`, FK para `channels`, `size_bytes` > 2^31 lido como `number` | `src/videos/entities/video.entity.integration-spec.ts` |
| Migration `CreateVideos` | Integration: up cria `videos`, down remove | `src/database/migrations.integration-spec.ts` |
| `short-id.util` | Unit: formato 11 chars base64url, `isValidShortId` aceita/rejeita | `src/videos/short-id.util.spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- `npm run migration:run` cria a tabela `videos`; `npm run migration:revert` a remove sem afetar `users`/`channels`.
- Inserir dois vídeos com o mesmo `short_id` falha com violação de unicidade.
- Inserir um vídeo com `processing_status = 'deleted'` ou `failure_reason = 'OTHER'` falha com violação de `CHECK`.
- Um vídeo inserido sem `processing_status`/`publication_status` é persistido com `uploading`/`draft`.
- Um vídeo com `size_bytes = 10737418240` é lido de volta como o número `10737418240`.
- `generateShortId()` sempre retorna 11 caracteres de `[A-Za-z0-9_-]`.

---

### SI-03.5 — Producer da fila video-processing

**Description:** Publica o job de processamento com `jobId = videoId` idempotente e as opções de retry definidas, isolando a API dos detalhes do BullMQ (`phase-03-upload-processing/TD-07`).

**Technical actions:**

1. Criar `src/video-processing/video-processing.constants.ts` — `VIDEO_PROCESSING_QUEUE = 'video-processing'`, `PROCESS_VIDEO_JOB = 'process'`, tipo `ProcessVideoJobData = { videoId: string }` e `PROCESS_VIDEO_JOB_OPTIONS` (`attempts: 3`, `backoff: { type: 'exponential', delay: 1000 }`, `removeOnComplete: true`, `removeOnFail: { age: 86400, count: 100 }`) (per `### Events/Messages` → Job options).
2. Criar `src/video-processing/video-processing.producer.ts` — `VideoProcessingProducer.enqueue(videoId)` com `@InjectQueue(VIDEO_PROCESSING_QUEUE)` chamando `queue.add(PROCESS_VIDEO_JOB, { videoId }, { ...PROCESS_VIDEO_JOB_OPTIONS, jobId: videoId })`; o `add` é limitado por um timeout de 5 s (com o Redis fora, o ioredis enfileira comandos offline e o `add` não rejeita sozinho), e falha ou timeout do broker propagam como `QueueUnavailableError` tipado (per library-refs → `bullmq`).
3. Criar `src/video-processing/video-processing-producer.module.ts` — importa `QueueModule` + `BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE })`, provê e exporta `VideoProcessingProducer` (sem registrar consumer — a API nunca consome jobs) (per `phase-03-upload-processing/TD-08`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessingProducer` | Integration (Redis real, fila limpa entre testes): job criado com `data`, `name`, `attempts`, `backoff`; segundo `enqueue` do mesmo `videoId` não cria segundo job | `src/video-processing/video-processing.producer.integration-spec.ts` |
| `VideoProcessingProducerModule` | Unit: compilation test | `src/video-processing/video-processing-producer.module.spec.ts` |

**Dependencies:** SI-03.1 — `QueueModule` e Redis.

**Acceptance criteria:**

- `enqueue(videoId)` cria na fila `video-processing` um job `process` com id `videoId`, `data` `{ videoId }`, 3 tentativas e backoff exponencial de 1000 ms.
- Chamar `enqueue` duas vezes com o mesmo `videoId` resulta em exatamente um job na fila.
- Com o Redis inacessível, `enqueue` rejeita com `QueueUnavailableError`.

---

### SI-03.6 — VideosService: iniciar upload + consulta do dono + serialização

**Description:** Implementa o pré-cadastro do rascunho ao iniciar o upload (linha `videos` + multipart S3) e a leitura do vídeo restrita ao dono, com a serialização `VideoResponse` (`phase-03-upload-processing/TD-02`, `TD-05`, `TD-10`, `TD-14`).

**Technical actions:**

1. Adicionar em `src/common/exceptions/domain.exception.ts` as exceções de `### Error Catalog`: `UnsupportedVideoFormatException` (`UNSUPPORTED_VIDEO_FORMAT`, 415), `VideoTooLargeException` (`VIDEO_TOO_LARGE`, 422), `VideoSizeMismatchException` (`VIDEO_SIZE_MISMATCH`, 422), `VideoNotFoundException` (`VIDEO_NOT_FOUND`, 404), `UploadNotInProgressException` (`UPLOAD_NOT_IN_PROGRESS`, 409), `InvalidUploadPartsException` (`INVALID_UPLOAD_PARTS`, 422), `UploadSessionExpiredException` (`UPLOAD_SESSION_EXPIRED`, 410), `ProcessingQueueUnavailableException` (`PROCESSING_QUEUE_UNAVAILABLE`, 503), `VideoNotReadyException` (`VIDEO_NOT_READY`, 409) (per `phase-02-auth/TD-07`).
2. Adicionar `ChannelsService.findByUserId(userId)` em `src/channels/channels.service.ts` (o dono do vídeo é o canal do usuário autenticado; a consulta de canal pertence ao módulo de canais).
3. Criar `src/videos/videos.service.ts` com `initiateUpload(userId, { file_name, mime_type, size })`: valida allowlist de extensão/`mime_type` e par coerente (415), `size` ≤ 10737418240 (422 `VIDEO_TOO_LARGE`), deriva `title` (nome sem extensão, truncado em 100) e `ext`, gera `short_id`, chama `CreateMultipartUpload` em `{short_id}/source.{ext}`, insere a linha com `upload_id`; em violação `23505` de `short_id` regenera e tenta de novo (até 3), e em falha do insert aborta o multipart antes de propagar; retorna `{ video, upload: { part_size, part_count } }` (per `### API Contracts` → `POST /videos`).
4. Adicionar `findOwnedByShortId(userId, shortId)` — `isValidShortId` falso, vídeo inexistente ou `channel_id` ≠ canal do usuário → `VideoNotFoundException` (per `phase-03-upload-processing/TD-05` revisão 2026-10-03), e `src/videos/video-response.mapper.ts` produzindo `VideoResponse` (sem campos internos; `thumbnail_url` via `StorageService.buildPublicObjectUrl`) (per `phase-03-upload-processing/TD-15`).
5. Criar `src/videos/videos.module.ts` — `TypeOrmModule.forFeature([Video])`, `StorageModule`, `ChannelsModule`, `VideoProcessingProducerModule`; provê e exporta `VideosService`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService` (initiate / findOwned) | Unit (repo, storage e channels mockados): allowlist e par extensão↔mime, limite de 10 GiB (10737418240 aceito, 10737418241 rejeitado), truncagem de `title`, retry de `short_id` em `23505` e erro após 3 colisões, abort do multipart quando o insert falha, `VideoNotFoundException` para shortId malformado/inexistente/de outro canal | `src/videos/videos.service.spec.ts` |
| `VideosService` (initiate / findOwned) | Integration (Postgres + SeaweedFS reais): linha persistida com `upload_id` válido no storage (`listParts` vazio), `findOwnedByShortId` filtra por canal | `src/videos/videos.service.integration-spec.ts` |
| `ChannelsService.findByUserId` | Integration: retorna o canal do usuário / `null` | `src/channels/channels.service.integration-spec.ts` |
| `VideosModule` | Unit: compilation test | `src/videos/videos.module.spec.ts` |

**Dependencies:** SI-03.3 (StorageService), SI-03.4 (entidade + migration), SI-03.5 (producer importado pelo módulo).

**Acceptance criteria:**

- Iniciar upload de `clip.mp4` / `video/mp4` / `1048576` cria um vídeo `uploading`/`draft` com `title = "clip"`, `short_id` de 11 caracteres e retorna `part_size = 67108864`, `part_count = 1`.
- Iniciar com `size = 10737418241` rejeita com `VIDEO_TOO_LARGE` sem criar linha nem multipart upload no storage.
- Iniciar com `clip.mov` / `video/quicktime`, ou `clip.webm` / `video/mp4`, rejeita com `UNSUPPORTED_VIDEO_FORMAT`.
- Um `file_name` de 150 caracteres sem extensão gera `title` com exatamente 100 caracteres.
- Buscar o vídeo de outro canal, um `short_id` inexistente ou malformado rejeita igualmente com `VIDEO_NOT_FOUND`.
- A `VideoResponse` nunca contém `id`, `channel_id`, `original_object_key`, `upload_id` nem `thumbnail_object_key`.

---

### SI-03.7 — Sessão de upload: URLs de parts, parts enviadas e complete (enfileirar → processing)

**Description:** Implementa o protocolo multipart do lado da API — presign de parts, retomada e complete com re-checagem de tamanho — e as transições condicionais de `processing_status`, enfileirando o job **antes** de marcar `processing` (`phase-03-upload-processing/TD-02`, `TD-07`, `TD-11`).

**Technical actions:**

1. Criar `src/videos/video-lifecycle.service.ts` — transições condicionais (`UPDATE … WHERE id = :id AND processing_status IN (…)`, retornando se afetou linha): `markProcessing` (`uploading → processing`), `markUploadRejected` (`uploading → failed` / `UPLOAD_REJECTED`), `markReady(id, metadata)` e `markFailed(id, reason)` (origem `uploading | processing`); exportado por `VideosModule` para o worker (per `### Data Model` → State transitions).
2. Adicionar `VideosService.signPartUrls(userId, shortId, part_numbers)` — exige `uploading` (409 `UPLOAD_NOT_IN_PROGRESS`), `part_number` ≤ `part_count` (422 `INVALID_UPLOAD_PARTS`), presign público com `expiresIn: 3600`, retorna `{ parts: [{ part_number, url }], expires_at }` ordenado (per `### API Contracts` → `POST /videos/:shortId/upload/part-urls`).
3. Adicionar `VideosService.listUploadedParts(userId, shortId)` — exige `uploading`, `ListParts` → `{ part_size, part_count, parts: [{ part_number, etag, size }] }`; `StorageUploadNotFoundError` → 410 `UPLOAD_SESSION_EXPIRED` (per `### API Contracts` → `GET /videos/:shortId/upload/parts`).
4. Adicionar `VideosService.completeUpload(userId, shortId, parts)` seguindo os passos 1–5 de `### API Contracts` → `POST /videos/:shortId/upload/complete` na ordem: gate de estado (replay 200 para `processing`/`ready`, 409 para `failed`); validação do conjunto {1..`part_count`} (422); `completeMultipartUpload` com fallback `StorageUploadNotFoundError` → `headObject` (objeto presente segue; ausente → 410) e `StorageInvalidPartsError` → 422; `headObject` > 10737418240 → `deleteObject` + `markUploadRejected` + 422 `VIDEO_TOO_LARGE`, ≠ `size_bytes` → idem com 422 `VIDEO_SIZE_MISMATCH`; `VideoProcessingProducer.enqueue(video.id)` e, se lançar `QueueUnavailableError`, 503 `PROCESSING_QUEUE_UNAVAILABLE` com o vídeo ainda `uploading`; só então `markProcessing`, releitura e retorno da `VideoResponse` (per `phase-03-upload-processing/TD-02` revisão 2026-10-04, `TD-07`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoLifecycleService` | Integration (Postgres): cada transição aplica só a partir dos estados de origem permitidos; `markProcessing` não regride um vídeo `ready`; `markFailed` não sobrescreve `ready` | `src/videos/video-lifecycle.service.integration-spec.ts` |
| `VideosService` (upload session) | Unit (storage, producer, lifecycle mockados): ordem `enqueue` → `markProcessing` (assert de ordem de chamada); `QueueUnavailableError` → 503 sem `markProcessing`; `headObject.ContentLength = 10737418241` → `deleteObject` + `markUploadRejected` + `VIDEO_TOO_LARGE` sem `enqueue`; tamanho divergente → `VIDEO_SIZE_MISMATCH`; `NoSuchUpload` com objeto presente segue para enqueue, sem objeto → 410; replay em `processing`/`ready` sem efeitos colaterais; `failed` → 409; conjunto de parts incompleto → 422 | `src/videos/videos.service.spec.ts` |
| `VideosService` (upload session) | Integration (Postgres + SeaweedFS + Redis reais): upload de 1 part via URL presignada + complete → vídeo `processing` e job `jobId = id` na fila; `size` declarado maior que os bytes enviados → 422, vídeo `failed`/`UPLOAD_REJECTED`, objeto removido, nenhum job; complete repetido após sucesso → mesma resposta e um único job; `listUploadedParts` reflete a part enviada | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.6 — `VideosService`, exceções e `VideosModule`.

**Acceptance criteria:**

- Complete de um upload íntegro deixa o vídeo `processing` e exatamente um job `process` com id igual ao `id` do vídeo na fila `video-processing`.
- Com o enqueue falhando, complete rejeita com `PROCESSING_QUEUE_UNAVAILABLE`, o vídeo permanece `uploading` com o objeto montado no storage, e um complete repetido após o Redis voltar termina em `processing` com um único job.
- Complete cujo objeto montado tem `ContentLength` maior que 10737418240 rejeita com `VIDEO_TOO_LARGE`, apaga o objeto, marca `failed`/`UPLOAD_REJECTED` e não enfileira job.
- Complete cujo objeto montado difere do `size` declarado rejeita com `VIDEO_SIZE_MISMATCH` com os mesmos efeitos (objeto apagado, `failed`/`UPLOAD_REJECTED`, sem job).
- Complete de vídeo já `processing` ou `ready` retorna o estado atual sem enfileirar novamente; de vídeo `failed` rejeita com `UPLOAD_NOT_IN_PROGRESS`.
- Pedir URLs para `part_number` maior que `part_count` rejeita com `INVALID_UPLOAD_PARTS`; para um vídeo fora de `uploading`, com `UPLOAD_NOT_IN_PROGRESS`.
- Listar parts de um upload abortado pelo storage rejeita com `UPLOAD_SESSION_EXPIRED` e mantém o vídeo `uploading`.

---

### SI-03.8 — URLs de mídia: streaming e download

**Description:** Emite URLs presignadas de `GetObject` para reprodução por streaming (Range nativo do storage) e para download com `Content-Disposition: attachment`, só para o dono e só para vídeos `ready` (`phase-03-upload-processing/TD-05`, `TD-06`).

**Technical actions:**

1. Adicionar `VideosService.getPlaybackUrl(userId, shortId)` — `findOwnedByShortId`, exige `ready` (409 `VIDEO_NOT_READY`), presign público de `original_object_key` com `expiresIn: 14400`, retorna `{ url, expires_at }` (per `### API Contracts` → `GET /videos/:shortId/playback-url`).
2. Criar `src/videos/content-disposition.util.ts` — `buildAttachmentDisposition(title, ext)` → `attachment; filename="{ascii-safe}.{ext}"; filename*=UTF-8''{percent-encoded}.{ext}` (fallback ASCII sem não-ASCII, `"` e `\`).
3. Adicionar `VideosService.getDownloadUrl(userId, shortId)` — mesmo gate, presign público com `expiresIn: 3600` e `ResponseContentDisposition` de `buildAttachmentDisposition` (`ext` de `original_object_key`), retorna `{ url, expires_at }` (per `### API Contracts` → `GET /videos/:shortId/download-url`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `content-disposition.util` | Unit: título ASCII, acentuado, com aspas/barra invertida | `src/videos/content-disposition.util.spec.ts` |
| `VideosService` (media URLs) | Unit: `VIDEO_NOT_READY` para `uploading`/`processing`/`failed`; TTLs 14400/3600 | `src/videos/videos.service.spec.ts` |
| `VideosService` (media URLs) | Integration (SeaweedFS real): URL de playback responde `206` a `Range`; URL de download devolve `Content-Disposition` de attachment | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.6 — `findOwnedByShortId` e `VideosService`.

**Acceptance criteria:**

- Para um vídeo `ready`, a URL de playback responde a `GET` com `Range: bytes=0-1023` com `206` e 1024 bytes.
- Para um vídeo `ready` com título `Férias "2026"`, a URL de download responde com `Content-Disposition` de `attachment` contendo `filename*=UTF-8''F%C3%A9rias%20%222026%22.mp4` e um `filename` ASCII sem aspas internas.
- Pedir URL de playback ou de download para vídeo `uploading`, `processing` ou `failed` rejeita com `VIDEO_NOT_READY`.
- `expires_at` da playback fica 4 h após a emissão; o da download, 1 h após.

---

### SI-03.9 — VideosController: endpoints de upload

**Route:** POST /videos, POST /videos/:shortId/upload/part-urls, GET /videos/:shortId/upload/parts, POST /videos/:shortId/upload/complete
**Test Specs:** see `nestjs-project/specs/videos-upload.plan.md`
**Authorization:** Authenticated (dono para as rotas com `:shortId`) — ver `### Authorization Matrix`

**Description:** Expõe o protocolo de upload em HTTP com DTOs snake_case, documentação OpenAPI explícita e isenção do rate limit de auth (`phase-03-upload-processing/TD-02`; `openapi-docs-nestjs/TD-01`).

**Technical actions:**

1. Criar os DTOs em `src/videos/dto/` com propriedades snake_case: `InitiateUploadDto` (`file_name`, `mime_type`, `size`), `SignPartUrlsDto` (`part_numbers`), `CompleteUploadDto` (`parts`) + `CompletedPartDto` (`part_number`, `etag`), com os decorators de `### API Contracts` → Validation Rules; e DTOs de resposta para o Swagger (`VideoResponseDto`, `InitiateUploadResponseDto`, `PartUrlsResponseDto`, `UploadedPartsResponseDto`) (per `phase-02-auth/TD-06`).
2. Criar `src/videos/videos.controller.ts` — `@Controller('videos')` + `@SkipThrottle()` na classe, `@ApiBearerAuth('access-token')`, handlers `POST /videos` (201), `POST :shortId/upload/part-urls` (200), `GET :shortId/upload/parts` (200), `POST :shortId/upload/complete` (200), usando `@CurrentUser()` e delegando ao `VideosService` (per `phase-02-auth/TD-08`; per `### API Contracts`).
3. Documentar cada operação com `@ApiOperation`, `@ApiBody`, `@ApiParam('shortId')` e `@ApiResponse` para todos os status de `### API Contracts`, com erros referenciando `ApiErrorEnvelope` (per `openapi-docs-nestjs/TD-01` revisão 2026-05-12).
4. Registrar `VideosController` em `VideosModule` e importar `VideosModule` no `AppModule`.
5. Regenerar o `openapi.json` commitado (`npm run openapi:export`) e adicionar exemplos do fluxo de upload em `api.http` (per `openapi-docs-nestjs/TD-02`).

**Tests:** _(empty — controller wiring; os cenários E2E HTTP são autorados no spec de /plan-test-specs)_

**Dependencies:** SI-03.7 — operações de sessão de upload no `VideosService`.

**Acceptance criteria:**

- `POST /videos` sem `Authorization` retorna `401`.
- `POST /videos` com `{ "file_name": "clip.mp4", "mime_type": "video/mp4", "size": 1048576 }` retorna `201` com `video.processing_status = "uploading"` e `upload.part_size = 67108864`.
- `POST /videos` com `size = 10737418241` retorna `422` com `error: "VIDEO_TOO_LARGE"`; com `mime_type = "video/quicktime"` retorna `415` com `error: "UNSUPPORTED_VIDEO_FORMAT"`.
- `POST /videos` com corpo sem `size` retorna `400` com `error: "VALIDATION_ERROR"`; `POST /videos/:shortId/upload/part-urls` com `part_numbers: []` também.
- `POST /videos/:shortId/upload/part-urls` de um vídeo de outro usuário retorna `404` com `error: "VIDEO_NOT_FOUND"`.
- `POST /videos/:shortId/upload/complete` com as parts enviadas retorna `200` com `processing_status = "processing"`.
- Mais de 10 requisições por minuto aos endpoints de vídeo não retornam `429`.
- `openapi.json` contém as quatro operações com seus status de erro documentados.

---

### SI-03.10 — VideosController: consulta do vídeo e URLs de mídia

**Route:** GET /videos/:shortId, GET /videos/:shortId/playback-url, GET /videos/:shortId/download-url
**Test Specs:** see `nestjs-project/specs/videos-media.plan.md`
**Authorization:** Owner — ver `### Authorization Matrix`

**Description:** Expõe o status do vídeo (polling do processamento) e as URLs de streaming e download para o dono (`phase-03-upload-processing/TD-05`, `TD-12`).

**Technical actions:**

1. Criar `src/videos/dto/media-url-response.dto.ts` (`url`, `expires_at`) para o Swagger.
2. Adicionar em `VideosController` os handlers `GET :shortId` (200 `VideoResponse`), `GET :shortId/playback-url` (200) e `GET :shortId/download-url` (200), delegando a `findOwnedByShortId` + mapper, `getPlaybackUrl` e `getDownloadUrl` (per `### API Contracts`).
3. Documentar as três operações com `@ApiOperation`, `@ApiParam('shortId')` e `@ApiResponse` (200, 401, 404, 409 conforme a rota) referenciando `ApiErrorEnvelope` (per `openapi-docs-nestjs/TD-01` revisão 2026-05-12).
4. Regenerar `openapi.json` e adicionar os exemplos em `api.http` (per `openapi-docs-nestjs/TD-02`).

**Tests:** _(empty — controller wiring; os cenários E2E HTTP são autorados no spec de /plan-test-specs)_

**Dependencies:** SI-03.8 (URLs de mídia no serviço), SI-03.9 (controller registrado).

**Acceptance criteria:**

- `GET /videos/:shortId` do dono retorna `200` com `processing_status`, `failure_reason` e `thumbnail_url`.
- `GET /videos/:shortId` com `shortId` de outro usuário, inexistente ou malformado (`abc`) retorna `404` com `error: "VIDEO_NOT_FOUND"` nos três casos.
- `GET /videos/:shortId` anônimo retorna `401`.
- `GET /videos/:shortId/playback-url` de vídeo `ready` retorna `200` com `url` e `expires_at`; de vídeo `processing` retorna `409` com `error: "VIDEO_NOT_READY"`.
- `GET /videos/:shortId/download-url` de vídeo `ready` retorna `200` com `url` cuja resposta de storage traz `Content-Disposition: attachment`.
- `openapi.json` contém as três operações com seus status de erro documentados.

---

### SI-03.11 — MediaProbeService: ffprobe, gate de compatibilidade e thumbnail via ffmpeg

**Description:** Encapsula a execução de `ffprobe`/`ffmpeg` por `spawn` sobre URL (leitura via Range, sem baixar o arquivo) e o gate de compatibilidade de formato/codec (`phase-03-upload-processing/TD-06`, `TD-09`, `TD-14`).

**Technical actions:**

1. Instalar `ffmpeg` (inclui `ffprobe`) em `nestjs-project/Dockerfile.dev` (`apt install -y ... ffmpeg`) e reconstruir a imagem compartilhada por `nestjs-api` e `video-worker` (per `phase-03-upload-processing/TD-09`).
2. Criar fixtures pequenas em `test/fixtures/videos/` geradas com `ffmpeg -f lavfi` (2 s cada) e um script `scripts/generate-video-fixtures.sh` que as reproduz: `h264-aac.mp4`, `vp9-opus.webm`, `mpeg4.mp4` (codec fora da allowlist), `audio-only.mp4` (sem stream de vídeo) e `not-a-video.mp4` (bytes de texto).
3. Criar `src/video-processing/media/video-compatibility.ts` — função pura `checkCompatibility(probe)` aplicando o gate de `### Events/Messages` → Consumer flow passo 5 (`format_name` com `mp4`/`webm`; vídeo `h264`/`vp8`/`vp9`/`av1`; áudio, se houver, `aac`/`mp3`/`opus`/`vorbis`; duração > 0) e extraindo `duration_seconds`, `width`, `height`, `video_codec`, `audio_codec` (per `phase-03-upload-processing/TD-14`).
4. Criar `src/video-processing/media/media-probe.service.ts` — `probe(url)` executa `ffprobe -v error -print_format json -show_format -show_streams <url>` via `child_process.spawn` (args em array, sem shell, timeout 60 s com kill) e faz parse do JSON; `extractThumbnail(url, durationSeconds)` calcula `t = clamp(duration × 0.1, 0, max(duration − 0.1, 0))` e executa `ffmpeg -ss <t> -i <url> -frames:v 1 -vf scale='min(1280,iw)':-2 -f image2 -c:v mjpeg -q:v 3 pipe:1` (timeout 120 s) retornando o `Buffer` JPEG (per `phase-03-upload-processing/TD-09`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `checkCompatibility` | Unit: cada regra do gate (container, codec de vídeo, codec de áudio, sem áudio, sem vídeo, duração 0) e extração de metadados | `src/video-processing/media/video-compatibility.spec.ts` |
| `MediaProbeService` | Integration (ffprobe/ffmpeg reais sobre as fixtures): probe de `h264-aac.mp4` e `vp9-opus.webm`, erro tipado para `not-a-video.mp4`, thumbnail JPEG (magic bytes `FF D8`) com largura ≤ 1280, timeout mata o processo | `src/video-processing/media/media-probe.service.integration-spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- `docker compose exec nestjs-api ffprobe -version` e `docker compose exec nestjs-api ffmpeg -version` executam com sucesso.
- Probe de `h264-aac.mp4` resulta em compatível com `video_codec = "h264"`, `audio_codec = "aac"`, `duration_seconds` ≈ 2 e `width`/`height` da fixture.
- `mpeg4.mp4` e `audio-only.mp4` resultam em incompatível; `vp9-opus.webm` em compatível.
- Probe de `not-a-video.mp4` falha com erro tipado em vez de lançar exceção não tratada.
- A thumbnail extraída de `h264-aac.mp4` é um JPEG válido.

---

### SI-03.12 — VideoProcessingConsumer: metadados, thumbnail e falhas

**Description:** Implementa o consumidor idempotente do job `process`: valida o arquivo, extrai metadados e thumbnail, grava no storage público e conclui o ciclo `ready`/`failed` (`phase-03-upload-processing/TD-07`, `TD-08`, `TD-09`, `TD-11`, `TD-15`).

**Technical actions:**

1. Criar `src/video-processing/video-processing.consumer.ts` — `@Processor(VIDEO_PROCESSING_QUEUE)` estendendo `WorkerHost`; `process(job)` segue `### Events/Messages` → Consumer flow passos 1–3: carrega o vídeo (ausente ou `ready`/`failed` → retorna), `headObject` (`StorageObjectNotFoundError` → `markFailed(SOURCE_MISSING)` + `throw new UnrecoverableError(...)`), presign `GetObject` no cliente **interno** com `expiresIn: 3600` (per `phase-03-upload-processing/TD-09`).
2. Continuar `process(job)` com os passos 4–5: `MediaProbeService.probe` + `checkCompatibility`; incompatível → `markFailed(UNSUPPORTED_FORMAT)` + `UnrecoverableError` (per `phase-03-upload-processing/TD-14`).
3. Concluir `process(job)` com os passos 6–7: `extractThumbnail`, `putObject` em `STORAGE_THUMBNAILS_BUCKET` com chave `{shortId}/{random}.jpg` (random = `randomBytes(8).toString('hex')`), `ContentType: image/jpeg`, `CacheControl: public, max-age=31536000, immutable`, e `markReady` com `duration_seconds`, `width`, `height`, `video_codec`, `audio_codec`, `thumbnail_object_key`, `processed_at` (per `phase-03-upload-processing/TD-15`).
4. Adicionar `@OnWorkerEvent('failed')` — age só quando `job.attemptsMade >= (job.opts.attempts ?? 1)` e o erro não é `UnrecoverableError`, chamando `markFailed(PROCESSING_FAILED)`; o objeto de origem é mantido (per library-refs → `bullmq`; per `phase-03-upload-processing/TD-11`).
5. Criar `src/video-processing/video-processing-consumer.module.ts` — importa `QueueModule`, `BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE })`, `StorageModule`, `VideosModule` (para `VideoLifecycleService` e repositório de leitura) e provê `MediaProbeService` + `VideoProcessingConsumer` (per `phase-03-upload-processing/TD-08`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessingConsumer` | Unit (storage, probe e lifecycle mockados): no-op para `ready`/`failed`/inexistente; `SOURCE_MISSING` e `UNSUPPORTED_FORMAT` lançam `UnrecoverableError`; handler `failed` só marca `PROCESSING_FAILED` na última tentativa e ignora `UnrecoverableError`; erro transitório propaga (retry) | `src/video-processing/video-processing.consumer.spec.ts` |
| `VideoProcessingConsumer` | Integration (Postgres + SeaweedFS + ffmpeg reais, `process()` chamado direto com o job): `h264-aac.mp4` → `ready` com metadados e thumbnail acessível anonimamente; `mpeg4.mp4` → `failed`/`UNSUPPORTED_FORMAT`; objeto ausente → `failed`/`SOURCE_MISSING`; vídeo ainda `uploading` também é processado | `src/video-processing/video-processing.consumer.integration-spec.ts` |
| `VideoProcessingConsumerModule` | Unit: compilation test | `src/video-processing/video-processing-consumer.module.spec.ts` |

**Dependencies:** SI-03.7 (`VideoLifecycleService`), SI-03.11 (`MediaProbeService`).

**Acceptance criteria:**

- Processar o job de um vídeo `processing` cujo objeto é `h264-aac.mp4` deixa o vídeo `ready` com `duration_seconds`, `width`, `height`, `video_codec = "h264"`, `audio_codec = "aac"` e `processed_at` preenchidos.
- Após o processamento, `thumbnail_url` do vídeo responde a `GET` anônimo com `200`, `Content-Type: image/jpeg` e `Cache-Control: public, max-age=31536000, immutable`.
- Processar um vídeo cujo objeto é `mpeg4.mp4` deixa o vídeo `failed` com `failure_reason = "UNSUPPORTED_FORMAT"`, sem novas tentativas e com o objeto de origem mantido.
- Processar um vídeo cujo objeto não existe deixa o vídeo `failed` com `failure_reason = "SOURCE_MISSING"`, sem novas tentativas.
- Um erro transitório em todas as 3 tentativas deixa o vídeo `failed` com `failure_reason = "PROCESSING_FAILED"`; antes da 3ª tentativa o vídeo continua `processing`.
- Reprocessar o job de um vídeo já `ready` não altera a linha nem grava nova thumbnail.

---

### SI-03.13 — Infra: entrypoint do worker + serviço video-worker

**Description:** Entrega o Video Worker como processo e container isolados, do mesmo codebase, que é o único consumidor da fila (`phase-03-upload-processing/TD-08`).

**Technical actions:**

1. Criar `src/worker.module.ts` — `ConfigModule.forRoot` (mesmo `load` + `envValidationSchema` do `AppModule`), `TypeOrmModule.forRootAsync` com `databaseConfig`, `VideoProcessingConsumerModule`; sem controllers, sem `AuthModule` (per `phase-03-upload-processing/TD-08`; per `phase-01-configuracao-base/TD-01`).
2. Criar `src/worker.ts` — `NestFactory.createApplicationContext(WorkerModule)` + `enableShutdownHooks()` (o `WorkerHost` fecha o worker BullMQ no shutdown).
3. Criar `tsconfig.worker.json` (estende `tsconfig.build.json` com `outDir: ./dist-worker`, evitando que o watch do worker e o da API apaguem o `dist/` um do outro) e os scripts `start:worker:dev` (`nest start --watch --path tsconfig.worker.json --entryFile worker`) e `start:worker:prod` (`node dist-worker/worker`); adicionar `/dist-worker` ao `.gitignore`.
4. Adicionar o serviço `video-worker` em `compose.yaml` — mesmo `build`/volume de `nestjs-api`, `command: npm run start:worker:dev`, sem portas, `depends_on` `db` (healthy), `redis` (healthy) e `storage-init` (completed_successfully) (per `phase-03-upload-processing/TD-08`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `WorkerModule` | Unit: compilation test; o contexto resolve `VideoProcessingConsumer` | `src/worker.module.spec.ts` |
| `AppModule` | Unit: compilation test; `VideoProcessingConsumer` **não** está registrado no contexto da API | `src/app.module.spec.ts` |

**Dependencies:** SI-03.12 — `VideoProcessingConsumerModule`.

**Acceptance criteria:**

- `docker compose up -d` sobe `video-worker` e `docker compose logs video-worker` mostra o contexto Nest inicializado sem erros.
- Com `video-worker` rodando, um vídeo que completa o upload pela API chega a `ready` sem nenhum processo extra iniciado manualmente.
- Com `video-worker` parado, um upload completado permanece `processing` e o job permanece em espera na fila (a API não consome jobs).
- `npm run start:worker:dev` e `npm run start:dev` rodando ao mesmo tempo não interrompem um ao outro.

---

### SI-03.14 — E2E do pipeline: upload → processamento → ready

**Description:** Prova o fluxo completo da fase sobre a infraestrutura real (Postgres, SeaweedFS, Redis, ffmpeg) — upload direto ao storage, enfileiramento, processamento pelo worker, streaming e download — além dos limites de tamanho (capabilities de upload 10GB, processamento, thumbnail, URL única, streaming e download).

**Technical actions:**

1. Criar `test/helpers/video-pipeline.ts` — sobe a API (`AppModule` com os pipes/filters globais do `main.ts`) e, no mesmo processo, um contexto `WorkerModule`; sobrescreve `storageConfig` para que `publicEndpoint` = `STORAGE_ENDPOINT` (o processo de teste roda dentro do container, onde `localhost:8333` não é o SeaweedFS; a assinatura SigV4 continua válida porque o host assinado é o mesmo usado na requisição); expõe helpers de usuário autenticado (register + confirmação + login), `uploadFile(path)` (initiate → part-urls → `PUT` das parts → complete) e `waitForStatus(shortId, status, timeout = 30 s)`.
2. Criar `test/video-pipeline.e2e-spec.ts` com os cenários: (a) fluxo completo com `h264-aac.mp4` até `ready`, conferindo metadados, `thumbnail_url` anônimo `200`, playback com `Range` → `206` e download com `Content-Disposition: attachment`; (b) `mpeg4.mp4` termina `failed`/`UNSUPPORTED_FORMAT`; (c) `size` declarado maior que os bytes enviados → complete `422` `VIDEO_SIZE_MISMATCH` e GET mostra `failed`/`UPLOAD_REJECTED`; (d) limite de 10 GiB no initiate: `size = 10737418240` → `201` e `size = 10737418241` → `422` `VIDEO_TOO_LARGE`; (e) dois uploads geram `short_id`s distintos e um usuário não enxerga o vídeo do outro (`404`).
3. Limpar entre cenários as tabelas tocadas (`videos`, tokens, `channels`, `users`, em ordem de FK), a fila `video-processing` (`obliterate`) e os objetos criados nos dois buckets; fechar app, contexto do worker e conexões em `afterAll`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| Pipeline de upload e processamento | E2E (supertest + SeaweedFS/Redis/Postgres/ffmpeg reais, worker no mesmo processo) | `test/video-pipeline.e2e-spec.ts` |

A rejeição de um objeto **montado** maior que 10 GiB no complete é coberta pelo unit test do SI-03.7 (`headObject` mockado com 10737418241 bytes): enviar 10 GiB num teste não é viável.

**Dependencies:** SI-03.10 (todas as rotas expostas), SI-03.13 (`WorkerModule`).

**Acceptance criteria:**

- Um MP4 H.264/AAC enviado em parts por URLs presignadas chega a `processing_status = "ready"` em até 30 s após o complete, com `duration_seconds`, `width`, `height`, `video_codec` e `thumbnail_url` preenchidos.
- O `thumbnail_url` desse vídeo responde `200` sem autenticação; a URL de playback responde `206` a uma requisição com `Range`; a URL de download traz `Content-Disposition: attachment`.
- Um MP4 com codec MPEG-4 Part 2 termina com `processing_status = "failed"` e `failure_reason = "UNSUPPORTED_FORMAT"`.
- Iniciar com `size = 10737418240` retorna `201`; com `size = 10737418241` retorna `422` com `error: "VIDEO_TOO_LARGE"`.
- Completar um upload cujo `size` declarado excede os bytes enviados retorna `422` com `error: "VIDEO_SIZE_MISMATCH"`, e o vídeo passa a `failed` com `failure_reason = "UPLOAD_REJECTED"`.
- Dois uploads do mesmo usuário recebem `short_id`s diferentes, e um segundo usuário recebe `404` ao consultar qualquer um deles.

---

### SI-03.15 — Documentação: CLAUDE.md, contrato de storage em produção e guia de testes

**Description:** Atualiza a documentação de arquitetura e operação para refletir fila, storage, worker, variáveis de ambiente e endpoints de vídeo entregues na fase (`phase-03-upload-processing/TD-01`, `TD-07`, `TD-08`, `TD-16`).

**Technical actions:**

1. Atualizar o `CLAUDE.md` raiz → `## Architecture`: **Message Queue** `(TBD)` → BullMQ sobre Redis (fila `video-processing`); **Object Storage** → API S3 em todos os ambientes (SeaweedFS em dev/test, qualquer S3-compatível em prod), dois buckets (vídeos privado + thumbnails public-read); **Video Worker** → mesmo codebase do `nestjs-project`, entrypoint `src/worker.ts`, serviço `video-worker` com ffprobe/ffmpeg.
2. Atualizar `nestjs-project/CLAUDE.md`: serviços (`redis`, `seaweedfs`, `storage-init`, `video-worker`) com verificações de prontidão (`docker compose exec redis redis-cli ping`, `storage-init` com exit `0` em `docker compose ps -a`, `docker compose logs video-worker`); comandos `start:worker:dev` / `start:worker:prod` e o motivo do `dist-worker/`; variáveis `REDIS_*` e `STORAGE_*` (com `STORAGE_PUBLIC_ENDPOINT` como único host voltado ao browser); resumo dos endpoints `/videos` e da convenção snake_case dos corpos; fixtures de vídeo e `scripts/generate-video-fixtures.sh`.
3. Criar `docs/storage-provisioning.md` com o contrato de produção: dois buckets, o mesmo CORS e lifecycle do `init.sh`, política public-read só no bucket de thumbnails (Block Public Access relaxado apenas nele), credenciais da API restritas a `Read`/`Write`/`List` em nível de objeto; IaC fica para uma fase de deploy (per `phase-03-upload-processing/TD-16`).
4. Alinhar `.claude/skills/testing-guide-nestjs-project/references/external-systems.md` ao Compose entregue (serviço `seaweedfs`, não `storage`; nota sobre `STORAGE_PUBLIC_ENDPOINT` ser sobrescrito para o endpoint interno nos testes que fazem `fetch` de URLs presignadas).

**Tests:** _(empty — documentação)_

**Dependencies:** SI-03.13 (serviços Compose e scripts finais), SI-03.14 (padrão de override do endpoint público nos testes).

**Acceptance criteria:**

- O `CLAUDE.md` raiz não contém mais `Message Queue** (TBD)` e descreve BullMQ/Redis, o storage S3 com dois buckets e o worker.
- `nestjs-project/CLAUDE.md` lista `redis`, `seaweedfs`, `storage-init` e `video-worker` com um comando de verificação de prontidão para cada um.
- `nestjs-project/CLAUDE.md` lista todas as chaves `REDIS_*` e `STORAGE_*` presentes em `.env.example`, sem divergência.
- `docs/storage-provisioning.md` descreve buckets, CORS, lifecycle, política pública e escopo das credenciais de produção.
- O guia de testes referencia o serviço `seaweedfs` e o override do endpoint público.

---

## Technical Specifications

### Data Model

#### Video

Table `videos` (new). Draft row created at initiate (per phase-03-upload-processing/TD-02 revision 2026-10-03); lifecycle per phase-03-upload-processing/TD-11 (Option B — two fields).

| Field | Type | Constraints |
|-------|------|-------------|
| id | uuid | PK, generated |
| channel_id | uuid | not null, FK → `channels(id)` — owner is the authenticated user's channel (one channel per user, phase-02-auth/TD-10) |
| short_id | varchar(11) | unique, not null — random 11-char base64url (phase-03-upload-processing/TD-10) |
| title | varchar(100) | not null — at initiate: `file_name` without extension, truncated to 100 chars |
| description | text | nullable — null at initiate (editing is Phase 04) |
| processing_status | varchar(20) | not null, default `'uploading'`, CHECK in (`uploading`, `processing`, `ready`, `failed`) |
| publication_status | varchar(20) | not null, default `'draft'`, CHECK in (`draft`) — Phase 04 widens the CHECK |
| failure_reason | varchar(32) | nullable, CHECK in (`UNSUPPORTED_FORMAT`, `PROCESSING_FAILED`, `SOURCE_MISSING`, `UPLOAD_REJECTED`) |
| original_object_key | varchar(255) | not null — key in `STORAGE_BUCKET` (private), format `{short_id}/source.{ext}` (`ext` ∈ `mp4`, `m4v`, `webm`, from `file_name`) |
| mime_type | varchar(64) | not null — `video/mp4` \| `video/webm` (phase-03-upload-processing/TD-14 allowlist) |
| size_bytes | bigint | not null — declared `size` at initiate; entity uses a bigint→number column transformer (≤ 10 GiB fits `Number.MAX_SAFE_INTEGER`) |
| upload_id | text | not null — S3 multipart `UploadId` from `CreateMultipartUpload` |
| duration_seconds | double precision | nullable — worker-filled (ffprobe `format.duration`) |
| width | integer | nullable — worker-filled |
| height | integer | nullable — worker-filled |
| video_codec | varchar(32) | nullable — worker-filled (ffprobe `codec_name` of the first video stream) |
| audio_codec | varchar(32) | nullable — worker-filled; stays null when the file has no audio stream |
| thumbnail_object_key | varchar(255) | nullable — key in `STORAGE_THUMBNAILS_BUCKET`, versioned `{shortId}/{random-or-hash}.jpg` (phase-03-upload-processing/TD-15) |
| processed_at | timestamp | nullable — set on `processing → ready` |
| created_at | timestamp | `@CreateDateColumn()` (project pattern) |
| updated_at | timestamp | `@UpdateDateColumn()` (project pattern) |

**Relations:** `Channel` has many `Video` (one-to-many; `Video.channel` is `@ManyToOne` with `@JoinColumn({ name: 'channel_id' })`). FK `ON DELETE` left at the default (`NO ACTION`) — account/channel deletion and storage cleanup are outside Phase 03.
**Indexes:** unique on `short_id`; non-unique on `channel_id`.

**State transitions of `processing_status`** (phase-03-upload-processing/TD-11 + revisions):

| From | To | Set by | Condition |
|------|----|--------|-----------|
| — | `uploading` | API — initiate | row insert |
| `uploading` | `processing` | API — complete | only **after** the processing job was enqueued successfully (see Events/Messages → ordering) |
| `uploading` | `failed` (`UPLOAD_REJECTED`) | API — complete | `HeadObject` `ContentLength` > 10 GiB or ≠ `size_bytes`; object deleted, no job enqueued |
| `uploading` \| `processing` | `ready` | Worker | ffprobe passes the compatibility gate, metadata + thumbnail stored |
| `uploading` \| `processing` | `failed` (`UNSUPPORTED_FORMAT` \| `SOURCE_MISSING`) | Worker | deterministic rejection (`UnrecoverableError`, no retries) |
| `uploading` \| `processing` | `failed` (`PROCESSING_FAILED`) | Worker | final failed attempt (3 attempts, exponential backoff) |

All transitions are conditional updates (`UPDATE … WHERE id = :id AND processing_status IN (…)`), so a stale writer never moves a video backwards (e.g., the API's `uploading → processing` update is a no-op if the worker already set `ready`). The worker accepts `uploading` as a source state because, under the enqueue-before-transition ordering, a job can start before the API commits `processing`. `failed` videos keep their object (diagnosis) except `UPLOAD_REJECTED`, whose object is deleted.

**Short ID generation** (phase-03-upload-processing/TD-10): `crypto.randomBytes(8).toString('base64url')` → 11 chars `[A-Za-z0-9_-]`; insert, and on unique violation of `short_id` (Postgres `23505`) regenerate and retry up to 3 attempts, then fail with 500.

**Thumbnail URL composition** (phase-03-upload-processing/TD-15): the DB stores only `thumbnail_object_key`; the API composes `thumbnail_url` at serialization time from `STORAGE_PUBLIC_ENDPOINT` + `STORAGE_THUMBNAILS_BUCKET` + key (path-style when `STORAGE_FORCE_PATH_STYLE` is true). `null` while there is no thumbnail.

#### Storage objects (no DB table)

| Bucket (env key) | Visibility | Object key | Written by | Notes |
|------------------|------------|------------|------------|-------|
| `STORAGE_BUCKET` | private | `{short_id}/source.{ext}` | Browser via presigned `UploadPart` URLs; assembled by API `CompleteMultipartUpload` | CORS + `AbortIncompleteMultipartUpload` after 1 day (phase-03-upload-processing/TD-16) |
| `STORAGE_THUMBNAILS_BUCKET` | public-read (`Read`, no `List`) | `{shortId}/{random-or-hash}.jpg` | Worker `PutObject`, `ContentType: image/jpeg`, `CacheControl: public, max-age=31536000, immutable` | No CORS (phase-03-upload-processing/TD-16) |

### API Contracts

Backend tier only (`ui_in_scope: deferred` — no BFF tier this phase). All endpoints live in a new `VideosController` (`@Controller('videos')`), require `Authorization: Bearer <access_token>` (global `JwtAuthGuard`, no `@Public()`), and are exempt from the auth rate limit via class-level `@SkipThrottle()` (phase-02-auth/TD-08: rate limiting scoped to `AuthModule`; same pattern as `AppController`). Error bodies use the inherited envelope `{ statusCode, error, message }` (phase-02-auth/TD-07). Every operation carries explicit `@ApiOperation` / `@ApiResponse` / `@ApiBody` / `@ApiParam` decorators with error responses referencing `ApiErrorEnvelope` (openapi-docs-nestjs/TD-01 revision 2026-05-12), and the committed `openapi.json` is regenerated (openapi-docs-nestjs/TD-02).

**Path parameter `:shortId`** (all routes below except `POST /videos`): the video's `short_id`. A value not matching `^[A-Za-z0-9_-]{11}$`, an unknown `short_id`, or a video whose `channel_id` is not the caller's channel all respond **404 `VIDEO_NOT_FOUND`** — existence is never revealed to non-owners (phase-03-upload-processing/TD-05 revision 2026-10-03).

**Shared response shape — `VideoResponse`** (owner view; field names per phase-03-upload-processing/TD-11):

- short_id: string — 11-char base64url
- title: string
- description: string | null
- processing_status: `uploading` | `processing` | `ready` | `failed`
- publication_status: `draft`
- failure_reason: `UNSUPPORTED_FORMAT` | `PROCESSING_FAILED` | `SOURCE_MISSING` | `UPLOAD_REJECTED` | null
- mime_type: string
- size_bytes: number
- duration_seconds: number | null
- width: number | null
- height: number | null
- video_codec: string | null
- audio_codec: string | null
- thumbnail_url: string | null — composed from `thumbnail_object_key` (phase-03-upload-processing/TD-15); the key itself is never exposed
- processed_at: string (ISO-8601) | null
- created_at: string (ISO-8601)
- updated_at: string (ISO-8601)

`id` (uuid), `channel_id`, `original_object_key`, `upload_id` and `thumbnail_object_key` are internal and never serialized.

**Field casing:** every request and response field of the videos API is snake_case (`file_name`, `mime_type`, `size`, `part_size`, `part_count`, `part_numbers`, `part_number`, `etag`, `expires_at`, …), and DTO class properties use the same names. This follows the existing API convention (`RefreshTokenDto.refresh_token`, `ResetPasswordDto.new_password`, login `access_token`) and the snake_case `VideoResponse` fields of phase-03-upload-processing/TD-11. The camelCase names in phase-03-upload-processing/TD-02 (`fileName`, `mimeType`, `partSize`) are illustrative; the project convention prevails. Route path placeholders (`:shortId`) are not body fields and keep the Nest param style.

**Upload constants** (phase-03-upload-processing/TD-02): `part_size` = 67108864 (64 MiB), max file size = 10737418240 bytes (10 GiB), presigned part URL TTL = 3600 s, `part_count` = `ceil(size_bytes / part_size)` (≤ 160). The client slices the file at exactly `part_size` (only the last part may be smaller) and never hard-codes it.

#### POST /videos (SI-03.9)

Initiate upload: creates the draft `Video` row + the S3 multipart upload (`CreateMultipartUpload` on `STORAGE_BUCKET`, `Key` = `original_object_key`, `ContentType` = `mime_type`) in one operation. If the DB insert fails after `CreateMultipartUpload`, the multipart upload is aborted (`AbortMultipartUpload`) before the error propagates.

**Request headers:**
- Authorization: Bearer <access_token>
- Content-Type: application/json

**Request body:**
- file_name: string, required — 1–255 chars; extension (case-insensitive) must be `.mp4`, `.m4v` or `.webm`
- mime_type: string, required — `video/mp4` or `video/webm`; must match the extension (`.mp4`/`.m4v` ↔ `video/mp4`, `.webm` ↔ `video/webm`)
- size: integer, required — bytes, ≥ 1, ≤ 10737418240

**Response 201:**
- video: `VideoResponse` — `processing_status` = `uploading`, `publication_status` = `draft`, `title` = `file_name` without extension (truncated to 100 chars), `description` = null
- upload: object
  - part_size: number — 67108864
  - part_count: number — `ceil(size / part_size)`

**Error responses:**
- 400 VALIDATION_ERROR: missing/ill-typed field, `size` not a positive integer, `file_name` empty or > 255 chars
- 401 Unauthorized: missing or invalid access token (guard default body)
- 415 UNSUPPORTED_VIDEO_FORMAT: `mime_type` not in the allowlist, extension not in the allowlist, or extension/`mime_type` mismatch (phase-03-upload-processing/TD-14)
- 422 VIDEO_TOO_LARGE: `size` > 10737418240 (phase-03-upload-processing/TD-02)

---

#### POST /videos/:shortId/upload/part-urls (SI-03.9)

Presigns `UploadPart` URLs on the **public** client (`STORAGE_PUBLIC_ENDPOINT`, phase-03-upload-processing/TD-04) with `expiresIn: 3600`. Re-callable at any time while the upload is in progress (re-sign on expiry / resume). Signing is local — no storage round-trip.

**Request headers:**
- Authorization: Bearer <access_token>
- Content-Type: application/json

**Request body:**
- part_numbers: integer[], required — 1–160 items, unique, each 1 ≤ n ≤ `part_count`

**Response 200:**
- parts: array of `{ part_number: number, url: string }` — ordered by `part_number`
- expires_at: string (ISO-8601) — signing time + 3600 s

**Error responses:**
- 400 VALIDATION_ERROR: body fails schema validation (empty array, non-integer, duplicates, > 160 items)
- 401 Unauthorized: missing or invalid access token
- 404 VIDEO_NOT_FOUND: see `:shortId` rule
- 409 UPLOAD_NOT_IN_PROGRESS: `processing_status` ≠ `uploading`
- 422 INVALID_UPLOAD_PARTS: a `part_number` > `part_count`

---

#### GET /videos/:shortId/upload/parts (SI-03.9)

Resume support: lists the parts storage already holds for the multipart upload (`ListParts` on the internal client), so a client that lost its local state (re-picked file after reload) uploads only the missing parts.

**Request headers:**
- Authorization: Bearer <access_token>

**Response 200:**
- part_size: number — 67108864
- part_count: number
- parts: array of `{ part_number: number, etag: string, size: number }` — ordered by `part_number`

**Error responses:**
- 401 Unauthorized: missing or invalid access token
- 404 VIDEO_NOT_FOUND: see `:shortId` rule
- 409 UPLOAD_NOT_IN_PROGRESS: `processing_status` ≠ `uploading`
- 410 UPLOAD_SESSION_EXPIRED: storage reports `NoSuchUpload` (aborted by the 24h lifecycle rule) — video stays `uploading` (orphan-draft cleanup is a follow-up, phase-03-upload-processing/TD-11)

---

#### POST /videos/:shortId/upload/complete (SI-03.9)

Assembles the object, validates it, enqueues processing and only then moves the video to `processing`. **Ordered steps** (each step's failure leaves a retry-safe state):

1. **State gate.** `processing` or `ready` → idempotent replay: respond 200 with the current `VideoResponse`, no side effects. `failed` → 409 `UPLOAD_NOT_IN_PROGRESS`. `uploading` → continue.
2. **Assemble.** `CompleteMultipartUpload` (internal client) with `parts` sorted by `part_number`. If storage answers `NoSuchUpload`, run `HeadObject` on `original_object_key`: object present → a previous complete already assembled it, continue to step 3; object absent → 410 `UPLOAD_SESSION_EXPIRED`. `InvalidPart` / `InvalidPartOrder` / `EntityTooSmall` → 422 `INVALID_UPLOAD_PARTS` (video stays `uploading`, client may re-upload and retry).
3. **Size re-check** (`HeadObject`, phase-03-upload-processing/TD-02 revision 2026-10-04). `ContentLength` > 10737418240 → 422 `VIDEO_TOO_LARGE`; `ContentLength` ≠ `size_bytes` → 422 `VIDEO_SIZE_MISMATCH`. On either: `DeleteObject`, conditional update `uploading → failed` with `failure_reason = UPLOAD_REJECTED`, **no job enqueued**.
4. **Enqueue** the processing job (`jobId` = video `id`, idempotent — see Events/Messages → `video-processing` / `process`). If `queue.add` throws (broker unreachable) → 503 `PROCESSING_QUEUE_UNAVAILABLE`; the video **stays `uploading`** (object kept) and the client retries this endpoint — step 2's `NoSuchUpload` → `HeadObject` path and the `jobId` idempotency make the retry safe.
5. **Transition.** Conditional update `processing_status = 'processing' WHERE id = :id AND processing_status = 'uploading'` (0 rows affected is fine: the worker already advanced it). Re-read and respond.

Enqueue-before-transition is deliberate: a failure to enqueue never leaves a video stuck in `processing` without a job (the reconciliation sweep is outside Phase 03, phase-03-upload-processing/TD-07 / TD-11).

**Request headers:**
- Authorization: Bearer <access_token>
- Content-Type: application/json

**Request body:**
- parts: array, required — 1–160 items; must contain each `part_number` from 1 to `part_count` exactly once
  - part_number: integer, required — ≥ 1
  - etag: string, required — non-empty; the `ETag` response header of the part's `PUT` (exposed by bucket CORS, phase-03-upload-processing/TD-16)

**Response 200:**
- `VideoResponse` — `processing_status` = `processing` (or `ready` if the worker already finished; or the current state on idempotent replay)

**Error responses:**
- 400 VALIDATION_ERROR: body fails schema validation
- 401 Unauthorized: missing or invalid access token
- 404 VIDEO_NOT_FOUND: see `:shortId` rule
- 409 UPLOAD_NOT_IN_PROGRESS: `processing_status` = `failed`
- 410 UPLOAD_SESSION_EXPIRED: multipart upload gone and no assembled object
- 422 INVALID_UPLOAD_PARTS: part set ≠ {1..`part_count`}, or storage rejects a part/ETag
- 422 VIDEO_TOO_LARGE: assembled `ContentLength` > 10 GiB (video → `failed` / `UPLOAD_REJECTED`)
- 422 VIDEO_SIZE_MISMATCH: assembled `ContentLength` ≠ declared `size` (video → `failed` / `UPLOAD_REJECTED`)
- 503 PROCESSING_QUEUE_UNAVAILABLE: enqueue failed; video stays `uploading`, safe to retry

---

#### GET /videos/:shortId (SI-03.10)

Owner view of the video, used to poll processing status (phase-03-upload-processing/TD-12 — polling; the FE consumer is deferred).

**Request headers:**
- Authorization: Bearer <access_token>

**Response 200:**
- `VideoResponse`

**Error responses:**
- 401 Unauthorized: missing or invalid access token
- 404 VIDEO_NOT_FOUND: see `:shortId` rule

---

#### GET /videos/:shortId/playback-url (SI-03.10)

Presigned `GetObject` URL on the public client for `<video src>` streaming; storage serves HTTP Range natively (phase-03-upload-processing/TD-05 Option C, TD-06 Option A — original file). Owner only in Phase 03.

**Request headers:**
- Authorization: Bearer <access_token>

**Response 200:**
- url: string — presigned GET, `expiresIn: 14400` (4 h, covers a long viewing session; Range requests after expiry fail)
- expires_at: string (ISO-8601)

**Error responses:**
- 401 Unauthorized: missing or invalid access token
- 404 VIDEO_NOT_FOUND: see `:shortId` rule
- 409 VIDEO_NOT_READY: `processing_status` ≠ `ready`

---

#### GET /videos/:shortId/download-url (SI-03.10)

Presigned `GetObject` URL on the public client with `ResponseContentDisposition` forcing attachment (phase-03-upload-processing/TD-05). Owner only in Phase 03.

**Request headers:**
- Authorization: Bearer <access_token>

**Response 200:**
- url: string — presigned GET, `expiresIn: 3600`, `ResponseContentDisposition: attachment; filename="{ascii-safe title}.{ext}"; filename*=UTF-8''{percent-encoded title}.{ext}` (`ext` from `original_object_key`; non-ASCII and `"` `\` stripped from the ASCII fallback)
- expires_at: string (ISO-8601)

**Error responses:**
- 401 Unauthorized: missing or invalid access token
- 404 VIDEO_NOT_FOUND: see `:shortId` rule
- 409 VIDEO_NOT_READY: `processing_status` ≠ `ready`

---

#### Validation Rules — video upload

- `file_name`: required string, `@IsNotEmpty()`, `@MaxLength(255)`; allowlisted extension (`.mp4`, `.m4v`, `.webm`) checked in the service → 415 `UNSUPPORTED_VIDEO_FORMAT`
- `mime_type`: required string; allowlist (`video/mp4`, `video/webm`) + extension match checked in the service → 415 `UNSUPPORTED_VIDEO_FORMAT` (DTO only enforces string/non-empty, so a wrong type is a domain 415, not a 400)
- `size`: required, `@IsInt()`, `@Min(1)`; upper bound 10737418240 checked in the service → 422 `VIDEO_TOO_LARGE`
- `part_numbers`: `@IsArray()`, `@ArrayMinSize(1)`, `@ArrayMaxSize(160)`, `@ArrayUnique()`, each `@IsInt()` + `@Min(1)`; range ≤ `part_count` checked in the service → 422 `INVALID_UPLOAD_PARTS`
- `parts`: `@IsArray()`, `@ArrayMinSize(1)`, `@ArrayMaxSize(160)`, `@ValidateNested({ each: true })` + `@Type(() => CompletedPartDto)`; `part_number` `@IsInt()` + `@Min(1)`, `etag` `@IsString()` + `@IsNotEmpty()`; contiguity {1..`part_count`} checked in the service → 422 `INVALID_UPLOAD_PARTS`
- `:shortId`: regex `^[A-Za-z0-9_-]{11}$` checked in the service (not a 400) → 404 `VIDEO_NOT_FOUND`

### Authorization Matrix

"Owner" = authenticated user whose channel (`channels.user_id = sub`) is the video's `channel_id`. "Authenticated" = any other authenticated user. Non-owners get 404 (never 403) so existence is not revealed (phase-03-upload-processing/TD-05 revision 2026-10-03). Every Phase 03 video is a `draft`; third-party access depends on publication/visibility (Phase 04).

| Endpoint | Anonymous | Authenticated | Owner |
|----------|-----------|---------------|-------|
| POST /videos | ✗ (401) | ✓ (becomes owner) | — |
| POST /videos/:shortId/upload/part-urls | ✗ (401) | ✗ (404) | ✓ |
| GET /videos/:shortId/upload/parts | ✗ (401) | ✗ (404) | ✓ |
| POST /videos/:shortId/upload/complete | ✗ (401) | ✗ (404) | ✓ |
| GET /videos/:shortId | ✗ (401) | ✗ (404) | ✓ |
| GET /videos/:shortId/playback-url | ✗ (401) | ✗ (404) | ✓ |
| GET /videos/:shortId/download-url | ✗ (401) | ✗ (404) | ✓ |
| Public thumbnail URL (`thumbnail_url`, served by storage) | ✓ | ✓ | ✓ |

The thumbnails bucket is anonymous `Read` only, no `List` (phase-03-upload-processing/TD-15, TD-16); the videos bucket has no anonymous access — video bytes are reachable only through presigned URLs issued by the endpoints above.

### Error Catalog

Envelope inherited from phase-02-auth/TD-07: `{ statusCode, error, message }`, raised as `DomainException` subclasses in `src/common/exceptions/domain.exception.ts` and rendered by `DomainExceptionFilter`. `400 VALIDATION_ERROR` (array `message`) comes from the existing `ValidationExceptionFilter`; `401` comes from `JwtAuthGuard` (`UnauthorizedException`, Nest default body).

| errorCode | HTTP | Trigger |
|-----------|------|---------|
| UNSUPPORTED_VIDEO_FORMAT | 415 | Initiate with `mime_type` / extension outside the allowlist (`video/mp4` `.mp4` `.m4v`, `video/webm` `.webm`) or mismatched pair |
| VIDEO_TOO_LARGE | 422 | Initiate with `size` > 10 GiB; or complete when the assembled `ContentLength` > 10 GiB (video → `failed` / `UPLOAD_REJECTED`, object deleted) |
| VIDEO_SIZE_MISMATCH | 422 | Complete when the assembled `ContentLength` ≠ declared `size` (video → `failed` / `UPLOAD_REJECTED`, object deleted) |
| VIDEO_NOT_FOUND | 404 | `:shortId` malformed, unknown, or not owned by the caller's channel |
| UPLOAD_NOT_IN_PROGRESS | 409 | Part URLs / list parts when `processing_status` ≠ `uploading`; complete when `processing_status` = `failed` |
| INVALID_UPLOAD_PARTS | 422 | `part_number` > `part_count`; complete part set ≠ {1..`part_count`}; storage rejects parts (`InvalidPart`, `InvalidPartOrder`, `EntityTooSmall`) |
| UPLOAD_SESSION_EXPIRED | 410 | Storage reports `NoSuchUpload` (lifecycle abort after 24h) and no assembled object exists |
| PROCESSING_QUEUE_UNAVAILABLE | 503 | Complete could not enqueue the processing job; video stays `uploading`, retry is safe |
| VIDEO_NOT_READY | 409 | Playback/download URL requested while `processing_status` ≠ `ready` |

**`failure_reason` codes** (persisted on the video, not HTTP errors — phase-03-upload-processing/TD-11):

| failure_reason | Set by | Trigger |
|----------------|--------|---------|
| UPLOAD_REJECTED | API (complete) | `HeadObject` size check fails (`VIDEO_TOO_LARGE` / `VIDEO_SIZE_MISMATCH`) |
| UNSUPPORTED_FORMAT | Worker | ffprobe: no video stream, container outside MP4/WebM, video codec ∉ {`h264`, `vp8`, `vp9`, `av1`} or audio codec ∉ {`aac`, `mp3`, `opus`, `vorbis`} (phase-03-upload-processing/TD-14, TD-06) |
| SOURCE_MISSING | Worker | `HeadObject` on `original_object_key` throws `NotFound` |
| PROCESSING_FAILED | Worker | Any other error after the final attempt (3 attempts, exponential backoff) |

### Events/Messages

#### video-processing / process

BullMQ queue `video-processing`, job name `process` (phase-03-upload-processing/TD-07 Option A — BullMQ + Redis via `@nestjs/bullmq`). Backend-only: the frontend observes the outcome by polling `GET /videos/:shortId` (phase-03-upload-processing/TD-12).

**Payload:**

```json
{ "videoId": "uuid" }
```

**Job options** (per job, set by the producer):

```json
{
  "jobId": "<videoId>",
  "attempts": 3,
  "backoff": { "type": "exponential", "delay": 1000 },
  "removeOnComplete": true,
  "removeOnFail": { "age": 86400, "count": 100 }
}
```

`jobId` = video `id` (uuid — contains no `:` and is not purely numeric, as BullMQ requires); `queue.add` with an existing `jobId` is a no-op, so retried completes never create duplicate jobs while the job exists. After `removeOnComplete` drops the job, duplicates are prevented by complete's state gate (`processing` / `ready` → idempotent replay, no enqueue).

**Producer:** `VideoProcessingQueue` provider in the API process (`@InjectQueue('video-processing')`), called by `VideosService` from `POST /videos/:shortId/upload/complete` (per phase-03-upload-processing/TD-07).
**Consumer:** `VideoProcessingConsumer` (`@Processor('video-processing')`, extends `WorkerHost`), registered **only** in the worker module loaded by the separate worker entrypoint / `video-worker` Compose service, so the API process never consumes jobs (per phase-03-upload-processing/TD-08 Option A). Concurrency: BullMQ default (1) per worker process.
**Trigger:** complete passed the `HeadObject` size re-check (step 3). **Ordering:** the job is enqueued **before** the `uploading → processing` update; an enqueue failure returns 503 and leaves the video `uploading` (retry-safe), never stuck in `processing` without a job.
**Delivery semantics:** at-least-once (per phase-03-upload-processing/TD-07) — the consumer is idempotent.

**Consumer flow** (`process(job)`, phase-03-upload-processing/TD-09 Option A — spawn `ffprobe`/`ffmpeg`, presigned internal GET over Range):

1. Load the video by `job.data.videoId`. Not found, or `processing_status` ∈ {`ready`, `failed`} → return (idempotent no-op). `uploading` or `processing` → continue.
2. `HeadObject` on `original_object_key` (internal client). `NotFound` → conditional update to `failed` / `SOURCE_MISSING`, then `throw new UnrecoverableError(...)` (no retries).
3. Presign a `GetObject` URL on the **internal** client (`STORAGE_ENDPOINT`, Compose service name; `expiresIn: 3600`) — the file is never downloaded whole; ffprobe/ffmpeg read it over HTTP Range.
4. Spawn `ffprobe -v error -print_format json -show_format -show_streams <url>` (`child_process.spawn`, args array, no shell; 60 s timeout → kill → retryable error).
5. **Compatibility gate** (phase-03-upload-processing/TD-06, TD-14): `format.format_name` must include `mp4` or `webm`; at least one video stream with `codec_name` ∈ {`h264`, `vp8`, `vp9`, `av1`}; first audio stream (if any) `codec_name` ∈ {`aac`, `mp3`, `opus`, `vorbis`}; `format.duration` > 0. Failure → conditional update to `failed` / `UNSUPPORTED_FORMAT`, then `throw new UnrecoverableError(...)`.
6. **Thumbnail:** seek time `t = clamp(duration_seconds × 0.1, 0, max(duration_seconds − 0.1, 0))`; spawn `ffmpeg -ss <t> -i <url> -frames:v 1 -vf scale='min(1280,iw)':-2 -f image2 -c:v mjpeg -q:v 3 pipe:1` (120 s timeout), collect stdout into a JPEG buffer; `PutObject` to `STORAGE_THUMBNAILS_BUCKET`, key `{shortId}/{random-or-hash}.jpg`, `ContentType: image/jpeg`, `CacheControl: public, max-age=31536000, immutable` (phase-03-upload-processing/TD-15).
7. Conditional update (`WHERE processing_status IN ('uploading','processing')`): `duration_seconds`, `width`, `height`, `video_codec`, `audio_codec` (null when no audio stream), `thumbnail_object_key`, `processed_at = now()`, `processing_status = 'ready'`, `failure_reason = null`.

Any other thrown error (spawn failure, timeout, storage/network error) is retryable and consumes an attempt.

**Final-failure handling** (`@OnWorkerEvent('failed')`): fires on every failed attempt — act only when `job.attemptsMade >= (job.opts.attempts ?? 1)` and the error is not an `UnrecoverableError` (those already set their specific `failure_reason` in steps 2/5). Then conditional update (`WHERE processing_status IN ('uploading','processing')`) to `failed` / `PROCESSING_FAILED`. The source object is kept (diagnosis; cleanup is a future task, phase-03-upload-processing/TD-11).

**Broker connection:** BullMQ root config via `BullModule.forRootAsync` with the project's `registerAs` + `ConfigType` pattern; connection passed as `{ host, port }` from the new `queue.config.ts` (`registerAs('queue')`) reading `REDIS_HOST` (= `redis`, the Compose service name, never `localhost`) and `REDIS_PORT` (= `6379`), both required in the Joi schema and listed in `.env.example` — a direct consequence of phase-03-upload-processing/TD-07 Option A. BullMQ creates its own connections (no manual ioredis instance → no `maxRetriesPerRequest` pitfall).

---

## Dependency Map

```
SI-03.1 (root — Redis + QueueModule)
└── SI-03.5 — depends on SI-03.1 (producer precisa do QueueModule/Redis)
    └── SI-03.6 — also depends on SI-03.3, SI-03.4 (VideosModule importa o producer)
SI-03.2 (root — SeaweedFS + storage-init)
└── SI-03.3 — depends on SI-03.2 (buckets, CORS, lifecycle e credenciais existem)
    └── SI-03.6 — (ver acima)
SI-03.4 (root — entidade Video + migration)
└── SI-03.6 — (ver acima)
SI-03.6 — VideosService: initiate + consulta do dono
├── SI-03.7 — depends on SI-03.6 (sessão de upload, VideoLifecycleService)
│   ├── SI-03.9 — depends on SI-03.7 (controller: endpoints de upload)
│   │   └── SI-03.10 — also depends on SI-03.8 (controller: consulta + URLs de mídia)
│   └── SI-03.12 — also depends on SI-03.11 (consumer usa VideoLifecycleService + MediaProbeService)
│       └── SI-03.13 — depends on SI-03.12 (WorkerModule + video-worker)
└── SI-03.8 — depends on SI-03.6 (URLs de streaming/download)
    └── SI-03.10 — (ver acima)
SI-03.11 (root — ffmpeg na imagem + MediaProbeService)
└── SI-03.12 — (ver acima)
SI-03.14 — depends on SI-03.10 + SI-03.13 (E2E do pipeline precisa de todas as rotas e do WorkerModule)
SI-03.15 — depends on SI-03.13 + SI-03.14 (documenta Compose, scripts e padrão de testes finais)
```

---

## Deliverables

- [ ] SI-03.1 — Infra: Redis + configuração raiz da fila
- [ ] SI-03.2 — Infra: SeaweedFS + provisionamento dos buckets (storage-init)
- [ ] SI-03.3 — StorageService com clientes S3 interno e público
- [ ] SI-03.4 — Entidade Video + migration da tabela videos + gerador de short ID
- [ ] SI-03.5 — Producer da fila video-processing
- [ ] SI-03.6 — VideosService: iniciar upload + consulta do dono + serialização
- [ ] SI-03.7 — Sessão de upload: URLs de parts, parts enviadas e complete (enfileirar → processing)
- [ ] SI-03.8 — URLs de mídia: streaming e download
- [ ] SI-03.9 — VideosController: endpoints de upload
- [ ] SI-03.10 — VideosController: consulta do vídeo e URLs de mídia
- [ ] SI-03.11 — MediaProbeService: ffprobe, gate de compatibilidade e thumbnail via ffmpeg
- [ ] SI-03.12 — VideoProcessingConsumer: metadados, thumbnail e falhas
- [ ] SI-03.13 — Infra: entrypoint do worker + serviço video-worker
- [ ] SI-03.14 — E2E do pipeline: upload → processamento → ready
- [ ] SI-03.15 — Documentação: CLAUDE.md, contrato de storage em produção e guia de testes

**Full test suites:**

- [ ] Backend unit + integration tests pass (`cd nestjs-project && docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] E2E tests pass (`cd nestjs-project && docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type/compilation checks pass (`cd nestjs-project && docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Lint passes (`cd nestjs-project && docker compose exec nestjs-api npm run lint`)
- [ ] Project builds successfully, API and worker (`cd nestjs-project && docker compose exec nestjs-api npm run build`, plus `npx nest build --path tsconfig.worker.json`)
