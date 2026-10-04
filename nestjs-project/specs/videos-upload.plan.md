---
subproject: backend
runner: jest+supertest
scope: phase-03-upload-processing
si: SI-03.9
target_file: test/videos-upload.e2e-spec.ts
---

# Videos upload endpoints — Test Plan

## Application Overview

O `VideosController` expõe o protocolo de upload multipart direto ao storage em quatro rotas autenticadas e isentas do rate limit de auth (`@SkipThrottle()` na classe): `POST /videos` pré-cadastra o vídeo como rascunho (`uploading`/`draft`) e abre o multipart upload no SeaweedFS, devolvendo `part_size`/`part_count`; `POST /videos/:shortId/upload/part-urls` presigna URLs de `UploadPart` no endpoint público; `GET /videos/:shortId/upload/parts` lista as parts já recebidas (retomada); `POST /videos/:shortId/upload/complete` monta o objeto, re-checa o tamanho, enfileira o job `process` e só então move o vídeo para `processing`. Corpos de request/response são snake_case; erros seguem o envelope `{ statusCode, error, message }`; rotas com `:shortId` respondem `404 VIDEO_NOT_FOUND` para não-donos. As quatro operações são documentadas no OpenAPI com todos os status de erro referenciando `ApiErrorEnvelope`.

## Test Scenarios

### 1. POST /videos — iniciar upload

**Setup:** `Test.createTestingModule({ imports: [AppModule] })` com `storageConfig` sobrescrito para `publicEndpoint = STORAGE_ENDPOINT` (o processo de teste roda no container); reproduzir o `main.ts` (`ValidationPipe({ whitelist, forbidNonWhitelisted, transform })` + `DomainExceptionFilter` + `ValidationExceptionFilter`); `beforeEach` → `cleanAllTables(dataSource)`, `obliterate` da fila `video-processing`, remoção dos objetos do bucket de vídeos e `ThrottlerStorage.storage.clear()`; usuário autenticado via register + confirmação (token capturado do `MailService`) + login; `afterAll` → `app.close()`.

#### 1.1. initiate-without-token-returns-401

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-10-04T13:54:02Z

**Steps:**
  1. POST /videos sem header `Authorization`, com body `{ "file_name": "clip.mp4", "mime_type": "video/mp4", "size": 1048576 }`
    - expect: status `401`
    - expect: nenhuma linha criada na tabela `videos`

#### 1.2. initiate-creates-uploading-draft

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-10-04T13:54:02Z

**Steps:**
  1. POST /videos autenticado com body `{ "file_name": "clip.mp4", "mime_type": "video/mp4", "size": 1048576 }`
    - expect: status `201`
    - expect: `video.processing_status = "uploading"` e `video.publication_status = "draft"`
    - expect: `video.title = "clip"` e `video.short_id` casa `^[A-Za-z0-9_-]{11}$`
    - expect: `upload.part_size = 67108864` e `upload.part_count = 1`
    - expect: `video` não contém `id`, `channel_id`, `original_object_key`, `upload_id` nem `thumbnail_object_key`

#### 1.3. initiate-rejects-too-large-and-unsupported-format

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-10-04T13:54:02Z

**Steps:**
  1. POST /videos autenticado com `{ "file_name": "clip.mp4", "mime_type": "video/mp4", "size": 10737418241 }`
    - expect: status `422` com `error: "VIDEO_TOO_LARGE"` no envelope `{ statusCode, error, message }`
    - expect: nenhuma linha criada na tabela `videos`
  2. POST /videos autenticado com `{ "file_name": "clip.mov", "mime_type": "video/quicktime", "size": 1048576 }`
    - expect: status `415` com `error: "UNSUPPORTED_VIDEO_FORMAT"`
    - expect: nenhuma linha criada na tabela `videos`

#### 1.4. initiate-validation-wiring

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-10-04T13:54:02Z

**Steps:**
  1. POST /videos autenticado com `{ "file_name": "clip.mp4", "mime_type": "video/mp4" }` (sem `size`)
    - expect: status `400` com `error: "VALIDATION_ERROR"` e `message` em array

### 2. POST /videos/:shortId/upload/part-urls — presign de parts

**Setup:** mesmo bootstrap do grupo 1; cada cenário inicia um upload de `clip.mp4` / `video/mp4` / `1048576` pelo dono para obter o `short_id`.

#### 2.1. part-urls-validation-wiring

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-10-04T13:54:02Z

**Steps:**
  1. POST /videos/:shortId/upload/part-urls como dono com `{ "part_numbers": [] }`
    - expect: status `400` com `error: "VALIDATION_ERROR"`

#### 2.2. part-urls-of-another-users-video-returns-404

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-10-04T13:54:02Z

**Steps:**
  1. Um segundo usuário autenticado chama POST /videos/:shortId/upload/part-urls com `{ "part_numbers": [1] }` para o vídeo do primeiro usuário
    - expect: status `404` com `error: "VIDEO_NOT_FOUND"`
  2. O dono chama a mesma rota com `{ "part_numbers": [1] }`
    - expect: status `200` com `parts[0].part_number = 1`, `parts[0].url` presignada e `expires_at` ISO-8601

### 3. Upload das parts e POST /videos/:shortId/upload/complete

**Setup:** mesmo bootstrap do grupo 1; o dono inicia o upload com `size` igual ao tamanho real de um buffer de teste (≤ 64 MiB, 1 part) e envia os bytes com `PUT` na URL presignada, guardando o header `ETag` da resposta.

#### 3.1. complete-moves-video-to-processing

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-10-04T13:54:02Z

**Steps:**
  1. GET /videos/:shortId/upload/parts como dono após o `PUT`
    - expect: status `200` com `part_size = 67108864`, `part_count = 1` e `parts` contendo `{ part_number: 1, etag, size }`
  2. POST /videos/:shortId/upload/complete como dono com `{ "parts": [{ "part_number": 1, "etag": "<ETag do PUT>" }] }`
    - expect: status `200` com `processing_status = "processing"` (ou `"ready"` se um worker já tiver avançado)
    - expect: a fila `video-processing` contém exatamente um job `process` cujo id é o `id` do vídeo

### 4. Rate limit e documentação OpenAPI

**Setup:** mesmo bootstrap do grupo 1; o cenário de documentação gera o documento com `SwaggerModule.createDocument(app, buildSwaggerConfig())`.

#### 4.1. video-endpoints-are-not-throttled

**Covers AC:** #7
**Source:** auto
**Last sync:** 2026-10-04T13:54:02Z

**Steps:**
  1. Como dono, faz 11 requisições seguidas a GET /videos/:shortId/upload/parts dentro do mesmo minuto
    - expect: nenhuma resposta tem status `429`
    - expect: todas respondem `200`

#### 4.2. openapi-documents-upload-operations

**Covers AC:** #8
**Source:** auto
**Last sync:** 2026-10-04T13:54:02Z

**Steps:**
  1. Gera o documento OpenAPI da aplicação
    - expect: `paths['/videos'].post` documenta `201`, `400`, `401`, `415` e `422`
    - expect: `paths['/videos/{shortId}/upload/part-urls'].post` documenta `200`, `400`, `401`, `404`, `409` e `422`
    - expect: `paths['/videos/{shortId}/upload/parts'].get` documenta `200`, `401`, `404`, `409` e `410`
    - expect: `paths['/videos/{shortId}/upload/complete'].post` documenta `200`, `400`, `401`, `404`, `409`, `410`, `422` e `503`
    - expect: as respostas de erro referenciam o schema `ApiErrorEnvelope`
