import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import {
  UnsupportedVideoFormatException,
  VideoNotFoundException,
  VideoTooLargeException,
} from '../common/exceptions/domain.exception';
import { StorageService } from '../storage/storage.service';
import { Video } from './entities/video.entity';
import { isValidShortId, generateShortId } from './short-id.util';
import { toVideoResponse, type VideoResponse } from './video-response.mapper';
import {
  MAX_TITLE_LENGTH,
  MAX_VIDEO_SIZE_BYTES,
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

  toResponse(video: Video): VideoResponse {
    return toVideoResponse(video, this.storage);
  }
}
