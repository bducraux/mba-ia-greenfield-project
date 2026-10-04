import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { Queue } from 'bullmq';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { createTestDataSource } from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video } from '../videos/entities/video.entity';
import { MediaProbeService } from './media/media-probe.service';
import { VideoProcessingConsumerModule } from './video-processing-consumer.module';
import { VIDEO_PROCESSING_QUEUE } from './video-processing.constants';
import { VideoProcessingConsumer } from './video-processing.consumer';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideoProcessingConsumerModule', () => {
  // compile() does not run onModuleInit, so no BullMQ Worker is started and
  // the shared queue is never consumed by this test.
  it('should compile and expose the consumer, the probe and the queue', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, queueConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        VideoProcessingConsumerModule,
      ],
    }).compile();

    expect(module.get(VideoProcessingConsumer)).toBeInstanceOf(
      VideoProcessingConsumer,
    );
    expect(module.get(MediaProbeService)).toBeInstanceOf(MediaProbeService);
    expect(module.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE)).name).toBe(
      VIDEO_PROCESSING_QUEUE,
    );

    await module.close();
  }, 30000);
});
