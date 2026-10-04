import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChannelsModule } from '../channels/channels.module';
import { StorageModule } from '../storage/storage.module';
import { VideoProcessingProducerModule } from '../video-processing/video-processing-producer.module';
import { Video } from './entities/video.entity';
import { VideoLifecycleService } from './video-lifecycle.service';
import { VideosController } from './videos.controller';
import { VideosService } from './videos.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Video]),
    StorageModule,
    ChannelsModule,
    VideoProcessingProducerModule,
  ],
  controllers: [VideosController],
  providers: [VideosService, VideoLifecycleService],
  exports: [VideosService, VideoLifecycleService],
})
export class VideosModule {}
