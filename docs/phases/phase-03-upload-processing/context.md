---
kind: phase
name: phase-03-upload-processing
sources_mtime:
  docs/project-plan.md: "2026-10-03T17:53:36-03:00"
  docs/decisions/technical-decisions-phase-03-upload-processing.md: "2026-10-03T20:28:39-03:00"
  docs/phases/phase-03-upload-processing/library-refs.md: "2026-10-03T20:31:49-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-10-03T18:04:32-03:00"
  docs/decisions/technical-decisions-next-frontend-config-base.md: "2026-10-03T18:04:32-03:00"
  docs/phases/phase-01-configuracao-base/context.md: "2026-10-03T18:04:32-03:00"
  docs/phases/phase-02-auth/context.md: "2026-10-03T18:04:32-03:00"
  docs/phases/phase-02-auth-frontend/context.md: "2026-10-03T18:04:32-03:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-10-03T20:21:02-03:00"
  .claude/skills/testing-guide-nestjs-project/references/external-systems.md: "2026-10-03T20:21:02-03:00"
---

# phase-03-upload-processing — Context

## Scope

**Phase name:** Upload e Processamento de Vídeos

**Capabilities** (literal, `docs/project-plan.md`):

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** _Not specified._
**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.
**Affected subprojects:** _None mentioned. The phase text names no subproject paths._
**Deferred subprojects:** _None._
**Sequencing notes:** "> Depende de: Fase 01, Fase 02"

**Neighbors (for boundary detection only):**

- **Phase 02:** Cadastro, Login e Gerenciamento de Conta — "> Depende de: Fase 01"
- **Phase 04:** Gerenciamento de Vídeos e Canal — "> Depende de: Fase 02, Fase 03"

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-upload-processing/TD-01 | phase | Backend | Object Storage Backend (dev/test vs production) | decided | A (S3 API everywhere, SeaweedFS in dev/test) | @aws-sdk/client-s3 |
| phase-03-upload-processing/TD-02 | phase | Cross-layer | Large-File Upload Protocol (10GB, resumable) | decided | A (S3 Multipart Upload, presigned part URLs, browser → storage) | @aws-sdk/client-s3, @aws-sdk/s3-request-presigner |
| phase-03-upload-processing/TD-03 | phase | Frontend | Frontend Upload Client | decided | Out of scope (UI deferred) | — |
| phase-03-upload-processing/TD-04 | phase | Cross-layer | Storage Endpoint Topology (internal vs browser-facing URLs) | decided | A (two endpoints: `STORAGE_ENDPOINT` + `STORAGE_PUBLIC_ENDPOINT`, bucket CORS) | @aws-sdk/client-s3, @aws-sdk/s3-request-presigner |
|     └─ Last revision: 2026-10-03 — Canonical key list extended with `STORAGE_THUMBNAILS_BUCKET` (public-read thumb… | | | | | | |
| phase-03-upload-processing/TD-05 | phase | Cross-layer | Media Delivery Strategy (streaming, download, thumbnails) | decided | C (hybrid: public-read thumbnails, presigned GET for playback and download) | @aws-sdk/s3-request-presigner |
| phase-03-upload-processing/TD-06 | phase | Backend | Playback Format: original vs normalized rendition vs HLS | decided | A (serve the original, gated by ffprobe compatibility check) | — |
| phase-03-upload-processing/TD-07 | phase | Backend | Background Job Queue Technology | decided | A (BullMQ + Redis via `@nestjs/bullmq`) | @nestjs/bullmq, bullmq |
| phase-03-upload-processing/TD-08 | phase | Backend | Video Worker Topology | decided | A (same codebase, separate entrypoint + `video-worker` Compose service) | — |
| phase-03-upload-processing/TD-09 | phase | Backend | FFmpeg Integration and Source-File Access | decided | A (spawn `ffprobe`/`ffmpeg` directly, input = presigned internal GET over HTTP Range) | — |
| phase-03-upload-processing/TD-10 | phase | Cross-layer | Unique Short Video Identifier (public URL) | decided | A (random 11-char base64url via `node:crypto`, unique index, retry on conflict) | — |
| phase-03-upload-processing/TD-11 | phase | Cross-layer | Video Lifecycle State Model | decided | B (two orthogonal fields: `processing_status` + `publication_status`) | — |
| phase-03-upload-processing/TD-12 | phase | Cross-layer | Processing Status Propagation to the Frontend | decided | Out of scope (UI deferred) | — |
| phase-03-upload-processing/TD-13 | phase | Frontend | Frontend Test Strategy for Browser → Storage Traffic | decided | Out of scope (UI deferred) | — |
| phase-03-upload-processing/TD-14 | phase | Cross-layer | Input Format Validation Before Upload | decided | A (declared-metadata allowlist at initiate + ffprobe as the authoritative gate) | — |
|     └─ Last revision: 2026-10-03 — MOV removed from the container allowlist. Final allowlist: `video/mp4` (extensi… | | | | | | |
| phase-03-upload-processing/TD-15 | phase | Cross-layer | Storage Bucket Topology (public thumbnails, private videos) | decided | B (two buckets: private `STORAGE_BUCKET` + public-read `STORAGE_THUMBNAILS_BUCKET`) | @aws-sdk/client-s3 |

_Source files:_

- phase-03-upload-processing — `docs/decisions/technical-decisions-phase-03-upload-processing.md` (scope_type: phase, related_phases: [3])

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-upload-processing/TD-01, phase-03-upload-processing/TD-04, phase-03-upload-processing/TD-15 |
| Serviço de processamento em segundo plano (filas) | phase-03-upload-processing/TD-07, phase-03-upload-processing/TD-08 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-upload-processing/TD-02, phase-03-upload-processing/TD-03, phase-03-upload-processing/TD-04, phase-03-upload-processing/TD-13, phase-03-upload-processing/TD-14 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-upload-processing/TD-02, phase-03-upload-processing/TD-11 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-upload-processing/TD-06, phase-03-upload-processing/TD-08, phase-03-upload-processing/TD-09, phase-03-upload-processing/TD-12, phase-03-upload-processing/TD-14 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-upload-processing/TD-05, phase-03-upload-processing/TD-08, phase-03-upload-processing/TD-09, phase-03-upload-processing/TD-15 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-upload-processing/TD-10 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-upload-processing/TD-04, phase-03-upload-processing/TD-05, phase-03-upload-processing/TD-06 |
| Download do vídeo pelo usuário | phase-03-upload-processing/TD-04, phase-03-upload-processing/TD-05 |

## Decisions Detail

### phase-03-upload-processing/TD-01

**Recommendation:** every later TD (direct upload, presigned delivery, worker reading over HTTP Range) relies on S3 semantics, and only Option A tests those semantics locally. SeaweedFS avoids the MinIO end-of-life problem with a single container. If its bucket-CORS support turns out insufficient during implementation, Garage is the fallback, with no code change. Choosing A replaces the "local filesystem" strategy in the NestJS testing guide.
**Libraries:** @aws-sdk/client-s3

### phase-03-upload-processing/TD-02

**Recommendation:** it is the only option where video bytes never touch the application tier. That is the literal requirement, and it is the mechanism `config-base/TD-03` already reserved for media. Proposed parameters for `/plan-build`: `partSize` = 64MiB, returned by the API (single source; the client never hard-codes it). Max file size = 10 GiB, enforced at initiate from the declared `size` and re-checked at complete via `HeadObject`. Presigned part URL TTL ≈ 1h, re-signable on demand. Bucket lifecycle rule aborts incomplete multipart uploads after 24h. Depends on TD-01 (S3 semantics) and TD-04 (public endpoint + CORS).
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

### phase-03-upload-processing/TD-03

**Recommendation:** **Option B (hand-rolled uploader)**, with **Option A as the fallback** if the team prefers a library. TD-02 makes the API the owner of initiate/complete, because that is where the draft is created and processing is enqueued. Uppy's current major moved toward the client performing S3 calls itself, which fights that ownership. The resume edge case that matters most (the user must re-pick the file after a reload) is a browser constraint that Uppy does not remove either. The hand-rolled module is small, has no dependencies, and its retry and re-sign behavior can be pinned down in Vitest.
**Libraries:** —

### phase-03-upload-processing/TD-04

**Recommendation:** it respects the project's Compose-service-name rule for container-to-container traffic, needs no new infrastructure, and collapses to a single URL in prod. Canonical new keys for `/plan-build`: `STORAGE_ENDPOINT`, `STORAGE_PUBLIC_ENDPOINT`, `STORAGE_REGION`, `STORAGE_ACCESS_KEY`, `STORAGE_SECRET_KEY`, `STORAGE_BUCKET`, `STORAGE_FORCE_PATH_STYLE`, plus `STORAGE_CORS_ORIGIN` (the FE origin).
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

**Revisions:**
- 2026-10-03 — Canonical key list extended with `STORAGE_THUMBNAILS_BUCKET` (public-read thumbnails bucket); `STORAGE_BUCKET` is clarified as the private video bucket. Rationale: parameter added by TD-15 B (two-bucket topology), same option A.

### phase-03-upload-processing/TD-05

**Recommendation:** thumbnails are displayed in volume across later phases and need stable URLs for caching, while video objects need signing-time control for drafts now and visibility later (Phase 04/05). Storage serves Range and `Content-Disposition` natively, so nothing heavy passes through Node. `<video src>` receives the presigned URL; MP4 Range playback works natively in browsers.
**Libraries:** @aws-sdk/s3-request-presigner

### phase-03-upload-processing/TD-06

**Recommendation:** it matches the literal phase scope (metadata + thumbnail), keeps storage at 1× (§4 cost concern) and keeps the worker fast. The playback contract (a single MP4/WebM URL in `<video src>`) is the same contract Option B would produce, so upgrading to B later is a worker-only change with no FE or API break. HLS (C) is a separate future initiative.
**Libraries:** —

### phase-03-upload-processing/TD-07

**Recommendation:** official NestJS integration, built-in retry/backoff/progress for long FFmpeg jobs, and alignment with the project's existing skill rule and testing guide. Its one real gap versus pg-boss (non-transactional enqueue) is closed cheaply with `jobId = videoId` idempotency and a reconciliation sweep. If avoiding new infrastructure is a priority, pg-boss (B) is the honest alternative.
**Libraries:** @nestjs/bullmq, bullmq

### phase-03-upload-processing/TD-08

**Recommendation:** it delivers the diagram's isolated worker container without duplicating the domain layer. API latency is protected by process and container isolation, and the shared code (entities, config, storage) stays single-sourced.
**Libraries:** —

### phase-03-upload-processing/TD-09

**Recommendation:** the job only needs metadata and one frame, so reading the whole 10GB file (B) is wasted IO and disk risk. Spawning the CLI directly is now the upstream-recommended path since `fluent-ffmpeg` was deprecated. If TD-06 later moves to transcoding, B's temp-file approach can be added for that job type only. Thumbnail frame choice (e.g., ~10% of duration, clamped) is an implementation detail for `/plan-build`.
**Libraries:** —

### phase-03-upload-processing/TD-10

**Recommendation:** it meets "short + unique + never conflicting" with no dependency, it doesn't reveal enumeration order (which unlisted videos will need), and the DB constraint makes uniqueness a guarantee rather than a probability.
**Libraries:** —

### phase-03-upload-processing/TD-11

**Recommendation:** the plan itself separates "processing" (Phase 03) from "draft → publication" (Phase 04). Two fields with clear owners let Phase 04 extend without redefining Phase 03's states, and give the FE a stable contract. Timestamps such as `processed_at` can still be added for audit.
**Libraries:** —

### phase-03-upload-processing/TD-12

**Recommendation:** processing is short under TD-06 A and TD-09 A, so polling's latency is irrelevant, and it is the only option that fits the strict BFF and the existing MSW/Route-Handler test scaffold without new infrastructure. SSE can be revisited if transcoding (TD-06 B/C) makes jobs long.
**Libraries:** —

### phase-03-upload-processing/TD-13

**Recommendation:** it keeps every existing invariant (real BFF, faked upstream, no `/api/**` interception) and makes upload failure modes cheap to test. Real S3 behavior (CORS, presigned multipart, Range) is verified once, where it belongs: in `nestjs-project` integration tests against the emulator.
**Libraries:** —

### phase-03-upload-processing/TD-14

**Recommendation:** A alone leaves the costly case (wrong codec in an MP4/MOV) undetected until after a 10GB transfer, and B closes most of that gap with no dependency, testing the same "browser-playable" property TD-06 A promises. C is the stricter upgrade if browser-dependent verdicts prove noisy, and since it only touches the FE, it needs no API change. D adds payload and complexity without real trust. Proposed parameters for `/plan-build`: container allowlist MP4/MOV/WebM (extension and MIME, with extension fallback when `File.type` is empty). The ffprobe codec allowlist follows TD-06 A (video `h264`, `vp8`, `vp9`, `av1`; audio `aac`, `mp3`, `opus`, `vorbis`; HEVC excluded). Initiate rejects with HTTP 415/422 plus a domain code. Worker rejection sets `processing_status = failed` with a reason code consumed by TD-12. The FE probe has a timeout of a few seconds and falls back to letting ffprobe decide. The failure semantics of the `failed` state are AMB-2's concern, not this TD's.
**Libraries:** —

**Revisions:**
- 2026-10-03 — Browser playability probe parameter removed from this phase: codec rejection happens only at the worker's ffprobe gate; the FE probe is a recorded follow-up for the Phase 03 frontend slice. Rationale: Phase 03 delivers backend only (UI deferred); keeps A without FE scope.
- 2026-10-03 — MOV removed from the container allowlist. Final allowlist: `video/mp4` (extensions `.mp4`, `.m4v`) and `video/webm` (`.webm`). Rationale: TD-06 A serves the original file and the playback contract is MP4/WebM; `video/quicktime` is not reliably playable across browsers.

### phase-03-upload-processing/TD-15

**Recommendation:** it makes "videos are never public" a structural guarantee rather than a correctly written policy. It relies only on bucket-level public read, the one primitive that SeaweedFS (without the 2026-09 policy fix), AWS and Garage all support, so it keeps TD-01's fallback alive. It matches TD-05 C as decided. The price is one env key, recorded as a Revision of TD-04. Proposed parameters for `/plan-build`: new key `STORAGE_THUMBNAILS_BUCKET` (added to the TD-04 list). The DB stores only the thumbnail **object key**, and the API composes the URL at serialization time from `STORAGE_PUBLIC_ENDPOINT` + bucket + key (path-style per `STORAGE_FORCE_PATH_STYLE`), so changing the endpoint needs no data migration. Keys are versioned (`{shortId}/{random-or-hash}.jpg`), so a replaced thumbnail (Phase 04 custom upload) gets a new URL, and objects are written with `Cache-Control: public, max-age=31536000, immutable`. Anonymous access on the thumbnails bucket is `Read` only, with no `List`. The FE adds the public storage host to `next/image` `remotePatterns`.
**Libraries:** @aws-sdk/client-s3

## Inherited Decisions Detail

### phase-01-configuracao-base/TD-01

**Recommendation:** Option A (@nestjs/config) — Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem: the factory function can be imported as a plain function by `data-source.ts` while also serving as a DI injection token inside NestJS. Building a custom module recreates solved functionality; third-party packages carry maintenance risk.

**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** Option A (Joi) — First-class integration with `@nestjs/config` via `validationSchema`, requiring zero custom wiring. Handles string-to-number coercion natively. Using a different tool for env validation vs. request validation is reasonable — env config is validated once at startup, DTOs are validated per-request. Zod is elegant but adds a third validation paradigm to the project.

**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** Option B (Namespaced/grouped with registerAs) — The project roadmap explicitly calls for auth, email, and storage in upcoming phases. Namespaced configs provide clear file boundaries per domain, typed injection via `ConfigType<typeof databaseConfig>`, and natural scalability. The `registerAs()` factory is dual-purpose: DI token inside NestJS and plain importable function for `data-source.ts`. Initial files for Phase 01: `src/config/database.config.ts`, `src/config/app.config.ts`.

**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** Option A (Shared registerAs factory) — Natural outcome of choosing `@nestjs/config` with `registerAs`. The factory is already callable by design. `data-source.ts` imports it, calls `dotenv.config()`, then calls the factory. Zero duplication, minimal code, no extra abstraction.

**Libraries:** `dotenv` (transitive via `@nestjs/config`)

### phase-02-auth/TD-01

**Recommendation:** Argon2id — For a greenfield project in 2026, Argon2id is the OWASP-recommended choice. The native build dependency is a one-time Docker setup cost. The project has no legacy constraints favoring bcrypt. OWASP minimum: 19MiB memory, 2 iterations.

**Libraries:** `argon2@^0.41.x`

### phase-02-auth/TD-02

**Recommendation:** Option A (@nestjs/passport) — The project plan includes only email/password auth for now, but the plugin architecture costs little and future phases may add social login. Aligns with official NestJS docs, making onboarding and maintenance easier.

**Note:** Decision deliberately diverged from the Recommendation during implementation — custom guards were preferred over `@nestjs/passport` to keep the dependency surface smaller; social login is not on the near-term roadmap, so the plugin-architecture benefit did not justify the extra abstraction layer.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-03

**Recommendation:** Option A (Refresh Token Rotation) — Provides the strongest security model with automatic theft detection. The DB write overhead is acceptable for a video platform (auth refresh is infrequent vs. video operations). PostgreSQL is already in the stack, so no new infrastructure needed. Race conditions can be mitigated with a short grace period for the old token.

**Libraries:** —

### phase-02-auth/TD-04

**Recommendation:** Option B (Random Opaque Tokens in DB) — Revocability is important: when a user requests a new password reset, previous tokens should be invalidated. The DB table is trivial to implement, and the tokens table can also serve future needs (e.g., API keys). Keeps email tokens decoupled from the JWT auth system.

**Libraries:** —

### phase-02-auth/TD-05

**Recommendation:** Option A (@nestjs-modules/mailer) — Best NestJS integration with minimal boilerplate. Supports SMTP (matching the architecture diagram), works with MailHog/Mailpit for local development without external dependencies, and scales to any SMTP provider in production. Template engine support (Handlebars) simplifies email formatting. No vendor lock-in.

**Libraries:** `@nestjs-modules/mailer@^2.x`, `handlebars@^4.x`

### phase-02-auth/TD-06

**Recommendation:** Option A (class-validator + class-transformer) — This is a backend-only project (no shared schemas with frontend), so Zod's single-source-of-truth advantage is less impactful. class-validator is the documented NestJS approach, and the project already uses decorators extensively (TypeORM entities, NestJS DI). Fewer integration surprises with NestJS 11.

**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Option A (Custom Domain Exception Filter) — Provides machine-readable error codes that the Next.js frontend can switch on, without the overhead of RFC 9457's URI-based type system. The project is single-consumer (first-party frontend), so a simple `{ statusCode, error, message }` format with domain codes balances clarity and simplicity. The custom filter cost is low — two small files.

**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** Option A (@nestjs/throttler) — Native NestJS integration is decisive: the guard system allows scoping rate limiting to `AuthModule` only via module-level `APP_GUARD`, with `@SkipThrottle()` for exemptions. The project is single-instance with no distributed requirements, so in-memory storage is sufficient. Using express-rate-limit would bypass NestJS's DI and guard lifecycle for no clear benefit.

**Libraries:** `@nestjs/throttler@^6.x`

### phase-02-auth/TD-09

**Recommendation:** Option B (Opaque) — Since DB lookup is mandatory (TD-03), JWT signature adds no security value. Opaque tokens are shorter, leak no data, and are simpler to generate.

**Note:** Decision deliberately diverged from the Recommendation — JWT was kept to reuse the access-token signing/verification infrastructure (`@nestjs/jwt`), trading token size and base64-readability for a single token format across the codebase.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-10

**Recommendation:** Option A — The platform is a video sharing service with URL-based channel handles. A strict `[a-z0-9_]` allowlist is the simplest and most portable choice: no extra dependencies, no edge cases around hyphen positioning, and the `user_<random>` fallback provides a valid handle even for extreme email prefixes. Hyphens can always be added in a future iteration if user feedback justifies it.

**Libraries:** —

### phase-02-auth-frontend/TD-01

**Recommendation:** Three reasons. (1) **Architectural fit.** The strict-BFF model in `next-frontend-config-base/TD-03` already nominates the Route Handler as the only NestJS caller; cookie-based sessions are the natural match, and Auth.js's framework adds layers between the BFF and the cookie that buy nothing because the backend is the auth authority — Auth.js's value (DB adapters, OAuth providers, magic-link, `getServerSession` helpers) is mostly unused in this configuration. (2) **Smaller blast radius.** A ~50-LOC session helper is grep-friendly, debuggable, and test-friendly via the existing MSW+BFF integration test pattern; a misconfigured Auth.js callback is a longer fault-isolation loop. (3) **Compatibility with Next.js 16 / React 19.** Built-in `next/headers` `cookies()` is the canonical primitive both runtimes already use; Auth.js v5 versions track Next.js majors with a lag, adding compatibility risk that Option A does not have. Option C is rejected as unsafe (`localStorage` for refresh tokens) and architecturally regressive (loses RSC personalization).
**Libraries:** —

### phase-02-auth-frontend/TD-02

**Recommendation:** Three reasons. (1) **Defense in depth on the cookie content** — `httpOnly` blocks JS, encryption blocks accidental log/proxy inspection; the marginal cost is one ~3KB dep. (2) **Single cookie to manage** simplifies logout (one `session.destroy()` call) and avoids the orphan-cookie failure mode of Option A. (3) **Room to carry minimal user metadata** (`userId`, `email`, `channelSlug`) lets `app/layout.tsx` RSC render the authenticated chrome (avatar, channel name) without a per-render `/auth/me` round-trip — Phase 04+ gains compound here. Option A is a viable downgrade if the team rejects `iron-session` for any reason; the migration A→B (or B→A) is a one-Route-Handler refactor with no test changes downstream because the BFF interface is unchanged. Option C is rejected: it solves a problem (server-side revocation) the project does not have at the cost of infrastructure the project does not own.
**Libraries:** iron-session

### phase-02-auth-frontend/TD-03

**Recommendation:** The single-flight detail is non-trivial and goes in the helper from day one — tested by MSW with a "two concurrent intercepted upstream calls; one refresh expected" assertion. Option B's client-driven pattern is rejected because it doesn't replace Option A (RSC still needs server-side refresh) — adopting B means doing both. Option C's pre-emptive timer is rejected because the failure modes (multiple tabs, sleep/wake) outweigh the latency saving and force a `"use client"` shell near the root.
**Libraries:** —

### phase-02-auth-frontend/TD-04

**Recommendation:** Three reasons. (1) **Decoupled from TD-05** — works with Route Handlers OR Server Actions; the form code does not change if TD-05 is revisited later. (2) **Aligned with shadcn's canonical form primitive** — the project already commits to `radix-nova` shadcn (`components.json`); `npx shadcn@latest add form` produces react-hook-form wrappers; choosing react-hook-form means using the supported primitive instead of hand-rolling around it. (3) **Zod-first developer ergonomics match the rest of the FE foundation** — `next-frontend-config-base/TD-01` chose Zod 4 for env; the same schemas-as-source-of-truth pattern carries to forms with zero new validator paradigm. Option B is rejected for impedance with shadcn's primitive and for over-investing in progressive-enhancement that the strict-BFF model does not require. Option C is rejected for the per-field boilerplate and the loss of client-side feedback on a project that values quick, type-safe form iteration.
**Libraries:** react-hook-form, @hookform/resolvers

### phase-02-auth-frontend/TD-05

**Recommendation:** Three reasons. (1) **Strict-BFF alignment.** `next-frontend-config-base/TD-03` named Route Handlers as the BFF surface; Option A keeps every mutation visible under `app/api/**`. (2) **Test scaffold already exists** — `next-frontend/CLAUDE.md` § Testing and `next-frontend-msw-foundation` were authored for Route-Handlers-as-functions; Option A reuses them with zero invention. (3) **Single mutation surface** — Phase 02 sets the precedent for Phases 03–07; uniformity beats per-mutation idiom-picking when the cost of inconsistency compounds (Option C). Option B has real ergonomic appeal for the simplest forms but fragments the BFF surface and forces test-pattern reinvention; if the team later wants progressive enhancement for specific forms, the migration A→B is per-form and doesn't require touching unrelated routes — A is the safer default and the cheaper baseline.
**Libraries:** —

### phase-02-auth-frontend/TD-06

**Recommendation:** Two reinforcing reasons. (1) **No first-render flicker, no round-trip** — the session is delivered in the same response as the page HTML; the Client Provider hydrates with the correct initial state; users never see "Login" briefly turn into their avatar. (2) **No new BFF endpoint** — the cookie is the source of truth, RSC reads it, the Provider broadcasts it; the BFF surface stays minimal. The `router.refresh()` requirement after mid-session mutations is a small price (one line in the relevant mutation handler) for the structural benefits. Option B is rejected for the double-read-and-flicker; Option C is dominated by Option B and rejected.
**Libraries:** —

### phase-02-auth-frontend/TD-07

**Recommendation:** Three reasons. (1) **First-paint-correct** — the user sees the right outcome on the first paint, no skeleton, no flicker. (2) **Single integration pattern across both flows** — confirmation is RSC-only; reset is RSC + Client form (TD-04, TD-05 patterns reused) — both share the "RSC owns the token, Client Component owns the input" split. (3) **Email-prefetch behavior** is solved at the backend's idempotent-confirmation level (a small note for `/plan-build` to confirm; not a separate TD). Option B's Route-Handler-as-link-target adds redirects for no clean gain. Option C is dominated.
**Libraries:** —

### openapi-docs-nestjs/TD-01

**Recommendation:** é a única opção que preserva as decisões anteriores (`class-validator` em TD-06 de phase-02-auth) sem re-platform; o CLI plugin com `classValidatorShim: true` aproveita os decoradores `class-validator` existentes para inferir schemas, mantendo o boilerplate baixo. Nestia tem mérito técnico real mas o custo de migração do stack de validação inviabiliza-a sem uma decisão upstream de supersede de TD-06. Manual authoring é descartado.
**Libraries:** @nestjs/swagger
**Revisions:**

- 2026-05-12 — Esclarece que o CLI plugin (`classValidatorShim: true`) cobre apenas inferência de schemas de DTOs a partir de `class-validator`; documentação de operações, respostas tipadas por status code, contratos de erro (alinhados ao envelope de phase-02-auth/TD-07) e exemplos exigem decoradores explícitos (`@ApiOperation`, `@ApiResponse`, `@ApiBody`, `@ApiParam`, `@ApiQuery`, `@ApiExtraModels`). _Rationale:_ openapi.json gerado pelo bootstrap atual está genérico — sem detalhes de parâmetros, schemas de retorno por status, nem contratos de erro — porque a base instalada se apoiou só na introspecção automática. Esta revisão fixa que enriquecimento via decoradores explícitos faz parte da Option A escolhida, não é trabalho fora do escopo do TD.

### openapi-docs-nestjs/TD-02

**Recommendation:** o custo marginal sobre Option A é apenas um npm script (~15 linhas) e o benefício é uma fundação correta para futura integração FE (codegen offline) sem perder a UI interativa que dev/QA usam. Option B sozinho pune a experiência de desenvolvimento em dev/local; Option A sozinho compromete o pipeline de codegen futuro. Combinar é dominante.
**Libraries:** —

### openapi-docs-nestjs/TD-03

**Recommendation:** alinha com a postura defensiva já estabelecida em phase 02 e não compromete consumidores legítimos (o `openapi.json` commitado em TD-02 cumpre o papel de "spec consultável fora da UI"). Re-abrir como Option A ou C é trivial no futuro se um caso de uso de API pública aparecer.
**Libraries:** —

### next-frontend-config-base/TD-01

**Recommendation:** Three converging reasons: (1) **Type-inference matches the FE's strict-TS culture** — `lib/env.ts` exports a typed `env` object with no `as` casts, satisfying the project's "Type Safety" working principle. (2) **Ecosystem gravity in Next.js / React 19** — Zod is the de-facto schema language for App Router (Server Actions inputs, form resolvers, future contract validation), so introducing it once at the env layer compounds value for forms in Phase 02+. (3) **Direct enablement of TD-02 Option A (`@t3-oss/env-nextjs`)** — t3-env's first-citizen validator. Backend parity with Joi is not load-bearing: env schemas are not shared FE↔BE (different runtimes, different key sets); two validators across two subprojects is a bounded cost.
**Libraries:** zod

### next-frontend-config-base/TD-02

**Recommendation:** The only option that combines (i) **type-level NEXT_PUBLIC_ prefix enforcement**, (ii) **runtime Proxy-based leak detection**, and (iii) **single-file, single-import-path consumer ergonomics**. Option B reaches roughly the same _structural_ outcome at higher implementation and maintenance cost, with a weaker guarantee (no prefix enforcement, no proxy). Option C is unsafe at any non-trivial team size. The marginal cost over B is one ~3KB dep — well-spent for the strongest boundary among the three.
**Libraries:** @t3-oss/env-nextjs

### next-frontend-config-base/TD-03

**Recommendation:** Aligned with the BFF testing strategy and architectural commitment already documented in `next-frontend/CLAUDE.md` (Route Handlers as the only NestJS caller; BFF tests stub `fetch` via MSW). Eliminates CORS, eliminates public exposure of the backend URL, and produces the smallest correct foundation. Option B's `NEXT_PUBLIC_API_URL` is a future-proofing concession with no current consumer — and adding a public key later is a non-breaking change, while removing one is breaking. Option C ties a foundational decision to infra work explicitly deferred elsewhere. The Docker networking gap (how server-in-container resolves the backend) is a separate orthogonal decision, surfaced below.
**Libraries:** —

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in... _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema`... _(from phase 01)_
- Config is injected into modules via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable... _(from phase 01)_
- `data-source.ts` loads `.env` via `import 'dotenv/config'` at the top, then imports `databaseConfig` and calls it as a plain... _(from phase 01)_
- Database connection parameters (host, port, etc.) are sourced from a single `databaseConfig` factory — never duplicated between... _(from phase 01)_
- `TypeOrmModule.forRootAsync` is used (not `forRoot`), with `imports: [ConfigModule]`, `inject: [databaseConfig.KEY]`,... _(from phase 01)_

## Inherited Deferred Capabilities

| Capability | Status | Origin phase | Rationale |
|-----------|--------|--------------|-----------|
| Telas de frontend | deferred | phase-01-configuracao-base | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| Telas de cadastro, login, confirmação de conta e recuperação de senha | deferred | phase-02-auth | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| "Confirmação de conta via e-mail com link de ativação" | deferred | phase-02-auth-frontend | deferred_to_next_phase — UI landing screen de-scoped 2026-05-14; FE confirmation flow (TD-07) picked up by a future phase. BE side unchanged in `phase-02-auth`. |
| "Logout" | deferred | phase-02-auth-frontend | deferred_to_next_phase — logout button lives inside authenticated chrome (typically Phase 04). Phase 02 still implements POST `/api/auth/logout` (BFF route handler + `session.destroy()`) so the contract is ready when the chrome lands. |
| "Recuperação de senha (destination screen / set-new-password)" | deferred | phase-02-auth-frontend | deferred_to_next_phase — `/forgot-password` ships this phase sending the e-mail; the reset-password destination screen is absent from Figma → link destination remains a 404 until a later phase delivers the screen via `/screen-inventory` extension run. Documented as a known gap. |
| "Telas de cadastro, login, confirmação de conta e recuperação de senha" | deferred | phase-02-auth-frontend | a tela de confirmação da conta não será implementada nesta fase corrente, será adiada — the umbrella bullet's full coverage requires the confirmação and reset-password destination screens; both are deferred per Non-UI rows above. The 3 ship-this-phase telas (signup, login, forgot-password) are inventoried and covered by their own verbs; the umbrella bullet itself is deferred to the phase that lands the missing screens. |

## UI Inventory

_No screen inventory — UI↔API sync deferred. Run /screen-inventory 03 and then rerun /plan-context 03 to activate UI checks._

## Non-UI / Deferred Capabilities

_None._

## Testing Requirements

### nestjs-project

| Artifact type | Required layers |
|---------------|-----------------|
| Entity (`*.entity.ts`) | Integration: constraints, defaults, `select: false` |
| Service with branching + DB | Unit: branch logic (mock repo) + Integration: DB contract |
| Service with DB only (no branching) | Integration: DB contract |
| Service with configured lib (JWT, cache) | Unit: real lib with test config |
| Service with side-effect dep (email, storage) | Integration: real capture service (Mailpit) or real S3 emulator (SeaweedFS) |
| Module with configured imports | Unit: compilation test |
| Controller | E2E only — do NOT write unit tests |
| DTO | E2E: one validation wiring test per endpoint |
| Guard (delegates to service for business logic) | E2E + Unit if complex internal logic |
| Guard (simple, delegates to Passport) | E2E only |
| Strategy (Passport) | E2E via guard |
| Pipe (custom transformation/validation) | Unit |
| Interceptor (response transform, logging) | Unit and/or E2E |
| Exception Filter | Unit + E2E |
| Middleware | E2E |

### next-frontend

_Deferred subproject — testing requirements will be defined when the testing-guide skill is loaded for the future frontend slice of this phase._
