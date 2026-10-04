import { randomUUID } from 'crypto';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { generateShortId } from '../short-id.util';
import { Video } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  let channel: Channel;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    const user = await userRepository.save(
      userRepository.create({
        email: 'video_owner@example.com',
        password: 'hashed',
      }),
    );
    channel = await channelRepository.save(
      channelRepository.create({
        name: 'Owner',
        nickname: 'video_owner',
        user_id: user.id,
      }),
    );
  });

  function buildVideo(overrides: Partial<Video> = {}): Video {
    const shortId = overrides.short_id ?? generateShortId();
    return videoRepository.create({
      channel_id: channel.id,
      short_id: shortId,
      title: 'My video',
      original_object_key: `${shortId}/source.mp4`,
      mime_type: 'video/mp4',
      size_bytes: 1024,
      upload_id: 'upload-id',
      ...overrides,
    });
  }

  it('should default processing_status to uploading and publication_status to draft', async () => {
    const saved = await videoRepository.save(buildVideo());

    const found = await videoRepository.findOneByOrFail({ id: saved.id });
    expect(found.processing_status).toBe('uploading');
    expect(found.publication_status).toBe('draft');
    expect(found.failure_reason).toBeNull();
  });

  it('should enforce unique short_id', async () => {
    await videoRepository.save(buildVideo({ short_id: 'dupShortId1' }));

    await expect(
      videoRepository.save(buildVideo({ short_id: 'dupShortId1' })),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it.each([
    ['processing_status', { processing_status: 'deleted' }],
    ['publication_status', { publication_status: 'published' }],
    ['failure_reason', { failure_reason: 'OTHER' }],
  ])(
    'should reject a %s outside the allowed set (CHECK)',
    async (_column, overrides) => {
      await expect(
        videoRepository.save(buildVideo(overrides as Partial<Video>)),
      ).rejects.toMatchObject({ code: '23514' });
    },
  );

  it('should accept every allowed failure_reason', async () => {
    for (const reason of [
      'UNSUPPORTED_FORMAT',
      'PROCESSING_FAILED',
      'SOURCE_MISSING',
      'UPLOAD_REJECTED',
    ] as const) {
      await expect(
        videoRepository.save(
          buildVideo({ processing_status: 'failed', failure_reason: reason }),
        ),
      ).resolves.toBeDefined();
    }
  });

  it('should reject a channel_id that does not reference a channel (FK)', async () => {
    await expect(
      videoRepository.save(buildVideo({ channel_id: randomUUID() })),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('should read size_bytes above 2^31 back as a number', async () => {
    const saved = await videoRepository.save(
      buildVideo({ size_bytes: 10737418240 }),
    );

    const found = await videoRepository.findOneByOrFail({ id: saved.id });
    expect(found.size_bytes).toBe(10737418240);
  });

  it('should load the owning channel via the ManyToOne relation', async () => {
    const saved = await videoRepository.save(buildVideo());

    const found = await videoRepository.findOneOrFail({
      where: { id: saved.id },
      relations: { channel: true },
    });
    expect(found.channel.nickname).toBe('video_owner');
  });
});
