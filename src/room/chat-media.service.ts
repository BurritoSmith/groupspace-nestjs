import { Injectable, Logger, PayloadTooLargeException, UnsupportedMediaTypeException } from '@nestjs/common';
import { Storage } from '@google-cloud/storage';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { sniffedTypeMatchesDeclared, sniffMediaType } from './file-sniff';
import { IChatAttachment } from './interfaces/room.interfaces';
import { PdfThumbnailService } from './pdf-thumbnail.service';
import { VideoThumbnailService } from './video-thumbnail.service';

export interface IUploadedChatMedia {
    url: string;
    storagePath: string | null;
    mimeType: string;
}

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

const DEFAULT_MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_VIDEO_BYTES = 100 * 1024 * 1024;
const DEFAULT_MAX_PDF_BYTES = 50 * 1024 * 1024;

/** How far an existing poster's own aspect ratio may drift from the claimed width/height before
 *  it's treated as wrong rather than encoder rounding noise — see ensureVideoThumbnail. Tune once
 *  there's real data (see the video-poster-fallback plan's verification notes). */
const ASPECT_RATIO_TOLERANCE = 0.12;

const EXTENSION_BY_MIME_TYPE: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'application/pdf': 'pdf',
};

/**
 * Uploads chat image/video/gif/pdf attachments — mirrors RecordingService's GCS/ADC/bucket-name-env-var
 * pattern (see that file's own gcsBucketName/storage fields), but into a SEPARATE bucket (its own
 * lifecycle/permissions, kept independent of recordings) and via a buffer-based upload rather than
 * RecordingService.uploadToGcsIfConfigured's local-file-path one, since this always starts from an
 * in-memory multipart buffer, not a file already on disk.
 *
 * Deliberately public-read (not signed URLs like recordings): chat scrollback stays open for the
 * whole call, and a 1-hour signed URL would go stale mid-call. UUID object names are unguessable,
 * and the room itself has no access code, so this isn't a meaningfully weaker guarantee than
 * "anyone who has the room link can see it" — which is already true of everything else in the room.
 */
@Injectable()
export class ChatMediaService {
    private readonly logger = new Logger(ChatMediaService.name);

    private readonly gcsBucketName = process.env.CHAT_MEDIA_GCS_BUCKET || undefined;
    private readonly storage = this.gcsBucketName ? new Storage() : null;
    private readonly localDir = process.env.CHAT_MEDIA_DIR ?? path.join(process.cwd(), 'chat-media');

    // '||' not '??', matching RecordingService.ffmpegPath's own reasoning — an explicitly blank
    // env var (Number('') === 0) must still fall back to the default, not silently become a
    // zero-byte cap that rejects every upload.
    private readonly maxImageBytes = Number(process.env.CHAT_MEDIA_MAX_IMAGE_BYTES) || DEFAULT_MAX_IMAGE_BYTES;
    private readonly maxVideoBytes = Number(process.env.CHAT_MEDIA_MAX_VIDEO_BYTES) || DEFAULT_MAX_VIDEO_BYTES;
    private readonly maxPdfBytes = Number(process.env.CHAT_MEDIA_MAX_PDF_BYTES) || DEFAULT_MAX_PDF_BYTES;

    /** The URL prefix every genuine upload's `url` starts with — used by room.gateway.ts's
     *  isAllowedAttachmentUrl to reject anything that doesn't actually come from here. Root-relative
     *  in local dev (no bucket configured), matching main.ts's /chat-media/ static mount. */
    readonly publicBase = this.gcsBucketName ? `https://storage.googleapis.com/${this.gcsBucketName}/` : '/chat-media/';

    /** Highest declared upload size across both kinds — passed to multer's own `limits.fileSize`
     *  so an oversized request is rejected before its body is even fully read into memory. Static
     *  (evaluated once, at module load, for the @UseInterceptors decorator in the controller,
     *  which can't read an instance field) rather than derived from the instance fields above —
     *  the per-kind cap below (checked AFTER sniffing, so a video-sized file lying about being an
     *  image still gets caught) is the real, per-instance enforcement point. */
    static readonly MAX_UPLOAD_BYTES = Math.max(
        Number(process.env.CHAT_MEDIA_MAX_IMAGE_BYTES) || DEFAULT_MAX_IMAGE_BYTES,
        Number(process.env.CHAT_MEDIA_MAX_VIDEO_BYTES) || DEFAULT_MAX_VIDEO_BYTES,
        Number(process.env.CHAT_MEDIA_MAX_PDF_BYTES) || DEFAULT_MAX_PDF_BYTES,
    );

    constructor(
        private readonly pdfThumbnails: PdfThumbnailService,
        private readonly videoThumbnails: VideoThumbnailService,
    ) {}

    /** Validates (magic-byte sniff, not the client's claimed Content-Type/filename), then uploads
     *  a chat attachment. Throws PayloadTooLargeException/UnsupportedMediaTypeException — the
     *  controller lets Nest's own exception filter turn those into the matching HTTP status. */
    async uploadAttachment(buffer: Buffer, roomName: string, declaredContentType: string): Promise<IUploadedChatMedia> {
        const sniffed = sniffMediaType(buffer);
        if (!sniffed || !sniffedTypeMatchesDeclared(sniffed, declaredContentType)) {
            throw new UnsupportedMediaTypeException('Unsupported or unrecognized file type');
        }
        const isImage = IMAGE_TYPES.has(sniffed);
        const isPdf = sniffed === 'application/pdf';
        const cap = isImage ? this.maxImageBytes : isPdf ? this.maxPdfBytes : this.maxVideoBytes;
        if (buffer.length > cap) {
            throw new PayloadTooLargeException(`File exceeds the ${isImage ? 'image' : isPdf ? 'pdf' : 'video'} size limit`);
        }

        const objectPath = `${this.sanitize(roomName)}/${new Date().getUTCFullYear()}/${String(new Date().getUTCMonth() + 1).padStart(2, '0')}/${randomUUID()}.${EXTENSION_BY_MIME_TYPE[sniffed]}`;

        if (this.storage && this.gcsBucketName) {
            await this.storage.bucket(this.gcsBucketName).file(objectPath).save(buffer, {
                contentType: sniffed,
                resumable: false,
                metadata: { cacheControl: 'public, max-age=31536000, immutable' },
            });
            return { url: `${this.publicBase}${objectPath}`, storagePath: objectPath, mimeType: sniffed };
        }

        const localPath = path.join(this.localDir, objectPath);
        await fs.mkdir(path.dirname(localPath), { recursive: true });
        await fs.writeFile(localPath, buffer);
        return { url: `${this.publicBase}${objectPath}`, storagePath: null, mimeType: sniffed };
    }

    /**
     * Renders and uploads a thumbnail for a just-uploaded PDF, returning its URL and pixel size —
     * or null for every reason including failure, exactly like the client-generated thumbnails
     * uploaded alongside an image/video (see ChatUploads.uploadSideCar's own comment): a missing
     * thumbnail costs the chat list its cheap source, not the send.
     *
     * The upload goes through uploadAttachment() itself, same as any other file — the rendered
     * thumbnail is a plain JPEG, sniffs and stores exactly like one a user attached directly.
     */
    async generatePdfThumbnail(buffer: Buffer, roomName: string): Promise<{ url: string; width: number; height: number } | null> {
        const rendered = await this.pdfThumbnails.generate(buffer);
        if (!rendered) {
            return null;
        }
        try {
            const uploaded = await this.uploadAttachment(rendered.buffer, roomName, 'image/jpeg');
            return { url: uploaded.url, width: rendered.width, height: rendered.height };
        } catch (error) {
            this.logger.warn(`Failed to upload generated pdf thumbnail: ${error instanceof Error ? error.message : String(error)}`);
            return null;
        }
    }

    /**
     * Regenerates a video's poster/dimensions when they look missing or wrong (see
     * videoThumbnailNeedsRegeneration). Returns a NEW IChatAttachment with thumbnailUrl/width/height
     * patched, or null when nothing needed to change or generation failed — both mean: leave the
     * message exactly as sent. Mirrors generatePdfThumbnail's best-effort shape, but takes/returns
     * a whole attachment (rather than a bare url/width/height) since the caller needs the patched
     * fields merged back onto the one it's replacing in the message's attachments array.
     */
    async ensureVideoThumbnail(attachment: IChatAttachment, roomName: string): Promise<IChatAttachment | null> {
        if (attachment.kind !== 'video' || !(await this.videoThumbnailNeedsRegeneration(attachment))) {
            return null;
        }
        const generated = await this.videoThumbnails.generate(this.resolveMediaLocation(attachment.url));
        if (!generated) {
            return null;
        }
        try {
            const uploaded = await this.uploadAttachment(generated.buffer, roomName, 'image/jpeg');
            return { ...attachment, thumbnailUrl: uploaded.url, width: generated.width, height: generated.height };
        } catch (error) {
            this.logger.warn(`Failed to upload generated video thumbnail: ${error instanceof Error ? error.message : String(error)}`);
            return null;
        }
    }

    /**
     * True when a video attachment's poster is missing, or when the poster's OWN decoded pixel
     * aspect ratio disagrees with the claimed width/height by more than ASPECT_RATIO_TOLERANCE (or
     * the poster can't be read/decoded at all).
     *
     * Deliberately only ever reads the poster image's own bytes here (cheap — a small JPEG), never
     * the video itself — probing the source video's real dimensions on every message, including the
     * common already-correct case, would touch every video's (up to 100MB) bytes for a failure mode
     * (internally-consistent-but-wrong values) this check doesn't need to catch.
     */
    private async videoThumbnailNeedsRegeneration(attachment: IChatAttachment): Promise<boolean> {
        if (!attachment.thumbnailUrl || !attachment.width || !attachment.height) {
            return true;
        }
        const posterBytes = await this.readMediaBytes(attachment.thumbnailUrl);
        if (!posterBytes) {
            return true;
        }
        const posterDimensions = await this.videoThumbnails.readImageDimensions(posterBytes);
        if (!posterDimensions) {
            return true;
        }
        const claimedRatio = attachment.width / attachment.height;
        const posterRatio = posterDimensions.width / posterDimensions.height;
        return Math.abs(claimedRatio - posterRatio) / claimedRatio > ASPECT_RATIO_TOLERANCE;
    }

    /** Best-effort raw-bytes read of one of OUR OWN attachment URLs (never the video itself — only
     *  used for the small poster-image mismatch check above). Plain fetch()/fs.readFile — NOT
     *  link-preview-url.ts's SSRF-hardened fetchWithRedirectGuard, which exists for arbitrary
     *  THIRD-PARTY urls; this only ever reads our own already-validated storage. Null on any failure
     *  (404, corrupt, unreachable). */
    private async readMediaBytes(url: string): Promise<Buffer | null> {
        try {
            const location = this.resolveMediaLocation(url);
            if (/^https?:\/\//.test(location)) {
                const response = await fetch(location);
                if (!response.ok) {
                    return null;
                }
                return Buffer.from(await response.arrayBuffer());
            }
            return await fs.readFile(location);
        } catch {
            return null;
        }
    }

    /** Resolves an attachment's own url to something ffmpeg/fs can read: the https URL as-is in
     *  GCS mode (public-read — no auth needed), or a real local filesystem path (strip publicBase's
     *  /chat-media/ prefix, join onto localDir) in local-dev mode, where storagePath is never
     *  populated (see uploadAttachment). */
    private resolveMediaLocation(url: string): string {
        if (this.gcsBucketName) {
            return url;
        }
        const relative = url.startsWith(this.publicBase) ? url.slice(this.publicBase.length) : url.replace(/^\/+/, '');
        return path.join(this.localDir, relative);
    }

    private sanitize(value: string): string {
        const cleaned = value
            .replace(/[^A-Za-z0-9_-]/g, '_')
            .replace(/_+/g, '_')
            .replace(/^_|_$/g, '');
        return cleaned || 'x';
    }
}
