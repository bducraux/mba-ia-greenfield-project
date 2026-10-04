import { Test } from '@nestjs/testing';
import { VideoProcessingConsumer } from './video-processing/video-processing.consumer';
import { WorkerModule } from './worker.module';

describe('WorkerModule', () => {
  // compile() does not run onModuleInit, so no BullMQ Worker is started and
  // the shared queue is never consumed by this test.
  it('should compile and resolve the video-processing consumer', async () => {
    const module = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();

    expect(
      module.get(VideoProcessingConsumer, { strict: false }),
    ).toBeInstanceOf(VideoProcessingConsumer);

    await module.close();
  }, 30000);
});
