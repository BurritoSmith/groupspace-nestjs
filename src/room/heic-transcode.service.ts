import { Injectable, Logger } from '@nestjs/common';
import { ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** Matches the JPEG quality the client encodes its own renditions at (see the frontend's
 *  image-thumbnail.ts) — a photo re-encoded on the way in should not be visibly worse than one the
 *  browser converted itself. */
const JPEG_QUALITY = 90;

/** A still-image decode, not a video pass. Generous enough for a 48MP HEIC on a loaded box, short
 *  enough that a wedged decoder cannot hold an upload request open indefinitely. */
const TIMEOUT_MS = 20_000;

/**
 * Converts HEIC/HEIF uploads to JPEG.
 *
 * iPhones shoot HEIC by default, and the chat file input has always advertised `.heic` — but no
 * browser except Safari can display one, so storing the original would put an image in the chat that
 * most people simply could not see. Transcoding on the way in means everything in storage stays
 * something every client can render, and nothing downstream has to know HEIC exists.
 *
 * `heif-convert` (libheif, installed in the Dockerfile alongside ffmpeg) rather than ffmpeg itself:
 * the container's ffmpeg is Debian bookworm's 5.1, and the HEIF demuxer did not arrive until 7.1, so
 * it cannot read these files at all. Upgrading it was the wrong lever — the live recording pipeline
 * runs on that exact binary and has a history of being delicate about it (see RecordingService), and
 * a photo format is no reason to put that at risk. libheif is ~1.3MB and touches nothing else.
 *
 * Unlike the thumbnail services this is NOT best-effort. A failure here has to fail the upload: the
 * alternative is storing bytes the recipients cannot open, which is worse than a clear rejection.
 * It returns null and lets ChatMediaService raise the HTTP error, keeping this file free of
 * transport concerns.
 *
 * Temp files rather than pipes because heif-convert takes paths, not streams — it picks the output
 * encoder from the filename extension and has no stdout mode.
 */
@Injectable()
export class HeicTranscodeService {
    private readonly logger = new Logger(HeicTranscodeService.name);

    // Same '||' vs '??' reasoning as VideoThumbnailService.ffmpegPath — a blank env var must fall
    // back to PATH resolution, not become an empty spawn() argument.
    private readonly heifConvertPath = process.env.HEIF_CONVERT_PATH || 'heif-convert';

    /**
     * The JPEG bytes, or null if the file could not be decoded.
     *
     * Null also covers the binary being missing entirely, which is the normal state of a Windows dev
     * machine — the same way ffmpeg is absent there and video thumbnails simply do not generate. The
     * difference is only in what the caller does about it.
     */
    async toJpeg(heic: Buffer): Promise<Buffer | null> {
        const workDir = path.join(os.tmpdir(), `heic-${randomUUID()}`);
        const input = path.join(workDir, 'in.heic');
        const output = path.join(workDir, 'out.jpg');

        try {
            await fs.mkdir(workDir, { recursive: true });
            await fs.writeFile(input, heic);
            await this.run(['-q', String(JPEG_QUALITY), input, output]);
            return await this.readOutput(workDir);
        } catch (error) {
            this.logger.warn(`HEIC transcode failed: ${error instanceof Error ? error.message : String(error)}`);
            return null;
        } finally {
            await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
        }
    }

    /**
     * Reads whatever heif-convert actually wrote.
     *
     * It does not always write the filename it is given: a HEIC holding more than one top-level
     * image — a burst, or the stills inside a Live Photo — gets an index appended per image, so the
     * requested `out.jpg` becomes `out-1.jpg`, `out-2.jpg` and so on, and nothing exists at the path
     * asked for. Scanning the directory covers both shapes without having to predict which one a
     * given file will take. The first image is the right one to keep: for a burst it is the frame the
     * phone itself shows as the photo.
     */
    private async readOutput(workDir: string): Promise<Buffer | null> {
        const written = (await fs.readdir(workDir)).filter((name) => name.endsWith('.jpg')).sort();
        if (written.length === 0) {
            this.logger.warn('HEIC transcode produced no output file');
            return null;
        }
        const jpeg = await fs.readFile(path.join(workDir, written[0]));
        return jpeg.length > 0 ? jpeg : null;
    }

    /** Rejects on a non-zero exit, a missing binary, or the timeout — all of which the caller turns
     *  into the same null. */
    private run(args: string[]): Promise<void> {
        return new Promise((resolve, reject) => {
            const child = this.spawn(args);
            const stderrChunks: Buffer[] = [];
            let settled = false;

            const timer = setTimeout(() => {
                if (!settled) {
                    child.kill('SIGKILL');
                }
            }, TIMEOUT_MS);

            child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

            child.once('error', (error) => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timer);
                reject(error);
            });

            child.once('exit', (code, signal) => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timer);
                if (code === 0) {
                    resolve();
                    return;
                }
                const stderrTail = Buffer.concat(stderrChunks).toString('utf8').slice(-500);
                reject(new Error(`heif-convert exited with code=${code} signal=${signal}: ${stderrTail}`));
            });
        });
    }

    /** Test-substitution seam, same reasoning as VideoThumbnailService.spawn: keep the process
     *  boundary in one overridable place so tests never launch a real decoder. */
    protected spawn(args: string[]): ChildProcess {
        return spawn(this.heifConvertPath, args, {
            stdio: ['ignore', 'ignore', 'pipe'],
        });
    }
}
