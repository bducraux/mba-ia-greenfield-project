import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import {
  InvalidUploadPartsException,
  ProcessingQueueUnavailableException,
  UnsupportedVideoFormatException,
  UploadNotInProgressException,
  UploadSessionExpiredException,
  VideoNotFoundException,
  VideoSizeMismatchException,
  VideoTooLargeException,
} from '../common/exceptions/domain.exception';
import {
  StorageInvalidPartsError,
  StorageObjectNotFoundError,
  StorageUploadNotFoundError,
} from '../storage/storage.errors';
import { StorageService } from '../storage/storage.service';
import { QueueUnavailableError } from '../video-processing/video-processing.errors';
import { VideoProcessingProducer } from '../video-processing/video-processing.producer';
import { Video } from './entities/video.entity';
import { VideoLifecycleService } from './video-lifecycle.service';
import { isValidShortId, generateShortId } from './short-id.util';
import { toVideoResponse, type VideoResponse } from './video-response.mapper';
import {
  MAX_TITLE_LENGTH,
  MAX_VIDEO_SIZE_BYTES,
  PART_URL_TTL_SECONDS,
  SHORT_ID_MAX_ATTEMPTS,
  SOURCE_OBJECT_NAME,
  UPLOAD_PART_SIZE,
  VIDEO_EXTENSION_MIME_TYPES,
  type VideoExtension,
} from './videos.constants';

const PG_UNIQUE_VIOLATION = '23505';
const SHORT_ID_COLUMN = 'short_id';

export interface InitiateUploadInput {
  file_name: string;
  mime_type: string;
  size: number;
}

export interface InitiateUploadResult {
  video: VideoResponse;
  upload: { part_size: number; part_count: number };
}

export interface SignedPartUrls {
  parts: Array<{ part_number: number; url: string }>;
  expires_at: string;
}

export interface UploadedParts {
  part_size: number;
  part_count: number;
  parts: Array<{ part_number: number; etag: string; size: number }>;
}

export interface CompletedUploadPart {
  part_number: number;
  etag: string;
}

interface ParsedFileName {
  title: string;
  extension: VideoExtension;
}

function isShortIdUniqueViolation(err: unknown): boolean {
  if (!(err instanceof QueryFailedError)) return false;
  const { code, detail } = err as QueryFailedError & {
    code?: unknown;
    detail?: unknown;
  };
  return (
    code === PG_UNIQUE_VIOLATION &&
    typeof detail === 'string' &&
    detail.includes(SHORT_ID_COLUMN)
  );
}

function isAllowedExtension(value: string): value is VideoExtension {
  return Object.hasOwn(VIDEO_EXTENSION_MIME_TYPES, value);
}

/**
 * Splits `file_name` into title (name without extension, truncated by code
 * point) and an allowlisted extension; the extension must match `mime_type`.
 */
function parseFileName(fileName: string, mimeType: string): ParsedFileName {
  const dot = fileName.lastIndexOf('.');
  // `dot <= 0`: no extension, or a dotfile such as `.mp4` with an empty name.
  const extension = dot > 0 ? fileName.slice(dot + 1).toLowerCase() : '';
  if (
    !isAllowedExtension(extension) ||
    VIDEO_EXTENSION_MIME_TYPES[extension] !== mimeType
  ) {
    throw new UnsupportedVideoFormatException();
  }
  const title = Array.from(fileName.slice(0, dot))
    .slice(0, MAX_TITLE_LENGTH)
    .join('');
  return { title, extension };
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storage: StorageService,
    private readonly channelsService: ChannelsService,
    private readonly lifecycle: VideoLifecycleService,
    private readonly producer: VideoProcessingProducer,
  ) {}

  /**
   * Creates the draft video row and its S3 multipart upload. A failed insert
   * aborts the multipart upload; a `short_id` collision retries with a new id.
   */
  async initiateUpload(
    userId: string,
    input: InitiateUploadInput,
  ): Promise<InitiateUploadResult> {
    const { title, extension } = parseFileName(
      input.file_name,
      input.mime_type,
    );
    if (input.size > MAX_VIDEO_SIZE_BYTES) {
      throw new VideoTooLargeException();
    }

    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      throw new Error(`User ${userId} has no channel`);
    }

    for (let attempt = 1; ; attempt++) {
      const shortId = generateShortId();
      const objectKey = `${shortId}/${SOURCE_OBJECT_NAME}.${extension}`;
      const uploadId = await this.storage.createMultipartUpload(
        objectKey,
        input.mime_type,
      );

      try {
        const video = await this.videoRepository.save(
          this.videoRepository.create({
            channel_id: channel.id,
            short_id: shortId,
            title,
            description: null,
            original_object_key: objectKey,
            mime_type: input.mime_type,
            size_bytes: input.size,
            upload_id: uploadId,
          }),
        );
        return {
          video: this.toResponse(video),
          upload: {
            part_size: UPLOAD_PART_SIZE,
            part_count: Math.ceil(input.size / UPLOAD_PART_SIZE),
          },
        };
      } catch (err) {
        await this.storage.abortMultipartUpload(objectKey, uploadId);
        if (
          !isShortIdUniqueViolation(err) ||
          attempt >= SHORT_ID_MAX_ATTEMPTS
        ) {
          throw err;
        }
      }
    }
  }

  /** Malformed, unknown and not-owned short ids are indistinguishable (404). */
  async findOwnedByShortId(userId: string, shortId: string): Promise<Video> {
    if (!isValidShortId(shortId)) {
      throw new VideoNotFoundException();
    }
    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      throw new VideoNotFoundException();
    }
    const video = await this.videoRepository.findOne({
      where: { short_id: shortId, channel_id: channel.id },
    });
    if (!video) {
      throw new VideoNotFoundException();
    }
    return video;
  }

  /** Presigns browser `UploadPart` URLs (local signing, no storage round-trip). */
  async signPartUrls(
    userId: string,
    shortId: string,
    partNumbers: number[],
  ): Promise<SignedPartUrls> {
    const video = await this.findUploadingOwned(userId, shortId);
    const partCount = this.partCount(video);
    if (partNumbers.some((n) => n < 1 || n > partCount)) {
      throw new InvalidUploadPartsException();
    }

    const signedAt = Date.now();
    const sorted = [...new Set(partNumbers)].sort((a, b) => a - b);
    const parts = await Promise.all(
      sorted.map(async (partNumber) => ({
        part_number: partNumber,
        url: await this.storage.presignUploadPart(
          video.original_object_key,
          video.upload_id,
          partNumber,
          PART_URL_TTL_SECONDS,
        ),
      })),
    );
    return {
      parts,
      expires_at: new Date(
        signedAt + PART_URL_TTL_SECONDS * 1000,
      ).toISOString(),
    };
  }

  /** Resume support: the parts storage already holds for this upload. */
  async listUploadedParts(
    userId: string,
    shortId: string,
  ): Promise<UploadedParts> {
    const video = await this.findUploadingOwned(userId, shortId);
    try {
      const parts = await this.storage.listParts(
        video.original_object_key,
        video.upload_id,
      );
      return {
        part_size: UPLOAD_PART_SIZE,
        part_count: this.partCount(video),
        parts: parts
          .map(({ partNumber, etag, size }) => ({
            part_number: partNumber,
            etag,
            size,
          }))
          .sort((a, b) => a.part_number - b.part_number),
      };
    } catch (err) {
      if (err instanceof StorageUploadNotFoundError) {
        throw new UploadSessionExpiredException();
      }
      throw err;
    }
  }

  /**
   * Assembles, size-checks and enqueues the video, and only then marks it
   * `processing` — an enqueue failure leaves it `uploading` and retry-safe.
   */
  async completeUpload(
    userId: string,
    shortId: string,
    parts: CompletedUploadPart[],
  ): Promise<VideoResponse> {
    const video = await this.findOwnedByShortId(userId, shortId);

    // 1. State gate: replay is side-effect free.
    if (
      video.processing_status === 'processing' ||
      video.processing_status === 'ready'
    ) {
      return this.toResponse(video);
    }
    if (video.processing_status !== 'uploading') {
      throw new UploadNotInProgressException();
    }

    const partCount = this.partCount(video);
    const partNumbers = new Set(parts.map((p) => p.part_number));
    if (
      parts.length !== partCount ||
      partNumbers.size !== partCount ||
      [...partNumbers].some((n) => n < 1 || n > partCount)
    ) {
      throw new InvalidUploadPartsException();
    }

    // 2. Assemble.
    await this.assemble(video, parts);

    // 3. Size re-check against the assembled object.
    const head = await this.storage.headObject(
      'videos',
      video.original_object_key,
    );
    const tooLarge = head.contentLength > MAX_VIDEO_SIZE_BYTES;
    if (tooLarge || head.contentLength !== video.size_bytes) {
      await this.storage.deleteObject('videos', video.original_object_key);
      await this.lifecycle.markUploadRejected(video.id);
      throw tooLarge
        ? new VideoTooLargeException()
        : new VideoSizeMismatchException();
    }

    // 4. Enqueue before the transition.
    try {
      await this.producer.enqueue(video.id);
    } catch (err) {
      if (err instanceof QueueUnavailableError) {
        throw new ProcessingQueueUnavailableException();
      }
      throw err;
    }

    // 5. Transition (no-op if the worker already advanced it).
    await this.lifecycle.markProcessing(video.id);
    const current = await this.videoRepository.findOneByOrFail({
      id: video.id,
    });
    return this.toResponse(current);
  }

  toResponse(video: Video): VideoResponse {
    return toVideoResponse(video, this.storage);
  }

  private async findUploadingOwned(
    userId: string,
    shortId: string,
  ): Promise<Video> {
    const video = await this.findOwnedByShortId(userId, shortId);
    if (video.processing_status !== 'uploading') {
      throw new UploadNotInProgressException();
    }
    return video;
  }

  private partCount(video: Video): number {
    return Math.ceil(video.size_bytes / UPLOAD_PART_SIZE);
  }

  /**
   * `NoSuchUpload` means either a previous complete already assembled the
   * object (continue) or the lifecycle rule aborted the upload (410).
   */
  private async assemble(
    video: Video,
    parts: CompletedUploadPart[],
  ): Promise<void> {
    try {
      await this.storage.completeMultipartUpload(
        video.original_object_key,
        video.upload_id,
        [...parts]
          .sort((a, b) => a.part_number - b.part_number)
          .map(({ part_number, etag }) => ({ partNumber: part_number, etag })),
      );
    } catch (err) {
      if (err instanceof StorageInvalidPartsError) {
        throw new InvalidUploadPartsException();
      }
      if (!(err instanceof StorageUploadNotFoundError)) {
        throw err;
      }
      try {
        await this.storage.headObject('videos', video.original_object_key);
      } catch (headErr) {
        if (headErr instanceof StorageObjectNotFoundError) {
          throw new UploadSessionExpiredException();
        }
        throw headErr;
      }
    }
  }
}
