import { Test } from '@nestjs/testing';
import { AppModule } from './app.module';
import { VideoProcessingConsumer } from './video-processing/video-processing.consumer';
import { VideoProcessingProducer } from './video-processing/video-processing.producer';

describe('AppModule', () => {
  it('should compile with the queue producer but without the consumer', async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    // The API enqueues jobs but never consumes them; only the worker process
    // registers the BullMQ Worker (phase-03-upload-processing/TD-08).
    expect(
      module.get(VideoProcessingProducer, { strict: false }),
    ).toBeInstanceOf(VideoProcessingProducer);
    expect(() =>
      module.get(VideoProcessingConsumer, { strict: false }),
    ).toThrow();

    await module.close();
  }, 30000);
});
