# Phase 03 — Manual verification: 10 GiB upload

Run on 2026-10-04 against a fresh clone of `feature/phase-03-videos` (`cp .env.example .env`, `docker compose up -d --build`, `npm ci`, `npm run start:dev`), with the `video-worker` service consuming the queue.

**Input:** a valid H.264/AAC MP4 (20 s, 1280x720, `-movflags +faststart`) padded to exactly 10 GiB (10737418240 bytes), the limit accepted by `POST /videos`.

**Script:** [`upload_10gib.py`](upload_10gib.py) — register → confirm (Mailpit) → login → initiate → PUT of the 160 parts straight to SeaweedFS through presigned URLs (8 in parallel) → complete → poll until `ready`. A second thread calls `GET /videos/:shortId` every 0.5 s during the upload to measure API latency. The file bytes never pass through the API.

```bash
python3 upload_10gib.py /path/to/big.mp4
```

## Result

```
initiate 201: short_id=ow7jJOVQYO4 part_size=67108864 part_count=160 status=uploading
upload: 160 parts, 10 GiB em 75s (136 MiB/s)
API durante o upload: 144 GETs, mediana 16 ms, p95 46 ms, máx 161 ms
complete 200: status=processing
processamento: ready em 2s; size_bytes=10737418240, duration_seconds=20, width=1280, height=720, video_codec=h264, audio_codec=aac, failure_reason=None, thumbnail_url=http://localhost:8333/streamtube-thumbnails/ow7jJOVQYO4/c2fa6ad043ad054d.jpg
streaming: HTTP 206, 1024 bytes, Content-Range=bytes 0-1023/10737418240
download: HTTP 206, Content-Disposition=attachment; filename="big-10gib.mp4"; filename*=UTF-8''big-10gib.mp4
thumbnail anônima: HTTP 200, image/jpeg, 25461 bytes
  short_id   |   title   | processing_status | publication_status | size_bytes  | duration_seconds | video_codec | processed 
-------------+-----------+-------------------+--------------------+-------------+------------------+-------------+-----------
 ow7jJOVQYO4 | big-10gib | ready             | draft              | 10737418240 |               20 | h264        | t
(1 row)
```

## What it shows

- The 10 GiB file was uploaded in 160 parts of 64 MiB directly to object storage; the API only signed URLs and completed the upload.
- The API stayed responsive during the transfer (144 requests, median 16 ms, max 161 ms).
- After `complete`, the worker extracted duration, resolution and codecs, generated the thumbnail and moved the video to `ready`, still as a `draft`.
- Streaming answers `Range` with `206` (no full download); download carries `Content-Disposition: attachment`; the thumbnail is readable without authentication.
