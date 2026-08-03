import {
    BACKFILL_DISPLAY_MAX_EDGE_PX,
    attachmentObjectPath,
    backfillDisplayBox,
    displayStoragePath,
    needsDisplayRendition,
    storagePathFromMediaUrl,
} from './chat-display-backfill';

const PUBLIC_BASE = 'https://storage.googleapis.com/test-chat-media-bucket/';

function attachment(overrides: Record<string, unknown> = {}) {
    return {
        kind: 'image' as const,
        url: `${PUBLIC_BASE}lobby/2026/08/photo.jpg`,
        storagePath: 'lobby/2026/08/photo.jpg',
        displayUrl: null,
        ...overrides,
    };
}

describe('needsDisplayRendition', () => {
    it('selects an image that has no rendition yet', () => {
        expect(needsDisplayRendition(attachment())).toBe(true);
    });

    /*
     * Idempotence, which is what makes an interrupted run safe to simply re-run — and what makes a
     * second run report zero work rather than re-encoding and re-uploading the whole room.
     */
    it('skips an image that already has one', () => {
        expect(needsDisplayRendition(attachment({ displayUrl: `${PUBLIC_BASE}lobby/2026/08/photo.display.jpg` }))).toBe(false);
    });

    /*
     * A video is handed to a real <video>, which decodes at its own resolution and never paints a
     * still we could substitute. A GIF drawn as a still would stop animating.
     */
    it('skips videos and gifs', () => {
        expect(needsDisplayRendition(attachment({ kind: 'video' }))).toBe(false);
        expect(needsDisplayRendition(attachment({ kind: 'gif' }))).toBe(false);
    });

    it('skips rows too malformed to act on', () => {
        expect(needsDisplayRendition(null)).toBe(false);
        expect(needsDisplayRendition(undefined)).toBe(false);
        expect(needsDisplayRendition(attachment({ url: '' }))).toBe(false);
    });

    /*
     * storagePath deliberately is NOT the gate. It is null for every attachment uploaded in local
     * dev without a bucket configured, which is most of a development database — gating on it made
     * the previous backfill find zero candidates locally and look like it had worked.
     */
    it('still selects an image whose storagePath was never recorded', () => {
        expect(needsDisplayRendition(attachment({ storagePath: null }))).toBe(true);
    });
});

describe('attachmentObjectPath', () => {
    it('prefers the recorded storagePath', () => {
        expect(attachmentObjectPath(attachment(), PUBLIC_BASE)).toBe('lobby/2026/08/photo.jpg');
    });

    it('recovers the path from the URL when none was recorded', () => {
        expect(attachmentObjectPath(attachment({ storagePath: null }), PUBLIC_BASE)).toBe('lobby/2026/08/photo.jpg');
    });

    // A hotlinked Giphy URL. There is no object of ours behind it to read or write beside.
    it('returns null for anything outside our bucket', () => {
        expect(attachmentObjectPath({ kind: 'gif', url: 'https://media1.giphy.com/media/abc/giphy.gif' }, PUBLIC_BASE)).toBeNull();
    });
});

describe('storagePathFromMediaUrl', () => {
    it('strips the public base', () => {
        expect(storagePathFromMediaUrl(`${PUBLIC_BASE}a/b.jpg`, PUBLIC_BASE)).toBe('a/b.jpg');
    });

    it('returns null for a foreign host or an empty path', () => {
        expect(storagePathFromMediaUrl('https://evil.example.com/a.jpg', PUBLIC_BASE)).toBeNull();
        expect(storagePathFromMediaUrl(PUBLIC_BASE, PUBLIC_BASE)).toBeNull();
    });
});

describe('displayStoragePath', () => {
    it('writes a sibling of the original, distinguished by suffix', () => {
        expect(displayStoragePath('lobby/2026/08/photo.jpg')).toBe('lobby/2026/08/photo.display.jpg');
    });

    // Must not collide with the thumbnail backfill's own sibling beside the same original.
    it('does not collide with the thumbnail suffix', () => {
        expect(displayStoragePath('lobby/photo.jpg')).not.toBe('lobby/photo.thumb.jpg');
    });

    /*
     * Only the FINAL segment's extension is stripped. A room named "v1.2" would otherwise have its
     * own directory name truncated and the rendition written somewhere else entirely.
     */
    it('leaves a dot in a directory name alone', () => {
        expect(displayStoragePath('v1.2/2026/08/photo.jpg')).toBe('v1.2/2026/08/photo.display.jpg');
    });

    it('handles a filename with no extension', () => {
        expect(displayStoragePath('lobby/photo')).toBe('lobby/photo.display.jpg');
    });
});

describe('backfillDisplayBox', () => {
    it('scales the longest edge down to the cap, preserving aspect ratio', () => {
        expect(backfillDisplayBox(8000, 6000)).toEqual({ width: 1600, height: 1200 });
        expect(backfillDisplayBox(3024, 4032)).toEqual({ width: 1200, height: 1600 });
    });

    /* Left alone rather than re-encoded — that would spend an object and a round trip to produce
     * something no smaller, while re-compressing already-compressed pixels. */
    it('returns null for an image already display-sized', () => {
        expect(backfillDisplayBox(BACKFILL_DISPLAY_MAX_EDGE_PX, BACKFILL_DISPLAY_MAX_EDGE_PX)).toBeNull();
        expect(backfillDisplayBox(1200, 900)).toBeNull();
    });

    it('never produces a zero-sized edge for an extreme panorama', () => {
        const box = backfillDisplayBox(40000, 20);
        expect(box?.width).toBe(BACKFILL_DISPLAY_MAX_EDGE_PX);
        expect(box!.height).toBeGreaterThanOrEqual(1);
    });

    it('returns null for dimensions that are not usable', () => {
        expect(backfillDisplayBox(0, 0)).toBeNull();
        expect(backfillDisplayBox(Number.NaN, 200)).toBeNull();
    });

    /* The cap must stay equal to DISPLAY_MAX_EDGE_PX in the frontend's image-thumbnail.ts, which
     * generates these for every new upload. They cannot be imported across repositories, so a
     * backfilled image looking softer than a freshly sent one in the same album is the failure this
     * pins against. */
    it('uses the same cap as the frontend generator', () => {
        expect(BACKFILL_DISPLAY_MAX_EDGE_PX).toBe(1600);
    });
});
