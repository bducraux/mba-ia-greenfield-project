import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { QueueModule } from '../queue/queue.module';
import { VIDEO_PROCESSING_QUEUE } from './video-processing.constants';
import { VideoProcessingProducer } from './video-processing.producer';

// Producer side only: no processor is registered here, so the API process
// never consumes jobs (the worker entrypoint owns the consumer).
@Module({
  imports: [
    QueueModule,
    BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
  ],
  providers: [VideoProcessingProducer],
  exports: [VideoProcessingProducer],
})
export class VideoProcessingProducerModule {}
