import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  // On SIGTERM/SIGINT the WorkerHost closes the BullMQ worker, letting the
  // active job finish before the process exits.
  app.enableShutdownHooks();
}
void bootstrap();
