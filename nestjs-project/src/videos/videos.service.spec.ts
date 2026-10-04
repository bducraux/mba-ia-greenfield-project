import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { QueryFailedError } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import type { Channel } from '../channels/entities/channel.entity';
import {
  UnsupportedVideoFormatException,
  VideoNotFoundException,
  VideoTooLargeException,
} from '../common/exceptions/domain.exception';
import { StorageService } from '../storage/storage.service';
import { Video } from './entities/video.entity';
import { VideosService } from './videos.service';

const USER_ID = 'user-1';
const CHANNEL = { id: 'channel-1', user_id: USER_ID } as Channel;
const VALID_SHORT_ID = 'abcDEF123_-';

function makeShortIdCollision(): QueryFailedError {
  return Object.assign(new QueryFailedError('INSERT', [], new Error()), {
    code: '23505',
    detail: 'Key (short_id)=(abcDEF123_-) already exists.',
  });
}

function persisted(partial: Partial<Video>): Video {
  return {
    id: 'video-1',
    description: null,
    processing_status: 'uploading',
    publication_status: 'draft',
    failure_reason: null,
    duration_seconds: null,
    width: null,
    height: null,
    video_codec: null,
    audio_codec: null,
    thumbnail_object_key: null,
    processed_at: null,
    created_at: new Date('2026-10-04T12:00:00Z'),
    updated_at: new Date('2026-10-04T12:00:00Z'),
    ...partial,
  } as Video;
}

describe('VideosService', () => {
  let service: VideosService;
  let repo: { create: jest.Mock; save: jest.Mock; findOne: jest.Mock };
  let storage: {
    createMultipartUpload: jest.Mock<Promise<string>, [string, string]>;
    abortMultipartUpload: jest.Mock;
    buildPublicObjectUrl: jest.Mock;
  };
  let channels: { findByUserId: jest.Mock };

  beforeEach(async () => {
    repo = {
      create: jest.fn((data: Partial<Video>) => data),
      save: jest.fn((data: Partial<Video>) => Promise.resolve(persisted(data))),
      findOne: jest.fn(),
    };
    storage = {
      createMultipartUpload: jest
        .fn<Promise<string>, [string, string]>()
        .mockResolvedValue('upload-1'),
      abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
      buildPublicObjectUrl: jest.fn(
        (bucket: string, key: string) => `http://cdn/${bucket}/${key}`,
      ),
    };
    channels = { findByUserId: jest.fn().mockResolvedValue(CHANNEL) };

    const module = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: repo },
        { provide: StorageService, useValue: storage },
        { provide: ChannelsService, useValue: channels },
      ],
    }).compile();

    service = module.get(VideosService);
  });

  describe('initiateUpload', () => {
    it('creates the draft and multipart upload under {short_id}/source.{ext}', async () => {
      const result = await service.initiateUpload(USER_ID, {
        file_name: 'clip.mp4',
        mime_type: 'video/mp4',
        size: 1048576,
      });

      const [key, contentType] = storage.createMultipartUpload.mock.calls[0];
      expect(key).toMatch(/^[A-Za-z0-9_-]{11}\/source\.mp4$/);
      expect(contentType).toBe('video/mp4');
      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          channel_id: CHANNEL.id,
          short_id: key.split('/')[0],
          title: 'clip',
          original_object_key: key,
          size_bytes: 1048576,
          upload_id: 'upload-1',
        }),
      );
      expect(result.upload).toEqual({ part_size: 67108864, part_count: 1 });
      expect(result.video.title).toBe('clip');
      expect(result.video.short_id).toBe(key.split('/')[0]);
    });

    it.each([
      ['clip.m4v', 'video/mp4', 'm4v'],
      ['clip.WEBM', 'video/webm', 'webm'],
    ])(
      'accepts %s with %s (lowercased extension %s)',
      async (fileName, mimeType, ext) => {
        await service.initiateUpload(USER_ID, {
          file_name: fileName,
          mime_type: mimeType,
          size: 10,
        });

        expect(storage.createMultipartUpload).toHaveBeenCalledWith(
          expect.stringMatching(new RegExp(`/source\\.${ext}$`)),
          mimeType,
        );
      },
    );

    it.each([
      ['clip.mov', 'video/quicktime'],
      ['clip.mov', 'video/mp4'],
      ['clip.mp4', 'video/quicktime'],
      ['clip.webm', 'video/mp4'],
      ['clip.mp4', 'video/webm'],
      ['clip', 'video/mp4'],
      ['.mp4', 'video/mp4'],
    ])(
      'rejects %s / %s with UnsupportedVideoFormatException before touching storage',
      async (fileName, mimeType) => {
        await expect(
          service.initiateUpload(USER_ID, {
            file_name: fileName,
            mime_type: mimeType,
            size: 10,
          }),
        ).rejects.toBeInstanceOf(UnsupportedVideoFormatException);
        expect(storage.createMultipartUpload).not.toHaveBeenCalled();
        expect(repo.save).not.toHaveBeenCalled();
      },
    );

    it('accepts exactly 10 GiB and computes the part count', async () => {
      const result = await service.initiateUpload(USER_ID, {
        file_name: 'big.mp4',
        mime_type: 'video/mp4',
        size: 10737418240,
      });

      expect(result.upload.part_count).toBe(160);
    });

    it('rejects 10 GiB + 1 byte with VideoTooLargeException without storage or insert', async () => {
      await expect(
        service.initiateUpload(USER_ID, {
          file_name: 'big.mp4',
          mime_type: 'video/mp4',
          size: 10737418241,
        }),
      ).rejects.toBeInstanceOf(VideoTooLargeException);
      expect(storage.createMultipartUpload).not.toHaveBeenCalled();
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('truncates a 150-char base name to a 100-char title', async () => {
      const result = await service.initiateUpload(USER_ID, {
        file_name: `${'a'.repeat(150)}.mp4`,
        mime_type: 'video/mp4',
        size: 10,
      });

      expect(result.video.title).toBe('a'.repeat(100));
    });

    it('truncates by code point, never splitting a surrogate pair', async () => {
      const result = await service.initiateUpload(USER_ID, {
        file_name: `${'🎬'.repeat(120)}.webm`,
        mime_type: 'video/webm',
        size: 10,
      });

      expect(Array.from(result.video.title)).toHaveLength(100);
      expect(result.video.title).toBe('🎬'.repeat(100));
    });

    it('retries with a new short id and a new multipart upload on short_id collision', async () => {
      repo.save
        .mockRejectedValueOnce(makeShortIdCollision())
        .mockImplementationOnce((data: Partial<Video>) =>
          Promise.resolve(persisted(data)),
        );

      const result = await service.initiateUpload(USER_ID, {
        file_name: 'clip.mp4',
        mime_type: 'video/mp4',
        size: 10,
      });

      expect(storage.createMultipartUpload).toHaveBeenCalledTimes(2);
      const firstKey = storage.createMultipartUpload.mock.calls[0][0];
      expect(storage.abortMultipartUpload).toHaveBeenCalledTimes(1);
      expect(storage.abortMultipartUpload).toHaveBeenCalledWith(
        firstKey,
        'upload-1',
      );
      expect(result.video.short_id).not.toBe(firstKey.split('/')[0]);
    });

    it('fails after 3 short_id collisions, aborting every multipart upload', async () => {
      const collision = makeShortIdCollision();
      repo.save.mockRejectedValue(collision);

      await expect(
        service.initiateUpload(USER_ID, {
          file_name: 'clip.mp4',
          mime_type: 'video/mp4',
          size: 10,
        }),
      ).rejects.toBe(collision);
      expect(repo.save).toHaveBeenCalledTimes(3);
      expect(storage.abortMultipartUpload).toHaveBeenCalledTimes(3);
    });

    it('aborts the multipart upload and propagates a non-collision insert failure', async () => {
      const failure = new Error('connection lost');
      repo.save.mockRejectedValueOnce(failure);

      await expect(
        service.initiateUpload(USER_ID, {
          file_name: 'clip.mp4',
          mime_type: 'video/mp4',
          size: 10,
        }),
      ).rejects.toBe(failure);
      expect(repo.save).toHaveBeenCalledTimes(1);
      expect(storage.abortMultipartUpload).toHaveBeenCalledWith(
        storage.createMultipartUpload.mock.calls[0][0],
        'upload-1',
      );
    });
  });

  describe('findOwnedByShortId', () => {
    it('returns the video of the caller channel', async () => {
      const video = persisted({ short_id: VALID_SHORT_ID });
      repo.findOne.mockResolvedValue(video);

      await expect(
        service.findOwnedByShortId(USER_ID, VALID_SHORT_ID),
      ).resolves.toBe(video);
      expect(repo.findOne).toHaveBeenCalledWith({
        where: { short_id: VALID_SHORT_ID, channel_id: CHANNEL.id },
      });
    });

    it('rejects a malformed short id without querying', async () => {
      await expect(
        service.findOwnedByShortId(USER_ID, 'not-a-short-id'),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
      expect(repo.findOne).not.toHaveBeenCalled();
    });

    it('rejects an unknown or not-owned short id', async () => {
      repo.findOne.mockResolvedValue(null);

      await expect(
        service.findOwnedByShortId(USER_ID, VALID_SHORT_ID),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });

    it('rejects when the user has no channel', async () => {
      channels.findByUserId.mockResolvedValue(null);

      await expect(
        service.findOwnedByShortId(USER_ID, VALID_SHORT_ID),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });
  });

  describe('toResponse', () => {
    it('never exposes internal fields', () => {
      const response = service.toResponse(
        persisted({
          channel_id: 'channel-1',
          short_id: VALID_SHORT_ID,
          original_object_key: `${VALID_SHORT_ID}/source.mp4`,
          upload_id: 'upload-1',
          thumbnail_object_key: `${VALID_SHORT_ID}/thumb.jpg`,
        }),
      );

      for (const field of [
        'id',
        'channel_id',
        'original_object_key',
        'upload_id',
        'thumbnail_object_key',
      ]) {
        expect(response).not.toHaveProperty(field);
      }
    });

    it('composes thumbnail_url from the thumbnails bucket, null without a key', () => {
      const withThumb = service.toResponse(
        persisted({ thumbnail_object_key: 'abc/1.jpg' }),
      );
      const withoutThumb = service.toResponse(persisted({}));

      expect(storage.buildPublicObjectUrl).toHaveBeenCalledWith(
        'thumbnails',
        'abc/1.jpg',
      );
      expect(withThumb.thumbnail_url).toBe('http://cdn/thumbnails/abc/1.jpg');
      expect(withoutThumb.thumbnail_url).toBeNull();
    });

    it('serializes dates as ISO-8601 strings', () => {
      const response = service.toResponse(
        persisted({ processed_at: new Date('2026-10-04T13:00:00Z') }),
      );

      expect(response.processed_at).toBe('2026-10-04T13:00:00.000Z');
      expect(response.created_at).toBe('2026-10-04T12:00:00.000Z');
    });
  });
});
