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
 * Three conditions, each of which excludes something real:
 *
 *  - **Images only.** A video already has a better thumbnail than a downscale could be — the poster
 *    frame, sampled from several positions to avoid a black opening. A GIF drawn as a still would
 *    stop animating.
 *  - **No thumbnail yet.** This is what makes the script idempotent, so a second run is a no-op and
 *    an interrupted first run can simply be re-run.
 *  - **A url at all**, since these rows are untyped JSON and predate several of these fields.
 *
 * Deliberately does NOT require storagePath — see attachmentObjectPath for why that field cannot be
 * the gate. Whether there is really an object of ours behind this is decided there.
 */
export function needsImageThumbnail(attachment: Partial<IChatAttachment> | null | undefined): boolean {
    if (!attachment || attachment.kind !== 'image') {
        return false;
    }
    if (typeof attachment.thumbnailUrl === 'string' && attachment.thumbnailUrl.length > 0) {
        return false;
    }
    return typeof attachment.url === 'string' && attachment.url.length > 0;
}

/**
 * The object path to read this attachment's bytes from, or null if it isn't ours to read.
 *
 * **storagePath alone is not enough, and relying on it silently skips everything in local dev.**
 * ChatMediaService only fills that field in on the GCS branch — the local filesystem branch returns
 * `storagePath: null` and encodes the location purely in the url. So an attachment uploaded against
 * a dev machine's own chat-media directory has a perfectly readable object and a null storagePath,
 * and a backfill gated on the field would report zero candidates and look like it had nothing to do.
 *
 * The url carries the same information in both modes, so it is the fallback. Anything not under our
 * own publicBase — a Giphy hotlink, a URL from a different environment's bucket — yields null and is
 * left alone, which is the check storagePath was standing in for.
 */
export function attachmentObjectPath(attachment: Partial<IChatAttachment>, publicBase: string): string | null {
    if (typeof attachment.storagePath === 'string' && attachment.storagePath.length > 0) {
        return attachment.storagePath;
    }
    return typeof attachment.url === 'string' ? storagePathFromMediaUrl(attachment.url, publicBase) : null;
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
 * The aspect ratio a correctly-shaped album cover has: the front card plus the room the two behind
 * it step out into, matching the tile it is drawn in. Kept equal to COVER_WIDTH_PX / COVER_HEIGHT_PX
 * in the frontend's album-cover.ts (536 / 416).
 */
const ALBUM_COVER_RATIO = 536 / 416;

/** How far a cover's ratio may drift before it counts as the wrong shape. Generous — the two shapes
 *  being told apart here are 1.29 and 1.0, so this only has to survive rounding. */
const ALBUM_COVER_RATIO_TOLERANCE = 0.02;

/**
 * Whether a stored album cover was drawn to the OLD, square geometry.
 *
 * Covers used to be composited onto a 480x480 canvas, which the tile then drew `object-fit: cover`
 * into a 268x208 box — cropping ~30px off the top and bottom. Worse for these purposes: the fanned
 * stack does not fill a square, so the leftover corners were transparent on the canvas and JPEG,
 * having no alpha, flattened them to solid BLACK. That is baked into the file; no amount of CSS or
 * re-encoding at the other end can remove it.
 *
 * A cover of the wrong shape is therefore not fixable in place — it is dropped instead, and the
 * album falls back to rendering the CSS card stack, which is built from the attachments themselves
 * and has always had correct geometry and real transparency.
 *
 * Detected by SHAPE rather than by a date cutoff: the shape is the actual defect, and a timestamp
 * would misjudge anything sent while a deploy was rolling.
 */
export function isStaleAlbumCover(width: number, height: number): boolean {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        return true; // unreadable is not worth keeping either
    }
    return Math.abs(width / height - ALBUM_COVER_RATIO) > ALBUM_COVER_RATIO_TOLERANCE;
}

/**
 * The object path inside our bucket for one of our own media URLs, or null if it isn't one.
 *
 * Album covers carry a URL rather than a storagePath (they are not attachments in their own right,
 * just a field on each of an album's attachments), so reaching the object behind one means undoing
 * the concatenation ChatMediaService.publicBase does. Anything that doesn't start with that base —
 * a Giphy hotlink, a URL from another environment's bucket — returns null and is left alone.
 */
export function storagePathFromMediaUrl(url: string, publicBase: string): string | null {
    if (typeof url !== 'string' || !url.startsWith(publicBase)) {
        return null;
    }
    const objectPath = url.slice(publicBase.length);
    return objectPath.length > 0 ? objectPath : null;
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
