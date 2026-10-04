import type { StorageService } from '../storage/storage.service';
import type { Video } from './entities/video.entity';
import type {
  FailureReason,
  ProcessingStatus,
  PublicationStatus,
} from './video.types';

/** Owner view of a video. Internal fields (ids, object keys, upload id) are never exposed. */
export interface VideoResponse {
  short_id: string;
  title: string;
  description: string | null;
  processing_status: ProcessingStatus;
  publication_status: PublicationStatus;
  failure_reason: FailureReason | null;
  mime_type: string;
  size_bytes: number;
  duration_seconds: number | null;
  width: number | null;
  height: number | null;
  video_codec: string | null;
  audio_codec: string | null;
  thumbnail_url: string | null;
  processed_at: string | null;
  created_at: string;
  updated_at: string;
}

export function toVideoResponse(
  video: Video,
  storage: Pick<StorageService, 'buildPublicObjectUrl'>,
): VideoResponse {
  return {
    short_id: video.short_id,
    title: video.title,
    description: video.description,
    processing_status: video.processing_status,
    publication_status: video.publication_status,
    failure_reason: video.failure_reason,
    mime_type: video.mime_type,
    size_bytes: video.size_bytes,
    duration_seconds: video.duration_seconds,
    width: video.width,
    height: video.height,
    video_codec: video.video_codec,
    audio_codec: video.audio_codec,
    thumbnail_url:
      video.thumbnail_object_key === null
        ? null
        : storage.buildPublicObjectUrl(
            'thumbnails',
            video.thumbnail_object_key,
          ),
    processed_at: video.processed_at?.toISOString() ?? null,
    created_at: video.created_at.toISOString(),
    updated_at: video.updated_at.toISOString(),
  };
}
