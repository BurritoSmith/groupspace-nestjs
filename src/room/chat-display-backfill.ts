import { IChatAttachment } from './interfaces/room.interfaces';

/**
 * The decision logic for the display-rendition backfill.
 *
 * Lives in src/ — and not in the script that uses it — so it is compiled and unit-tested with
 * everything else. The script itself is plumbing (GCS, sharp, Prisma) and lives outside src/; see
 * scripts/backfill-display-renditions.ts for why that separation matters to the production image.
 *
 * The same split, and the same reasoning, as the thumbnail backfill that ran before it.
 */

/**
 * Longest edge of a backfilled display rendition.
 *
 * Kept equal to DISPLAY_MAX_EDGE_PX in the frontend's image-thumbnail.ts, which is what generates
 * these for every new upload. It cannot be imported across the two repositories, so if you change
 * one, change the other — a backfilled image looking softer than a freshly sent one in the same
 * album is the failure this note exists to prevent.
 */
export const BACKFILL_DISPLAY_MAX_EDGE_PX = 1600;

/**
 * Whether an already-stored attachment is one the backfill should generate a display rendition for.
 *
 * Three conditions, each excluding something real:
 *
 *  - **Images only.** A video is handed to a real <video> element, which decodes at its own
 *    resolution and never paints a still we could substitute. A GIF drawn as a still would stop
 *    animating — the same exclusion the thumbnail path already makes.
 *  - **No rendition yet.** This is what makes the script idempotent, so a second run is a no-op and
 *    an interrupted first run can simply be re-run.
 *  - **A url at all**, since these rows are untyped JSON and predate several of these fields.
 *
 * Deliberately does NOT require storagePath — see attachmentObjectPath for why that field cannot be
 * the gate. Whether there is really an object of ours behind this is decided there.
 */
export function needsDisplayRendition(attachment: Partial<IChatAttachment> | null | undefined): boolean {
    if (!attachment || attachment.kind !== 'image') {
        return false;
    }
    if (typeof attachment.displayUrl === 'string' && attachment.displayUrl.length > 0) {
        return false;
    }
    return typeof attachment.url === 'string' && attachment.url.length > 0;
}

/**
 * The GCS object path behind an attachment, or null when there is nothing of ours to read.
 *
 * `storagePath` is preferred, but cannot be the gate on its own: it is **null for every attachment
 * uploaded in local dev without a bucket configured**, which is most of a development database — a
 * backfill gated on it finds zero candidates locally and looks like it worked. Recovering the path
 * from the URL covers those rows, and returns null for a hotlinked Giphy URL, which is exactly right
 * since there is no object of ours behind one.
 */
export function attachmentObjectPath(attachment: Partial<IChatAttachment>, publicBase: string): string | null {
    if (typeof attachment.storagePath === 'string' && attachment.storagePath.length > 0) {
        return attachment.storagePath;
    }
    return typeof attachment.url === 'string' ? storagePathFromMediaUrl(attachment.url, publicBase) : null;
}

/** The object path inside our own bucket, for a URL that points at it — null for anything else. */
export function storagePathFromMediaUrl(url: string, publicBase: string): string | null {
    if (typeof url !== 'string' || !url.startsWith(publicBase)) {
        return null;
    }
    const objectPath = url.slice(publicBase.length);
    return objectPath.length > 0 ? objectPath : null;
}

/**
 * Where a backfilled display rendition is stored, derived from the image's own object path.
 *
 * A sibling distinguished by suffix, the same convention the thumbnail backfill and
 * RecordingService.thumbnailPath() already use — it needs no new column and no lookup, since the
 * path is recomputable from the original at any time.
 *
 * `.display.jpg`, deliberately distinct from the thumbnail's `.thumb.jpg`: the two live beside the
 * same original and must not collide.
 *
 * The extension is only stripped from the FINAL path segment. A bucket prefix containing a dot (a
 * room named "v1.2", say) would otherwise have its own text truncated and the rendition written to a
 * different directory than the image it belongs to.
 */
export function displayStoragePath(storagePath: string): string {
    const lastSlash = storagePath.lastIndexOf('/');
    const directory = lastSlash === -1 ? '' : storagePath.slice(0, lastSlash + 1);
    const filename = storagePath.slice(lastSlash + 1);
    const lastDot = filename.lastIndexOf('.');
    const stem = lastDot <= 0 ? filename : filename.slice(0, lastDot);
    return `${directory}${stem}.display.jpg`;
}

/**
 * The scaled dimensions for a source image, or null when it is already small enough.
 *
 * Deliberately the same rule as the frontend's displayBox: an image at or under the cap is left
 * alone rather than re-encoded, which would spend an object and a round trip to produce something no
 * smaller while re-compressing already-compressed pixels. Those rows keep a null displayUrl, which
 * is what makes the viewer fall back to the original — correct, since the original is already
 * display-sized.
 */
export function backfillDisplayBox(width: number, height: number): { width: number; height: number } | null {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        return null;
    }
    const longestEdge = Math.max(width, height);
    if (longestEdge <= BACKFILL_DISPLAY_MAX_EDGE_PX) {
        return null;
    }
    const scale = BACKFILL_DISPLAY_MAX_EDGE_PX / longestEdge;
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}
