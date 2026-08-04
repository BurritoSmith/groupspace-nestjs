import { Injectable, Logger } from '@nestjs/common';
import { createCanvas } from '@napi-rs/canvas';
import * as path from 'node:path';

export interface PdfThumbnailResult {
    buffer: Buffer;
    width: number;
    height: number;
}

/** Matches the image pipeline's own thumbnail target (see the frontend's image-thumbnail.ts) — one
 *  size serves the same consumers regardless of which kind generated it. Exported for
 *  VideoThumbnailService, which targets the same box for the identical reason. */
export const THUMBNAIL_MAX_EDGE_PX = 768;
/** Matches the frontend's own THUMBNAIL_QUALITY — text renders with visible JPEG artefacts well
 *  before a photo does. */
const THUMBNAIL_QUALITY = 0.8;

/**
 * Renders a PDF's first page to a JPEG thumbnail, server-side.
 *
 * This used to be attempted client-side (pdfjs-dist in the browser, mirroring how a video's poster
 * frame is generated on-device) — in practice it didn't reliably produce a thumbnail, so generation
 * moved here instead. Unlike the image/poster pipeline, this is the one rendition this API DOES
 * generate itself: there's no equivalent of "the pixels are already decoded on the device that chose
 * the file" for a PDF once client-side rendering is off the table.
 *
 * pdfjs-dist's Node/legacy build plus @napi-rs/canvas (prebuilt native binaries — no cairo/pango
 * toolchain needed at install time, unlike the `canvas` package) is what actually renders a page to
 * pixels; nothing here needs a browser or a DOM. disableFontFace is required in Node (there's no
 * FontFace API to use), and standardFontDataUrl points at pdfjs-dist's own bundled standard-font
 * files so a PDF using only the base 14 fonts (no embedded font program) still renders its text
 * rather than silently coming back blank.
 *
 * Best-effort throughout: resolves null on any failure (a corrupt file, a render that throws) rather
 * than rejecting — a missing thumbnail is a cosmetic gap, never a reason to fail the whole upload.
 */
@Injectable()
export class PdfThumbnailService {
    private readonly logger = new Logger(PdfThumbnailService.name);

    /** Resolved once, from wherever pdfjs-dist actually installed — not a relative path assembled
     *  by hand, which would break the moment this runs from a different working directory (as a
     *  compiled dist/ output routinely does) than the one it was written against. Forward slashes
     *  always, not path.sep: pdfjs-dist validates this as a URL-shaped string ("must include
     *  trailing slash"), and rejects it outright given Windows' native backslashes even though a
     *  trailing one is technically present — a real failure caught testing this on Windows dev
     *  machines, harmless on the Linux deploy target where path.sep already is "/". */
    private readonly standardFontDataUrl = `${path
        .join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts')
        .split(path.sep)
        .join('/')}/`;

    async generate(buffer: Buffer): Promise<PdfThumbnailResult | null> {
        try {
            const pdfjsLib = await this.loadPdfjsLib();
            // The loading task, not the PDFDocumentProxy its .promise resolves to, is what
            // destroy() lives on — PDFDocumentProxy itself only has cleanup(), which frees cached
            // resources but leaves the parse session running.
            const loadingTask = pdfjsLib.getDocument({
                data: new Uint8Array(buffer),
                disableFontFace: true,
                standardFontDataUrl: this.standardFontDataUrl,
            });
            try {
                const pdf = await loadingTask.promise;
                const page = await pdf.getPage(1);
                const baseViewport = page.getViewport({ scale: 1 });
                const scale = Math.min(1, THUMBNAIL_MAX_EDGE_PX / Math.max(baseViewport.width, baseViewport.height));
                const viewport = page.getViewport({ scale });
                const width = Math.max(1, Math.round(viewport.width));
                const height = Math.max(1, Math.round(viewport.height));

                const canvas = createCanvas(width, height);
                const context = canvas.getContext('2d');
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- @napi-rs/canvas's
                // Canvas/SKRSContext2D are structurally close to but not typed as the DOM's
                // HTMLCanvasElement/CanvasRenderingContext2D that pdfjs-dist's own types expect.
                await page.render({ canvasContext: context as any, canvas: canvas as any, viewport }).promise;

                return { buffer: canvas.toBuffer('image/jpeg', THUMBNAIL_QUALITY), width, height };
            } finally {
                await loadingTask.destroy().catch(() => undefined);
            }
        } catch (error) {
            this.logger.warn(`PDF thumbnail generation failed: ${error instanceof Error ? error.message : String(error)}`);
            return null;
        }
    }

    /**
     * Isolated into its own method specifically so tests can substitute it instead of touching the
     * real dynamic import of an ESM-only package. pdfjs-dist ships no CommonJS build, and this
     * project's `nest build` output is CommonJS, so loading it has to be a dynamic import() (which
     * works from CJS) rather than a static one — but Jest's default (non-ESM) test environment
     * can't resolve a real dynamic import() at all without --experimental-vm-modules, even though
     * it works fine in the actual compiled/running service (a plain Node process, not Jest's
     * sandboxed VM). Same reasoning, and the same fix, as VideoCompression.createFFmpeg on the
     * frontend.
     */
    protected loadPdfjsLib() {
        return import('pdfjs-dist/legacy/build/pdf.mjs');
    }
}
