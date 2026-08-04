import { PdfThumbnailService } from './pdf-thumbnail.service';

function stubLoadingTask(service: PdfThumbnailService, page: unknown, destroy: jest.Mock = jest.fn().mockResolvedValue(undefined)) {
    const getPage = jest.fn().mockResolvedValue(page);
    const getDocument = jest.fn().mockReturnValue({ promise: Promise.resolve({ getPage }), destroy });
    // See PdfThumbnailService.loadPdfjsLib's own comment: this is the substitution point precisely
    // because a real dynamic import() of pdfjs-dist (ESM-only) can't be resolved inside Jest's
    // default test environment without --experimental-vm-modules, even though it works fine in the
    // actual running service.
    jest.spyOn(service as unknown as { loadPdfjsLib: () => unknown }, 'loadPdfjsLib').mockResolvedValue({ getDocument });
    return { getDocument, getPage, destroy };
}

describe('PdfThumbnailService', () => {
    let service: PdfThumbnailService;

    beforeEach(() => {
        service = new PdfThumbnailService();
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('renders the first page to a JPEG and reports its rendered pixel size', async () => {
        stubLoadingTask(service, {
            getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }),
            render: () => ({ promise: Promise.resolve() }),
        });

        const result = await service.generate(Buffer.from('irrelevant — loadPdfjsLib is stubbed'));

        expect(result).not.toBeNull();
        // JPEG magic bytes (FF D8 FF) — a real encoded image, not an empty/placeholder buffer.
        expect(result!.buffer[0]).toBe(0xff);
        expect(result!.buffer[1]).toBe(0xd8);
        // A 600x800 page scaled to fit a 768px longest edge — the shorter edge (600) scales with it.
        expect(result!.height).toBe(768);
        expect(result!.width).toBe(576);
    });

    it('points standardFontDataUrl at the real pdfjs-dist install, not a hand-assembled relative path', async () => {
        const { getDocument } = stubLoadingTask(service, {
            getViewport: () => ({ width: 600, height: 800 }),
            render: () => ({ promise: Promise.resolve() }),
        });

        await service.generate(Buffer.from('x'));

        const options = getDocument.mock.calls[0][0];
        expect(options.standardFontDataUrl).toContain('pdfjs-dist');
        expect(options.standardFontDataUrl).toMatch(/standard_fonts[\\/]$/);
        expect(options.disableFontFace).toBe(true);
    });

    it('destroys the loading task once done, releasing the worker', async () => {
        const { destroy } = stubLoadingTask(service, { getViewport: () => ({ width: 600, height: 800 }), render: () => ({ promise: Promise.resolve() }) });

        await service.generate(Buffer.from('x'));

        expect(destroy).toHaveBeenCalledTimes(1);
    });

    // Never allowed to fail the whole upload over a cosmetic thumbnail.
    it('resolves null, never rejects, when the document fails to load (a corrupt file)', async () => {
        const destroy = jest.fn().mockResolvedValue(undefined);
        // Pre-caught so Node's unhandled-rejection tracking doesn't flag it in the gap between this
        // synchronous setup and the service actually awaiting the same promise a tick later — the
        // production code's own await still sees the rejection independently.
        const failed = Promise.reject(new Error('invalid PDF structure'));
        failed.catch(() => undefined);
        const getDocument = jest.fn().mockReturnValue({ promise: failed, destroy });
        jest.spyOn(service as unknown as { loadPdfjsLib: () => unknown }, 'loadPdfjsLib').mockResolvedValue({ getDocument });

        await expect(service.generate(Buffer.from('not a pdf'))).resolves.toBeNull();
        expect(destroy).toHaveBeenCalledTimes(1);
    });

    it('resolves null when rendering itself throws', async () => {
        const failed = Promise.reject(new Error('render failed'));
        failed.catch(() => undefined);
        stubLoadingTask(service, { getViewport: () => ({ width: 600, height: 800 }), render: () => ({ promise: failed }) });

        await expect(service.generate(Buffer.from('x'))).resolves.toBeNull();
    });

    it('resolves null when the dynamic import of pdfjs-dist itself fails', async () => {
        jest.spyOn(service as unknown as { loadPdfjsLib: () => unknown }, 'loadPdfjsLib').mockRejectedValue(new Error('module not found'));

        await expect(service.generate(Buffer.from('x'))).resolves.toBeNull();
    });
});
