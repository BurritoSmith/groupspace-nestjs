import {
    BACKFILL_THUMBNAIL_MAX_EDGE_PX,
    attachmentObjectPath,
    backfillThumbnailBox,
    isStaleAlbumCover,
    needsImageThumbnail,
    storagePathFromMediaUrl,
    thumbnailStoragePath,
} from './chat-thumbnail-backfill';
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

    /*
     * A null storagePath must NOT disqualify it. ChatMediaService only fills that field in on the
     * GCS branch — the local filesystem branch returns null and encodes the location purely in the
     * url. Gating on the field made the backfill report zero candidates in local dev while every
     * object sat there perfectly readable.
     */
    it('still selects an image whose storagePath was never recorded', () => {
        expect(needsImageThumbnail(attachment({ storagePath: null }))).toBe(true);
    });

    // These rows are untyped JSON and predate several of these fields, so nothing may be assumed.
    it('tolerates malformed rows', () => {
        expect(needsImageThumbnail(null)).toBe(false);
        expect(needsImageThumbnail(undefined)).toBe(false);
        expect(needsImageThumbnail({})).toBe(false);
        expect(needsImageThumbnail(attachment({ url: undefined }))).toBe(false);
        expect(needsImageThumbnail(attachment({ url: '' }))).toBe(false);
    });
});

describe('attachmentObjectPath', () => {
    const publicBase = 'https://storage.googleapis.com/bucket/';

    it('prefers the recorded storage path', () => {
        expect(attachmentObjectPath(attachment(), publicBase)).toBe('lobby/2026/08/abc.jpg');
    });

    // The local-dev case that a storagePath-only lookup missed entirely.
    it('recovers the path from the url when none was recorded', () => {
        expect(attachmentObjectPath(attachment({ storagePath: null }), publicBase)).toBe('lobby/2026/08/abc.jpg');
        expect(
            attachmentObjectPath({ kind: 'image', url: '/chat-media/mackie/2026/08/abc.jpg', storagePath: null }, '/chat-media/'),
        ).toBe('mackie/2026/08/abc.jpg');
    });

    // This is the check the storagePath requirement was really standing in for.
    it('returns null for anything that is not ours to read', () => {
        expect(attachmentObjectPath({ kind: 'image', url: 'https://media1.giphy.com/media/abc/giphy.gif', storagePath: null }, publicBase)).toBeNull();
        expect(attachmentObjectPath({ kind: 'image', url: 'https://storage.googleapis.com/other-bucket/abc.jpg', storagePath: null }, publicBase)).toBeNull();
        expect(attachmentObjectPath({ kind: 'image' }, publicBase)).toBeNull();
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

describe('isStaleAlbumCover', () => {
    /*
     * The shape that has to be recognised: covers used to be composited onto a 480x480 canvas. The
     * fanned stack does not fill a square, so the leftover corners were transparent on the canvas
     * and JPEG — having no alpha — flattened them to solid black. That is baked into the file, so
     * these are dropped rather than kept, and the album falls back to the CSS card stack.
     */
    it('recognises the old square cover', () => {
        expect(isStaleAlbumCover(480, 480)).toBe(true);
    });

    it('keeps a cover cut to the tile it is drawn in', () => {
        expect(isStaleAlbumCover(536, 416)).toBe(false);
        // The same shape at another scale is still the right shape.
        expect(isStaleAlbumCover(268, 208)).toBe(false);
        expect(isStaleAlbumCover(1072, 832)).toBe(false);
    });

    // Detected by shape rather than by a date cutoff, so a cover that is merely off by rounding is
    // not thrown away.
    it('tolerates a pixel of rounding', () => {
        expect(isStaleAlbumCover(537, 416)).toBe(false);
        expect(isStaleAlbumCover(536, 415)).toBe(false);
    });

    it('treats unreadable dimensions as not worth keeping', () => {
        expect(isStaleAlbumCover(0, 0)).toBe(true);
        expect(isStaleAlbumCover(Number.NaN, 416)).toBe(true);
    });
});

describe('storagePathFromMediaUrl', () => {
    const publicBase = 'https://storage.googleapis.com/bucket/';

    it('undoes the concatenation publicBase does', () => {
        expect(storagePathFromMediaUrl('https://storage.googleapis.com/bucket/lobby/2026/08/abc.jpg', publicBase)).toBe('lobby/2026/08/abc.jpg');
    });

    // A cover URL from another environment's bucket, or a Giphy hotlink: not ours to touch.
    it('returns null for anything outside our own storage', () => {
        expect(storagePathFromMediaUrl('https://media1.giphy.com/media/abc/giphy.gif', publicBase)).toBeNull();
        expect(storagePathFromMediaUrl('https://storage.googleapis.com/other-bucket/abc.jpg', publicBase)).toBeNull();
        expect(storagePathFromMediaUrl('', publicBase)).toBeNull();
        // The base itself names no object.
        expect(storagePathFromMediaUrl(publicBase, publicBase)).toBeNull();
    });

    it('works against the local-dev root-relative base too', () => {
        expect(storagePathFromMediaUrl('/chat-media/lobby/2026/08/abc.jpg', '/chat-media/')).toBe('lobby/2026/08/abc.jpg');
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
