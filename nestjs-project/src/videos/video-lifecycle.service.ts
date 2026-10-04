import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { Video } from './entities/video.entity';
import type { FailureReason, ProcessingStatus } from './video.types';

export interface ProcessedVideoMetadata {
  duration_seconds: number;
  width: number;
  height: number;
  video_codec: string;
  audio_codec: string | null;
  thumbnail_object_key: string;
}

/** The worker may run before the API commits `processing`, so it accepts both. */
const WORKER_SOURCE_STATES: ProcessingStatus[] = ['uploading', 'processing'];

/**
 * Conditional `processing_status` transitions. Each update only applies from
 * its allowed source states, so a stale writer never moves a video backwards.
 * Every method resolves `true` when a row was updated.
 */
@Injectable()
export class VideoLifecycleService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
  ) {}

  /** `null` when the video no longer exists (the worker treats it as a no-op). */
  async findById(id: string): Promise<Video | null> {
    return this.videoRepository.findOneBy({ id });
  }

  async markProcessing(id: string): Promise<boolean> {
    return this.transition(id, ['uploading'], {
      processing_status: 'processing',
    });
  }

  async markUploadRejected(id: string): Promise<boolean> {
    return this.transition(id, ['uploading'], {
      processing_status: 'failed',
      failure_reason: 'UPLOAD_REJECTED',
    });
  }

  async markReady(
    id: string,
    metadata: ProcessedVideoMetadata,
  ): Promise<boolean> {
    return this.transition(id, WORKER_SOURCE_STATES, {
      ...metadata,
      processing_status: 'ready',
      failure_reason: null,
      processed_at: () => 'CURRENT_TIMESTAMP',
    });
  }

  async markFailed(id: string, reason: FailureReason): Promise<boolean> {
    return this.transition(id, WORKER_SOURCE_STATES, {
      processing_status: 'failed',
      failure_reason: reason,
    });
  }

  private async transition(
    id: string,
    from: ProcessingStatus[],
    changes: QueryDeepPartialEntity<Video>,
  ): Promise<boolean> {
    const result = await this.videoRepository.update(
      { id, processing_status: In(from) },
      changes,
    );
    return (result.affected ?? 0) > 0;
  }
}
