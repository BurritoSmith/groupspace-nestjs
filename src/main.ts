import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AppModule } from './app.module';
import { getAllowedOrigins } from './config/cors-origins';

async function bootstrap() {
  // Opt-in only (see .env's DEV_HTTPS_CERT/DEV_HTTPS_KEY comment) — lets the API be reached as
  // https:// from a phone testing the frontend's `npm run start:lan` over the LAN. Undefined in
  // every other case (normal local dev, CI, deployed environments), so app.listen below falls
  // back to plain HTTP exactly as before.
  const httpsOptions =
    process.env.DEV_HTTPS_CERT && process.env.DEV_HTTPS_KEY
      ? { cert: fs.readFileSync(process.env.DEV_HTTPS_CERT), key: fs.readFileSync(process.env.DEV_HTTPS_KEY) }
      : undefined;
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { httpsOptions });
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
  // Same local-dev-only fallback as recordings above — ChatMediaService only writes here when
  // CHAT_MEDIA_GCS_BUCKET isn't configured; in production, chat attachments go straight to a
  // public-read GCS bucket instead (see that service's own comment for why, unlike recordings,
  // that's public-read rather than signed URLs).
  const chatMediaDir = process.env.CHAT_MEDIA_DIR ?? path.join(process.cwd(), 'chat-media');
  app.useStaticAssets(chatMediaDir, { prefix: '/chat-media/' });
  await app.listen(process.env.PORT ?? 3001);
}
bootstrap();
