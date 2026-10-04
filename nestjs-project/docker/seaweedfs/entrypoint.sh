#!/bin/sh
# Renders the S3 identity file from env and starts `weed mini` with it.
# Identities (phase-03-upload-processing/TD-16):
#   - admin: bucket provisioning, used only by storage-init
#   - app: object-level Read/Write/List on the two buckets (API + worker)
#   - anonymous: Read on the thumbnails bucket only (no List)
set -eu

: "${STORAGE_ADMIN_ACCESS_KEY:?}" "${STORAGE_ADMIN_SECRET_KEY:?}"
: "${STORAGE_ACCESS_KEY:?}" "${STORAGE_SECRET_KEY:?}"
: "${STORAGE_BUCKET:?}" "${STORAGE_THUMBNAILS_BUCKET:?}"

CONFIG_FILE=/tmp/s3.json

cat > "$CONFIG_FILE" <<EOF
{
  "identities": [
    {
      "name": "admin",
      "credentials": [
        { "accessKey": "${STORAGE_ADMIN_ACCESS_KEY}", "secretKey": "${STORAGE_ADMIN_SECRET_KEY}" }
      ],
      "actions": ["Admin", "Read", "List", "Tagging", "Write"]
    },
    {
      "name": "app",
      "credentials": [
        { "accessKey": "${STORAGE_ACCESS_KEY}", "secretKey": "${STORAGE_SECRET_KEY}" }
      ],
      "actions": [
        "Read:${STORAGE_BUCKET}",
        "Write:${STORAGE_BUCKET}",
        "List:${STORAGE_BUCKET}",
        "Read:${STORAGE_THUMBNAILS_BUCKET}",
        "Write:${STORAGE_THUMBNAILS_BUCKET}",
        "List:${STORAGE_THUMBNAILS_BUCKET}"
      ]
    },
    {
      "name": "anonymous",
      "actions": ["Read:${STORAGE_THUMBNAILS_BUCKET}"]
    }
  ]
}
EOF
chmod 644 "$CONFIG_FILE"

exec /entrypoint.sh mini -s3.config="$CONFIG_FILE"
