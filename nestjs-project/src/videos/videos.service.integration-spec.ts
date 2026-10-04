import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import { VideoNotFoundException } from '../common/exceptions/domain.exception';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideosService (integration)', () => {
  let module: TestingModule;
  let service: VideosService;
  let storage: StorageService;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  const openUploads: Array<{ key: string; uploadId: string }> = [];

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, queueConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        VideosModule,
      ],
    }).compile();

    service = module.get(VideosService);
    storage = module.get(StorageService);
    dataSource = module.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
  }, 30000);

  afterAll(async () => {
    for (const { key, uploadId } of openUploads) {
      await storage.abortMultipartUpload(key, uploadId);
    }
    await cleanAllTables(dataSource);
    await module.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let userCounter = 0;
  async function createUserWithChannel(): Promise<User> {
    const n = ++userCounter;
    const user = await dataSource.getRepository(User).save({
      email: `videos_svc_${n}@example.com`,
      password: 'hashed',
    });
    await dataSource.getRepository(Channel).save({
      name: `videos_svc_${n}`,
      nickname: `videos_svc_${n}`,
      user_id: user.id,
    });
    return user;
  }

  async function initiate(userId: string): Promise<Video> {
    const result = await service.initiateUpload(userId, {
      file_name: 'clip.mp4',
      mime_type: 'video/mp4',
      size: 1048576,
    });
    const video = await videoRepository.findOneByOrFail({
      short_id: result.video.short_id,
    });
    openUploads.push({
      key: video.original_object_key,
      uploadId: video.upload_id,
    });
    return video;
  }

  describe('initiateUpload', () => {
    it('persists an uploading draft whose upload_id is a live multipart upload', async () => {
      const user = await createUserWithChannel();

      const result = await service.initiateUpload(user.id, {
        file_name: 'clip.mp4',
        mime_type: 'video/mp4',
        size: 1048576,
      });

      const video = await videoRepository.findOneByOrFail({
        short_id: result.video.short_id,
      });
      openUploads.push({
        key: video.original_object_key,
        uploadId: video.upload_id,
      });
      expect(video.processing_status).toBe('uploading');
      expect(video.publication_status).toBe('draft');
      expect(video.title).toBe('clip');
      expect(video.original_object_key).toBe(`${video.short_id}/source.mp4`);
      await expect(
        storage.listParts(video.original_object_key, video.upload_id),
      ).resolves.toEqual([]);

      expect(result.video).toMatchObject({
        short_id: video.short_id,
        processing_status: 'uploading',
        publication_status: 'draft',
        size_bytes: 1048576,
        thumbnail_url: null,
      });
      expect(result.upload).toEqual({ part_size: 67108864, part_count: 1 });
    });
  });

  describe('findOwnedByShortId', () => {
    it('returns the video to its owner', async () => {
      const owner = await createUserWithChannel();
      const video = await initiate(owner.id);

      const found = await service.findOwnedByShortId(owner.id, video.short_id);

      expect(found.id).toBe(video.id);
    });

    it('hides the video from another channel', async () => {
      const owner = await createUserWithChannel();
      const other = await createUserWithChannel();
      const video = await initiate(owner.id);

      await expect(
        service.findOwnedByShortId(other.id, video.short_id),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });
  });
});
