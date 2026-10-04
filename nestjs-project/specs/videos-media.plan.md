---
subproject: backend
runner: jest+supertest
scope: phase-03-upload-processing
si: SI-03.10
target_file: test/videos-media.e2e-spec.ts
---

# Videos status & media URL endpoints — Test Plan

## Application Overview

O `VideosController` expõe ao dono a consulta do vídeo e as URLs de mídia: `GET /videos/:shortId` devolve a `VideoResponse` usada no polling do processamento (`processing_status`, `failure_reason`, `thumbnail_url`); `GET /videos/:shortId/playback-url` emite uma URL presignada de `GetObject` (TTL 4 h) para streaming com Range nativo do storage; `GET /videos/:shortId/download-url` emite uma URL presignada (TTL 1 h) com `ResponseContentDisposition` de attachment. As três rotas exigem autenticação, respondem `404 VIDEO_NOT_FOUND` para `shortId` malformado, inexistente ou de outro canal (sem revelar existência), e as URLs de mídia exigem vídeo `ready` (`409 VIDEO_NOT_READY` caso contrário). As operações são documentadas no OpenAPI com os status de erro referenciando `ApiErrorEnvelope`.

## Test Scenarios

### 1. GET /videos/:shortId — consulta do dono

**Setup:** `Test.createTestingModule({ imports: [AppModule] })` com `storageConfig` sobrescrito para `publicEndpoint = STORAGE_ENDPOINT` (o processo de teste roda no container); reproduzir o `main.ts` (`ValidationPipe({ whitelist, forbidNonWhitelisted, transform })` + `DomainExceptionFilter` + `ValidationExceptionFilter`); `beforeEach` → `cleanAllTables(dataSource)`, `obliterate` da fila `video-processing` e remoção dos objetos dos buckets de vídeos e thumbnails; usuários autenticados via register + confirmação (token capturado do `MailService`) + login; o dono inicia um upload de `clip.mp4` / `video/mp4` / `1048576` para obter o `short_id`; `afterAll` → `app.close()`.

#### 1.1. get-video-as-owner-returns-video-response

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-10-04T13:54:02Z

**Steps:**
  1. GET /videos/:shortId como dono
    - expect: status `200`
    - expect: corpo contém `short_id`, `processing_status = "uploading"`, `failure_reason = null` e `thumbnail_url = null`
    - expect: corpo não contém `id`, `channel_id`, `original_object_key`, `upload_id` nem `thumbnail_object_key`

#### 1.2. get-video-not-owned-unknown-or-malformed-returns-404

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-10-04T13:54:02Z

**Steps:**
  1. GET /videos/:shortId com o `short_id` do dono, autenticado como um segundo usuário
    - expect: status `404` com `error: "VIDEO_NOT_FOUND"`
  2. GET /videos/:shortId com um `short_id` bem-formado (11 caracteres base64url) que não existe, autenticado como dono
    - expect: status `404` com `error: "VIDEO_NOT_FOUND"`
  3. GET /videos/abc autenticado como dono
    - expect: status `404` com `error: "VIDEO_NOT_FOUND"` (não `400`)

#### 1.3. get-video-anonymous-returns-401

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-10-04T13:54:02Z

**Steps:**
  1. GET /videos/:shortId sem header `Authorization`
    - expect: status `401`

### 2. URLs de mídia — playback e download

**Setup:** mesmo bootstrap do grupo 1; o dono envia os bytes de um buffer de teste por `PUT` na URL presignada de part e chama `POST /videos/:shortId/upload/complete` (vídeo fica `processing`, sem worker na suíte); para o estado `ready`, o vídeo é avançado com `VideoLifecycleService.markReady(id, metadata)` obtido do módulo de teste.

#### 2.1. playback-url-ready-vs-processing

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-10-04T13:54:02Z

**Steps:**
  1. GET /videos/:shortId/playback-url como dono com o vídeo em `processing`
    - expect: status `409` com `error: "VIDEO_NOT_READY"`
  2. Avança o vídeo para `ready` e repete GET /videos/:shortId/playback-url
    - expect: status `200` com `url` (string) e `expires_at` ISO-8601
    - expect: `GET` na `url` com `Range: bytes=0-1023` responde `206`

#### 2.2. download-url-forces-attachment

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-10-04T13:54:02Z

**Steps:**
  1. Com o vídeo `ready`, GET /videos/:shortId/download-url como dono
    - expect: status `200` com `url` e `expires_at` ISO-8601
  2. `GET` na `url` retornada
    - expect: status `200`
    - expect: header `Content-Disposition` começa com `attachment` e contém `filename*=UTF-8''clip.mp4`

### 3. Documentação OpenAPI

**Setup:** mesmo bootstrap do grupo 1; documento gerado com `SwaggerModule.createDocument(app, buildSwaggerConfig())`.

#### 3.1. openapi-documents-media-operations

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-10-04T13:54:02Z

**Steps:**
  1. Gera o documento OpenAPI da aplicação
    - expect: `paths['/videos/{shortId}'].get` documenta `200`, `401` e `404`
    - expect: `paths['/videos/{shortId}/playback-url'].get` documenta `200`, `401`, `404` e `409`
    - expect: `paths['/videos/{shortId}/download-url'].get` documenta `200`, `401`, `404` e `409`
    - expect: as respostas de erro referenciam o schema `ApiErrorEnvelope`
