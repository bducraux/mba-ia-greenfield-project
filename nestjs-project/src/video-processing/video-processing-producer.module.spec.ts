import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import queueConfig from '../config/queue.config';
import { VideoProcessingProducerModule } from './video-processing-producer.module';
import { VIDEO_PROCESSING_QUEUE } from './video-processing.constants';
import { VideoProcessingProducer } from './video-processing.producer';

describe('VideoProcessingProducerModule', () => {
  it('should compile and expose the producer bound to the video-processing queue', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        VideoProcessingProducerModule,
      ],
    }).compile();

    expect(module.get(VideoProcessingProducer)).toBeInstanceOf(
      VideoProcessingProducer,
    );
    expect(module.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE)).name).toBe(
      VIDEO_PROCESSING_QUEUE,
    );

    await module.close();
  }, 15000);
});
