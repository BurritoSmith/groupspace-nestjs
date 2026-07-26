import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import * as path from 'node:path';
import { AppModule } from './app.module';
import { getAllowedOrigins } from './config/cors-origins';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.enableCors({
    origin: getAllowedOrigins(),
    credentials: true,
  });
  // Serves recordings directly from disk for RecordingService.getSessionDetail's local-dev
  // playback links (no RECORDINGS_GCS_BUCKET configured). In production, finalized recordings
  // are uploaded to GCS and deleted locally, so this route normally has nothing to serve there —
  // playback links point at signed GCS URLs instead. express.static's built-in Range support is
  // what actually matters here: without it, <video> scrubbing wouldn't work even locally.
  const recordingsDir = process.env.RECORDINGS_DIR ?? path.join(process.cwd(), 'recordings');
  app.useStaticAssets(recordingsDir, { prefix: '/recordings/' });
  await app.listen(process.env.PORT ?? 3001);
}
bootstrap();
