import { BACKFILL_THUMBNAIL_MAX_EDGE_PX, backfillThumbnailBox, needsImageThumbnail, thumbnailStoragePath } from './chat-thumbnail-backfill';
import { IChatAttachment } from './interfaces/room.interfaces';

function attachment(overrides: Partial<IChatAttachment> = {}): Partial<IChatAttachment> {
    return {
        id: 'a1',
        kind: 'image',
        url: 'https://storage.googleapis.com/bucket/lobby/2026/08/abc.jpg',
        storagePath: 'lobby/2026/08/abc.jpg',
        thumbnailUrl: null,
        ...overrides,
    };
}

describe('needsImageThumbnail', () => {
    it('selects a stored image that has no thumbnail yet', () => {
        expect(needsImageThumbnail(attachment())).toBe(true);
    });

    // What makes a second run a no-op, and an interrupted first run safe to simply re-run.
    it('skips an attachment that already has one', () => {
        expect(needsImageThumbnail(attachment({ thumbnailUrl: 'https://storage.googleapis.com/bucket/lobby/2026/08/abc.thumb.jpg' }))).toBe(false);
    });

    /*
     * A video already has a better thumbnail than a downscale could be — its poster frame, sampled
     * from several positions specifically to avoid a black opening. A GIF rendered as a still would
     * simply stop animating.
     */
    it('skips videos and gifs', () => {
        expect(needsImageThumbnail(attachment({ kind: 'video' }))).toBe(false);
        expect(needsImageThumbnail(attachment({ kind: 'gif' }))).toBe(false);
    });

    // Hotlinked Giphy URLs, and anything uploaded in local dev with no bucket configured: there is
    // no object of ours to read.
    it('skips anything with no storage path of ours', () => {
        expect(needsImageThumbnail(attachment({ storagePath: null }))).toBe(false);
        expect(needsImageThumbnail(attachment({ storagePath: '' }))).toBe(false);
    });

    // These rows are untyped JSON and predate several of these fields, so nothing may be assumed.
    it('tolerates malformed rows', () => {
        expect(needsImageThumbnail(null)).toBe(false);
        expect(needsImageThumbnail(undefined)).toBe(false);
        expect(needsImageThumbnail({})).toBe(false);
        expect(needsImageThumbnail(attachment({ url: undefined }))).toBe(false);
    });
});

describe('thumbnailStoragePath', () => {
    it('derives a sibling of the image, distinguished by suffix', () => {
        expect(thumbnailStoragePath('lobby/2026/08/abc.jpg')).toBe('lobby/2026/08/abc.thumb.jpg');
        expect(thumbnailStoragePath('lobby/2026/08/abc.png')).toBe('lobby/2026/08/abc.thumb.jpg');
        expect(thumbnailStoragePath('abc.webp')).toBe('abc.thumb.jpg');
    });

    /*
     * The extension is stripped from the FINAL segment only. A room named "v1.2" produces a prefix
     * containing a dot, and truncating at the last dot in the whole path would write the thumbnail
     * into a different directory from the image it belongs to.
     */
    it('does not truncate a directory that contains a dot', () => {
        expect(thumbnailStoragePath('v1.2/2026/08/abc.jpg')).toBe('v1.2/2026/08/abc.thumb.jpg');
        expect(thumbnailStoragePath('v1.2/2026/08/abc')).toBe('v1.2/2026/08/abc.thumb.jpg');
    });

    it('leaves a dotfile-style name intact rather than emptying it', () => {
        expect(thumbnailStoragePath('lobby/.hidden')).toBe('lobby/.hidden.thumb.jpg');
    });
});

describe('backfillThumbnailBox', () => {
    it('scales the longest edge down to the cap, preserving aspect ratio', () => {
        expect(backfillThumbnailBox(4000, 3000)).toEqual({ width: 768, height: 576 });
        expect(backfillThumbnailBox(3000, 4000)).toEqual({ width: 576, height: 768 });
    });

    // Same rule as the frontend's thumbnailBox: re-encoding an already-small image would spend an
    // object and a round trip to produce something no smaller.
    it('returns null for an image already at or under the cap', () => {
        expect(backfillThumbnailBox(BACKFILL_THUMBNAIL_MAX_EDGE_PX, BACKFILL_THUMBNAIL_MAX_EDGE_PX)).toBeNull();
        expect(backfillThumbnailBox(640, 480)).toBeNull();
    });

    it('returns null for dimensions that are not usable', () => {
        expect(backfillThumbnailBox(0, 100)).toBeNull();
        expect(backfillThumbnailBox(-1, 100)).toBeNull();
        expect(backfillThumbnailBox(Number.NaN, 100)).toBeNull();
    });
});
