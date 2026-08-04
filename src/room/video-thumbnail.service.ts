import { Injectable, Logger } from '@nestjs/common';
import { loadImage } from '@napi-rs/canvas';
import { ChildProcess, spawn } from 'node:child_process';
import { THUMBNAIL_MAX_EDGE_PX } from './pdf-thumbnail.service';

export interface VideoThumbnailResult {
    buffer: Buffer;
    width: number;
    height: number;
}

/** A frame grab is a single fast seek + decode, nowhere near RecordingService's live-RTP timescale
 *  — this is just a ceiling against a hung/unreachable input (a slow-to-buffer GCS read, a
 *  moov-atom-at-end file ffmpeg has to scan for) rather than a tuned budget. */
const FFMPEG_TIMEOUT_MS = 15_000;

/**
 * Extracts one frame from a video as a JPEG thumbnail, server-side — the video-message equivalent
 * of PdfThumbnailService, and for the same reason: client-side poster generation
 * (spaces-angular-claude's poster-frame.ts) can silently fail, most commonly on iOS HEVC uploads,
 * leaving a video attachment with no usable thumbnail.
 *
 * ffmpeg (already a runtime dependency — see RecordingService) is asked to stream-copy exactly one
 * frame to stdout rather than write a temp file, since this only ever needs the resulting bytes in
 * memory. Best-effort throughout: resolves null on any failure (missing binary, unreadable input,
 * timeout, corrupt frame) rather than rejecting — a missing poster is a cosmetic gap, never a
 * reason to fail message delivery.
 */
@Injectable()
export class VideoThumbnailService {
    private readonly logger = new Logger(VideoThumbnailService.name);

    // Same '||' vs '??' reasoning as RecordingService.ffmpegPath — a blank env var must still fall
    // back to PATH resolution, not become an empty spawn() argument.
    private readonly ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';

    /** input: an https:// URL ffmpeg can read directly (GCS, public-read), or a local filesystem
     *  path (local-dev) — see ChatMediaService.resolveMediaLocation. Reports the RENDERED
     *  thumbnail's own pixel size, same convention as PdfThumbnailService.generate. Null on any
     *  failure. */
    async generate(input: string): Promise<VideoThumbnailResult | null> {
        try {
            const buffer = await this.captureFrame(input);
            const dimensions = await this.readImageDimensions(buffer);
            if (!dimensions) {
                return null;
            }
            return { buffer, width: dimensions.width, height: dimensions.height };
        } catch (error) {
            this.logger.warn(`Video thumbnail generation failed for ${input}: ${error instanceof Error ? error.message : String(error)}`);
            return null;
        }
    }

    /** Reads a JPEG/PNG buffer's own real pixel dimensions — used here to measure generate()'s own
     *  output, and by ChatMediaService to measure an EXISTING poster for the mismatch check. */
    async readImageDimensions(buffer: Buffer): Promise<{ width: number; height: number } | null> {
        try {
            const image = await this.loadImage(buffer);
            return { width: image.width, height: image.height };
        } catch {
            return null;
        }
    }

    /** One frame near the 1s mark (skips a common all-black/all-title first frame), scaled to fit
     *  THUMBNAIL_MAX_EDGE_PX without upscaling — works for both landscape and portrait without
     *  knowing the source dimensions up front, same box PDF thumbnails target. Piped to stdout
     *  (pipe:1) rather than a temp file, since only the bytes are ever needed. */
    private captureFrame(input: string): Promise<Buffer> {
        const scale = `scale='min(${THUMBNAIL_MAX_EDGE_PX},iw)':'min(${THUMBNAIL_MAX_EDGE_PX},ih)':force_original_aspect_ratio=decrease`;
        const args = ['-y', '-ss', '1', '-i', input, '-frames:v', '1', '-vf', scale, '-f', 'image2', '-vcodec', 'mjpeg', '-q:v', '3', 'pipe:1'];

        return new Promise((resolve, reject) => {
            const ffmpeg = this.spawn(args);
            const stdoutChunks: Buffer[] = [];
            const stderrChunks: Buffer[] = [];
            let settled = false;

            const timer = setTimeout(() => {
                if (!settled) {
                    ffmpeg.kill('SIGKILL');
                }
            }, FFMPEG_TIMEOUT_MS);

            ffmpeg.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
            ffmpeg.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

            ffmpeg.once('error', (error) => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timer);
                reject(error);
            });

            ffmpeg.once('exit', (code, signal) => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timer);
                const buffer = Buffer.concat(stdoutChunks);
                if (code === 0 && buffer.length > 0) {
                    resolve(buffer);
                    return;
                }
                const stderrTail = Buffer.concat(stderrChunks).toString('utf8').slice(-500);
                reject(new Error(`ffmpeg (video-thumbnail) exited with code=${code} signal=${signal}: ${stderrTail}`));
            });
        });
    }

    // Test-substitution seams, same reasoning as PdfThumbnailService.loadPdfjsLib: isolate the
    // native/process boundary so tests never spawn a real ffmpeg or decode a real image.
    protected spawn(args: string[]): ChildProcess {
        return spawn(this.ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    }

    protected loadImage(buffer: Buffer) {
        return loadImage(buffer);
    }
}
