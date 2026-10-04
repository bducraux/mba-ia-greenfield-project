import {
  SUPPORTED_AUDIO_CODECS,
  SUPPORTED_CONTAINERS,
  SUPPORTED_VIDEO_CODECS,
} from './media.constants';
import type { FfprobeResult, FfprobeStream } from './media-probe.types';

export interface ProbedVideoMetadata {
  duration_seconds: number;
  width: number;
  height: number;
  video_codec: string;
  audio_codec: string | null;
}

export type CompatibilityResult =
  | { compatible: true; metadata: ProbedVideoMetadata }
  | { compatible: false; reason: string };

const incompatible = (reason: string): CompatibilityResult => ({
  compatible: false,
  reason,
});

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0;

/**
 * Browser-playback gate over an ffprobe result: MP4/WebM container, at least
 * one video stream in the codec allowlist, first audio stream (if any) in the
 * audio allowlist and a positive duration.
 */
export function checkCompatibility(probe: FfprobeResult): CompatibilityResult {
  const streams = probe.streams ?? [];
  const containers = (probe.format?.format_name ?? '').split(',');
  if (!containers.some((name) => SUPPORTED_CONTAINERS.includes(name))) {
    return incompatible(
      `container "${probe.format?.format_name ?? 'unknown'}" is not MP4/WebM`,
    );
  }

  const videoStreams = streams.filter((s) => s.codec_type === 'video');
  if (videoStreams.length === 0) {
    return incompatible('no video stream');
  }
  const video = videoStreams.find((s) =>
    SUPPORTED_VIDEO_CODECS.includes(s.codec_name ?? ''),
  );
  if (!video) {
    const codecs = videoStreams.map((s) => s.codec_name ?? 'unknown');
    return incompatible(`video codec "${codecs.join(', ')}" is not supported`);
  }
  if (!isPositiveInteger(video.width) || !isPositiveInteger(video.height)) {
    return incompatible('video stream has no dimensions');
  }

  const audio: FfprobeStream | undefined = streams.find(
    (s) => s.codec_type === 'audio',
  );
  if (audio && !SUPPORTED_AUDIO_CODECS.includes(audio.codec_name ?? '')) {
    return incompatible(
      `audio codec "${audio.codec_name ?? 'unknown'}" is not supported`,
    );
  }

  const duration = Number.parseFloat(probe.format?.duration ?? '');
  if (!Number.isFinite(duration) || duration <= 0) {
    return incompatible('duration is not positive');
  }

  return {
    compatible: true,
    metadata: {
      duration_seconds: duration,
      width: video.width,
      height: video.height,
      video_codec: video.codec_name as string,
      audio_codec: audio?.codec_name ?? null,
    },
  };
}
