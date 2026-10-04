/**
 * Typed ffprobe/ffmpeg errors so the consumer never inspects exit codes or
 * stderr. Failed/timeout are transient (retryable); unsupported content is not.
 */
export class MediaProcessError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** The process could not start, exited non-zero, or produced unusable output. */
export class MediaProcessFailedError extends MediaProcessError {}

/**
 * The input was read but is not a parsable media file (e.g. "Invalid data
 * found when processing input"). Not retryable: the consumer maps it to
 * `UNSUPPORTED_FORMAT`.
 */
export class MediaUnsupportedContentError extends MediaProcessError {}

/** The process exceeded its timeout and was killed. */
export class MediaProcessTimeoutError extends MediaProcessError {}
