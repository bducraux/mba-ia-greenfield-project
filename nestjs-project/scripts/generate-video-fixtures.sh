#!/bin/sh
# Regenerates the small (2 s) video fixtures used by the media/worker tests.
# Run inside the container: docker compose exec nestjs-api sh scripts/generate-video-fixtures.sh
set -eu

OUT_DIR="$(dirname "$0")/../test/fixtures/videos"
mkdir -p "$OUT_DIR"

VIDEO_SRC="testsrc=duration=2:size=320x240:rate=25"
AUDIO_SRC="sine=frequency=440:duration=2"
FFMPEG="ffmpeg -hide_banner -loglevel error -y"

# Compatible: H.264 + AAC in MP4.
$FFMPEG -f lavfi -i "$VIDEO_SRC" -f lavfi -i "$AUDIO_SRC" \
  -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest \
  "$OUT_DIR/h264-aac.mp4"

# Compatible: VP9 + Opus in WebM.
$FFMPEG -f lavfi -i "$VIDEO_SRC" -f lavfi -i "$AUDIO_SRC" \
  -c:v libvpx-vp9 -b:v 200k -c:a libopus -shortest \
  "$OUT_DIR/vp9-opus.webm"

# Incompatible: MPEG-4 Part 2 video codec (outside the allowlist).
$FFMPEG -f lavfi -i "$VIDEO_SRC" -c:v mpeg4 \
  "$OUT_DIR/mpeg4.mp4"

# Incompatible: MP4 with an audio stream only.
$FFMPEG -f lavfi -i "$AUDIO_SRC" -c:a aac \
  "$OUT_DIR/audio-only.mp4"

# Incompatible: text bytes with a video extension.
printf 'this is not a video file\n' > "$OUT_DIR/not-a-video.mp4"
