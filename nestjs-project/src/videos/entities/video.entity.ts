import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import { bigintNumberTransformer } from '../../common/transformers/bigint-number.transformer';
import type {
  FailureReason,
  ProcessingStatus,
  PublicationStatus,
} from '../video.types';

@Entity('videos')
@Check(
  'CHK_videos_processing_status',
  `"processing_status" IN ('uploading', 'processing', 'ready', 'failed')`,
)
@Check('CHK_videos_publication_status', `"publication_status" IN ('draft')`)
@Check(
  'CHK_videos_failure_reason',
  `"failure_reason" IN ('UNSUPPORTED_FORMAT', 'PROCESSING_FAILED', 'SOURCE_MISSING', 'UPLOAD_REJECTED')`,
)
export class Video {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid' })
  channel_id: string;

  @Column({ type: 'varchar', length: 11, unique: true })
  short_id: string;

  @Column({ type: 'varchar', length: 100 })
  title: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ type: 'varchar', length: 20, default: 'uploading' })
  processing_status: ProcessingStatus;

  @Column({ type: 'varchar', length: 20, default: 'draft' })
  publication_status: PublicationStatus;

  @Column({ type: 'varchar', length: 32, nullable: true })
  failure_reason: FailureReason | null;

  @Column({ type: 'varchar', length: 255 })
  original_object_key: string;

  @Column({ type: 'varchar', length: 64 })
  mime_type: string;

  @Column({ type: 'bigint', transformer: bigintNumberTransformer })
  size_bytes: number;

  @Column({ type: 'text' })
  upload_id: string;

  @Column({ type: 'double precision', nullable: true })
  duration_seconds: number | null;

  @Column({ type: 'integer', nullable: true })
  width: number | null;

  @Column({ type: 'integer', nullable: true })
  height: number | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  video_codec: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  audio_codec: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  thumbnail_object_key: string | null;

  @Column({ type: 'timestamp', nullable: true })
  processed_at: Date | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;

  // Unidirectional: Channel is not aware of its videos.
  @ManyToOne(() => Channel)
  @JoinColumn({ name: 'channel_id' })
  channel: Channel;
}
