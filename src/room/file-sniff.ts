/**
 * Magic-byte content sniffing for chat media uploads — deliberately NOT trusting the client-
 * supplied filename/Content-Type, since either can be forged (a malicious upload could name a
 * script ".jpg" or lie about its Content-Type header). Only the formats the chat-media
 * pipeline actually accepts are recognized; everything else (including a real but unsupported
 * format like AVI) sniffs as null and gets rejected by the caller.
 *
 * 'image/heic' is the one type here that never reaches storage as itself: no browser but Safari can
 * display it, so ChatMediaService transcodes it to JPEG on the way in. It's recognized rather than
 * rejected because an iPhone photo is otherwise a dead end — the chat file input has always
 * advertised .heic while this sniffer refused it.
 *
 * Not using the `file-type` npm package here: it's ESM-only and this project builds CommonJS
 * (`nest build`) — a small sniffer covering exactly the formats we accept is simpler than fighting
 * that mismatch.
 */

export type SniffedMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' | 'image/heic' | 'video/mp4' | 'video/webm' | 'application/pdf';

// MP4/MOV ("ISO base media file format") brands we're willing to accept as "this is a real video
// a browser produced," not an exhaustive list of every brand that has ever existed.
const MP4_BRAND_ALLOWLIST = new Set(['isom', 'iso2', 'mp41', 'mp42', 'avc1', 'qt  ', 'M4V ', 'dash']);

// HEIF brands. Same ISO base media container as MP4 above — the brand is the only thing separating
// "an iPhone photo" from "a video" this early in the file.
//
// 'mif1'/'msf1' are the generic still-image and image-sequence brands; the rest are the HEVC-coded
// ones an iPhone actually writes. Unlike the video list this isn't the major brand alone: an image
// whose major brand is 'mif1' routinely names 'heic' only in its compatible-brands list, so both get
// searched. AVIF ('avif'/'avis') is deliberately absent — a different codec that
// HeicTranscodeService's decoder doesn't necessarily handle, and no client here produces one.
const HEIF_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs', 'mif1', 'msf1']);

/** How far into the ftyp box to read compatible brands. The box is `size|'ftyp'|major|minor` then a
 *  list of 4-byte brands; capping the scan keeps a corrupt or hostile size field from walking the
 *  whole buffer. Eight brands is far more than any real file carries. */
const MAX_FTYP_SCAN_BYTES = 48;

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
        // Checked after the video allowlist, since the two share this container and a file matching
        // both is far likelier to be the video it claims than a still.
        if (ftypBrands(buffer).some((candidate) => HEIF_BRANDS.has(candidate))) {
            return 'image/heic';
        }
    }

    if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46 && buffer[4] === 0x2d) {
        return 'application/pdf';
    }

    return null;
}

/**
 * Every brand an ftyp box declares: the major brand, then each compatible brand after it.
 *
 * Bounded by the box's own declared size AND by MAX_FTYP_SCAN_BYTES, so a file claiming a
 * multi-gigabyte ftyp can't turn a sniff of the first few bytes into a long scan. Assumes the caller
 * has already confirmed 'ftyp' at offset 4.
 */
function ftypBrands(buffer: Buffer): string[] {
    const declaredSize = buffer.readUInt32BE(0);
    const end = Math.min(buffer.length, MAX_FTYP_SCAN_BYTES, declaredSize > 0 ? declaredSize : MAX_FTYP_SCAN_BYTES);
    const brands: string[] = [];
    // Major brand sits at 8; compatible brands run from 16 (past the 4-byte minor version).
    if (end >= 12) {
        brands.push(buffer.toString('ascii', 8, 12));
    }
    for (let offset = 16; offset + 4 <= end; offset += 4) {
        brands.push(buffer.toString('ascii', offset, offset + 4));
    }
    return brands;
}

/** Whether a sniffed type is at least plausibly what the client's declared Content-Type claims —
 *  a mismatch (e.g. a PNG uploaded as "video/mp4") is a strong signal of a forged/malicious upload. */
export function sniffedTypeMatchesDeclared(sniffed: SniffedMediaType, declaredContentType: string): boolean {
    const declaredFamily = declaredContentType.split('/')[0]?.trim().toLowerCase();
    const sniffedFamily = sniffed.split('/')[0];
    return declaredFamily === sniffedFamily;
}
