import { isAllowedAttachmentUrl, sanitizeAttachment } from './chat-attachment-url';

const GCS_BASE = 'https://storage.googleapis.com/test-chat-media-bucket/';
const LOCAL_BASE = '/chat-media/';

function baseAttachment(overrides: Record<string, unknown> = {}) {
    return {
        id: 'att-1',
        kind: 'image',
        url: `${GCS_BASE}lobby/2026/07/photo.jpg`,
        storagePath: 'lobby/2026/07/photo.jpg',
        thumbnailUrl: null,
        mimeType: 'image/jpeg',
        width: 800,
        height: 600,
        durationMs: null,
        sizeBytes: 12345,
        name: 'photo.jpg',
        albumId: null,
        albumCoverUrl: null,
        ...overrides,
    };
}

describe('isAllowedAttachmentUrl', () => {
    it('allows a URL under the configured GCS public base', () => {
        expect(isAllowedAttachmentUrl(`${GCS_BASE}lobby/2026/07/photo.jpg`, 'image', GCS_BASE)).toBe(true);
    });

    it('rejects a URL that does not start with the configured public base', () => {
        expect(isAllowedAttachmentUrl('https://evil.example.com/tracker.png', 'image', GCS_BASE)).toBe(false);
    });

    it('allows a root-relative local-dev URL under the configured local base', () => {
        expect(isAllowedAttachmentUrl(`${LOCAL_BASE}lobby/2026/07/photo.jpg`, 'image', LOCAL_BASE)).toBe(true);
    });

    it('rejects a root-relative URL outside the local base', () => {
        expect(isAllowedAttachmentUrl('/recordings/lobby/x.webm', 'image', LOCAL_BASE)).toBe(false);
    });

    it('allows a Giphy CDN URL for kind "gif" even though it is not under the public base', () => {
        expect(isAllowedAttachmentUrl('https://media3.giphy.com/media/abc/giphy.gif', 'gif', GCS_BASE)).toBe(true);
        expect(isAllowedAttachmentUrl('https://i.giphy.com/media/abc/giphy.gif', 'gif', GCS_BASE)).toBe(true);
    });

    it('rejects a Giphy-lookalike host', () => {
        expect(isAllowedAttachmentUrl('https://giphy.com.evil.example.com/x.gif', 'gif', GCS_BASE)).toBe(false);
    });

    it('rejects the Giphy CDN for a non-gif kind — hotlinking is only trusted for the gif picker path', () => {
        expect(isAllowedAttachmentUrl('https://media3.giphy.com/media/abc/giphy.gif', 'image', GCS_BASE)).toBe(false);
    });

    // Every Giphy case above uses the GCS base, which is why this hole went unnoticed: the
    // local-dev branch returned early and never reached the Giphy allowlist at all, so hotlinked
    // GIFs were dropped in local dev — and a GIF-only message, having no text and no surviving
    // attachment, was then discarded by the gateway with nothing shown to the sender.
    describe('with the local-dev base (no GCS bucket configured)', () => {
        it('still allows a Giphy CDN URL for kind "gif"', () => {
            expect(isAllowedAttachmentUrl('https://media3.giphy.com/media/abc/giphy.gif', 'gif', LOCAL_BASE)).toBe(true);
            expect(isAllowedAttachmentUrl('https://i.giphy.com/media/abc/giphy.gif', 'gif', LOCAL_BASE)).toBe(true);
        });

        it('still rejects the Giphy CDN for a non-gif kind', () => {
            expect(isAllowedAttachmentUrl('https://media3.giphy.com/media/abc/giphy.gif', 'image', LOCAL_BASE)).toBe(false);
        });

        it('still rejects a Giphy-lookalike host', () => {
            expect(isAllowedAttachmentUrl('https://giphy.com.evil.example.com/x.gif', 'gif', LOCAL_BASE)).toBe(false);
        });

        // The prefix test must not become "any absolute URL is fine when the base is relative".
        it('still rejects an unrelated absolute URL', () => {
            expect(isAllowedAttachmentUrl('https://evil.example.com/tracker.png', 'image', LOCAL_BASE)).toBe(false);
            expect(isAllowedAttachmentUrl('https://evil.example.com/tracker.gif', 'gif', LOCAL_BASE)).toBe(false);
        });

        // A host cannot smuggle itself past a root-relative base by embedding it in a path.
        it('still rejects a URL that merely contains the local base', () => {
            expect(isAllowedAttachmentUrl('https://evil.example.com/chat-media/x.jpg', 'image', LOCAL_BASE)).toBe(false);
        });
    });

    it('rejects an empty URL', () => {
        expect(isAllowedAttachmentUrl('', 'image', GCS_BASE)).toBe(false);
    });

    it('rejects an unparseable URL rather than throwing', () => {
        expect(isAllowedAttachmentUrl('not a url at all', 'gif', GCS_BASE)).toBe(false);
    });
});

describe('sanitizeAttachment', () => {
    it('passes through a well-formed attachment unchanged (aside from normalization)', () => {
        const result = sanitizeAttachment(baseAttachment(), GCS_BASE);

        expect(result).toEqual(baseAttachment());
    });

    it('returns null for a disallowed URL', () => {
        expect(sanitizeAttachment(baseAttachment({ url: 'https://evil.example.com/x.png' }), GCS_BASE)).toBeNull();
    });

    it('returns null for a garbage/non-object input', () => {
        expect(sanitizeAttachment(null, GCS_BASE)).toBeNull();
        expect(sanitizeAttachment('a string', GCS_BASE)).toBeNull();
        expect(sanitizeAttachment(undefined, GCS_BASE)).toBeNull();
    });

    it('returns null for an unrecognized kind', () => {
        expect(sanitizeAttachment(baseAttachment({ kind: 'audio' }), GCS_BASE)).toBeNull();
    });

    it('generates a fresh id when the client omitted one', () => {
        const result = sanitizeAttachment(baseAttachment({ id: undefined }), GCS_BASE);

        expect(typeof result?.id).toBe('string');
        expect(result?.id.length).toBeGreaterThan(0);
    });

    it('clamps an absurdly large width/height to the max instead of passing it through', () => {
        const result = sanitizeAttachment(baseAttachment({ width: 999_999, height: 999_999 }), GCS_BASE);

        expect(result?.width).toBe(8000);
        expect(result?.height).toBe(8000);
    });

    it('treats a negative or zero dimension as absent (null)', () => {
        const result = sanitizeAttachment(baseAttachment({ width: -10, height: 0 }), GCS_BASE);

        expect(result?.width).toBeNull();
        expect(result?.height).toBeNull();
    });

    it('forces storagePath to null for a gif attachment regardless of what the client sent', () => {
        const result = sanitizeAttachment(
            baseAttachment({
                kind: 'gif',
                url: 'https://media1.giphy.com/media/abc/giphy.gif',
                storagePath: 'lobby/should-be-dropped.gif',
            }),
            GCS_BASE,
        );

        expect(result?.storagePath).toBeNull();
    });

    it('drops a disallowed thumbnailUrl but keeps the rest of the attachment', () => {
        const result = sanitizeAttachment(baseAttachment({ thumbnailUrl: 'https://evil.example.com/thumb.jpg' }), GCS_BASE);

        expect(result?.thumbnailUrl).toBeNull();
        expect(result?.url).toBe(baseAttachment().url);
    });

    it('keeps an allowed thumbnailUrl under the public base', () => {
        const result = sanitizeAttachment(baseAttachment({ thumbnailUrl: `${GCS_BASE}lobby/2026/07/poster.jpg` }), GCS_BASE);

        expect(result?.thumbnailUrl).toBe(`${GCS_BASE}lobby/2026/07/poster.jpg`);
    });

    it('truncates an absurdly long name rather than persisting it verbatim', () => {
        const result = sanitizeAttachment(baseAttachment({ name: 'x'.repeat(1000) }), GCS_BASE);

        expect(result?.name?.length).toBe(255);
    });

    // This literal names every field explicitly, so a new one that isn't listed is dropped with
    // nothing logged — an album would simply render as separate attachments for everyone but the
    // sender, whose optimistic copy still has it.
    it('keeps the albumId that groups a quick album together', () => {
        const result = sanitizeAttachment(baseAttachment({ albumId: 'album-abc' }), GCS_BASE);

        expect(result?.albumId).toBe('album-abc');
    });

    it('yields a null albumId for an ordinary attachment that has none', () => {
        const result = sanitizeAttachment(baseAttachment({ albumId: undefined }), GCS_BASE);

        expect(result?.albumId).toBeNull();
    });

    it('drops a non-string albumId rather than passing it through', () => {
        expect(sanitizeAttachment(baseAttachment({ albumId: 42 }), GCS_BASE)?.albumId).toBeNull();
        expect(sanitizeAttachment(baseAttachment({ albumId: { id: 'x' } }), GCS_BASE)?.albumId).toBeNull();
        // An empty string groups nothing, and would otherwise read as "this is an album" everywhere
        // the client tests for a non-null albumId.
        expect(sanitizeAttachment(baseAttachment({ albumId: '' }), GCS_BASE)?.albumId).toBeNull();
    });

    it('truncates an absurdly long albumId', () => {
        const result = sanitizeAttachment(baseAttachment({ albumId: 'a'.repeat(500) }), GCS_BASE);

        expect(result?.albumId?.length).toBe(64);
    });

    it('keeps an album cover that lives in our own storage', () => {
        const result = sanitizeAttachment(baseAttachment({ albumCoverUrl: `${GCS_BASE}lobby/2026/08/cover.jpg` }), GCS_BASE);

        expect(result?.albumCoverUrl).toBe(`${GCS_BASE}lobby/2026/08/cover.jpg`);
    });

    /*
     * A cover is a URL the client hands us, so it goes through the same allowlist as the
     * attachment's own. Accepting an arbitrary one would let anyone point every album in a room at
     * a host they control — a tracking pixel at best.
     */
    it('drops an album cover pointing anywhere but our own storage', () => {
        expect(sanitizeAttachment(baseAttachment({ albumCoverUrl: 'https://evil.example.com/cover.jpg' }), GCS_BASE)?.albumCoverUrl).toBeNull();
        // Not even the Giphy CDN, which IS allowed for a gif's own url — a cover is always our upload.
        expect(
            sanitizeAttachment(baseAttachment({ albumCoverUrl: 'https://media1.giphy.com/media/abc/giphy.gif' }), GCS_BASE)?.albumCoverUrl,
        ).toBeNull();
    });

    it('yields a null album cover when there is none, or it is not a string', () => {
        expect(sanitizeAttachment(baseAttachment({ albumCoverUrl: undefined }), GCS_BASE)?.albumCoverUrl).toBeNull();
        expect(sanitizeAttachment(baseAttachment({ albumCoverUrl: 42 }), GCS_BASE)?.albumCoverUrl).toBeNull();
    });
});
