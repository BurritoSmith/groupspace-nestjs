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
});
