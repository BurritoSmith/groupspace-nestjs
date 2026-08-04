import { Injectable, Logger, PayloadTooLargeException, UnsupportedMediaTypeException } from '@nestjs/common';
import { Storage } from '@google-cloud/storage';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { sniffedTypeMatchesDeclared, sniffMediaType } from './file-sniff';

export interface IUploadedChatMedia {
    url: string;
    storagePath: string | null;
    mimeType: string;
}

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

const DEFAULT_MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_VIDEO_BYTES = 100 * 1024 * 1024;
const DEFAULT_MAX_PDF_BYTES = 50 * 1024 * 1024;

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

    private sanitize(value: string): string {
        const cleaned = value
            .replace(/[^A-Za-z0-9_-]/g, '_')
            .replace(/_+/g, '_')
            .replace(/^_|_$/g, '');
        return cleaned || 'x';
    }
}
