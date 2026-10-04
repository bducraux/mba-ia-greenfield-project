// Browser-playable allowlists (phase-03-upload-processing/TD-06, TD-14).
// `format_name` is a comma-separated list (e.g. `mov,mp4,m4a,3gp,3g2,mj2`).
export const SUPPORTED_CONTAINERS: readonly string[] = ['mp4', 'webm'];
export const SUPPORTED_VIDEO_CODECS: readonly string[] = [
  'h264',
  'vp8',
  'vp9',
  'av1',
];
export const SUPPORTED_AUDIO_CODECS: readonly string[] = [
  'aac',
  'mp3',
  'opus',
  'vorbis',
];

export interface MediaProcessTimeouts {
  probeMs: number;
  thumbnailMs: number;
}

export const DEFAULT_MEDIA_PROCESS_TIMEOUTS: MediaProcessTimeouts = {
  probeMs: 60_000,
  thumbnailMs: 120_000,
};

/** Optional override of {@link DEFAULT_MEDIA_PROCESS_TIMEOUTS} (tests use short values). */
export const MEDIA_PROCESS_TIMEOUTS = Symbol('MEDIA_PROCESS_TIMEOUTS');

export const THUMBNAIL_MAX_WIDTH = 1280;

/** Keeps the thumbnail seek strictly before the end so ffmpeg still finds a frame. */
export const THUMBNAIL_END_MARGIN_SECONDS = 0.1;

export const THUMBNAIL_SEEK_RATIO = 0.1;

/** stderr of a non-zero exit caused by the bytes themselves (not retryable). */
export const INVALID_CONTENT_STDERR_PATTERNS: readonly RegExp[] = [
  /Invalid data found when processing input/,
  /moov atom not found/,
  /EBML header parsing failed/,
];

/**
 * stderr of a failure reaching the input. Takes precedence over the invalid
 * content patterns, so an interrupted read is always retried.
 */
export const TRANSPORT_FAILURE_STDERR_PATTERNS: readonly RegExp[] = [
  /Server returned/,
  /Connection (refused|reset|timed out)/,
  /Failed to resolve hostname/,
  /Network is unreachable/,
  /Input\/output error/,
];

/** Only the tail of stderr is kept in error messages. */
export const MAX_STDERR_CHARS = 4096;
