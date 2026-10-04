# CLAUDE.md

## Environment Startup Verification

**Default behavior:** starting the environment means starting **only infrastructure services** (database, mail, etc.) — **never** start the NestJS application server unless the user explicitly asks to run/serve the project (e.g., "rode o projeto", "suba o servidor", "run the app").

**Exception — `video-worker`.** `docker compose up -d` also starts the `video-worker` service (the Nest worker process, `npm run start:worker:dev`). It is part of the required infrastructure: without it, completed uploads stay `processing` forever. This exception covers only the worker; the HTTP API (`npm run start:dev`) still starts only on explicit request. On a fresh checkout the worker waits (logging every 5 s) until `node_modules/.package-lock.json` exists, i.e. until `npm install` has finished in `nestjs-api`; it never installs dependencies itself and has no restart policy.

After starting infrastructure, always confirm the containers are up before proceeding:

```bash
docker compose ps   # all services must show status "running"
```

Then verify each infrastructure service is actually ready to accept connections — not just running:

- **PostgreSQL:** `docker compose exec db pg_isready -U streamtube` — expect `accepting connections`
- **Redis:** `docker compose exec redis redis-cli ping` — expect `PONG`
- **SeaweedFS (S3 gateway):** `docker compose exec seaweedfs wget -q -O /dev/null http://127.0.0.1:8333/healthz` — expect exit code `0` (from the host: `curl -s -o /dev/null -w '%{http_code}' http://localhost:8333/healthz` → `200`)
- **storage-init:** `docker compose ps -a storage-init` — expect `Exited (0)` (one-shot; it provisions the buckets and exits). `docker compose logs storage-init` shows `bucket …: created` / `already exists`, `CORS applied`, `lifecycle applied`
- **video-worker:** `docker compose logs video-worker` — expect `Found 0 errors. Watching for file changes.` followed by `VideoProcessingConsumerModule dependencies initialized`, and no `ERROR` lines. If it shows `waiting for node_modules`, run `docker compose exec nestjs-api npm install`

Only start the NestJS dev server (`npm run start:dev`) when the user **explicitly** asks to run the application — never as part of "start the environment".

## Development Environment

This project runs inside Docker. Always use the container for development:

```bash
# Start containers
docker compose up -d

# Install dependencies (first time only)
docker compose exec nestjs-api npm install

# Run the dev server (watch mode)
docker compose exec nestjs-api npm run start:dev
```

Services:
- `nestjs-api` — NestJS API, port `3000` (the container idles; the API runs only via `npm run start:dev`)
- `video-worker` — video processing worker (same image and bind mount as `nestjs-api`, no ports); starts with `docker compose up`
- `db` — PostgreSQL 17, port `5432`, database `streamtube`, user/password `streamtube`
- `mailpit` — SMTP capture, SMTP port `1025`, web UI `http://localhost:8025`
- `redis` — Redis 7.4 (BullMQ broker), port `6379`
- `seaweedfs` — SeaweedFS S3 gateway (`weed mini`), port `8333`; identities rendered by `docker/seaweedfs/entrypoint.sh`
- `storage-init` — one-shot `aws-cli` container running `docker/storage-init/init.sh`: creates both buckets, applies CORS and the abort-multipart lifecycle rule (idempotent). `nestjs-api` and `video-worker` start only after it exits `0`

The object-storage production contract (buckets, CORS, lifecycle, public policy, credential scope) is in `../docs/storage-provisioning.md`.

All verification and teardown commands run on the **host machine**:

```bash
# Verify NestJS is running (expect 200 + "Hello World!")
curl http://localhost:3000

# Verify PostgreSQL is ready (runs inside the db container)
docker compose exec db pg_isready -U streamtube

# Check container logs
docker compose logs nestjs-api
docker compose logs db
docker compose logs video-worker

# Tear down the entire environment
docker compose down
```

## Commands

**Strict rule:** every `npm`, `npx`, `node`, `tsc`, and test command runs **inside the container**, never on the host. Running on the host causes env-var divergence (`DB_HOST` resolves to `localhost` instead of the Compose service), uses a different Node version, and produces results that do not reflect what runs in CI/prod.

### Container-only commands (always prefix with `docker compose exec nestjs-api`)

```bash
npm run start:dev                        # Dev server with hot-reload
npm run build                            # Compile to dist/
npm run start:prod                       # Run compiled build

npm run start:worker:dev                 # Video worker with hot-reload (what the video-worker service runs)
npx nest build --path tsconfig.worker.json  # Compile the worker to dist-worker/
npm run start:worker:prod                # Run the compiled worker (node dist-worker/worker)

npm test                                 # Unit tests
npm run test:watch                       # Unit tests in watch mode
npm run test:cov                         # Coverage report
npm run test:e2e                         # End-to-end tests (always with --runInBand)

npx tsc --noEmit                         # Type-check (required before declaring a task done)
npm run lint                             # ESLint with auto-fix
npm run format                           # Prettier formatting
```

**Why `dist-worker/`:** the worker is a second entrypoint of this codebase (`src/worker.ts` → `WorkerModule`: config, TypeORM and the queue consumer, no HTTP layer). `tsconfig.worker.json` compiles it to `dist-worker/` so the worker's watch build and the API's build (both delete their output dir) never delete each other's output. `dist-worker` is excluded in `tsconfig.json`, `tsconfig.build.json` and `tsconfig.worker.json`, and git-ignored.

### Host-only commands (Docker / connectivity probes)

```bash
docker compose ps
docker compose logs nestjs-api
docker compose exec db pg_isready -U streamtube
docker compose exec redis redis-cli ping
docker compose ps -a storage-init
curl http://localhost:3000
```

### Test execution

Integration and e2e suites share a single test database. They **must** be run with `--runInBand`:

```bash
docker compose exec nestjs-api npm test -- --runInBand
docker compose exec nestjs-api npm run test:e2e   # already configured
```

Parallel execution causes FK violations, deadlocks, and cross-suite contamination because suites truncate or seed shared tables concurrently.

**Infrastructure the tests need.** Integration and e2e suites use the real services, all reached by Compose service name from inside `nestjs-api`: `db`, `redis`, `seaweedfs` (buckets already provisioned by `storage-init`) and `mailpit`. `ffprobe`/`ffmpeg` come from the `nestjs-api` image (`Dockerfile.dev`); rebuild after changing the Dockerfile — `video-worker` builds its own image from the same file (`docker compose build nestjs-api video-worker && docker compose up -d nestjs-api video-worker`). Before running the suites, check the services as described in "Environment Startup Verification".

- **Storage URLs in tests.** Presigned and public URLs are signed for `STORAGE_PUBLIC_ENDPOINT` (`localhost:8333`), which is unreachable from inside the container. Tests do not override it: they send those requests with `storageHttpRequest` (`src/test/storage.ts`), which connects to `STORAGE_ENDPOINT` but keeps the signed `Host` header. Tests delete only the objects and uploads they created.
- **Shared queue.** Suites that must keep their jobs from being consumed (the running `video-worker` listens on the same `video-processing` queue) pause the queue in `beforeAll` and resume it in `afterAll`, removing only their own jobs. If a run is killed in between, the dev queue stays paused; restore it with `docker compose exec redis redis-cli HDEL bull:video-processing:meta paused`.
- **Pipeline e2e.** `test/video-pipeline.e2e-spec.ts` runs the API and a `WorkerModule` context in the same process (`test/helpers/video-pipeline.ts`), so it passes with or without the `video-worker` container running.
- **Video fixtures.** `test/fixtures/videos/` holds small committed clips (`h264-aac.mp4`, `vp9-opus.webm`, `mpeg4.mp4`, `audio-only.mp4`, `not-a-video.mp4`). Regenerate them with `docker compose exec nestjs-api sh scripts/generate-video-fixtures.sh`.

During active development, run only the tests related to the file being changed (`npm test -- path/to/file.spec.ts`). Before declaring a task done, run the full suite — see the global `CLAUDE.md` → "Definition of Done (Technical)".

## Long-running Processes

Commands that never exit (dev server, watch modes) must be run in background in the Bash tool — otherwise the agent blocks indefinitely waiting for the process to return.

This applies to: `start:dev`, `start:prod`, `test:watch`, and any other persistent process.

## Test Type Selection

Choose the suffix by what the test really does, not by where the code under test lives. The suffix is a contract that drives Jest config (`testRegex`, parallelism), CI steps, and reader expectations.

| Suffix                  | Purpose                                                              | DB / external I/O | Location                     |
|-------------------------|----------------------------------------------------------------------|-------------------|------------------------------|
| `*.spec.ts`             | **Unit** — pure logic, all collaborators mocked                      | Forbidden         | Next to the source file      |
| `*.integration-spec.ts` | **Integration** — exercises real DB, real repositories, real modules | Required          | Next to the source file      |
| `*.e2e-spec.ts`         | **End-to-end** — full HTTP cycle via `supertest`                     | Required          | `nestjs-project/test/`       |

A test that constructs a `TypeOrmModule.forRoot`, opens a connection, or hits the `db` service **must** be `*.integration-spec.ts`, never `*.spec.ts`. A test that boots the full Nest application and makes HTTP calls **must** be `*.e2e-spec.ts`.

Conventions for **how to write** each kind of test (mocking patterns, AAA structure, override strategies for global guards, etc.) live in `.claude/rules/nestjs-testing.md` and load when you edit a test file.

## Jest Configuration

These settings are required in `package.json` (jest config) and `test/jest-e2e.json` for the project's tests to work correctly:

- `setupFiles: ["dotenv/config"]` — without this, `.env` is not loaded inside the Jest process. `DB_HOST`, `JWT_SECRET`, etc. fall back to undefined or to the host's `localhost`, breaking container-to-container DNS.
- `testRegex: '.*\\.(spec|integration-spec)\\.ts$'` — covers both unit (`*.spec.ts`) and integration (`*.integration-spec.ts`) suffixes.

Do not add new test-file suffixes; if a new test type is needed, update the regex deliberately.

## Environment File Conventions

`.env` is parsed by both Docker Compose and `dotenv` — values containing shell-special characters (`<`, `>`, `|`, `&`, spaces) **must be quoted** or rewritten:

```dotenv
# Wrong — the unquoted angle brackets are shell redirection syntax and break parsing
MAIL_FROM=StreamTube <noreply@streamtube.local>

# Right — quote the value
MAIL_FROM="StreamTube <noreply@streamtube.local>"
```

Whenever possible, prefer storing only the bare address in `.env` and composing display names in code (e.g., in `mail.config.ts`) so the file stays shell-safe.

## Environment Variables — queue and storage

All keys below are in `.env.example`. The API and worker validate `REDIS_*` and `STORAGE_*` (except the admin keys) in `src/config/env.validation.ts`.

| Variable | Dev value | Purpose |
|---|---|---|
| `REDIS_HOST` | `redis` | BullMQ broker host (Compose service name) |
| `REDIS_PORT` | `6379` | BullMQ broker port |
| `STORAGE_ENDPOINT` | `http://seaweedfs:8333` | S3 endpoint for server-side calls (API and worker) |
| `STORAGE_PUBLIC_ENDPOINT` | `http://localhost:8333` | The **only browser-facing host**: presigned part/playback/download URLs and public thumbnail URLs are built on it (the one allowed exception to "never `localhost`") |
| `STORAGE_REGION` | `us-east-1` | Region used for signing |
| `STORAGE_ACCESS_KEY` / `STORAGE_SECRET_KEY` | `streamtube-app` / … | Application credentials (object-level access to both buckets) |
| `STORAGE_BUCKET` | `streamtube-videos` | Private bucket for uploaded videos |
| `STORAGE_THUMBNAILS_BUCKET` | `streamtube-thumbnails` | Public-read bucket for thumbnails |
| `STORAGE_FORCE_PATH_STYLE` | `true` | Path-style addressing (required by SeaweedFS) |
| `STORAGE_CORS_ORIGIN` | `http://localhost:3001` | Frontend origin allowed by the videos bucket CORS rule (applied by `storage-init`) |
| `STORAGE_ADMIN_ACCESS_KEY` / `STORAGE_ADMIN_SECRET_KEY` | `streamtube-admin` / … | Dev-only admin identity used by `storage-init` to provision buckets. Not read by the API or worker |

## Video Endpoints

All `/videos` routes require a Bearer access token and only expose the caller's own videos (anything else is `404 VIDEO_NOT_FOUND`). Request and response bodies use **snake_case** (`file_name`, `mime_type`, `part_numbers`, `processing_status`, `thumbnail_url`, …). `:shortId` is the 11-character public id.

| Method & path | Purpose |
|---|---|
| `POST /videos` | Create the video and its multipart upload (`file_name`, `mime_type`, `size` ≤ 10 GiB) → `201` |
| `POST /videos/:shortId/upload/part-urls` | Presigned PUT URLs for the requested `part_numbers` |
| `GET /videos/:shortId/upload/parts` | Parts already uploaded (to resume an upload) |
| `POST /videos/:shortId/upload/complete` | Assemble the parts, check the size and enqueue processing → `processing` |
| `GET /videos/:shortId` | Video status and metadata |
| `GET /videos/:shortId/playback-url` | Presigned streaming URL (`ready` only, otherwise `409 VIDEO_NOT_READY`) |
| `GET /videos/:shortId/download-url` | Presigned download URL with `Content-Disposition: attachment` (`ready` only) |

Contracts and error codes: Swagger UI (`/api/docs` when `SWAGGER_ENABLED=true`), `openapi.json`, and sample requests in `api.http`.

## Build Assets

`tsc` (and therefore `nest build`) only emits compiled `.ts` files to `dist/`. Any non-TypeScript runtime asset — Handlebars templates (`.hbs`), JSON fixtures, static config files, etc. — must be declared in `nest-cli.json` under `compilerOptions.assets` (with `watchAssets: true` for dev). Without that, the file exists in `src/` but is missing in `dist/` and runtime fails only after build.

## Architecture

NestJS with standard module structure. Source lives in `src/`, compiled output in `dist/` (API) and `dist-worker/` (worker).

- Each domain feature gets its own module (e.g., `UsersModule`, `VideosModule`) registered in `AppModule`
- Two entrypoints: `src/main.ts` → `AppModule` (HTTP API) and `src/worker.ts` → `WorkerModule` (video worker, no HTTP). `VideoProcessingConsumerModule` is imported **only** by `WorkerModule`, so the API publishes jobs (`VideoProcessingProducerModule`) but never consumes them
- Controllers handle HTTP routing; Services hold business logic; both are scoped to their module

## Code Conventions

- **TypeScript:** `nodenext` module resolution, `ES2023` target, `strictNullChecks` on, `noImplicitAny` off
- **Decorators:** `emitDecoratorMetadata` + `experimentalDecorators` enabled — required for NestJS DI
- **Prettier:** single quotes, trailing commas everywhere
- **ESLint:** `no-explicit-any` allowed; `no-floating-promises` and `no-unsafe-argument` are warnings

## REST Conventions

This is a RESTful API. All endpoints must follow standard REST conventions — correct HTTP methods, proper status codes, plural resource nouns, and consistent URL structure. Details are enforced via rules on controller files.
