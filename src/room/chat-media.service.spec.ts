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
import { PdfThumbnailService } from './pdf-thumbnail.service';

// A plain stub, not jest.mock('./pdf-thumbnail.service'): most tests here have nothing to do with
// pdf thumbnailing, and generate() defaulting to "nothing generated" (null) keeps them that way —
// only the pdf-thumbnail-specific tests below override it.
const fakePdfThumbnails = { generate: jest.fn().mockResolvedValue(null) } as unknown as PdfThumbnailService;

function createService(): ChatMediaService {
    return new ChatMediaService(fakePdfThumbnails);
}

function jpegBuffer(totalBytes = 100): Buffer {
    const header = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
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
});
