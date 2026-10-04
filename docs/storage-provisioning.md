# Object Storage — Production Provisioning Contract

StreamTube talks to object storage only through the S3 API (`phase-03-upload-processing/TD-01`). In dev/test the buckets live in SeaweedFS and are provisioned by the one-shot `storage-init` Compose service (`nestjs-project/docker/storage-init/init.sh`), with the identities declared in `nestjs-project/docker/seaweedfs/entrypoint.sh`. In production the **same declarative set** must exist before the API or the worker starts. It is owned by infrastructure, not by the application (`phase-03-upload-processing/TD-16`): the runtime credentials never create or configure buckets.

Writing the infrastructure-as-code (Terraform/OpenTofu, provider runbook, etc.) is deferred to a deploy phase. This document is the contract that code must satisfy.

## Buckets

| Bucket (env var) | Visibility | Contents | Object keys |
|---|---|---|---|
| `STORAGE_BUCKET` | Private | Uploaded source videos (multipart upload from the browser via presigned part URLs) | `{short_id}/source.{ext}` |
| `STORAGE_THUMBNAILS_BUCKET` | Public read (objects only) | JPEG thumbnails written by the video worker | `{short_id}/{random-hex}.jpg`, written with `Cache-Control: public, max-age=31536000, immutable` |

Both buckets must exist before the first deploy. The application never calls `CreateBucket`.

## Video bucket (`STORAGE_BUCKET`)

**CORS** — identical to `init.sh`. The browser uploads parts straight to the bucket and must read each part's `ETag`:

```json
{
  "CORSRules": [
    {
      "AllowedOrigins": ["<STORAGE_CORS_ORIGIN>"],
      "AllowedMethods": ["PUT", "GET", "HEAD"],
      "AllowedHeaders": ["*"],
      "ExposeHeaders": ["ETag"]
    }
  ]
}
```

`<STORAGE_CORS_ORIGIN>` is the frontend's origin in that environment (the same value as the API's `STORAGE_CORS_ORIGIN`).

**Lifecycle** — identical to `init.sh`. Abandoned multipart uploads are cleaned up after one day:

```json
{
  "Rules": [
    {
      "ID": "abort-incomplete-multipart-uploads",
      "Status": "Enabled",
      "Filter": {},
      "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 1 }
    }
  ]
}
```

**Access** — fully private. Block Public Access stays **on**. Playback and download go through short-lived presigned GET URLs issued by the API (4 h for playback, 1 h for download).

## Thumbnails bucket (`STORAGE_THUMBNAILS_BUCKET`)

**Public read policy** — anonymous `GetObject` on objects only, never `ListBucket`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PublicReadThumbnails",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::<STORAGE_THUMBNAILS_BUCKET>/*"
    }
  ]
}
```

On AWS, Block Public Access is relaxed **only on this bucket**, and only as much as the policy above needs (`BlockPublicPolicy` and `RestrictPublicBuckets` off). ACLs stay blocked. No CORS and no lifecycle rule are needed: thumbnails are loaded with `<img>`, and their keys are versioned (a new key per processing run), so cached copies never go stale.

Dev equivalent: the `anonymous` identity with `Read:<STORAGE_THUMBNAILS_BUCKET>` in the SeaweedFS identity file.

## Application credentials (`STORAGE_ACCESS_KEY` / `STORAGE_SECRET_KEY`)

One identity is shared by the API and the video worker, limited to **object-level** actions. The table lists exactly what the current code calls (`StorageService`, used by `VideosService` and `VideoProcessingConsumer`):

| Action | Video bucket | Thumbnails bucket | Used for |
|---|---|---|---|
| `s3:PutObject` | ✓ | ✓ | `CreateMultipartUpload`, presigned `UploadPart`, `CompleteMultipartUpload`; thumbnail upload by the worker |
| `s3:GetObject` | ✓ | — | `HeadObject` after assembly and in the worker; presigned playback, download and worker source URLs |
| `s3:ListBucket` | ✓ | — | Lets `HeadObject` return 404 (not 403) for a missing key, which maps to `SOURCE_MISSING` |
| `s3:ListMultipartUploadParts` | ✓ | — | `GET /videos/:shortId/upload/parts` |
| `s3:AbortMultipartUpload` | ✓ | — | Discarding the upload when the video row cannot be created |
| `s3:DeleteObject` | ✓ | — | Deleting an assembled object rejected on complete (size mismatch / too large) |

The thumbnails bucket needs only `PutObject` today: nothing in the application reads, lists or deletes thumbnails (they are read anonymously through the public policy). If a later phase deletes thumbnails or videos, add `s3:DeleteObject` there.

Not granted: `CreateBucket`, `DeleteBucket`, `PutBucketPolicy`, `PutBucketCors`, `PutLifecycleConfiguration`, `PutPublicAccessBlock`, or any action on other buckets.

In dev, SeaweedFS has no action finer than `Write:<bucket>`, so the dev `app` identity can also change bucket CORS. Production IAM must not repeat that.

## Endpoints

| Env var | Production value |
|---|---|
| `STORAGE_ENDPOINT` | Endpoint the API and worker use for server-side calls (may be a private/VPC endpoint) |
| `STORAGE_PUBLIC_ENDPOINT` | The only browser-facing host. Presigned URLs and public thumbnail URLs are built on it, so it must be reachable from the user's browser |
| `STORAGE_REGION` | Bucket region |
| `STORAGE_FORCE_PATH_STYLE` | `false` on AWS (virtual-hosted style); `true` for SeaweedFS and most self-hosted S3 |

## Checklist before a deploy

- [ ] Both buckets exist in `STORAGE_REGION`.
- [ ] Video bucket: CORS and lifecycle above applied; Block Public Access on.
- [ ] Thumbnails bucket: public-read policy applied; Block Public Access relaxed only there.
- [ ] Application credentials limited to the object-level actions above.
- [ ] `STORAGE_PUBLIC_ENDPOINT` resolves from the public internet; `STORAGE_CORS_ORIGIN` matches the frontend origin.
