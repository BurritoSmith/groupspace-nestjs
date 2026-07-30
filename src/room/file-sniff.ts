/**
 * Magic-byte content sniffing for chat media uploads — deliberately NOT trusting the client-
 * supplied filename/Content-Type, since either can be forged (a malicious upload could name a
 * script ".jpg" or lie about its Content-Type header). Only the six formats the chat-media
 * pipeline actually accepts are recognized; everything else (including a real but unsupported
 * format like HEIC or AVI) sniffs as null and gets rejected by the caller.
 *
 * Not using the `file-type` npm package here: it's ESM-only and this project builds CommonJS
 * (`nest build`) — a small sniffer covering exactly the formats we accept is simpler than fighting
 * that mismatch.
 */

export type SniffedMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' | 'video/mp4' | 'video/webm';

// MP4/MOV ("ISO base media file format") brands we're willing to accept as "this is a real video
// a browser produced," not an exhaustive list of every brand that has ever existed.
const MP4_BRAND_ALLOWLIST = new Set(['isom', 'iso2', 'mp41', 'mp42', 'avc1', 'qt  ', 'M4V ', 'dash']);

export function sniffMediaType(buffer: Buffer): SniffedMediaType | null {
    if (buffer.length < 12) {
        return null;
    }

    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
        return 'image/jpeg';
    }

    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
        return 'image/png';
    }

    if (
        buffer[0] === 0x47 &&
        buffer[1] === 0x49 &&
        buffer[2] === 0x46 &&
        buffer[3] === 0x38 &&
        (buffer[4] === 0x37 || buffer[4] === 0x39) &&
        buffer[5] === 0x61
    ) {
        return 'image/gif';
    }

    if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
        return 'image/webp';
    }

    // WebM and Matroska share the same EBML header — mediasoup-recorded/browser-produced video is
    // always WebM in this app, but there's no distinguishing magic byte from Matroska at this
    // point in the stream, so this accepts both.
    if (buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) {
        return 'video/webm';
    }

    if (buffer.length >= 12 && buffer.toString('ascii', 4, 8) === 'ftyp') {
        const brand = buffer.toString('ascii', 8, 12);
        if (MP4_BRAND_ALLOWLIST.has(brand)) {
            return 'video/mp4';
        }
    }

    return null;
}

/** Whether a sniffed type is at least plausibly what the client's declared Content-Type claims —
 *  a mismatch (e.g. a PNG uploaded as "video/mp4") is a strong signal of a forged/malicious upload. */
export function sniffedTypeMatchesDeclared(sniffed: SniffedMediaType, declaredContentType: string): boolean {
    const declaredFamily = declaredContentType.split('/')[0]?.trim().toLowerCase();
    const sniffedFamily = sniffed.split('/')[0];
    return declaredFamily === sniffedFamily;
}
