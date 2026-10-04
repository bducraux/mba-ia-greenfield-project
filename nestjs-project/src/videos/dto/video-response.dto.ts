import { ApiProperty } from '@nestjs/swagger';
import type { VideoResponse } from '../video-response.mapper';
import {
  FAILURE_REASONS,
  PROCESSING_STATUSES,
  PUBLICATION_STATUSES,
  type FailureReason,
  type ProcessingStatus,
  type PublicationStatus,
} from '../video.types';

export class VideoResponseDto implements VideoResponse {
  @ApiProperty({ pattern: '^[A-Za-z0-9_-]{11}$', example: 'dQw4w9WgXcQ' })
  short_id: string;

  @ApiProperty({ example: 'clip' })
  title: string;

  @ApiProperty({ type: String, nullable: true, example: null })
  description: string | null;

  @ApiProperty({ enum: PROCESSING_STATUSES, example: 'uploading' })
  processing_status: ProcessingStatus;

  @ApiProperty({ enum: PUBLICATION_STATUSES, example: 'draft' })
  publication_status: PublicationStatus;

  @ApiProperty({ enum: FAILURE_REASONS, nullable: true, example: null })
  failure_reason: FailureReason | null;

  @ApiProperty({ example: 'video/mp4' })
  mime_type: string;

  @ApiProperty({ example: 1048576 })
  size_bytes: number;

  @ApiProperty({ type: Number, nullable: true, example: null })
  duration_seconds: number | null;

  @ApiProperty({ type: Number, nullable: true, example: null })
  width: number | null;

  @ApiProperty({ type: Number, nullable: true, example: null })
  height: number | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  video_codec: string | null;

  @ApiProperty({ type: String, nullable: true, example: null })
  audio_codec: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Public URL of the generated thumbnail.',
    example: null,
  })
  thumbnail_url: string | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    example: null,
  })
  processed_at: string | null;

  @ApiProperty({ format: 'date-time' })
  created_at: string;

  @ApiProperty({ format: 'date-time' })
  updated_at: string;
}
