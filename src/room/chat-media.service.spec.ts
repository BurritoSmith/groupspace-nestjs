import { PayloadTooLargeException, UnsupportedMediaTypeException } from '@nestjs/common';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const mockSave = jest.fn().mockResolvedValue(undefined);
const mockFile = jest.fn().mockReturnValue({ save: mockSave });
const mockBucket = jest.fn().mockReturnValue({ file: mockFile });
const MockStorage = jest.fn().mockImplementation(() => ({ bucket: mockBucket }));
jest.mock('@google-cloud/storage', () => ({ Storage: MockStorage }));

// Imported after the mock so ChatMediaService's module-level `new Storage()` call (inside its
// instance field initializer) picks up the mock, not the real @google-cloud/storage client.
import { ChatMediaService } from './chat-media.service';
import { HeicTranscodeService } from './heic-transcode.service';
import { IChatAttachment } from './interfaces/room.interfaces';
import { PdfThumbnailService } from './pdf-thumbnail.service';
import { VideoThumbnailService } from './video-thumbnail.service';

// A plain stub, not jest.mock('./pdf-thumbnail.service'): most tests here have nothing to do with
// pdf thumbnailing, and generate() defaulting to "nothing generated" (null) keeps them that way —
// only the pdf-thumbnail-specific tests below override it.
const fakePdfThumbnails = { generate: jest.fn().mockResolvedValue(null) } as unknown as PdfThumbnailService;

// Same reasoning as fakePdfThumbnails — only the ensureVideoThumbnail-specific tests below override
// these defaults.
const fakeVideoThumbnails = {
    generate: jest.fn().mockResolvedValue(null),
    readImageDimensions: jest.fn().mockResolvedValue(null),
} as unknown as VideoThumbnailService;

// Same reasoning again — defaults to "the decoder couldn't read it", which is what every test not
// specifically about HEIC wants, since none of them upload one.
const fakeHeicTranscoder = { toJpeg: jest.fn().mockResolvedValue(null) } as unknown as HeicTranscodeService;

function createService(): ChatMediaService {
    return new ChatMediaService(fakePdfThumbnails, fakeVideoThumbnails, fakeHeicTranscoder);
}

function jpegBuffer(totalBytes = 100): Buffer {
    const header = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    return Buffer.concat([header, Buffer.alloc(Math.max(0, totalBytes - header.length))]);
}

/** An ISO base media file whose ftyp names `heic` — the shape of an iPhone photo, as far as the
 *  sniffer is concerned. */
function heicBuffer(totalBytes = 100): Buffer {
    const header = Buffer.concat([
        Buffer.from([0x00, 0x00, 0x00, 0x18]), // ftyp box size
        Buffer.from('ftypheic', 'ascii'),
        Buffer.from([0x00, 0x00, 0x00, 0x00]), // minor version
        Buffer.from('mif1', 'ascii'), // one compatible brand
    ]);
    return Buffer.concat([header, Buffer.alloc(Math.max(0, totalBytes - header.length))]);
}

function pdfBuffer(totalBytes = 100): Buffer {
    const header = Buffer.from('%PDF-1.7\n', 'ascii');
    return Buffer.concat([header, Buffer.alloc(Math.max(0, totalBytes - header.length))]);
}

describe('ChatMediaService', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        process.env = { ...originalEnv };
        jest.clearAllMocks();
        mockSave.mockResolvedValue(undefined);
    });

    afterAll(() => {
        process.env = originalEnv;
    });

    describe('with CHAT_MEDIA_GCS_BUCKET configured', () => {
        beforeEach(() => {
            process.env.CHAT_MEDIA_GCS_BUCKET = 'test-chat-media-bucket';
        });

        it('uploads the validated buffer to the configured bucket and returns a public URL', async () => {
            const service = createService();
            const buffer = jpegBuffer();

            const result = await service.uploadAttachment(buffer, 'lobby', 'image/jpeg');

            expect(mockBucket).toHaveBeenCalledWith('test-chat-media-bucket');
            expect(mockSave).toHaveBeenCalledWith(buffer, expect.objectContaining({ contentType: 'image/jpeg', resumable: false }));
            expect(result.mimeType).toBe('image/jpeg');
            expect(result.storagePath).not.toBeNull();
            expect(result.url).toBe(`https://storage.googleapis.com/test-chat-media-bucket/${result.storagePath}`);
        });

        it('derives the stored extension from the sniffed type, not any client-supplied filename', async () => {
            const service = createService();

            const result = await service.uploadAttachment(jpegBuffer(), 'lobby', 'image/jpeg');

            expect(result.storagePath).toMatch(/\.jpg$/);
        });

        it('groups the object path under the sanitized room name and a year/month prefix', async () => {
            const service = createService();

            const result = await service.uploadAttachment(jpegBuffer(), 'My Room!', 'image/jpeg');

            expect(result.storagePath).toMatch(/^My_Room\/\d{4}\/\d{2}\/[0-9a-f-]+\.jpg$/);
        });

        it('exposes a publicBase pointing at the configured bucket, for the gateway allowlist to match against', () => {
            const service = createService();

            expect(service.publicBase).toBe('https://storage.googleapis.com/test-chat-media-bucket/');
        });

        describe('HEIC uploads', () => {
            const transcoded = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20)]);

            it('stores the transcoded JPEG rather than the HEIC it was given', async () => {
                (fakeHeicTranscoder.toJpeg as jest.Mock).mockResolvedValue(transcoded);
                const service = createService();
                const original = heicBuffer();

                const result = await service.uploadAttachment(original, 'lobby', 'image/heic');

                expect(fakeHeicTranscoder.toJpeg).toHaveBeenCalledWith(original);
                expect(mockSave).toHaveBeenCalledWith(transcoded, expect.objectContaining({ contentType: 'image/jpeg' }));
                expect(result.mimeType).toBe('image/jpeg');
                expect(result.storagePath).toMatch(/\.jpg$/);
            });

            // The controller reports this to every client as the attachment's size. Reporting the
            // HEIC's length would describe a file nobody can download — the stored object is the JPEG.
            it('reports the size of what was stored, not of the uploaded original', async () => {
                (fakeHeicTranscoder.toJpeg as jest.Mock).mockResolvedValue(transcoded);
                const service = createService();

                const result = await service.uploadAttachment(heicBuffer(5000), 'lobby', 'image/heic');

                expect(result.sizeBytes).toBe(transcoded.length);
            });

            // Not best-effort, unlike the thumbnail services: storing an undisplayable original would
            // put an image in the chat that most clients can't render, which is worse than refusing it.
            it('rejects the upload when the file cannot be decoded, storing nothing', async () => {
                (fakeHeicTranscoder.toJpeg as jest.Mock).mockResolvedValue(null);
                const service = createService();

                await expect(service.uploadAttachment(heicBuffer(), 'lobby', 'image/heic')).rejects.toBeInstanceOf(UnsupportedMediaTypeException);
                expect(mockSave).not.toHaveBeenCalled();
            });

            // The cap bounds what one request may cost this process, and those bytes have already been
            // read by the time the transcode happens — so it's checked before, against the original.
            it('applies the image size cap to the uploaded HEIC, before any transcode', async () => {
                process.env.CHAT_MEDIA_MAX_IMAGE_BYTES = '1000';
                (fakeHeicTranscoder.toJpeg as jest.Mock).mockResolvedValue(transcoded);
                const service = createService();

                await expect(service.uploadAttachment(heicBuffer(2000), 'lobby', 'image/heic')).rejects.toBeInstanceOf(PayloadTooLargeException);
                expect(fakeHeicTranscoder.toJpeg).not.toHaveBeenCalled();
            });
        });
    });

    describe('without CHAT_MEDIA_GCS_BUCKET (local-dev fallback)', () => {
        let tmpDir: string;

        beforeEach(async () => {
            delete process.env.CHAT_MEDIA_GCS_BUCKET;
            tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chat-media-test-'));
            process.env.CHAT_MEDIA_DIR = tmpDir;
        });

        afterEach(async () => {
            await fs.rm(tmpDir, { recursive: true, force: true });
        });

        it('writes the buffer under CHAT_MEDIA_DIR and returns a root-relative URL, never touching GCS', async () => {
            const service = createService();
            const buffer = jpegBuffer();

            const result = await service.uploadAttachment(buffer, 'lobby', 'image/jpeg');

            expect(mockBucket).not.toHaveBeenCalled();
            expect(result.storagePath).toBeNull();
            expect(result.url.startsWith('/chat-media/')).toBe(true);
            const written = await fs.readFile(path.join(tmpDir, result.url.replace('/chat-media/', '')));
            expect(written.equals(buffer)).toBe(true);
        });

        it('exposes a root-relative publicBase, matching main.ts\'s /chat-media/ static mount', () => {
            const service = createService();

            expect(service.publicBase).toBe('/chat-media/');
        });
    });

    describe('validation', () => {
        beforeEach(() => {
            process.env.CHAT_MEDIA_GCS_BUCKET = 'test-chat-media-bucket';
        });

        it('rejects an unrecognized/unsupported format before ever touching storage', async () => {
            const service = createService();

            await expect(service.uploadAttachment(Buffer.from('not a real file'), 'lobby', 'image/jpeg')).rejects.toBeInstanceOf(
                UnsupportedMediaTypeException,
            );
            expect(mockSave).not.toHaveBeenCalled();
        });

        it('rejects when the sniffed type disagrees with the declared Content-Type (a forged upload)', async () => {
            const service = createService();

            await expect(service.uploadAttachment(jpegBuffer(), 'lobby', 'video/mp4')).rejects.toBeInstanceOf(UnsupportedMediaTypeException);
        });

        it('enforces the per-kind size cap AFTER sniffing — a video-sized file lying about being an image is still caught', async () => {
            process.env.CHAT_MEDIA_MAX_IMAGE_BYTES = '50';
            const service = createService();

            await expect(service.uploadAttachment(jpegBuffer(200), 'lobby', 'image/jpeg')).rejects.toBeInstanceOf(PayloadTooLargeException);
            expect(mockSave).not.toHaveBeenCalled();
        });

        it('falls back to the default cap when the env var is set but blank', async () => {
            process.env.CHAT_MEDIA_MAX_IMAGE_BYTES = '';
            const service = createService();

            // Well under the 50MB default — must NOT be rejected as if the cap were 0.
            await expect(service.uploadAttachment(jpegBuffer(1000), 'lobby', 'image/jpeg')).resolves.toBeDefined();
        });

        it('accepts a PDF, stored with a .pdf extension', async () => {
            const service = createService();

            const result = await service.uploadAttachment(pdfBuffer(), 'lobby', 'application/pdf');

            expect(result.mimeType).toBe('application/pdf');
            expect(result.storagePath).toMatch(/\.pdf$/);
        });

        it('enforces the PDF size cap independently of the image cap', async () => {
            process.env.CHAT_MEDIA_MAX_PDF_BYTES = '50';
            const service = createService();

            await expect(service.uploadAttachment(pdfBuffer(200), 'lobby', 'application/pdf')).rejects.toBeInstanceOf(PayloadTooLargeException);
            expect(mockSave).not.toHaveBeenCalled();
        });
    });

    describe('generatePdfThumbnail', () => {
        beforeEach(() => {
            process.env.CHAT_MEDIA_GCS_BUCKET = 'test-chat-media-bucket';
        });

        it('uploads the rendered thumbnail and returns its url and pixel size', async () => {
            (fakePdfThumbnails.generate as jest.Mock).mockResolvedValueOnce({ buffer: jpegBuffer(), width: 300, height: 400 });
            const service = createService();

            const result = await service.generatePdfThumbnail(pdfBuffer(), 'lobby');

            expect(result).toEqual({ url: expect.stringContaining('https://storage.googleapis.com/test-chat-media-bucket/'), width: 300, height: 400 });
            // Goes through the SAME upload path as any other file — sniffs and stores like an
            // ordinary image, not a special-cased write.
            expect(mockSave).toHaveBeenCalledWith(expect.any(Buffer), expect.objectContaining({ contentType: 'image/jpeg' }));
        });

        it('returns null without touching storage when rendering itself produced nothing', async () => {
            (fakePdfThumbnails.generate as jest.Mock).mockResolvedValueOnce(null);
            const service = createService();

            const result = await service.generatePdfThumbnail(pdfBuffer(), 'lobby');

            expect(result).toBeNull();
            expect(mockSave).not.toHaveBeenCalled();
        });

        // Best-effort, same as the image/video sidecar upload: a thumbnail that fails to save costs
        // the chat list its cheap source, never the send itself.
        it('returns null, rather than throwing, when the thumbnail upload itself fails', async () => {
            (fakePdfThumbnails.generate as jest.Mock).mockResolvedValueOnce({ buffer: jpegBuffer(), width: 300, height: 400 });
            mockSave.mockRejectedValueOnce(new Error('bucket unavailable'));
            const service = createService();

            await expect(service.generatePdfThumbnail(pdfBuffer(), 'lobby')).resolves.toBeNull();
        });
    });

    describe('ensureVideoThumbnail', () => {
        function videoAttachment(overrides: Partial<IChatAttachment> = {}): IChatAttachment {
            return {
                id: 'att-1',
                kind: 'video',
                url: 'https://storage.googleapis.com/test-chat-media-bucket/lobby/2026/08/video.mp4',
                storagePath: 'lobby/2026/08/video.mp4',
                thumbnailUrl: 'https://storage.googleapis.com/test-chat-media-bucket/lobby/2026/08/poster.jpg',
                mimeType: 'video/mp4',
                width: 1920,
                height: 1080,
                durationMs: 5000,
                sizeBytes: 5_000_000,
                name: 'video.mp4',
                ...overrides,
            };
        }

        describe('with CHAT_MEDIA_GCS_BUCKET configured', () => {
            let fetchMock: jest.Mock;
            const originalFetch = global.fetch;

            beforeEach(() => {
                process.env.CHAT_MEDIA_GCS_BUCKET = 'test-chat-media-bucket';
                fetchMock = jest.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => new Uint8Array(jpegBuffer()).buffer });
                global.fetch = fetchMock as unknown as typeof fetch;
            });

            afterEach(() => {
                global.fetch = originalFetch;
            });

            it('skips a non-video attachment without reading or generating anything', async () => {
                const service = createService();

                const result = await service.ensureVideoThumbnail(videoAttachment({ kind: 'image' }), 'lobby');

                expect(result).toBeNull();
                expect(fetchMock).not.toHaveBeenCalled();
                expect(fakeVideoThumbnails.generate).not.toHaveBeenCalled();
            });

            it('regenerates, skipping the poster read entirely, when thumbnailUrl is missing', async () => {
                (fakeVideoThumbnails.generate as jest.Mock).mockResolvedValueOnce({ buffer: jpegBuffer(), width: 1920, height: 1080 });
                const service = createService();

                const result = await service.ensureVideoThumbnail(videoAttachment({ thumbnailUrl: null }), 'lobby');

                expect(fetchMock).not.toHaveBeenCalled();
                expect(result).toEqual(
                    expect.objectContaining({ thumbnailUrl: expect.stringContaining('https://storage.googleapis.com/'), width: 1920, height: 1080 }),
                );
            });

            it('regenerates when width is missing', async () => {
                (fakeVideoThumbnails.generate as jest.Mock).mockResolvedValueOnce({ buffer: jpegBuffer(), width: 1920, height: 1080 });
                const service = createService();

                const result = await service.ensureVideoThumbnail(videoAttachment({ width: null }), 'lobby');

                expect(result).not.toBeNull();
            });

            it('regenerates when height is missing', async () => {
                (fakeVideoThumbnails.generate as jest.Mock).mockResolvedValueOnce({ buffer: jpegBuffer(), width: 1920, height: 1080 });
                const service = createService();

                const result = await service.ensureVideoThumbnail(videoAttachment({ height: null }), 'lobby');

                expect(result).not.toBeNull();
            });

            it("skips regeneration when the existing poster's aspect ratio matches the claimed dimensions", async () => {
                (fakeVideoThumbnails.readImageDimensions as jest.Mock).mockResolvedValueOnce({ width: 960, height: 540 }); // same 16:9 as 1920x1080
                const service = createService();

                const result = await service.ensureVideoThumbnail(videoAttachment(), 'lobby');

                expect(result).toBeNull();
                expect(fakeVideoThumbnails.generate).not.toHaveBeenCalled();
            });

            it("regenerates when the existing poster's aspect ratio disagrees with the claimed dimensions", async () => {
                (fakeVideoThumbnails.readImageDimensions as jest.Mock).mockResolvedValueOnce({ width: 540, height: 960 }); // portrait poster, landscape claim
                (fakeVideoThumbnails.generate as jest.Mock).mockResolvedValueOnce({ buffer: jpegBuffer(), width: 1920, height: 1080 });
                const service = createService();

                const result = await service.ensureVideoThumbnail(videoAttachment(), 'lobby');

                expect(result).not.toBeNull();
                expect(fakeVideoThumbnails.generate).toHaveBeenCalledWith('https://storage.googleapis.com/test-chat-media-bucket/lobby/2026/08/video.mp4');
            });

            it('regenerates when the existing poster cannot be fetched (404)', async () => {
                fetchMock.mockResolvedValueOnce({ ok: false, status: 404 });
                (fakeVideoThumbnails.generate as jest.Mock).mockResolvedValueOnce({ buffer: jpegBuffer(), width: 1920, height: 1080 });
                const service = createService();

                const result = await service.ensureVideoThumbnail(videoAttachment(), 'lobby');

                expect(result).not.toBeNull();
            });

            it('regenerates when the existing poster fails to decode', async () => {
                (fakeVideoThumbnails.readImageDimensions as jest.Mock).mockResolvedValueOnce(null);
                (fakeVideoThumbnails.generate as jest.Mock).mockResolvedValueOnce({ buffer: jpegBuffer(), width: 1920, height: 1080 });
                const service = createService();

                const result = await service.ensureVideoThumbnail(videoAttachment(), 'lobby');

                expect(result).not.toBeNull();
            });

            it('returns null without uploading when generation itself fails', async () => {
                const service = createService();

                const result = await service.ensureVideoThumbnail(videoAttachment({ thumbnailUrl: null }), 'lobby');

                expect(result).toBeNull();
                expect(mockSave).not.toHaveBeenCalled();
            });

            // Best-effort, same as generatePdfThumbnail: a poster that fails to save costs the chat
            // list its cheap source, never the send itself.
            it('returns null, rather than throwing, when the generated thumbnail fails to upload', async () => {
                (fakeVideoThumbnails.generate as jest.Mock).mockResolvedValueOnce({ buffer: jpegBuffer(), width: 1920, height: 1080 });
                mockSave.mockRejectedValueOnce(new Error('bucket unavailable'));
                const service = createService();

                await expect(service.ensureVideoThumbnail(videoAttachment({ thumbnailUrl: null }), 'lobby')).resolves.toBeNull();
            });

            it('reads the existing poster over https directly (public-read, no auth) in GCS mode', async () => {
                (fakeVideoThumbnails.readImageDimensions as jest.Mock).mockResolvedValueOnce({ width: 960, height: 540 });
                const service = createService();

                await service.ensureVideoThumbnail(videoAttachment(), 'lobby');

                expect(fetchMock).toHaveBeenCalledWith('https://storage.googleapis.com/test-chat-media-bucket/lobby/2026/08/poster.jpg');
            });
        });

        describe('without CHAT_MEDIA_GCS_BUCKET (local-dev fallback)', () => {
            let tmpDir: string;

            beforeEach(async () => {
                delete process.env.CHAT_MEDIA_GCS_BUCKET;
                tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chat-media-video-test-'));
                process.env.CHAT_MEDIA_DIR = tmpDir;
            });

            afterEach(async () => {
                await fs.rm(tmpDir, { recursive: true, force: true });
            });

            it("reads the poster from local disk, resolving the root-relative url against CHAT_MEDIA_DIR", async () => {
                const posterPath = path.join(tmpDir, 'lobby', '2026', '08', 'poster.jpg');
                await fs.mkdir(path.dirname(posterPath), { recursive: true });
                await fs.writeFile(posterPath, jpegBuffer());
                (fakeVideoThumbnails.readImageDimensions as jest.Mock).mockResolvedValueOnce({ width: 960, height: 540 });
                const service = createService();

                const result = await service.ensureVideoThumbnail(
                    videoAttachment({ url: '/chat-media/lobby/2026/08/video.mp4', thumbnailUrl: '/chat-media/lobby/2026/08/poster.jpg' }),
                    'lobby',
                );

                // Ratio matches, so no regeneration is needed — reaching that conclusion at all
                // proves the local poster read (not a 404/fetch) actually succeeded.
                expect(result).toBeNull();
            });

            it('treats a poster missing from disk as unreadable, and regenerates', async () => {
                (fakeVideoThumbnails.generate as jest.Mock).mockResolvedValueOnce({ buffer: jpegBuffer(), width: 1920, height: 1080 });
                const service = createService();

                const result = await service.ensureVideoThumbnail(
                    videoAttachment({ url: '/chat-media/lobby/2026/08/video.mp4', thumbnailUrl: '/chat-media/lobby/2026/08/missing.jpg' }),
                    'lobby',
                );

                expect(result).not.toBeNull();
            });

            it("resolves the video's own local path (not a URL) as ffmpeg's input", async () => {
                (fakeVideoThumbnails.generate as jest.Mock).mockResolvedValueOnce({ buffer: jpegBuffer(), width: 1920, height: 1080 });
                const service = createService();

                await service.ensureVideoThumbnail(videoAttachment({ url: '/chat-media/lobby/2026/08/video.mp4', thumbnailUrl: null }), 'lobby');

                expect(fakeVideoThumbnails.generate).toHaveBeenCalledWith(path.join(tmpDir, 'lobby', '2026', '08', 'video.mp4'));
            });
        });
    });
});
