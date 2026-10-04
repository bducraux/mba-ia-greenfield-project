/** Clients slice files at exactly this size; only the last part may be smaller. */
export const UPLOAD_PART_SIZE = 67108864; // 64 MiB

export const MAX_VIDEO_SIZE_BYTES = 10737418240; // 10 GiB

/** ceil(MAX_VIDEO_SIZE_BYTES / UPLOAD_PART_SIZE): bound for part arrays in requests. */
export const MAX_PART_COUNT = 160;

export const PART_URL_TTL_SECONDS = 3600;

/** Covers a long viewing session; Range requests after expiry fail. */
export const PLAYBACK_URL_TTL_SECONDS = 14400;

export const DOWNLOAD_URL_TTL_SECONDS = 3600;

export const MAX_TITLE_LENGTH = 100;

export const SHORT_ID_MAX_ATTEMPTS = 3;

/** Allowed file extensions (lowercase) and the only mime type each may declare. */
export const VIDEO_EXTENSION_MIME_TYPES = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
} as const;

export type VideoExtension = keyof typeof VIDEO_EXTENSION_MIME_TYPES;

export const SOURCE_OBJECT_NAME = 'source';
