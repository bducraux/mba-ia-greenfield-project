import { getQueueToken, BullModule } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import queueConfig from '../config/queue.config';
import { QueueModule } from './queue.module';

describe('QueueModule', () => {
  it('should compile and wire the root connection from queue config', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        QueueModule,
        BullModule.registerQueue({ name: 'queue-module-spec' }),
      ],
    }).compile();

    const queue = module.get<Queue>(getQueueToken('queue-module-spec'));
    const connection = queue.opts.connection as { host: string; port: number };
    expect(connection.host).toBe(process.env.REDIS_HOST);
    expect(connection.port).toBe(Number(process.env.REDIS_PORT ?? 6379));

    await module.close();
  }, 15000);
});
