---
kind: phase
name: phase-03-upload-processing
status: dirty
issue_count: 2
sources_mtime:
  docs/phases/phase-03-upload-processing/context.md: "2026-10-04T10:34:22-03:00"
  docs/decisions/technical-decisions-phase-03-upload-processing.md: "2026-10-04T10:31:48-03:00"
issues:
  - id: IC-1
    status: resolved
    summary: "TD-03 (Scope: Frontend) orphaned — UI Inventory deferred"
    resolved_by: phase-03-upload-processing/TD-03
  - id: IC-2
    status: resolved
    summary: "TD-13 (Scope: Frontend) orphaned — UI Inventory deferred"
    resolved_by: phase-03-upload-processing/TD-13
  - id: IC-3
    status: resolved
    summary: "TD-01 (S3 everywhere) vs testing guide 'local adapter' for storage"
    resolved_by: testing-guide-nestjs-project/SKILL.md (storage integration → real S3 emulator SeaweedFS)
  - id: IC-4
    status: resolved
    summary: "TD-15 claims a Revision of TD-04 (STORAGE_THUMBNAILS_BUCKET) not recorded"
    resolved_by: phase-03-upload-processing/TD-04
  - id: IC-5
    status: resolved
    summary: "TD-14 decided A, but its parameters prescribe the FE probe of option B"
    resolved_by: phase-03-upload-processing/TD-14
  - id: IC-6
    status: resolved
    summary: "TD-14 accepts MOV, but TD-06 playback contract is MP4/WebM original"
    resolved_by: phase-03-upload-processing/TD-14
  - id: IC-7
    status: open
    summary: "TD-15 prescribes FE next/image remotePatterns in a backend-only phase"
  - id: AMB-1
    status: resolved
    summary: "Who may stream/download a video in Phase 03 (owner only vs anyone)?"
    resolved_by: clarification
  - id: AMB-2
    status: resolved
    summary: "processing_status values and failure/abandon semantics undefined"
    resolved_by: clarification
  - id: AMB-3
    status: resolved
    summary: "Draft pre-registration: required fields, defaults and owner entity"
    resolved_by: clarification
  - id: AMB-4
    status: open
    summary: "Outcome of complete-time HeadObject check failure is undefined"
  - id: MD-1
    status: resolved
    summary: "No TD fixes accepted input formats / MIME allowlist at initiate"
    resolved_by: phase-03-upload-processing/TD-14
  - id: MD-2
    status: resolved
    summary: "No TD on public-read thumbnails vs private videos in one bucket"
    resolved_by: phase-03-upload-processing/TD-15
  - id: MD-3
    status: resolved
    summary: "No TD on who provisions buckets, CORS, lifecycle and public-read"
    resolved_by: phase-03-upload-processing/TD-16
  - id: OQ-1
    status: resolved
    summary: "TD-03 pending — Frontend Upload Client"
    resolved_by: phase-03-upload-processing/TD-03
  - id: OQ-2
    status: resolved
    summary: "TD-12 pending — Processing Status Propagation to the Frontend"
    resolved_by: phase-03-upload-processing/TD-12
  - id: OQ-3
    status: resolved
    summary: "TD-13 pending — Frontend Test Strategy for Browser → Storage"
    resolved_by: phase-03-upload-processing/TD-13
advisories: []
---

# phase-03-upload-processing — Validation

## Findings

### Inconsistencies

- **IC-7** — TD-03, TD-12 and TD-13 all fix Phase 03 as "backend only, UI deferred to Phase 03 FE slice", and IC-5 already removed an FE-side parameter from TD-14 for the same reason. TD-15's Recommendation still prescribes FE work: "The FE adds the public storage host to `next/image` `remotePatterns`." TD-15 has no Revision addressing it, and the regenerated context still carries the sentence. `/plan-build` would either emit an FE step in a backend-only phase or drop the parameter silently. Explicit choice: (a) append a Revision to TD-15 moving the `remotePatterns` parameter to a recorded follow-up for the Phase 03 frontend slice (same treatment as IC-5); (b) keep it and add `next-frontend` as an affected subproject of this phase (contradicts TD-03/TD-12/TD-13).

### Ambiguities

- **AMB-4** — TD-02 says the 10 GiB limit is "re-checked at complete via `HeadObject`". The TD-11 revision defines only `uploading → processing` on multipart complete, and its `failure_reason` set (`UNSUPPORTED_FORMAT`, `PROCESSING_FAILED`, `SOURCE_MISSING`) has no code for a complete-time violation. Neither TD-02 nor TD-11 gained a Revision on this point, and TD-16 covers only bucket configuration. Undefined: what the complete endpoint does when the assembled object exceeds 10 GiB or differs from the declared `size`. Open points are the HTTP status and domain code, whether the object is deleted, and the row's resulting state (stays `uploading`, a new `uploading → failed` transition with a new reason code, or row deleted). Explicit choice: clarify the complete-time rejection behavior and record it as a Revision of TD-02 / TD-11.

### Missing Decisions

_None._

### Dependency Gaps

_None._

### Inherited Constraint Conflicts

_None._

### Unresolved Open Questions

_None._

### UI Coverage Gaps

_None._ _(UI Inventory deferred — check not applicable.)_

## Resolved Issues

- **IC-3** _(resolved_by testing-guide-nestjs-project/SKILL.md)_ — TD-01 (S3 everywhere) vs testing guide 'local adapter' for storage. The regenerated `## Testing Requirements` now reads "Service with side-effect dep (email, storage) | Integration: real capture service (Mailpit) or real S3 emulator (SeaweedFS)", consistent with TD-01 A.
- **MD-1** _(resolved_by phase-03-upload-processing/TD-14)_ — No TD fixes accepted input formats / MIME allowlist at initiate. TD-14 (decided A) defines the declared-metadata allowlist at initiate plus the ffprobe codec gate.
- **MD-2** _(resolved_by phase-03-upload-processing/TD-15)_ — No TD on public-read thumbnails vs private videos in one bucket. TD-15 (decided B) splits them into a private `STORAGE_BUCKET` and a public-read `STORAGE_THUMBNAILS_BUCKET`, and fixes the thumbnail URL shape.
- **IC-1** _(resolved_by phase-03-upload-processing/TD-03)_ — TD-03 (Scope: Frontend) orphaned — UI Inventory deferred. Option (c): removed from this phase. TD-03 `**Decision:**` = "Out of scope — Phase 03 delivers backend only (UI deferred); revisit in the Phase 03 frontend slice".
- **IC-2** _(resolved_by phase-03-upload-processing/TD-13)_ — TD-13 (Scope: Frontend) orphaned — UI Inventory deferred. Option (c): removed from this phase. TD-13 `**Decision:**` = "Out of scope — Phase 03 delivers backend only (UI deferred); revisit in the Phase 03 frontend slice".
- **IC-4** _(resolved_by phase-03-upload-processing/TD-04)_ — TD-15 claims a Revision of TD-04 not recorded. Option (a): Revision appended to TD-04 adding `STORAGE_THUMBNAILS_BUCKET` to the canonical key list and clarifying that `STORAGE_BUCKET` is the private video bucket (TD-15 B).
- **IC-5** _(resolved_by phase-03-upload-processing/TD-14)_ — TD-14 decided A, but its parameters prescribed the FE probe of B. Option (c): A kept for this phase; Revision appended to TD-14 removing the FE-probe parameter. Codec rejection happens only at the worker's ffprobe gate; the browser playability probe is a recorded follow-up for the future Phase 03 frontend slice.
- **IC-6** _(resolved_by phase-03-upload-processing/TD-14)_ — TD-14 accepted MOV, but TD-06's playback contract is MP4/WebM original. Option (a): Revision appended to TD-14 removing MOV. Final allowlist: `video/mp4` (`.mp4`, `.m4v`) and `video/webm` (`.webm`).
- **AMB-1** _(resolved_by clarification)_ — Who may stream/download a video in Phase 03. Owner only: every Phase-03 video is a draft; presigned streaming and download URLs are issued only to the authenticated owner of the video's channel. Any other user or anonymous caller receives 404 (existence is not revealed). Thumbnails stay in the public bucket by design (TD-15). "O usuário" in the download bullet = the owner. Third-party access depends on publication/visibility, which is Phase 04.
- **AMB-2** _(resolved_by clarification)_ — `processing_status` ∈ `uploading | processing | ready | failed`. Transitions: `uploading → processing` (on multipart complete; enqueues the job), `processing → ready` (ffprobe OK + metadata + thumbnail), `processing → failed`. Column `failure_reason` (code, nullable) with the set: `UNSUPPORTED_FORMAT` (ffprobe rejects container/codec), `PROCESSING_FAILED` (job exhausts BullMQ retries — attempts 3, exponential backoff), `SOURCE_MISSING` (object does not exist at processing time). Owner-visible signal: GET of the video returns `processing_status` + `failure_reason`. The video object of a `failed` video is NOT deleted in this phase (kept for diagnosis; cleanup is a future task). Abandoned upload: the row stays `uploading`; the bucket lifecycle aborts the incomplete multipart after 24h. Cleanup of orphan drafts and the reconciliation sweep are out of scope for Phase 03 (recorded follow-up).
- **AMB-3** _(resolved_by clarification)_ — Initiate payload = `fileName`, `mimeType`, `size` (TD-02/TD-14). No title is requested: the draft is born with `title` = file name without extension (truncated to 100 characters); editing title/description is Phase 04. Defaults: `description` null, `processing_status` = `uploading`, `publication_status` = `draft`, `short_id` generated (TD-10), `original_object_key`, `mime_type`, `size_bytes`, multipart `upload_id`. Filled by the worker: `duration_seconds`, `width`, `height`, `video_codec`, `audio_codec`, `thumbnail_object_key`, `processed_at`. Owner: the authenticated user's channel (`channel_id` FK → channels, per phase-02-auth/TD-10, one channel per user).
- **OQ-1** _(resolved_by phase-03-upload-processing/TD-03)_ — TD-03 pending — Frontend Upload Client. Decision filled: out of scope for Phase 03 (backend only, UI deferred); revisit in the Phase 03 frontend slice.
- **OQ-2** _(resolved_by phase-03-upload-processing/TD-12)_ — TD-12 pending — Processing Status Propagation to the Frontend. Decision filled: out of scope for Phase 03 (backend only, UI deferred); revisit in the Phase 03 frontend slice. Backend contract for status is the owner GET (see AMB-2).
- **OQ-3** _(resolved_by phase-03-upload-processing/TD-13)_ — TD-13 pending — Frontend Test Strategy for Browser → Storage. Decision filled: out of scope for Phase 03 (backend only, UI deferred); revisit in the Phase 03 frontend slice.
- **MD-3** _(resolved_by phase-03-upload-processing/TD-16)_ — No TD on who provisions buckets, CORS, lifecycle and public-read. TD-16 (decided A) adds a one-shot `storage-init` container (`amazon/aws-cli`, idempotent script) for dev/test. It creates both buckets, sets video-bucket CORS (`STORAGE_CORS_ORIGIN`, PUT/GET/HEAD, exposes `ETag`) and a 1-day abort-incomplete-multipart lifecycle rule, and gives the thumbnails bucket anonymous `Read` only. API credentials are object-level only. The prod contract is documented in `docs/`, and IaC is deferred until a deploy phase exists. It is consistent with TD-02 (24h abort), TD-04 (CORS origin) and TD-15 (two buckets, no `List`).
