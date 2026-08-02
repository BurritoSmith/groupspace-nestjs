import { IChatAttachment } from './interfaces/room.interfaces';

/**
 * Longest edge of a backfilled thumbnail.
 *
 * Kept equal to THUMBNAIL_MAX_EDGE_PX in the frontend's image-thumbnail.ts, which is what generates
 * these for every new upload. It cannot be imported across the two repositories, so if you change
 * one, change the other — a backfilled image looking different from a freshly sent one in the same
 * album is the failure this note exists to prevent.
 */
export const BACKFILL_THUMBNAIL_MAX_EDGE_PX = 768;

/**
 * Whether an already-stored attachment is one the backfill should generate a thumbnail for.
 *
 * Four conditions, each of which excludes something real:
 *
 *  - **Images only.** A video already has a better thumbnail than a downscale could be — the poster
 *    frame, sampled from several positions to avoid a black opening. A GIF drawn as a still would
 *    stop animating.
 *  - **No thumbnail yet.** This is what makes the script idempotent, so a second run is a no-op and
 *    an interrupted first run can simply be re-run.
 *  - **Something of ours to read.** storagePath is null for a hotlinked Giphy URL and for anything
 *    uploaded in local dev without a bucket configured; there is no object to fetch in either case.
 *  - **A url at all**, since these rows are untyped JSON and predate several of these fields.
 */
export function needsImageThumbnail(attachment: Partial<IChatAttachment> | null | undefined): boolean {
    if (!attachment || attachment.kind !== 'image') {
        return false;
    }
    if (typeof attachment.thumbnailUrl === 'string' && attachment.thumbnailUrl.length > 0) {
        return false;
    }
    return typeof attachment.storagePath === 'string' && attachment.storagePath.length > 0 && typeof attachment.url === 'string';
}

/**
 * Where a backfilled thumbnail is stored, derived from the image's own object path.
 *
 * A sibling distinguished by suffix, the same convention RecordingService.thumbnailPath() already
 * uses — it needs no new column and no lookup, since the path is recomputable from the original at
 * any time.
 *
 * The extension is only stripped from the FINAL path segment. A bucket prefix containing a dot (a
 * room named "v1.2", say) would otherwise have its own text truncated and the thumbnail written to a
 * different directory than the image it belongs to.
 */
export function thumbnailStoragePath(storagePath: string): string {
    const lastSlash = storagePath.lastIndexOf('/');
    const directory = lastSlash === -1 ? '' : storagePath.slice(0, lastSlash + 1);
    const filename = storagePath.slice(lastSlash + 1);
    const lastDot = filename.lastIndexOf('.');
    const stem = lastDot <= 0 ? filename : filename.slice(0, lastDot);
    return `${directory}${stem}.thumb.jpg`;
}

/**
 * The scaled dimensions for a source image, or null when it is already small enough.
 *
 * Deliberately the same rule as the frontend's thumbnailBox: an image at or under the cap is left
 * alone rather than re-encoded, which would spend an object and a round trip to produce something no
 * smaller while re-compressing already-compressed pixels.
 */
export function backfillThumbnailBox(width: number, height: number): { width: number; height: number } | null {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        return null;
    }
    const longestEdge = Math.max(width, height);
    if (longestEdge <= BACKFILL_THUMBNAIL_MAX_EDGE_PX) {
        return null;
    }
    const scale = BACKFILL_THUMBNAIL_MAX_EDGE_PX / longestEdge;
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}
