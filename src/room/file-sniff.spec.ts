import { sniffedTypeMatchesDeclared, sniffMediaType } from './file-sniff';

function bytes(...values: number[]): Buffer {
    return Buffer.from(values);
}

function padTo(buffer: Buffer, length: number): Buffer {
    if (buffer.length >= length) {
        return buffer;
    }
    return Buffer.concat([buffer, Buffer.alloc(length - buffer.length)]);
}

describe('sniffMediaType', () => {
    it('recognizes a JPEG by its FF D8 FF marker', () => {
        expect(sniffMediaType(padTo(bytes(0xff, 0xd8, 0xff, 0xe0), 16))).toBe('image/jpeg');
    });

    it('recognizes a PNG by its 89 50 4E 47 signature', () => {
        expect(sniffMediaType(padTo(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), 16))).toBe('image/png');
    });

    it('recognizes a GIF87a/GIF89a header', () => {
        const gif89a = Buffer.concat([Buffer.from('GIF89a', 'ascii'), Buffer.alloc(10)]);
        expect(sniffMediaType(gif89a)).toBe('image/gif');
    });

    it('recognizes a WebP by its RIFF....WEBP container', () => {
        const webp = Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.alloc(4), Buffer.from('WEBP', 'ascii'), Buffer.alloc(4)]);
        expect(sniffMediaType(webp)).toBe('image/webp');
    });

    it('recognizes WebM/Matroska by its EBML header', () => {
        expect(sniffMediaType(padTo(bytes(0x1a, 0x45, 0xdf, 0xa3), 16))).toBe('video/webm');
    });

    it('recognizes an MP4 with an allowlisted brand (isom)', () => {
        const mp4 = Buffer.concat([Buffer.alloc(4), Buffer.from('ftyp', 'ascii'), Buffer.from('isom', 'ascii'), Buffer.alloc(4)]);
        expect(sniffMediaType(mp4)).toBe('video/mp4');
    });

    it('recognizes a PDF by its %PDF- header', () => {
        expect(sniffMediaType(padTo(Buffer.from('%PDF-1.7\n', 'ascii'), 16))).toBe('application/pdf');
    });

    it('rejects an ftyp box with a brand not on the allowlist', () => {
        const mp4 = Buffer.concat([Buffer.alloc(4), Buffer.from('ftyp', 'ascii'), Buffer.from('xxxx', 'ascii'), Buffer.alloc(4)]);
        expect(sniffMediaType(mp4)).toBeNull();
    });

    it('returns null for an unrecognized/unsupported format (e.g. a zip disguised as an image)', () => {
        const zip = padTo(bytes(0x50, 0x4b, 0x03, 0x04), 16);
        expect(sniffMediaType(zip)).toBeNull();
    });

    it('returns null for a buffer too short to contain any recognizable header', () => {
        expect(sniffMediaType(bytes(0xff, 0xd8))).toBeNull();
    });
});

describe('sniffedTypeMatchesDeclared', () => {
    it('matches when the declared Content-Type family agrees with the sniffed type', () => {
        expect(sniffedTypeMatchesDeclared('image/jpeg', 'image/jpeg')).toBe(true);
        expect(sniffedTypeMatchesDeclared('image/png', 'image/*')).toBe(true);
    });

    it('rejects a mismatched family — a PNG uploaded with a declared video Content-Type', () => {
        expect(sniffedTypeMatchesDeclared('image/png', 'video/mp4')).toBe(false);
    });
});
