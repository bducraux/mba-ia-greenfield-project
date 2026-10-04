#!/bin/sh
# Idempotent bucket provisioning for dev/test (phase-03-upload-processing/TD-16).
# Anonymous Read on the thumbnails bucket is declared in the SeaweedFS identity
# file (docker/seaweedfs/entrypoint.sh), not here.
set -eu

: "${STORAGE_ENDPOINT:?}" "${STORAGE_REGION:?}"
: "${STORAGE_ADMIN_ACCESS_KEY:?}" "${STORAGE_ADMIN_SECRET_KEY:?}"
: "${STORAGE_BUCKET:?}" "${STORAGE_THUMBNAILS_BUCKET:?}" "${STORAGE_CORS_ORIGIN:?}"

export AWS_ACCESS_KEY_ID="$STORAGE_ADMIN_ACCESS_KEY"
export AWS_SECRET_ACCESS_KEY="$STORAGE_ADMIN_SECRET_KEY"
export AWS_DEFAULT_REGION="$STORAGE_REGION"
aws configure set default.s3.addressing_style path

s3api() {
  aws --endpoint-url "$STORAGE_ENDPOINT" s3api "$@"
}

ensure_bucket() {
  if s3api head-bucket --bucket "$1" >/dev/null 2>&1; then
    echo "bucket $1: already exists"
  else
    s3api create-bucket --bucket "$1" >/dev/null
    echo "bucket $1: created"
  fi
}

ensure_bucket "$STORAGE_BUCKET"
ensure_bucket "$STORAGE_THUMBNAILS_BUCKET"

s3api put-bucket-cors --bucket "$STORAGE_BUCKET" --cors-configuration "{
  \"CORSRules\": [
    {
      \"AllowedOrigins\": [\"${STORAGE_CORS_ORIGIN}\"],
      \"AllowedMethods\": [\"PUT\", \"GET\", \"HEAD\"],
      \"AllowedHeaders\": [\"*\"],
      \"ExposeHeaders\": [\"ETag\"]
    }
  ]
}"
echo "bucket $STORAGE_BUCKET: CORS applied"

s3api put-bucket-lifecycle-configuration --bucket "$STORAGE_BUCKET" --lifecycle-configuration '{
  "Rules": [
    {
      "ID": "abort-incomplete-multipart-uploads",
      "Status": "Enabled",
      "Filter": {},
      "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 1 }
    }
  ]
}'
echo "bucket $STORAGE_BUCKET: lifecycle applied"
