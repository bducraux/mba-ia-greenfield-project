import type { FfprobeResult, FfprobeStream } from './media-probe.types';
import { checkCompatibility } from './video-compatibility';

const videoStream = (
  overrides: Partial<FfprobeStream> = {},
): FfprobeStream => ({
  codec_type: 'video',
  codec_name: 'h264',
  width: 1920,
  height: 1080,
  ...overrides,
});

const audioStream = (
  overrides: Partial<FfprobeStream> = {},
): FfprobeStream => ({
  codec_type: 'audio',
  codec_name: 'aac',
  ...overrides,
});

const probeResult = (
  overrides: Partial<FfprobeResult> = {},
): FfprobeResult => ({
  streams: [videoStream(), audioStream()],
  format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '12.480000' },
  ...overrides,
});

describe('checkCompatibility', () => {
  it('should accept H.264 + AAC in MP4 and extract the metadata', () => {
    expect(checkCompatibility(probeResult())).toEqual({
      compatible: true,
      metadata: {
        duration_seconds: 12.48,
        width: 1920,
        height: 1080,
        video_codec: 'h264',
        audio_codec: 'aac',
      },
    });
  });

  it('should accept WebM with VP9 + Opus', () => {
    const result = checkCompatibility(
      probeResult({
        streams: [
          videoStream({ codec_name: 'vp9' }),
          audioStream({ codec_name: 'opus' }),
        ],
        format: { format_name: 'matroska,webm', duration: '2.008000' },
      }),
    );

    expect(result).toMatchObject({
      compatible: true,
      metadata: { video_codec: 'vp9', audio_codec: 'opus' },
    });
  });

  it.each(['h264', 'vp8', 'vp9', 'av1'])(
    'should accept the %s video codec',
    (codec) => {
      const result = checkCompatibility(
        probeResult({ streams: [videoStream({ codec_name: codec })] }),
      );

      expect(result.compatible).toBe(true);
    },
  );

  it.each(['aac', 'mp3', 'opus', 'vorbis'])(
    'should accept the %s audio codec',
    (codec) => {
      const result = checkCompatibility(
        probeResult({
          streams: [videoStream(), audioStream({ codec_name: codec })],
        }),
      );

      expect(result).toMatchObject({
        compatible: true,
        metadata: { audio_codec: codec },
      });
    },
  );

  it('should accept a video without audio and report audio_codec as null', () => {
    const result = checkCompatibility(
      probeResult({ streams: [videoStream()] }),
    );

    expect(result).toMatchObject({
      compatible: true,
      metadata: { audio_codec: null },
    });
  });

  it('should reject a container other than MP4/WebM', () => {
    const result = checkCompatibility(
      probeResult({ format: { format_name: 'avi', duration: '5.0' } }),
    );

    expect(result).toEqual({
      compatible: false,
      reason: expect.stringContaining('avi') as string,
    });
  });

  it('should not match a container by substring', () => {
    const result = checkCompatibility(
      probeResult({ format: { format_name: 'mp4x', duration: '5.0' } }),
    );

    expect(result.compatible).toBe(false);
  });

  it('should reject a file without a video stream', () => {
    const result = checkCompatibility(
      probeResult({ streams: [audioStream()] }),
    );

    expect(result).toEqual({ compatible: false, reason: 'no video stream' });
  });

  it('should reject a video codec outside the allowlist', () => {
    const result = checkCompatibility(
      probeResult({ streams: [videoStream({ codec_name: 'mpeg4' })] }),
    );

    expect(result).toEqual({
      compatible: false,
      reason: expect.stringContaining('mpeg4') as string,
    });
  });

  it('should use a supported video stream when another video stream is not supported', () => {
    const result = checkCompatibility(
      probeResult({
        streams: [
          videoStream({ codec_name: 'mjpeg', width: 320, height: 240 }),
          videoStream({ codec_name: 'h264', width: 1280, height: 720 }),
        ],
      }),
    );

    expect(result).toMatchObject({
      compatible: true,
      metadata: { video_codec: 'h264', width: 1280, height: 720 },
    });
  });

  it('should reject when the first audio stream codec is outside the allowlist', () => {
    const result = checkCompatibility(
      probeResult({
        streams: [
          videoStream(),
          audioStream({ codec_name: 'flac' }),
          audioStream({ codec_name: 'aac' }),
        ],
      }),
    );

    expect(result).toEqual({
      compatible: false,
      reason: expect.stringContaining('flac') as string,
    });
  });

  it('should reject a video stream without dimensions', () => {
    const result = checkCompatibility(
      probeResult({ streams: [videoStream({ width: undefined })] }),
    );

    expect(result).toEqual({
      compatible: false,
      reason: 'video stream has no dimensions',
    });
  });

  it.each([['0.000000'], ['N/A'], [undefined]])(
    'should reject duration %p',
    (duration) => {
      const result = checkCompatibility(
        probeResult({ format: { format_name: 'mov,mp4', duration } }),
      );

      expect(result).toEqual({
        compatible: false,
        reason: 'duration is not positive',
      });
    },
  );
});
