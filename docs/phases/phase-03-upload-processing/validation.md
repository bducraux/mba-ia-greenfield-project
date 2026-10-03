---
kind: phase
name: phase-03-upload-processing
status: dirty
issue_count: 11
sources_mtime:
  docs/phases/phase-03-upload-processing/context.md: "2026-10-03T20:25:28-03:00"
  docs/decisions/technical-decisions-phase-03-upload-processing.md: "2026-10-03T20:13:01-03:00"
issues:
  - id: IC-1
    status: open
    summary: "TD-03 (Scope: Frontend) orphaned — UI Inventory deferred"
  - id: IC-2
    status: open
    summary: "TD-13 (Scope: Frontend) orphaned — UI Inventory deferred"
  - id: IC-3
    status: resolved
    summary: "TD-01 (S3 everywhere) vs testing guide 'local adapter' for storage"
    resolved_by: testing-guide-nestjs-project/SKILL.md (storage integration → real S3 emulator SeaweedFS)
  - id: IC-4
    status: open
    summary: "TD-15 claims a Revision of TD-04 (STORAGE_THUMBNAILS_BUCKET) not recorded"
  - id: IC-5
    status: open
    summary: "TD-14 decided A, but its parameters prescribe the FE probe of option B"
  - id: IC-6
    status: open
    summary: "TD-14 accepts MOV, but TD-06 playback contract is MP4/WebM original"
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
    status: resolved
    summary: "No TD fixes accepted input formats / MIME allowlist at initiate"
    resolved_by: phase-03-upload-processing/TD-14
  - id: MD-2
    status: resolved
    summary: "No TD on public-read thumbnails vs private videos in one bucket"
    resolved_by: phase-03-upload-processing/TD-15
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
- **IC-4** — `phase-03-upload-processing/TD-15` says "The price is one env key, recorded as a Revision of TD-04 … new key `STORAGE_THUMBNAILS_BUCKET` (added to the TD-04 list)". `## Decisions Detail → TD-04`, however, has no `**Revisions:**` block, and its "Canonical new keys" list (`STORAGE_ENDPOINT`, `STORAGE_PUBLIC_ENDPOINT`, `STORAGE_REGION`, `STORAGE_ACCESS_KEY`, `STORAGE_SECRET_KEY`, `STORAGE_BUCKET`, `STORAGE_FORCE_PATH_STYLE`, `STORAGE_CORS_ORIGIN`) still omits the key. Revisions are rendered for other TDs in this context.md (e.g., `openapi-docs-nestjs/TD-01`), so the absence is real, not a reader artifact. `/plan-build` would get two different env key sets for the storage namespace. Explicit choice: (a) append a `**Revisions:**` entry to TD-04 adding `STORAGE_THUMBNAILS_BUCKET` to the canonical list and clarifying that `STORAGE_BUCKET` is the private video bucket (Append revision via `/plan-resolve`); (b) drop the "Revision of TD-04" claim from TD-15 and make TD-15 the sole owner of the new key.
- **IC-5** — `phase-03-upload-processing/TD-14` is indexed as `Decision: A (declared-metadata allowlist at initiate + ffprobe as the authoritative gate)`, but its Recommendation argues against A alone ("A alone leaves the costly case (wrong codec in an MP4/MOV) undetected until after a 10GB transfer, and B closes most of that gap") and its "Proposed parameters for `/plan-build`" include B's mechanism ("The FE probe has a timeout of a few seconds and falls back to letting ffprobe decide"). The decided letter and the prescribed parameters describe different runtime behavior: is there a browser-side codec probe before upload or not? This also bears on IC-1 / OQ-1, since a FE probe is frontend work in a phase whose UI is deferred. Explicit choice: (a) flip TD-14 to B (or "A + B") via Supersede, keeping the FE probe and accepting it as FE scope; (b) keep A and append a Revision removing the FE-probe parameter (codec rejection happens only at the ffprobe gate); (c) keep A for this phase and move the FE probe to the future FE slice as a recorded follow-up.
- **IC-6** — `phase-03-upload-processing/TD-14` sets the container allowlist to "MP4/MOV/WebM". `phase-03-upload-processing/TD-06` (Decision A: serve the **original** upload, no rendition) defines the playback contract as "a single MP4/WebM URL in `<video src>`", and `TD-05` relies on "MP4 Range playback works natively in browsers". Under TD-06 A, an accepted `.mov` original (`video/quicktime`) is served as-is, which breaks the MP4/WebM contract and is not reliably playable across browsers even with an allowlisted codec (e.g., H.264). The ffprobe gate in TD-14 checks codecs only, not the container. Explicit choice: (a) remove MOV from the TD-14 allowlist (Append revision); (b) keep MOV and add a worker-side remux to MP4 (stream copy, no transcode). That extends TD-06 A/TD-09 to write a second object, so it needs a revision there too; (c) keep MOV as-is and revise TD-06's playback contract to explicitly accept QuickTime with the cross-browser risk documented.

### Ambiguities

- **AMB-1** — The capabilities "Reprodução via streaming (sem necessidade de download completo)" and "Download do vídeo pelo usuário" don't say who may play or download a video in Phase 03. Per TD-11 every Phase-03 video stays in `publication_status` = draft, because publication belongs to Phase 04. TD-15 makes "videos are never public" structural, and TD-05 issues presigned GETs, but neither sets the authorization rule for **issuing** the presigned URL on a draft. Explicit choice: does Phase 03 restrict presigned playback/download to the owning user only, or allow any authenticated or anonymous user who knows the short id (TD-10)? Also: does "o usuário" in the download bullet mean the owner or any viewer? State the Phase 03 ↔ Phase 04 boundary explicitly.
- **AMB-2** — TD-11 picked two orthogonal fields (`processing_status` + `publication_status`), but context.md lists neither the allowed values nor the transitions. TD-14 adds a `failed` state with a reason code and explicitly says "The failure semantics of the `failed` state are AMB-2's concern, not this TD's". Several edge cases still have no stated outcome: (i) the TD-06/TD-14 ffprobe gate rejects the file; (ii) the FFmpeg job exhausts BullMQ retries (TD-07); (iii) the multipart upload is abandoned, so storage aborts it after 24h (TD-02) and a draft row is left with no object; (iv) the reconciliation sweep from TD-07 finds a stuck video. Explicit choice: list the `processing_status` values (e.g., `uploading | processing | ready | failed`), the reason-code set, the terminal outcome and user-visible signal for each failure case, whether a `failed` video's object is deleted, and what happens to orphan draft rows.
- **AMB-3** — The capability "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload" doesn't define what the pre-registered record contains. Open points: which fields are required at initiate (title from file name? empty?), which are filled later by the worker (duration, metadata, thumbnail object key per TD-15), and which entity owns the video (user vs. the user's channel from phase-02-auth/TD-10). Explicit choice: define the initiate payload (beyond the declared `size` / MIME / extension already fixed by TD-02 and TD-14), the draft row's default values, and the owner relationship.

### Missing Decisions

_None._

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

- **IC-3** _(resolved_by testing-guide-nestjs-project/SKILL.md)_ — TD-01 (S3 everywhere) vs testing guide 'local adapter' for storage. The regenerated `## Testing Requirements` now reads "Service with side-effect dep (email, storage) | Integration: real capture service (Mailpit) or real S3 emulator (SeaweedFS)", consistent with TD-01 A.
- **MD-1** _(resolved_by phase-03-upload-processing/TD-14)_ — No TD fixes accepted input formats / MIME allowlist at initiate. TD-14 (decided A) defines the declared-metadata allowlist at initiate plus the ffprobe codec gate.
- **MD-2** _(resolved_by phase-03-upload-processing/TD-15)_ — No TD on public-read thumbnails vs private videos in one bucket. TD-15 (decided B) splits them into a private `STORAGE_BUCKET` and a public-read `STORAGE_THUMBNAILS_BUCKET`, and fixes the thumbnail URL shape.
