import { spawn } from 'node:child_process';
import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  DEFAULT_MEDIA_PROCESS_TIMEOUTS,
  INVALID_CONTENT_STDERR_PATTERNS,
  MAX_STDERR_CHARS,
  MEDIA_PROCESS_TIMEOUTS,
  THUMBNAIL_END_MARGIN_SECONDS,
  THUMBNAIL_MAX_WIDTH,
  THUMBNAIL_SEEK_RATIO,
  TRANSPORT_FAILURE_STDERR_PATTERNS,
  type MediaProcessTimeouts,
} from './media.constants';
import {
  MediaProcessFailedError,
  MediaProcessTimeoutError,
  MediaUnsupportedContentError,
} from './media-probe.errors';
import type { FfprobeResult } from './media-probe.types';

/**
 * Runs ffprobe/ffmpeg over a URL (HTTP Range reads — the file is never
 * downloaded whole). Args are always an array and no shell is involved.
 */
@Injectable()
export class MediaProbeService {
  constructor(
    @Optional()
    @Inject(MEDIA_PROCESS_TIMEOUTS)
    private readonly timeouts: MediaProcessTimeouts = DEFAULT_MEDIA_PROCESS_TIMEOUTS,
  ) {}

  async probe(url: string): Promise<FfprobeResult> {
    const stdout = await this.run(
      'ffprobe',
      [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        url,
      ],
      this.timeouts.probeMs,
    );
    try {
      return JSON.parse(stdout.toString('utf8')) as FfprobeResult;
    } catch (error) {
      throw new MediaProcessFailedError('ffprobe returned invalid JSON', {
        cause: error,
      });
    }
  }

  /** Returns a JPEG frame taken at 10% of the duration, at most 1280px wide. */
  async extractThumbnail(
    url: string,
    durationSeconds: number,
  ): Promise<Buffer> {
    const seek = thumbnailSeekSeconds(durationSeconds);
    const jpeg = await this.run(
      'ffmpeg',
      [
        '-nostdin',
        '-v',
        'error',
        '-ss',
        seek.toFixed(3),
        '-i',
        url,
        '-frames:v',
        '1',
        '-vf',
        `scale='min(${THUMBNAIL_MAX_WIDTH},iw)':-2`,
        '-f',
        'image2',
        '-c:v',
        'mjpeg',
        '-q:v',
        '3',
        'pipe:1',
      ],
      this.timeouts.thumbnailMs,
    );
    if (jpeg.length === 0) {
      throw new MediaProcessFailedError('ffmpeg produced no thumbnail frame');
    }
    return jpeg;
  }

  private run(
    command: string,
    args: string[],
    timeoutMs: number,
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      const stdout: Buffer[] = [];
      let stderr = '';
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);

      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-MAX_STDERR_CHARS);
      });

      child.once('error', (error) => {
        clearTimeout(timer);
        reject(
          new MediaProcessFailedError(`${command} could not be started`, {
            cause: error,
          }),
        );
      });

      child.once('close', (code, signal) => {
        clearTimeout(timer);
        if (timedOut) {
          reject(
            new MediaProcessTimeoutError(
              `${command} timed out after ${timeoutMs} ms and was killed`,
            ),
          );
          return;
        }
        if (code !== 0) {
          const message = `${command} exited with ${code ?? signal}: ${stderr.trim()}`;
          reject(
            code !== null && isInvalidContentFailure(stderr)
              ? new MediaUnsupportedContentError(message)
              : new MediaProcessFailedError(message),
          );
          return;
        }
        resolve(Buffer.concat(stdout));
      });
    });
  }
}

/** Bad bytes, not a failure to reach them (transport errors win). */
function isInvalidContentFailure(stderr: string): boolean {
  return (
    INVALID_CONTENT_STDERR_PATTERNS.some((pattern) => pattern.test(stderr)) &&
    !TRANSPORT_FAILURE_STDERR_PATTERNS.some((pattern) => pattern.test(stderr))
  );
}

/** `clamp(duration × 0.1, 0, max(duration − 0.1, 0))`. */
export function thumbnailSeekSeconds(durationSeconds: number): number {
  const upper = Math.max(durationSeconds - THUMBNAIL_END_MARGIN_SECONDS, 0);
  return Math.min(Math.max(durationSeconds * THUMBNAIL_SEEK_RATIO, 0), upper);
}
