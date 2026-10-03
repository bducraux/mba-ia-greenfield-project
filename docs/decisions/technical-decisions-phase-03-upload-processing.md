---
scope_type: phase
related_phases: [3]
status: pending
date: 2026-10-03
scope_description: "Upload and processing of videos: object storage, resumable 10GB upload protocol, background job queue and worker topology, FFmpeg metadata/thumbnail extraction, video lifecycle states, unique short URLs, and media delivery (streaming + download) under the strict-BFF model."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — primary subproject. Receives the object-storage integration, the upload-session endpoints (initiate / sign / complete), the `videos` domain (entity, lifecycle, short ID), the job queue producer, the **Video Worker** process (FFmpeg) and the media-delivery endpoints (playback / download URLs). New infra services (S3-compatible storage, queue broker, worker) join `nestjs-project/compose.yaml`.
- `next-frontend/` — upload UI client (chunked, resumable, direct-to-storage), BFF Route Handlers that proxy the upload-session endpoints, processing-status display, and the E2E strategy for browser→storage traffic. Covered by TD-03, TD-12, TD-13 and the Cross-layer TDs (TD-02, TD-04, TD-05, TD-10, TD-11). The **video player UI** and **download button** are Phase 05 capabilities — this phase only delivers the URLs/contract they consume.

> Cross-doc anchors (already decided — do NOT reopen):
> - **Strict BFF:** `next-frontend-config-base/TD-03` — the browser never calls NestJS directly. That TD explicitly anticipated that "object storage URLs will need a separate mechanism anyway (presigned URLs from object storage, NOT the backend URL)". Browser→**storage** traffic is therefore compatible with the BFF model; browser→**NestJS** traffic is not.
> - **Auth:** custom `@nestjs/jwt` guards (`phase-02-auth/TD-02`); BFF attaches `Authorization: Bearer` via the iron-session helper with transparent refresh (`phase-02-auth-frontend/TD-02`, `TD-03`). Upload endpoints reuse this unchanged.
> - **Mutation pathway:** Route Handler POST + client `fetch` (`phase-02-auth-frontend/TD-05`).
> - **Error envelope:** `{ statusCode, error, message }` with domain codes (`phase-02-auth/TD-07`).
> - **Config:** `@nestjs/config` + namespaced `registerAs` + Joi (`phase-01/TD-01..03`). New namespaces (`storage`, `queue`) follow that pattern — not a TD.
> - **OpenAPI chain + MSW per domain:** `openapi-docs-nestjs/TD-01..03`, `next-frontend-openapi-typing/TD-01..05`, `next-frontend-msw-foundation/TD-01..04`.

> ⚠️ **Discrepancy flagged:** `.claude/skills/testing-guide-nestjs-project/references/external-systems.md` prescribes **local filesystem storage in dev/tests, S3 in prod**. That strategy is incompatible with presigned direct-to-storage uploads (TD-02 Option A) — a filesystem adapter cannot issue presigned multipart URLs. TD-01 decides this; if TD-01 Option A is chosen, the testing guide must be updated by `/plan-build`.

---

## TD-01: Object Storage Backend (dev/test vs production)

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** The architecture diagram names "S3 or MinIO". Two facts changed since it was drawn: **MinIO Community Edition stopped publishing official binaries/Docker images in Oct 2025 and entered maintenance mode in Dec 2025** (repo archived in early 2026), so `minio/minio:latest` is no longer a sound default. Also, the testing guide currently assumes a local-filesystem adapter in dev/tests, which rules out presigned URLs (see TD-02). The choice also sets the SDK: any S3-compatible backend is driven by `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`.

**Options:**

### Option A: S3 API everywhere — S3-compatible container in dev/test (SeaweedFS or Garage), AWS S3 (or any S3 provider) in prod
- A single `StorageService` built on `@aws-sdk/client-s3`. Dev/test use an S3-compatible container in `compose.yaml`; prod points to a real S3 endpoint. Only config changes (endpoint, credentials, `forcePathStyle`).
- **Pros:** Dev = prod protocol, so multipart, presigned URLs, CORS and Range GETs are tested for real. One code path, no adapter matrix. Integration tests use the real emulator, the same way Postgres and Mailpit are already used.
- **Cons:** Adds one container. The emulator choice needs care: SeaweedFS (Apache-2.0, single-container `weed server -s3`) is the lightest. Garage needs a layout/bootstrap step. MinIO is only available through third-party images (e.g., Chainguard). Bucket-CORS and presigned-multipart support must be checked against the chosen emulator.

### Option B: Storage abstraction with local-filesystem adapter (dev/test) + S3 adapter (prod)
- `StorageService` interface with two implementations, as the current testing guide prescribes.
- **Pros:** No extra container. Trivial unit/integration tests on `os.tmpdir()`.
- **Cons:** The filesystem adapter cannot issue presigned URLs, so uploads and streaming must go through the API in dev, and **the dev code path diverges from prod** exactly where Phase 03's risk lives (10GB, resumable, Range). Two adapters to maintain, and the S3 one is untested locally.

### Option C: LocalStack S3 in dev/test, AWS S3 in prod
- AWS emulator container exposing the S3 API.
- **Pros:** Very high AWS API fidelity, including presign and multipart.
- **Cons:** Heavy image for a single service. The community edition's licensing and feature tiers have been shifting. AWS-centric, which adds nothing over Option A when prod may not be AWS.

**Recommendation:** **Option A (S3 API everywhere, SeaweedFS in dev/test)** — every later TD (direct upload, presigned delivery, worker reading over HTTP Range) relies on S3 semantics, and only Option A tests those semantics locally. SeaweedFS avoids the MinIO end-of-life problem with a single container. If its bucket-CORS support turns out insufficient during implementation, Garage is the fallback, with no code change. Choosing A replaces the "local filesystem" strategy in the NestJS testing guide.

**Decision:** A (S3 API everywhere — SeaweedFS in dev/test)
**Libraries:** @aws-sdk/client-s3

**Note:** Chosen over MinIO, which the challenge statement and `CLAUDE.md` mention as the example S3 store. Evidence gathered on 2026-10-03 before deciding: `docker pull minio/minio:latest` (and pinned tags `RELEASE.2025-04-22T22-12-26Z`, `RELEASE.2024-12-18T13-15-44Z`) fails with "repository does not exist"; `quay.io/minio/minio` returns 401; `bitnami/minio` is no longer published. The only working MinIO build found was Chainguard's (`cgr.dev/chainguard/minio`), which booted and created a bucket in a smoke test, but its free tier ships only a rolling `latest` tag, so it cannot be pinned by version. SeaweedFS publishes versioned images and speaks the S3 API the rest of the phase relies on. Because every consumer talks S3 (TD-02, TD-04, TD-05, TD-09), swapping SeaweedFS for MinIO or AWS S3 is a configuration change (endpoint + credentials), not a code change.

---

## TD-02: Large-File Upload Protocol (10GB, resumable)

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance", "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload"

**Context:** Files up to 10GB must upload "without impacting system performance" and must be **resumable after a connection failure** (project-plan §4). Under the strict BFF, any protocol that streams bytes through the API means **two Node hops** (browser → Next Route Handler → NestJS → storage) for 10GB. The protocol also defines the moment the draft video row is created ("ao iniciar o upload") and how the backend learns the upload finished, which is what triggers processing. Both sides implement the handshake.

**Options:**

### Option A: S3 Multipart Upload with presigned part URLs — browser → storage direct
- `POST /videos/uploads` (via BFF) creates the draft `Video` row, calls `CreateMultipartUpload` and returns `{ videoId, uploadId, key, partSize }`. The client asks the API (via BFF) to presign batches of `UploadPart` URLs, PUTs parts **directly to storage**, then calls `POST /videos/:id/upload/complete` with the ETags. The API runs `CompleteMultipartUpload` and enqueues processing.
- **Pros:** Zero video bytes cross Next or Nest, so the API stays responsive under any number of uploads. Resumable by design: `ListParts` tells the client which parts already exist. Parallel parts give better throughput. Standard S3 semantics: max 10,000 parts and ≥5MiB per part; a 10GB file at 64MiB parts is ~160 parts. Already anticipated by `next-frontend-config-base/TD-03`.
- **Cons:** Requires bucket CORS (allow `PUT` from the FE origin, `ExposeHeaders: ETag`) and a browser-reachable storage endpoint (TD-04). Abandoned multipart uploads hold storage until aborted, which needs an `AbortIncompleteMultipartUpload` lifecycle rule or a cleanup job. More endpoints (initiate / sign / complete / abort).

### Option B: tus protocol served by NestJS (`@tus/server` + `@tus/s3-store`)
- The NestJS API hosts a tus endpoint. The client uses `tus-js-client` (or Uppy's tus plugin), and the server streams chunks into S3 multipart.
- **Pros:** Open resumable-upload standard with mature clients. Resume logic lives in the protocol (`HEAD` gives the offset). The API sees every byte, so it can validate and abort early.
- **Cons:** **All 10GB flow through Node**, and under the strict BFF **twice** (Next Route Handler + Nest), which is exactly the "performance impact" the capability forbids. Proxying a streaming tus `PATCH` through a Next Route Handler is non-trivial (request-body streaming and timeouts). The alternative is to expose Nest to the browser, which breaks `config-base/TD-03`.

### Option C: Custom chunked upload via BFF → Nest → S3 multipart
- The client splits the file into chunks and POSTs each one to `/api/videos/:id/chunks/:n`. The BFF forwards to Nest, and Nest calls `UploadPart`.
- **Pros:** Stays inside the BFF model with no CORS and no public storage endpoint. Simple mental model.
- **Cons:** Same double-hop byte traffic as Option B, without a standard protocol. Hand-rolled resume and offset bookkeeping. Request-size limits on both servers must be raised. Strictly worse than A on performance and worse than B on standards.

**Recommendation:** **Option A (S3 multipart with presigned part URLs, direct to storage)** — it is the only option where video bytes never touch the application tier. That is the literal requirement, and it is the mechanism `config-base/TD-03` already reserved for media. Proposed parameters for `/plan-build`: `partSize` = 64MiB, returned by the API (single source; the client never hard-codes it). Max file size = 10 GiB, enforced at initiate from the declared `size` and re-checked at complete via `HeadObject`. Presigned part URL TTL ≈ 1h, re-signable on demand. Bucket lifecycle rule aborts incomplete multipart uploads after 24h. Depends on TD-01 (S3 semantics) and TD-04 (public endpoint + CORS).

**Decision:** A (S3 Multipart Upload with presigned part URLs — browser → storage direct)
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

**Revisions:**
- 2026-10-03 — Initiate payload fixed as `fileName`, `mimeType`, `size` (no title field). The draft row is created at initiate with `title` = file name without extension (truncated to 100 chars), `description` null, `processing_status` = `uploading`, `publication_status` = `draft`, `short_id` (TD-10), `original_object_key`, `mime_type`, `size_bytes`, `upload_id`; owner is the authenticated user's channel (`channel_id` FK → `channels`, one channel per user per phase-02-auth/TD-10). Rationale: AMB-3 resolution — title/description editing belongs to Phase 04.

---

## TD-03: Frontend Upload Client

**Scope:** Frontend

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** Under TD-02 Option A, the browser must slice the `File`, PUT parts in parallel with retry, report progress, collect ETags, and resume (including after a page reload) by asking the API which parts exist. This logic is correctness-critical and has well-known edge cases: retrying on 5xx and network errors, expired presigned URLs, concurrency limits, and progress on a per-part XHR. The UI itself is built with the project's shadcn primitives either way.

**Options:**

### Option A: Uppy headless (`@uppy/core` + `@uppy/aws-s3`, no Dashboard)
- Uppy's S3 plugin handles multipart: chunking, concurrency (`limit`), retries and progress. In the current major, custom backends plug in through a single `signRequest({ method, key, uploadId, partNumber })` callback that hits our BFF. `@uppy/golden-retriever` can restore uploads after a reload.
- **Pros:** Battle-tested multipart engine with retries and resume, maintained by Transloadit. Headless use keeps the UI in shadcn/Tailwind (no Uppy CSS). `getChunkSize` lets the client follow the API's `partSize`.
- **Cons:** Two or three new dependencies (~tens of KB gzip). In the current major, **Uppy performs the S3 calls itself** (Create/Complete via presigned requests). Our flow wants the API to own initiate and complete (draft creation, enqueue), so either the backend presigns Create/Complete too and the client then calls an explicit "complete" notification endpoint, or the integration must be adapted. Real integration work, and the release's API changed recently (six callbacks → `signRequest`).

### Option B: Hand-rolled uploader (`lib/upload/multipart-uploader.ts`)
- About 200 LOC: `File.slice` → concurrency pool (e.g., 4) → `XMLHttpRequest` PUT per part (for `upload.onprogress`) → retry with backoff → re-sign on 403/expired → ETag collection. Resume state (`videoId`, `uploadId`) stored in `localStorage`. Reconciliation via `ListParts` through the BFF.
- **Pros:** Zero dependencies. The flow matches TD-02's API-owned initiate/sign/complete one-to-one. Fully testable in Vitest. No library-major churn.
- **Cons:** We own every edge case: retry policy, URL expiry, `File` re-selection after reload (browsers cannot re-open a file without user action, so resume always needs the user to pick the same file again), abort, and memory (slicing is lazy, so this is fine). Higher risk of subtle bugs in the most critical flow of the phase.

### Option C: `@aws-sdk/lib-storage` (`Upload`) in the browser
- AWS SDK's managed multipart uploader running client-side.
- **Pros:** Official, robust multipart engine.
- **Cons:** Needs **S3 credentials in the browser** (STS temporary credentials at minimum). That is a much larger trust surface than presigned URLs and an STS service the S3 emulator may not provide. It also adds a large SDK to the client bundle. Listed only to rule it out.

**Recommendation:** **Option B (hand-rolled uploader)**, with **Option A as the fallback** if the team prefers a library. TD-02 makes the API the owner of initiate/complete, because that is where the draft is created and processing is enqueued. Uppy's current major moved toward the client performing S3 calls itself, which fights that ownership. The resume edge case that matters most (the user must re-pick the file after a reload) is a browser constraint that Uppy does not remove either. The hand-rolled module is small, has no dependencies, and its retry and re-sign behavior can be pinned down in Vitest.

**Decision:** Out of scope — Phase 03 delivers backend only (UI deferred); revisit in the Phase 03 frontend slice

---

## TD-04: Storage Endpoint Topology (internal vs browser-facing URLs)

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Serviço de armazenamento de arquivos (vídeos e thumbnails)", "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance", "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** SigV4 presigned URLs embed the **host** in the signature. Inside Docker, the API and the worker reach storage at the Compose service name (e.g., `http://seaweedfs:8333`, per the project's Docker-networking rule), but the browser can only reach a host-exposed address (`http://localhost:8333` in dev, a public domain in prod). A URL signed for `seaweedfs:8333` is unusable in the browser, and rewriting the host breaks the signature. This determines the canonical env-key set (Joi schema + `compose.yaml` + `.env.example`) and the CORS contract with the FE origin.

**Options:**

### Option A: Two endpoints — `STORAGE_ENDPOINT` (internal) + `STORAGE_PUBLIC_ENDPOINT` (browser-facing), bucket CORS for the FE origin
- Server-side operations (Create/Complete multipart, HeadObject, worker reads, thumbnail writes) use an S3 client on the internal endpoint. **Presigning** uses a second client configured with the public endpoint. The bucket's CORS allows the FE origin (`http://localhost:3001` in dev).
- **Pros:** Works the same in dev and prod (in prod, both keys can point to the same S3 URL). No extra container. Explicit and grep-able.
- **Cons:** Two S3 client instances and two env keys. CORS must be configured on the bucket (a bootstrap step in dev). The browser sees the storage host, which is acceptable because the URLs are presigned and temporary.

### Option B: Single hostname reachable from both sides (e.g., `host.docker.internal:8333`)
- Containers and browser use the same URL by routing containers through the host gateway (as `next-frontend/compose.yaml` already does for the API).
- **Pros:** One env key and one S3 client.
- **Cons:** Containers talk to storage through the host instead of the Compose network, which contradicts the project's Docker-networking rule ("always use the Compose service name"). `host.docker.internal` behaves differently across platforms (WSL2, Linux, macOS). It does not translate to prod topology.

### Option C: Reverse proxy (Caddy/nginx) exposing FE and storage under one origin (`/storage/*`)
- A proxy container serves the Next app and forwards `/storage/*` to the S3 service. Presigning uses the proxy origin.
- **Pros:** Same origin, so no CORS. Storage is never exposed directly.
- **Cons:** New infrastructure piece and a change to dev topology (FE and BE stacks are currently separate Compose projects). Path-style signing through a path-prefix proxy needs careful `Host` and path preservation. It solves CORS, which Option A already solves with one bucket config.

**Recommendation:** **Option A (internal + public endpoint, bucket CORS)** — it respects the project's Compose-service-name rule for container-to-container traffic, needs no new infrastructure, and collapses to a single URL in prod. Canonical new keys for `/plan-build`: `STORAGE_ENDPOINT`, `STORAGE_PUBLIC_ENDPOINT`, `STORAGE_REGION`, `STORAGE_ACCESS_KEY`, `STORAGE_SECRET_KEY`, `STORAGE_BUCKET`, `STORAGE_FORCE_PATH_STYLE`, plus `STORAGE_CORS_ORIGIN` (the FE origin).

**Decision:** A (Two endpoints — internal `STORAGE_ENDPOINT` + browser-facing `STORAGE_PUBLIC_ENDPOINT`, bucket CORS)
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

**Revisions:**
- 2026-10-03 — Canonical key list extended with `STORAGE_THUMBNAILS_BUCKET` (public-read thumbnails bucket); `STORAGE_BUCKET` is clarified as the private video bucket. Rationale: parameter added by TD-15 B (two-bucket topology), same option A.

---

## TD-05: Media Delivery Strategy (streaming, download, thumbnails)

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** Playback must start without downloading the whole file, which means HTTP Range requests, and users must be able to download the video. Under the strict BFF, the browser cannot hit NestJS, and proxying multi-GB Range traffic through Next + Nest repeats TD-02's double-hop problem. Thumbnails are small but appear in many listings (Phases 04/07), so cacheable, stable URLs matter for them. The chosen mechanism defines what the API returns (URL fields in the video DTO) and what the FE puts in `<video src>` and `<Image src>`. Depends on TD-04.

**Options:**

### Option A: Presigned GET URLs for everything (video, download, thumbnails)
- The video detail endpoint returns short-lived presigned URLs. Download uses a presigned GET with `ResponseContentDisposition=attachment; filename="…"`.
- **Pros:** Bucket stays fully private, and access control (drafts, future unlisted) is enforced at signing time. Storage serves Range natively. The download override is a standard S3 feature.
- **Cons:** **URLs expire**: seeking in a long video after expiry fails, so the video TTL must be generous (hours). Thumbnails get a new URL per response, which **defeats browser/`next/image` caching** in listing grids, and every listing response pays for N signatures.

### Option B: Public-read bucket with unguessable keys for everything
- Objects under keys like `videos/{shortId}/{random}`. The API returns stable public URLs.
- **Pros:** Stable, cacheable, CDN-friendly URLs with no expiry. Simplest delivery.
- **Cons:** Drafts and processing-stage files are publicly fetchable by anyone who obtains the key. Access can no longer be revoked (e.g., Phase 04 unpublishing) without moving objects. Download still needs a `Content-Disposition` mechanism (object metadata set at upload time).

### Option C: Hybrid — thumbnails public-read (stable URLs), video and download via presigned GET
- A `thumbnails/` prefix gets a public-read bucket policy. Original video objects stay private and are served via presigned GET (playback TTL ~6h; download TTL short, with an `attachment` override).
- **Pros:** Thumbnails are stable and cacheable for `next/image` and listings, and they are low-sensitivity. Videos keep signing-time access control for drafts and future visibility rules. Range streaming and download are served by storage, with zero bytes through Node.
- **Cons:** Two delivery mechanisms to document. A long TTL still lets a leaked video URL be reused within its window, which is acceptable for a platform where published videos are anonymous-watchable anyway.

### Option D: Range-proxy streaming through NestJS (and the BFF)
- `GET /videos/:id/stream` reads from S3 with the incoming `Range` and pipes the bytes. The BFF re-proxies.
- **Pros:** Full control on every byte (per-request authorization, view counting hooks).
- **Cons:** Every playback and download streams through two Node processes. That violates the "no performance impact" spirit and scales poorly. Listed for completeness.

**Recommendation:** **Option C (hybrid)** — thumbnails are displayed in volume across later phases and need stable URLs for caching, while video objects need signing-time control for drafts now and visibility later (Phase 04/05). Storage serves Range and `Content-Disposition` natively, so nothing heavy passes through Node. `<video src>` receives the presigned URL; MP4 Range playback works natively in browsers.

**Decision:** C (Hybrid — thumbnails public-read, video playback and download via presigned GET)
**Libraries:** @aws-sdk/s3-request-presigner

**Revisions:**
- 2026-10-03 — Phase 03 authorization for presigned playback/download: URLs are issued only to the authenticated owner of the video's channel; any other caller (authenticated or anonymous) gets 404 without revealing existence. Thumbnails stay public-read by design (TD-15). "O usuário" in the download capability means the owner. Third-party access depends on publication/visibility (Phase 04). Rationale: AMB-1 resolution — every Phase 03 video is a draft.

---

## TD-06: Playback Format — original file vs normalized rendition vs HLS

**Scope:** Backend

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** The plan's processing scope is **metadata extraction + thumbnail**, not transcoding. But "streaming without full download" depends on the file being browser-playable (container + codecs) and on Range-friendly layout. An MP4 with `moov` at the end still plays via Range in modern browsers, with an extra seek. Project-plan §4 also flags storage cost. This decides how heavy the worker is and how much storage each video uses.

**Options:**

### Option A: Serve the original upload — accept browser-playable formats only, gated by ffprobe
- Allowed containers/codecs: MP4/MOV (H.264/AAC), WebM (VP8/VP9/AV1, Opus/Vorbis). The client pre-checks MIME/extension. The worker's ffprobe marks the video `failed` with a domain error code if the codecs are unsupported.
- **Pros:** Lightest worker (seconds per video, no CPU-bound transcoding). 1× storage. Exactly the plan's processing scope. Download returns the user's original file.
- **Cons:** Users can upload a 10GB file only to have it rejected after probing (mitigated by the client pre-check). No bitrate adaptation, so slow connections stall on high-bitrate originals. Playback quality depends on what the user uploaded.

### Option B: Normalize to one MP4 rendition (H.264/AAC, `+faststart`) — remux when compatible, transcode otherwise
- The worker first tries `-c copy -movflags +faststart` (fast). It falls back to a full transcode for incompatible codecs. The rendition is stored next to the original (or replaces it).
- **Pros:** Accepts virtually any input. Guaranteed browser-compatible, fast-start playback.
- **Cons:** Transcoding a 10GB source is CPU-heavy (tens of minutes to hours) and needs scratch disk. Up to 2× storage if the original is kept. Goes beyond the plan's processing scope.

### Option C: HLS adaptive bitrate ladder (e.g., 360p/720p/1080p)
- The worker transcodes to several renditions plus `.m3u8` playlists. The FE needs `hls.js` on non-Safari browsers.
- **Pros:** YouTube-like adaptive playback. Best experience on poor networks.
- **Cons:** Heaviest compute and 2–3× storage. Adds a player library and a playlist-signing problem (every segment URL must be accessible, which complicates TD-05). Clearly beyond the plan's scope for this phase.

**Recommendation:** **Option A (original file + ffprobe compatibility gate)** — it matches the literal phase scope (metadata + thumbnail), keeps storage at 1× (§4 cost concern) and keeps the worker fast. The playback contract (a single MP4/WebM URL in `<video src>`) is the same contract Option B would produce, so upgrading to B later is a worker-only change with no FE or API break. HLS (C) is a separate future initiative.

**Decision:** A (Serve the original upload, gated by ffprobe compatibility check)

---

## TD-07: Background Job Queue Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The architecture diagram leaves "Message Queue" as **TBD**. Processing must be async, retryable and observable. The queue choice determines infrastructure (new container or not), the NestJS integration module, and how the enqueue relates to the DB write that marks the upload complete.

**Options:**

### Option A: BullMQ + Redis (`@nestjs/bullmq`)
- Official NestJS integration: `BullModule.forRoot`, `registerQueue`, `@Processor` + `WorkerHost`. Redis container in Compose.
- **Pros:** First-class NestJS docs and the project's `nestjs-best-practices` skill rule. Attempts plus exponential backoff, concurrency per worker, job progress, deduplication by `jobId`, stalled-job recovery. Bull Board is available for inspection. The testing guide already sketches the BullMQ integration-test pattern. Redis can later back `@nestjs/throttler` storage.
- **Cons:** New infrastructure (Redis) to run and persist (AOF). The enqueue is **not transactional** with the Postgres update: a crash between "mark uploaded" and `queue.add` can strand a video. This is mitigated by an idempotent `jobId = videoId` plus a periodic reconciliation of videos stuck in `uploaded`.

### Option B: pg-boss (Postgres-backed queue)
- Queue tables in the existing PostgreSQL. Jobs are created via SQL, optionally in the **same transaction** as the video update.
- **Pros:** No new infrastructure. Transactional enqueue (no stranded jobs). Retries, backoff and scheduling included.
- **Cons:** No official NestJS module (thin custom provider or a community wrapper). Polling-based fetch adds DB load and latency. Smaller ecosystem and tooling. Diverges from the project's best-practices skill and testing guide.

### Option C: RabbitMQ (`@nestjs/microservices` RMQ transport or `@golevelup/nestjs-rabbitmq`)
- AMQP broker container. Workers consume from a durable queue.
- **Pros:** Mature broker, strong delivery semantics, language-agnostic consumers (handy if the worker were ever rewritten outside Node).
- **Cons:** Retries and backoff need DLX/TTL plumbing. No built-in job progress or state. Heavier operations for a single job type. Nest's RMQ transport is RPC/event-oriented, not job-oriented.

**Recommendation:** **Option A (BullMQ + Redis)** — official NestJS integration, built-in retry/backoff/progress for long FFmpeg jobs, and alignment with the project's existing skill rule and testing guide. Its one real gap versus pg-boss (non-transactional enqueue) is closed cheaply with `jobId = videoId` idempotency and a reconciliation sweep. If avoiding new infrastructure is a priority, pg-boss (B) is the honest alternative.

**Decision:** A (BullMQ + Redis via `@nestjs/bullmq`)
**Libraries:** @nestjs/bullmq, bullmq

---

## TD-08: Video Worker Topology

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de processamento em segundo plano (filas)", "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** The C4 diagram shows a separate **Video Worker (FFmpeg)** container that reads and writes storage and updates the DB. FFmpeg work is CPU- and IO-heavy and must not degrade API latency. The topology decides the code location, the Dockerfile (FFmpeg binaries), the Compose services and how entities are shared between API and worker.

**Options:**

### Option A: Same `nestjs-project` codebase, separate entrypoint and Compose service
- `src/worker.ts` boots `NestFactory.createApplicationContext(WorkerModule)`, which has no HTTP server and imports `VideosModule` entities plus the processor. A `video-worker` service in Compose shares the image, with FFmpeg installed, and runs only the worker.
- **Pros:** Matches the C4 diagram (separate container) while reusing entities, config, `StorageService` and test infrastructure. The API is isolated from FFmpeg CPU spikes and can scale independently. One `package.json`, one migration history.
- **Cons:** Two entrypoints to keep wired. The FFmpeg layer ends up in the API image too, unless a multi-stage target is used (dev image size is a minor concern).

### Option B: Processor in-process with the API
- `@Processor` registered inside the API's `AppModule`.
- **Pros:** Zero extra services or entrypoints. Simplest to start.
- **Cons:** FFmpeg child processes compete with HTTP handling for CPU in the same container, against the capability's "no performance impact". It also contradicts the C4 diagram's separate worker and cannot scale workers independently.

### Option C: Separate subproject (`video-worker/`) with its own package
- A standalone Node (or other language) project consuming the queue.
- **Pros:** Strongest isolation. Free choice of runtime.
- **Cons:** Duplicates entities, config, storage client and DB access, or forces a shared-package/monorepo tooling decision. New test and lint setup. Too much overhead for one job type.

**Recommendation:** **Option A (same codebase, separate entrypoint + `video-worker` Compose service)** — it delivers the diagram's isolated worker container without duplicating the domain layer. API latency is protected by process and container isolation, and the shared code (entities, config, storage) stays single-sourced.

**Decision:** A (Same `nestjs-project` codebase, separate entrypoint and `video-worker` Compose service)

---

## TD-09: FFmpeg Integration and Source-File Access

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** The worker needs `ffprobe` (duration, codecs, resolution) and `ffmpeg` (one frame → JPEG/WebP thumbnail). Two coupled questions: **how Node drives FFmpeg**, given that `fluent-ffmpeg`, the historic wrapper, was **archived and deprecated in May 2025**, and **how the worker reads a source of up to 10GB**: download it first, or let FFmpeg read the object over HTTP Range.

**Options:**

### Option A: Spawn `ffprobe`/`ffmpeg` directly (`node:child_process`), input = presigned internal GET URL (HTTP Range)
- Distro FFmpeg (Debian `apt install ffmpeg`) in the worker image. `ffprobe -v error -print_format json -show_format -show_streams <url>` gives the metadata. `ffmpeg -ss <t> -i <url> -frames:v 1 …` gives the thumbnail. FFmpeg's HTTP demuxer seeks via Range, so only the header/`moov` and the frames it needs are fetched.
- **Pros:** No 10GB local copy, so no scratch volume or disk-full failures, and the job finishes in seconds. No wrapper dependency, as the `fluent-ffmpeg` author now recommends. JSON output is typed by a small parser.
- **Cons:** We write argument building and exit-code/stderr handling ourselves (small, unit-testable). Network hiccups mid-probe surface as job failures, which BullMQ retries. The presigned URL must use the **internal** endpoint (TD-04).

### Option B: Spawn directly, but download the object to a temp volume first
- `GetObject` streams to `/tmp/<videoId>`, then FFmpeg runs on the local file and the file is deleted.
- **Pros:** FFmpeg reads from local disk, the most predictable IO. Ready for future transcoding (TD-06 Option B).
- **Cons:** Copies up to 10GB per job for a probe that needs kilobytes. Needs a sized scratch volume and cleanup on crash. Much slower jobs.

### Option C: `fluent-ffmpeg` wrapper
- Fluent API around the FFmpeg CLI.
- **Pros:** Familiar API and many examples online.
- **Cons:** **Archived and deprecated (May 2025)**. No fixes, and it is known to break with recent FFmpeg versions. Listed to rule it out by name.

**Recommendation:** **Option A (direct spawn, HTTP-Range input via presigned internal URL)** — the job only needs metadata and one frame, so reading the whole 10GB file (B) is wasted IO and disk risk. Spawning the CLI directly is now the upstream-recommended path since `fluent-ffmpeg` was deprecated. If TD-06 later moves to transcoding, B's temp-file approach can be added for that job type only. Thumbnail frame choice (e.g., ~10% of duration, clamped) is an implementation detail for `/plan-build`.

**Decision:** A (Spawn `ffprobe`/`ffmpeg` directly, input = presigned internal GET URL over HTTP Range)

---

## TD-10: Unique Short Video Identifier (public URL)

**Scope:** Cross-layer

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Each video needs a **short, unique, never-conflicting** public URL (project-plan §4), e.g. `/watch/{id}`. The entity rule mandates UUID primary keys, so the short ID is a separate unique column. The format affects the DB column, API DTOs, FE dynamic route segments and the storage key prefix. It must be generated at draft creation (TD-02) and must not expose counts or ordering.

**Options:**

### Option A: Random 11-char base64url from `node:crypto` + unique index + retry on conflict
- `crypto.randomBytes(8)` → base64url → 11 chars (64 bits, YouTube-style). Inserted with a `UNIQUE` constraint, regenerated on violation (vanishingly rare).
- **Pros:** No dependency. Unguessable, so it doesn't leak creation order or volume, and that also helps unlisted videos in Phase 05. The DB constraint guarantees "never conflicts".
- **Cons:** Needs a retry loop on unique violation (a few lines). Not human-friendly to dictate (mixed case, `-`/`_`).

### Option B: `nanoid` with a custom alphabet/length
- `customAlphabet('0-9a-zA-Z', 11)()` plus the same unique-constraint safety net.
- **Pros:** Configurable alphabet (can drop `-`/`_`). Well-known lib.
- **Cons:** Extra dependency for what `node:crypto` already does. nanoid v5 is ESM-only while `nestjs-project` compiles to CommonJS (`nodenext`), so it depends on `require(esm)` support or pinning v3.

### Option C: Sqids/Hashids over a sequential integer
- Add a `bigserial` column and encode it into a short string.
- **Pros:** Deterministic, short, and collision-free by construction (no retry).
- **Cons:** Decodable: it leaks order and volume, and anyone can enumerate neighbors, which undermines unlisted videos (Phase 05). Adds a sequence column beside the UUID PK, plus a dependency.

### Option D: Use the UUID PK in the URL
- `/watch/3f2b…` (36 chars).
- **Pros:** Zero extra column or logic.
- **Cons:** Fails the "URL curta" requirement in §4.

**Recommendation:** **Option A (crypto-random 11-char base64url + unique constraint)** — it meets "short + unique + never conflicting" with no dependency, it doesn't reveal enumeration order (which unlisted videos will need), and the DB constraint makes uniqueness a guarantee rather than a probability.

**Decision:** A (Random 11-char base64url from `node:crypto` + unique index + retry on conflict)

---

## TD-11: Video Lifecycle State Model

**Scope:** Cross-layer

**Capability:** Pré-cadastro automático do vídeo como rascunho ao iniciar o upload

**Context:** A video row exists from upload start. It moves through upload → processing → ready/failed, and in Phase 04 through draft → published plus public/unlisted visibility. The state model is read by the API, the worker, the FE (status badges, polling stop condition, TD-12) and later listings ("only published + ready + public"). Modelling it now prevents a breaking migration in Phase 04.

**Options:**

### Option A: Single `status` enum covering everything
- `uploading | processing | ready | failed | published` (Phase 04 extends it).
- **Pros:** One column, simple queries.
- **Cons:** Conflates two independent dimensions: a published video cannot be "reprocessing", and "failed" plus "draft" cannot both be true. Phase 04 has to rework the enum, and `CHECK` logic gets tangled.

### Option B: Two orthogonal fields — `processing_status` + `publication_status`
- `processing_status`: `pending_upload | uploaded | processing | ready | failed` (owned by Phase 03, written by API and worker). `publication_status`: `draft` (default at pre-registration; Phase 04 adds `published`). Visibility (`public | unlisted`) is a third column added in Phase 04.
- **Pros:** Each dimension has a single owner (upload/worker vs. the user's publish action). Phase 04 only adds values and columns, with no migration of meaning. Listing filters stay explicit (`ready AND published AND public`). The FE derives badges deterministically.
- **Cons:** Two columns plus an invariant (cannot publish unless `ready`) enforced in the service layer.

### Option C: Derive state from timestamps (`uploaded_at`, `processed_at`, `published_at`, `failed_at`)
- No enum. State is computed from which timestamps are set.
- **Pros:** Audit trail for free.
- **Cons:** Every query and DTO has to recompute state. Invalid combinations are easy to persist. Awkward for indexes and for the FE contract.

**Recommendation:** **Option B (orthogonal `processing_status` + `publication_status`)** — the plan itself separates "processing" (Phase 03) from "draft → publication" (Phase 04). Two fields with clear owners let Phase 04 extend without redefining Phase 03's states, and give the FE a stable contract. Timestamps such as `processed_at` can still be added for audit.

**Decision:** B (Two orthogonal fields — `processing_status` + `publication_status`)

**Revisions:**
- 2026-10-03 — `processing_status` values: `uploading | processing | ready | failed`. Transitions: `uploading → processing` on multipart complete (job enqueued), `processing → ready` (ffprobe ok, metadata and thumbnail stored), `processing → failed`. Nullable `failure_reason` code: `UNSUPPORTED_FORMAT` (ffprobe rejects container/codec), `PROCESSING_FAILED` (job exhausts BullMQ retries — 3 attempts, exponential backoff), `SOURCE_MISSING` (object absent when processing). The owner sees `processing_status` + `failure_reason` on the video GET. A `failed` video's object is kept (diagnosis; cleanup is a future task). Abandoned uploads stay `uploading`; bucket lifecycle aborts incomplete multipart after 24h; orphan-draft cleanup and the reconciliation sweep are follow-ups outside Phase 03. `publication_status` is `draft` for every Phase 03 video. Worker-filled fields: `duration_seconds`, `width`, `height`, `video_codec`, `audio_codec`, `thumbnail_object_key`, `processed_at`. Rationale: AMB-2/AMB-3 resolution.

---

## TD-12: Processing Status Propagation to the Frontend

**Scope:** Cross-layer

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** After the upload completes, the user waits for processing (`processing` → `ready`/`failed`, TD-11). Under TD-06 Option A and TD-09 Option A this takes seconds to about a minute. The FE must reflect the transition. Real-time transport is a cross-layer contract: the backend endpoint shape plus BFF streaming behavior plus the client subscription.

**Options:**

### Option A: Client polling via BFF (`GET /api/videos/:id` every few seconds until terminal status)
- A Client Component polls with an interval (e.g., 3s, with backoff) and stops on `ready`/`failed`. It reuses the existing Route Handler + `upstream` pattern.
- **Pros:** No new transport. Works through the BFF, iron-session refresh (`phase-02-auth-frontend/TD-03`) and MSW tests unchanged. Trivial to test. Load is negligible for short jobs.
- **Cons:** Up to one interval of latency. Wasted requests if a job is stuck (bounded by a max-attempts cap).

### Option B: Server-Sent Events (Nest `@Sse` → BFF streaming Route Handler → `EventSource`)
- The worker publishes status changes (e.g., via Redis pub/sub). Nest streams them, and the Next Route Handler pipes the stream to the browser.
- **Pros:** Instant updates with one long-lived connection.
- **Cons:** Needs a pub/sub path from worker to API, long-lived streaming through two Node layers (with timeouts and the auth-refresh mid-stream problem), and a new MSW/test pattern for streams. Heavy for a seconds-long wait.

### Option C: WebSocket (`@nestjs/websockets` / Socket.IO)
- A bidirectional socket pushes status events.
- **Pros:** Real-time. Reusable for future live features.
- **Cons:** The strict BFF forbids browser→Nest connections, and Next Route Handlers cannot proxy WebSockets. Would need a separate gateway. Disqualified under `config-base/TD-03`.

**Recommendation:** **Option A (polling via BFF)** — processing is short under TD-06 A and TD-09 A, so polling's latency is irrelevant, and it is the only option that fits the strict BFF and the existing MSW/Route-Handler test scaffold without new infrastructure. SSE can be revisited if transcoding (TD-06 B/C) makes jobs long.

**Decision:** Out of scope — Phase 03 delivers backend only (UI deferred); revisit in the Phase 03 frontend slice

---

## TD-13: Frontend Test Strategy for Browser → Storage Traffic

**Scope:** Frontend

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** Under TD-02 Option A, part PUTs go **from the browser to storage**, outside `/api/**`. The project's testing setup fakes only the upstream NestJS (MSW server-side via `instrumentation.ts` in E2E; `msw/node` in Vitest) and forbids browser-level interception of `/api/**`. The testing guide marks Object Storage as "Fake (deferred) — in-memory/local emulator, never a real bucket". A strategy is needed so E2E can drive a full upload, and so Vitest can test the uploader module (TD-03), without a real bucket.

**Options:**

### Option A: Playwright `page.route()` on the **storage origin** only (never `/api/**`)
- MSW fixtures for the upstream initiate/sign endpoints return presigned URLs on a reserved fake storage host (e.g., `http://storage.test/...`). E2E specs intercept that host with `page.route()` and answer PUTs with `200` + `ETag`. In Vitest, the uploader's XHR/fetch to the same host is intercepted by MSW handlers in a `mocks/handlers/storage.ts` domain file.
- **Pros:** Respects the existing hard rules (the real `/api/**` Route Handlers still run, the upstream is still server-side MSW). Deterministic, fast, no new container. Failure scenarios (403 expired URL, 5xx retry) become trivial reserved triggers.
- **Cons:** The browser→storage leg is faked, so CORS and SigV4 against a real S3 are not covered by FE tests. That coverage moves to backend integration tests against the emulator (TD-01 A).

### Option B: Real S3 emulator reachable from the FE E2E environment
- FE E2E uses the backend stack's S3 emulator. MSW fixtures return real presigned URLs (or the BFF hits a real presign service).
- **Pros:** Exercises real CORS and multipart end to end.
- **Cons:** Couples FE E2E to backend infrastructure. MSW fixtures cannot produce valid signatures without real credentials, so either the backend runs for real (against the "never reach a real NestJS" rule) or signatures are generated in fixtures with emulator credentials (brittle). Contradicts the testing guide's "never a real bucket".

**Recommendation:** **Option A (fake storage origin, intercepted at the browser in E2E and by MSW in Vitest)** — it keeps every existing invariant (real BFF, faked upstream, no `/api/**` interception) and makes upload failure modes cheap to test. Real S3 behavior (CORS, presigned multipart, Range) is verified once, where it belongs: in `nestjs-project` integration tests against the emulator.

**Decision:** Out of scope — Phase 03 delivers backend only (UI deferred); revisit in the Phase 03 frontend slice

---

## TD-14: Input Format Validation Before Upload (allowlist at initiate + ffprobe gate)

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** TD-06 A serves the original file, so only browser-playable inputs are acceptable: MP4/MOV (H.264/AAC) and WebM (VP8/VP9/AV1, Opus/Vorbis), with the worker's ffprobe as the gate. TD-02 A fixes the size check (10 GiB at initiate and at complete) but not the **format** check. Under presigned multipart, the API never sees the bytes, and S3 parts are unreadable until `CompleteMultipartUpload`. So without a pre-upload check, an unsupported file is only rejected after up to 10GB has been transferred. The decision sets the initiate payload (`fileName`, `mimeType`, `size`), the accepted-format list shared by the API DTO, the FE pre-check and the worker's ffprobe allowlist, and the domain error codes on each side (`phase-02-auth/TD-07` envelope). This TD refines TD-06 A's "client pre-checks MIME/extension"; it does not reopen it.

**Options:**

### Option A: Declared-metadata allowlist at initiate + ffprobe as the authoritative gate
- The FE checks extension and `File.type` against the allowlist. Initiate re-validates the declared `mimeType` and extension (`.mp4`/`.m4v`/`.mov`/`.webm` ↔ `video/mp4`, `video/quicktime`, `video/webm`) and rejects with a domain code (e.g., `VIDEO_UNSUPPORTED_FORMAT`) before creating the draft or the multipart upload. The worker's ffprobe checks container and codecs and sets `processing_status = failed` with a reason code.
- **Pros:** No dependencies. A single list mirrored in the DTO, the FE constant and the worker. Blocks wrong containers (AVI, MKV, WMV) before any byte moves.
- **Cons:** Declared metadata is client-controlled, and `File.type` is empty or OS-dependent for some extensions (hence the extension fallback). It **cannot catch a wrong codec in an allowed container** (e.g., HEVC or ProRes in `.mp4`/`.mov`, which is common for phone and camera exports), which is exactly the case that wastes a 10GB upload.

### Option B: Option A + zero-dependency browser playability probe before initiate
- Before calling initiate, the FE loads the local `File` through `URL.createObjectURL` into a detached `<video preload="metadata">`. It accepts on `loadedmetadata` (finite `duration`, `videoWidth > 0`) and rejects on `error` (`MEDIA_ERR_SRC_NOT_SUPPORTED`) or a timeout. The browser reads only the headers of the local file (including a trailing `moov`), so the probe takes milliseconds even for 10GB. The API contract and ffprobe gate are the same as in A.
- **Pros:** Catches the codec-mismatch case before upload, with no dependency. It tests the property that actually matters (can **a browser** play it), which is TD-06 A's playback contract. FE-only, so no change to the API surface.
- **Cons:** The verdict depends on the browser. Safari plays HEVC while Chrome may or may not, so the probe can pass a file that ffprobe later rejects. ffprobe stays authoritative, and the codec allowlist must be stricter than "the uploader's browser plays it". An unsupported **audio** track may still pass. Hard to unit-test (needs real media fixtures in E2E).

### Option C: Option A + JS container parser in the browser (e.g., `mediabunny` / `mp4box.js`)
- The FE parses the file's container headers with a library, extracts the codec identifiers, and checks them against the **same codec allowlist** the worker uses, before initiate.
- **Pros:** The verdict does not depend on the browser and matches ffprobe's allowlist exactly. Reports precise reasons ("HEVC video is not supported").
- **Cons:** New FE dependency (tens of KB gzip, lazy-loadable), which goes against the zero-dependency direction of TD-03's recommendation. Each container needs parser support. Still client-side, so not a trust boundary, and ffprobe remains required.

### Option D: Option A + server-side magic-byte sniff of a header sample sent at initiate
- The FE sends the first ~64KiB of the file with the initiate request (through the BFF). Nest checks the container signature (`ftyp` box for MP4/MOV, EBML `1A45DFA3` for WebM) before creating the draft.
- **Pros:** The container check runs on the server instead of trusting the declared MIME.
- **Cons:** It is not a real trust boundary, because the client can send a valid header and then upload different parts. It still misses codec mismatches (and an `ftyp` box says nothing about codecs). It adds a binary payload to initiate and the BFF route. The usual sniffing lib (`file-type`) is ESM-only, the same CJS friction noted for `nanoid` in TD-10.

**Recommendation:** **Option B (declared allowlist at initiate + browser playability probe, ffprobe authoritative)** — A alone leaves the costly case (wrong codec in an MP4/MOV) undetected until after a 10GB transfer, and B closes most of that gap with no dependency, testing the same "browser-playable" property TD-06 A promises. C is the stricter upgrade if browser-dependent verdicts prove noisy, and since it only touches the FE, it needs no API change. D adds payload and complexity without real trust. Proposed parameters for `/plan-build`: container allowlist MP4/MOV/WebM (extension and MIME, with extension fallback when `File.type` is empty). The ffprobe codec allowlist follows TD-06 A (video `h264`, `vp8`, `vp9`, `av1`; audio `aac`, `mp3`, `opus`, `vorbis`; HEVC excluded). Initiate rejects with HTTP 415/422 plus a domain code. Worker rejection sets `processing_status = failed` with a reason code consumed by TD-12. The FE probe has a timeout of a few seconds and falls back to letting ffprobe decide. The failure semantics of the `failed` state are AMB-2's concern, not this TD's.

**Decision:** A (Declared-metadata allowlist at initiate + ffprobe as the authoritative gate)

**Note:** Diverges from the Recommendation (B) by scope, not by merit: the browser playability probe of Option B lives in `next-frontend`, which is out of scope for this backend-only delivery (UI deferred in `/plan-context 03`). Option A is the backend half of B, so the probe can be added later by the frontend slice without changing this contract. The initiate endpoint rejects any declared MIME type outside the allowlist (`video/mp4`, `video/webm`, the browser-playable containers per TD-06 A); ffprobe in the worker remains the authoritative codec check and marks the video `failed` when it is not playable.

**Revisions:**
- 2026-10-03 — Browser playability probe parameter removed from this phase: codec rejection happens only at the worker's ffprobe gate; the FE probe is a recorded follow-up for the Phase 03 frontend slice. Rationale: Phase 03 delivers backend only (UI deferred); keeps A without FE scope.
- 2026-10-03 — MOV removed from the container allowlist. Final allowlist: `video/mp4` (extensions `.mp4`, `.m4v`) and `video/webm` (`.webm`). Rationale: TD-06 A serves the original file and the playback contract is MP4/WebM; `video/quicktime` is not reliably playable across browsers.

---

## TD-15: Storage Bucket Topology for Public Thumbnails and Private Videos

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Serviço de armazenamento de arquivos (vídeos e thumbnails)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** TD-05 C needs **public-read thumbnails with stable, cacheable URLs** and **private video objects reachable only through presigned GETs**. TD-04 A defines a single `STORAGE_BUCKET`, and no TD says how the two access levels coexist. The choice determines the env keys (Joi schema + `compose.yaml` + `.env.example`), the storage bootstrap (bucket creation, access grants, CORS, lifecycle), the thumbnail URL shape built on `STORAGE_PUBLIC_ENDPOINT` that appears in the video DTO, and the host the FE must allow in `next/image` `remotePatterns`. Emulator support matters (TD-01). In SeaweedFS, **bucket-level** anonymous read (`s3.anonymous.set -bucket … -access Read`) is long-standing. **Bucket policies** with `Principal: "*"` were only honored for anonymous requests from the fix merged on 2026-09-26 (PR #11471), after reports that policies were accepted but had no effect (issue #7469), and prefix-scoped `Resource` matching is not explicitly documented. Garage, TD-01's fallback, has **no bucket policies** at all. It only offers bucket-level public read through its website endpoint. On AWS S3, new buckets have Block Public Access enabled, so any public-read setup must explicitly relax it for the public bucket or prefix.

**Options:**

### Option A: Single bucket, prefix-scoped bucket policy (`thumbnails/*` public, `videos/*` private)
- One `STORAGE_BUCKET`. Bootstrap applies a policy allowing anonymous `s3:GetObject` on `arn:aws:s3:::{bucket}/thumbnails/*` only. URL: `{STORAGE_PUBLIC_ENDPOINT}/{STORAGE_BUCKET}/thumbnails/{shortId}/{version}.jpg`.
- **Pros:** Keeps TD-04's key set unchanged. One bucket to create, with one CORS config and one lifecycle rule. This is the textbook AWS pattern.
- **Cons:** The private videos sit one policy line away from exposure: a wrong `Resource` (`/*`) makes every draft public. Depends on SeaweedFS's newest policy path (requires an image at or after the 2026-09 fix, plus a smoke test for prefix matching). **Breaks TD-01's Garage fallback**, which has no bucket policies. AWS Block Public Access must be relaxed on the bucket that holds private videos.

### Option B: Two buckets — private `STORAGE_BUCKET` (videos) + public-read `STORAGE_THUMBNAILS_BUCKET`
- Videos (and the multipart lifecycle rule plus the upload CORS) live in the private bucket. Thumbnails are written by the worker into a second bucket that has **bucket-level** anonymous read only (no `List`). URL: `{STORAGE_PUBLIC_ENDPOINT}/{STORAGE_THUMBNAILS_BUCKET}/{shortId}/{version}.jpg`.
- **Pros:** Isolation by construction: no policy mistake can expose videos. It uses the most portable primitive (bucket-level public read): SeaweedFS's long-standing anonymous grant, a whole-bucket policy on AWS, website mode on Garage, so the TD-01 fallback still works. Each bucket's config stays minimal. CORS is only needed on the video bucket, because `<img>`/`next/image` fetches need none.
- **Cons:** One extra env key and one extra bucket in bootstrap and tests. It extends TD-04's canonical key list, which is recorded as a **Revision** of TD-04 (same option, added parameter), not a reopening. Thumbnail and video lifecycles are cleaned up separately (e.g., deleting a video must delete in both buckets).

### Option C: No public storage — stable app URL that proxies or redirects to a presigned GET
- The DTO exposes `/api/videos/{shortId}/thumbnail`. A BFF Route Handler calls Nest, which returns a 302 to a short-lived presigned GET (or streams the bytes).
- **Pros:** Everything stays private, and it works on any S3 backend with no access-policy features.
- **Cons:** Effectively reverses TD-05 C's "public-read thumbnails" (it is closer to TD-05 A). Every thumbnail in a listing grid costs a BFF + Nest round trip, and the redirect target expires, which undermines the caching TD-05 C was chosen for. Listed because the validation report named it.

**Recommendation:** **Option B (two buckets: private videos, public-read thumbnails)** — it makes "videos are never public" a structural guarantee rather than a correctly written policy. It relies only on bucket-level public read, the one primitive that SeaweedFS (without the 2026-09 policy fix), AWS and Garage all support, so it keeps TD-01's fallback alive. It matches TD-05 C as decided. The price is one env key, recorded as a Revision of TD-04. Proposed parameters for `/plan-build`: new key `STORAGE_THUMBNAILS_BUCKET` (added to the TD-04 list). The DB stores only the thumbnail **object key**, and the API composes the URL at serialization time from `STORAGE_PUBLIC_ENDPOINT` + bucket + key (path-style per `STORAGE_FORCE_PATH_STYLE`), so changing the endpoint needs no data migration. Keys are versioned (`{shortId}/{random-or-hash}.jpg`), so a replaced thumbnail (Phase 04 custom upload) gets a new URL, and objects are written with `Cache-Control: public, max-age=31536000, immutable`. Anonymous access on the thumbnails bucket is `Read` only, with no `List`. The FE adds the public storage host to `next/image` `remotePatterns`.

**Decision:** B (Two buckets — private `STORAGE_BUCKET` for videos + public-read `STORAGE_THUMBNAILS_BUCKET` for thumbnails)
**Libraries:** @aws-sdk/client-s3

**Note:** Adds `STORAGE_THUMBNAILS_BUCKET` to the TD-04 environment keys (to be recorded as a TD-04 Revision by `/plan-resolve 03`). Chosen because the anonymous-read grant then applies to a whole bucket — the one policy shape SeaweedFS is confirmed to honor — instead of depending on prefix-scoped policies that are unconfirmed in the emulator.

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|----------------|--------|
| TD-01 | Backend | Object storage backend (dev/test vs prod) | A — S3 API everywhere, SeaweedFS in dev/test | A |
| TD-02 | Cross-layer | Large-file upload protocol | A — S3 multipart, presigned parts, browser → storage direct | A |
| TD-03 | Frontend | Frontend upload client | B — hand-rolled multipart uploader (Uppy headless as fallback) | Out of scope (UI deferred) |
| TD-04 | Cross-layer | Storage endpoint topology | A — internal + public endpoint, bucket CORS | A |
| TD-05 | Cross-layer | Media delivery (streaming, download, thumbnails) | C — hybrid: public thumbnails, presigned video/download | C |
| TD-06 | Backend | Playback format | A — original file + ffprobe compatibility gate | A |
| TD-07 | Backend | Background job queue | A — BullMQ + Redis (`@nestjs/bullmq`) | A |
| TD-08 | Backend | Video worker topology | A — same codebase, separate entrypoint + Compose service | A |
| TD-09 | Backend | FFmpeg integration and source access | A — direct spawn, HTTP-Range input via presigned URL | A |
| TD-10 | Cross-layer | Unique short video identifier | A — crypto-random 11-char base64url + unique constraint | A |
| TD-11 | Cross-layer | Video lifecycle state model | B — `processing_status` + `publication_status` | B |
| TD-12 | Cross-layer | Processing status propagation | A — polling via BFF | Out of scope (UI deferred) |
| TD-13 | Frontend | FE test strategy for browser → storage traffic | A — fake storage origin (Playwright route + MSW) | Out of scope (UI deferred) |
| TD-14 | Cross-layer | Input format validation before upload | B — declared allowlist at initiate + browser playability probe, ffprobe authoritative | A (browser probe deferred with UI) |
| TD-15 | Cross-layer | Storage bucket topology (public thumbnails, private videos) | B — two buckets: private videos + public-read thumbnails bucket | B |

---

## Notes for downstream pipeline

- **Dependency chain:** TD-01 (S3 semantics) → TD-02 (presigned multipart) → TD-03, TD-04, TD-13. TD-04 → TD-05, TD-09 (internal vs public presign). TD-06 ↔ TD-09 (Option A of both assumes no transcoding). TD-07 → TD-08 (worker hosts the `@Processor`). TD-11 → TD-12 (polling stop condition). TD-10 is independent. TD-06 A → TD-14 (the ffprobe codec allowlist); TD-14 also feeds the initiate contract of TD-02 and the `failed` reason consumed by TD-12. TD-01 + TD-04 + TD-05 C → TD-15; TD-15 B adds `STORAGE_THUMBNAILS_BUCKET` to TD-04's key list, to be recorded as a TD-04 **Revision** (same option).
- **Testing-guide update:** if TD-01 A is chosen, `testing-guide-nestjs-project/references/external-systems.md` § Object Storage must switch from "local filesystem" to "real S3 emulator (Docker)". If TD-13 A is chosen, `testing-guide-next-frontend/references/external-systems.md` § Object Storage should document the fake storage origin.
- **Out of scope here (later phases):** player UI and download button (Phase 05); custom thumbnail upload, publish flow, visibility (Phase 04); view counting (Phase 05).

Sources consulted:

- [MinIO Community Edition maintenance mode / image discontinuation](https://blog.elest.io/minio-is-in-maintenance-mode-your-guide-to-s3-compatible-storage-alternatives/), [LWN — MinIO alternatives: Ceph and Garage](https://lwn.net/Articles/1077739/), [Chainguard — MinIO Docker image changes](https://www.chainguard.dev/unchained/secure-and-free-minio-chainguard-containers)
- [fluent-ffmpeg — "Phasing out" issue #1324](https://github.com/fluent-ffmpeg/node-fluent-ffmpeg/issues/1324) and [repository (archived)](https://github.com/fluent-ffmpeg/node-fluent-ffmpeg)
- [Uppy AWS S3 plugin docs](https://uppy.io/docs/aws-s3) and [migration guide (`signRequest`)](https://uppy.io/docs/guides/migration-guides) — via Context7
- [`@nestjs/bullmq` API reference (`@Processor`, `WorkerHost`, attempts/backoff)](https://github.com/nestjs/bull) — via Context7
- `.claude/skills/nestjs-best-practices/rules/micro-use-queues.md`, `.claude/skills/testing-guide-*/references/external-systems.md`
- `docs/decisions/technical-decisions-next-frontend-config-base.md` (TD-03), `technical-decisions-phase-02-auth*.md`
- SeaweedFS wiki — [S3 Bucket Policies](https://github.com/seaweedfs/seaweedfs/wiki/S3-Bucket-Policies) and [Simplest S3 Bucket and User Setup (`s3.anonymous.set`)](https://github.com/seaweedfs/seaweedfs/wiki/Simplest-S3-Bucket-and-User-Setup) — via Context7; [PR #11471 — evaluate bucket policy for anonymous requests (merged 2026-09-26)](https://github.com/seaweedfs/seaweedfs/pull/11471); [issue #7469 — bucket policy without effect (v4.0)](https://github.com/seaweedfs/seaweedfs/issues/7469) (TD-15)
