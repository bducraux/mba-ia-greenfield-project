---
kind: phase
name: phase-03-upload-processing
status: dirty
issue_count: 11
sources_mtime:
  # UNVERIFIED — `stat` was not available in the session that generated this file.
  # Replace with real `stat -c '%y'` values (or rerun /plan-validate 03) before /plan-build.
  docs/phases/phase-03-upload-processing/context.md: "UNVERIFIED"
  docs/decisions/technical-decisions-phase-03-upload-processing.md: "2026-10-03T18:53:18-03:00"
issues:
  - id: IC-1
    status: open
    summary: "TD-03 (Scope: Frontend) orphaned — UI Inventory deferred"
  - id: IC-2
    status: open
    summary: "TD-13 (Scope: Frontend) orphaned — UI Inventory deferred"
  - id: IC-3
    status: open
    summary: "TD-01 (S3 everywhere) vs testing guide 'local adapter' for storage"
  - id: AMB-1
    status: open
    summary: "Who may stream/download a video in Phase 03 (owner only vs anyone)?"
  - id: AMB-2
    status: open
    summary: "processing_status values and failure/abandon semantics undefined"
  - id: AMB-3
    status: open
    summary: "Draft pre-registration: required fields, defaults and owner entity"
  - id: MD-1
    status: open
    summary: "No TD fixes accepted input formats / MIME allowlist at initiate"
  - id: MD-2
    status: open
    summary: "No TD on public-read thumbnails vs private videos in one bucket"
  - id: OQ-1
    status: open
    summary: "TD-03 pending — Frontend Upload Client"
  - id: OQ-2
    status: open
    summary: "TD-12 pending — Processing Status Propagation to the Frontend"
  - id: OQ-3
    status: open
    summary: "TD-13 pending — Frontend Test Strategy for Browser → Storage"
advisories: []
---

# phase-03-upload-processing — Validation

## Findings

### Inconsistencies

- **IC-1** — TD `phase-03-upload-processing/TD-03` (Frontend Upload Client) has `Scope: Frontend`, but phase 03 has no active UI scope: `## UI Inventory` holds the deferred placeholder (`_No screen inventory — UI↔API sync deferred…_`). The TD would be orphaned in the final artifact. Backend subsections filter it out (Decisão #17), and the UI Contracts subsection is not emitted. Explicit choice: (a) change TD Scope to `Cross-layer` if the decision also informs backend contracts (e.g., the part-URL re-sign / complete endpoints); (b) add active UI scope (run `/screen-inventory 03` without picking 'defer', then rerun `/plan-context 03`); (c) remove the TD if it is out of scope for this phase; (d) mark TD as `Renders in: frontend-runtime` and flip UI Inventory to logic-only via `/plan-resolve` (use when the TD is FE-runtime architectural-transversal and the phase has no UI surface).
- **IC-2** — TD `phase-03-upload-processing/TD-13` (Frontend Test Strategy for Browser → Storage Traffic) has `Scope: Frontend`, but `## UI Inventory` is the deferred placeholder. `## Testing Requirements → next-frontend` also reads "_Deferred subproject_". The TD would be orphaned in the final artifact. Explicit choice: (a) change TD Scope to `Cross-layer`; (b) add active UI scope via `/screen-inventory 03` + `/plan-context 03`; (c) remove the TD if out of scope; (d) mark TD as `Renders in: frontend-runtime` and flip UI Inventory to logic-only via `/plan-resolve`.
- **IC-3** — The two sources disagree on how storage is tested. `phase-03-upload-processing/TD-01` says "S3 API everywhere, SeaweedFS in dev/test … Choosing A replaces the 'local filesystem' strategy in the NestJS testing guide". `## Testing Requirements` (from `testing-guide-nestjs-project`) still says "Service with side-effect dep (email, storage) | Integration: real capture service (Mailpit) or **local adapter**". Explicit choice: (a) update `.claude/skills/testing-guide-nestjs-project/SKILL.md` so storage integration tests run against SeaweedFS (S3 API), then rerun `/plan-context 03`; (b) revise TD-01 to keep a local-adapter path for tests, which would undercut the S3-semantics argument that TD-02/05/09 rely on.

### Ambiguities

- **AMB-1** — The capabilities "Reprodução via streaming (sem necessidade de download completo)" and "Download do vídeo pelo usuário" don't say who may play or download a video in Phase 03. Per TD-11 every Phase-03 video stays in `publication_status` = draft, because publication belongs to Phase 04. TD-05 issues presigned GETs but sets no authorization rule for drafts. Explicit choice: does Phase 03 restrict presigned playback/download to the owning user only, or allow any authenticated or anonymous user who knows the short id (TD-10)? Also: does "o usuário" in the download bullet mean the owner or any viewer? State the Phase 03 ↔ Phase 04 boundary explicitly.
- **AMB-2** — TD-11 picked two orthogonal fields (`processing_status` + `publication_status`), but context.md lists neither the allowed values nor the transitions. Several edge cases have no stated outcome: (i) the TD-06 ffprobe compatibility check rejects the file; (ii) the FFmpeg job exhausts BullMQ retries (TD-07); (iii) the multipart upload is abandoned, so storage aborts it after 24h (TD-02) and a draft row is left with no object; (iv) the reconciliation sweep from TD-07 finds a stuck video. Explicit choice: list the `processing_status` values (e.g., `uploading | processing | ready | failed`), the terminal outcome and user-visible signal for each failure case, and what happens to orphan draft rows.
- **AMB-3** — The capability "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload" doesn't define what the pre-registered record contains. Open points: which fields are required at initiate (title from file name? empty?), which are filled later by the worker (duration, metadata, thumbnail), and which entity owns the video (user vs. the user's channel from phase-02-auth/TD-10). Explicit choice: define the initiate payload and the draft row's default values, plus the owner relationship.

### Missing Decisions

- **MD-1** — The capability "Upload de vídeos com suporte a arquivos de até 10GB…" fixes a size limit (TD-02: 10 GiB checked at initiate and at complete), but no TD fixes the **accepted input formats**. TD-06 serves the original file "gated by ffprobe compatibility check" and TD-05 assumes MP4/WebM in `<video src>`. Without a declared allowlist (MIME/container/codec) checked at initiate, unsupported files are only rejected after a full 10GB upload. Explicit choice: run `/research` (or `/decide`) to add a TD setting the input-format allowlist and where each check happens (declared MIME at initiate vs. ffprobe in the worker).
- **MD-2** — The capability "Serviço de armazenamento de arquivos (vídeos e thumbnails)" needs public-read thumbnails and private, presigned-only videos (TD-05 Option C). TD-04, however, defines a single `STORAGE_BUCKET` key, and no TD says how the two access levels coexist. Options include a prefix-scoped anonymous-read bucket policy (SeaweedFS support needs checking per TD-01's fallback note), two buckets, or proxying thumbnails. The choice also determines the stable thumbnail URL shape built on `STORAGE_PUBLIC_ENDPOINT`. Explicit choice: run `/research` to add a TD covering the thumbnail public-access mechanism and the URL format.

### Dependency Gaps

_None._

### Inherited Constraint Conflicts

_None._

### Unresolved Open Questions

- **OQ-1** — TD-03 pending — Frontend Upload Client. Resolution: fill the **Decision:** field of TD-03 in `docs/decisions/technical-decisions-phase-03-upload-processing.md`, then re-run `/plan-validate 03`.
- **OQ-2** — TD-12 pending — Processing Status Propagation to the Frontend. Resolution: fill the **Decision:** field of TD-12 in `docs/decisions/technical-decisions-phase-03-upload-processing.md`, then re-run `/plan-validate 03`.
- **OQ-3** — TD-13 pending — Frontend Test Strategy for Browser → Storage Traffic. Resolution: fill the **Decision:** field of TD-13 in `docs/decisions/technical-decisions-phase-03-upload-processing.md`, then re-run `/plan-validate 03`.

### UI Coverage Gaps

_None._ _(UI Inventory deferred — check not applicable.)_

## Resolved Issues

_No issues resolved yet._
