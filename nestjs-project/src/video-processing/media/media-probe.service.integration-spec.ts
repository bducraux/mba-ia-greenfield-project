import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import {
  createServer as createHttpServer,
  type Server as HttpServer,
} from 'node:http';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Test } from '@nestjs/testing';
import { MEDIA_PROCESS_TIMEOUTS } from './media.constants';
import {
  MediaProcessFailedError,
  MediaProcessTimeoutError,
  MediaUnsupportedContentError,
} from './media-probe.errors';
import { MediaProbeService } from './media-probe.service';
import { checkCompatibility } from './video-compatibility';

const FIXTURES = resolve(__dirname, '../../../test/fixtures/videos');
const fixture = (name: string): string => join(FIXTURES, name);

const SHORT_TIMEOUT_MS = 1000;

async function createService(timeouts?: {
  probeMs: number;
  thumbnailMs: number;
}): Promise<MediaProbeService> {
  const moduleRef = await Test.createTestingModule({
    providers: [
      MediaProbeService,
      ...(timeouts
        ? [{ provide: MEDIA_PROCESS_TIMEOUTS, useValue: timeouts }]
        : []),
    ],
  }).compile();
  return moduleRef.get(MediaProbeService);
}

/** Listens on a random local port and returns it. */
async function listen(server: Server | HttpServer): Promise<number> {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  return typeof address === 'object' && address ? address.port : 0;
}

/** Probes a JPEG buffer through a temp file and returns its first stream. */
async function probeJpeg(
  service: MediaProbeService,
  dir: string,
  jpeg: Buffer,
): Promise<{ codec_name?: string; width?: number; height?: number }> {
  const path = join(dir, `thumb-${Date.now()}.jpg`);
  writeFileSync(path, jpeg);
  const result = await service.probe(path);
  return result.streams?.[0] ?? {};
}

describe('MediaProbeService (integration)', () => {
  let service: MediaProbeService;
  let tmpDir: string;

  beforeAll(async () => {
    service = await createService();
    tmpDir = mkdtempSync(join(tmpdir(), 'media-probe-'));
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('probe', () => {
    it('should probe h264-aac.mp4 as compatible with its metadata', async () => {
      const result = checkCompatibility(
        await service.probe(fixture('h264-aac.mp4')),
      );

      expect(result).toEqual({
        compatible: true,
        metadata: {
          duration_seconds: expect.closeTo(2, 1) as number,
          width: 320,
          height: 240,
          video_codec: 'h264',
          audio_codec: 'aac',
        },
      });
    });

    it('should probe vp9-opus.webm as compatible', async () => {
      const result = checkCompatibility(
        await service.probe(fixture('vp9-opus.webm')),
      );

      expect(result).toMatchObject({
        compatible: true,
        metadata: { video_codec: 'vp9', audio_codec: 'opus' },
      });
    });

    it.each(['mpeg4.mp4', 'audio-only.mp4'])(
      'should probe %s as incompatible',
      async (name) => {
        const result = checkCompatibility(await service.probe(fixture(name)));

        expect(result.compatible).toBe(false);
      },
    );

    it('should reject not-a-video.mp4 as unsupported content', async () => {
      await expect(service.probe(fixture('not-a-video.mp4'))).rejects.toThrow(
        MediaUnsupportedContentError,
      );
    });

    it('should reject a non-WebM payload with a .webm name as unsupported content', async () => {
      const junk = join(tmpDir, 'junk.webm');
      writeFileSync(junk, 'this is not a webm file\n');

      await expect(service.probe(junk)).rejects.toThrow(
        MediaUnsupportedContentError,
      );
    });
  });

  describe('invalid content vs transport failures over HTTP', () => {
    let server: HttpServer;
    let baseUrl: string;

    beforeAll(async () => {
      const notAVideo = readFileSync(fixture('not-a-video.mp4'));
      server = createHttpServer((request, response) => {
        if (request.url === '/not-a-video.mp4') {
          response.writeHead(200, { 'Content-Type': 'video/mp4' });
          response.end(notAVideo);
          return;
        }
        response.writeHead(503);
        response.end();
      });
      baseUrl = `http://127.0.0.1:${await listen(server)}`;
    });

    afterAll(async () => {
      await new Promise<void>((done) => server.close(() => done()));
    });

    it('should reject invalid bytes served over HTTP as unsupported content', async () => {
      await expect(service.probe(`${baseUrl}/not-a-video.mp4`)).rejects.toThrow(
        MediaUnsupportedContentError,
      );
    });

    it('should reject an HTTP 5xx from storage as a retryable failure', async () => {
      await expect(service.probe(`${baseUrl}/unavailable.mp4`)).rejects.toThrow(
        MediaProcessFailedError,
      );
    });

    it('should reject a refused connection as a retryable failure', async () => {
      const closed = createHttpServer();
      const port = await listen(closed);
      await new Promise<void>((done) => closed.close(() => done()));

      await expect(
        service.probe(`http://127.0.0.1:${port}/video.mp4`),
      ).rejects.toThrow(MediaProcessFailedError);
    });
  });

  describe('extractThumbnail', () => {
    it('should return a JPEG frame from h264-aac.mp4', async () => {
      const jpeg = await service.extractThumbnail(fixture('h264-aac.mp4'), 2);

      expect(jpeg.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
      await expect(probeJpeg(service, tmpDir, jpeg)).resolves.toMatchObject({
        codec_name: 'mjpeg',
        width: 320,
      });
    });

    it('should seek to the start when the duration is shorter than the end margin', async () => {
      const jpeg = await service.extractThumbnail(
        fixture('vp9-opus.webm'),
        0.05,
      );

      expect(jpeg.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    });

    it('should scale a wider source down to 1280px', async () => {
      const wide = join(tmpDir, 'wide.mp4');
      const generated = spawnSync('ffmpeg', [
        '-v',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc=duration=1:size=1920x1080:rate=10',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        wide,
      ]);
      expect(generated.status).toBe(0);

      const jpeg = await service.extractThumbnail(wide, 1);

      await expect(probeJpeg(service, tmpDir, jpeg)).resolves.toMatchObject({
        width: 1280,
        height: 720,
      });
    });

    it('should reject not-a-video.mp4 as unsupported content', async () => {
      await expect(
        service.extractThumbnail(fixture('not-a-video.mp4'), 2),
      ).rejects.toThrow(MediaUnsupportedContentError);
    });
  });

  describe('timeout', () => {
    let server: Server;
    let url: string;
    const sockets: Socket[] = [];

    beforeAll(async () => {
      // Accepts the connection and never answers, so ffprobe/ffmpeg hang.
      // `resume()` drains the request so the peer's FIN is seen as 'close'.
      server = createServer((socket) => {
        sockets.push(socket);
        socket.resume();
      });
      url = `http://127.0.0.1:${await listen(server)}/video.mp4`;
    });

    afterAll(async () => {
      sockets.forEach((socket) => socket.destroy());
      await new Promise<void>((done) => server.close(() => done()));
    });

    it('should kill a hanging ffprobe and reject with a timeout error', async () => {
      const fast = await createService({
        probeMs: SHORT_TIMEOUT_MS,
        thumbnailMs: SHORT_TIMEOUT_MS,
      });
      const connected = new Promise<Socket>((done) =>
        server.once('connection', done),
      );

      const started = Date.now();
      await expect(fast.probe(url)).rejects.toThrow(MediaProcessTimeoutError);
      expect(Date.now() - started).toBeLessThan(SHORT_TIMEOUT_MS * 5);

      // The killed process closes its end of the connection.
      const socket = await connected;
      await new Promise<void>((done) => {
        if (socket.destroyed || socket.readableEnded) return done();
        socket.once('close', () => done());
      });
    });

    it('should kill a hanging ffmpeg thumbnail extraction', async () => {
      const fast = await createService({
        probeMs: SHORT_TIMEOUT_MS,
        thumbnailMs: SHORT_TIMEOUT_MS,
      });

      await expect(fast.extractThumbnail(url, 2)).rejects.toThrow(
        MediaProcessTimeoutError,
      );
    });
  });
});
