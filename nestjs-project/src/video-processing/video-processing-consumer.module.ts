import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { QueueModule } from '../queue/queue.module';
import { StorageModule } from '../storage/storage.module';
import { VideosModule } from '../videos/videos.module';
import { MediaProbeService } from './media/media-probe.service';
import { VIDEO_PROCESSING_QUEUE } from './video-processing.constants';
import { VideoProcessingConsumer } from './video-processing.consumer';

// Consumer side: imported only by the worker entrypoint, so the API process
// never registers a BullMQ Worker (phase-03-upload-processing/TD-08).
@Module({
  imports: [
    QueueModule,
    BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
    StorageModule,
    VideosModule,
  ],
  providers: [MediaProbeService, VideoProcessingConsumer],
})
export class VideoProcessingConsumerModule {}
