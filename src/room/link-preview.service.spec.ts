import { LinkPreviewService, extractFirstUrl } from './link-preview.service';
import type { ChatMediaService } from './chat-media.service';

jest.mock('node:dns/promises', () => ({ lookup: jest.fn().mockResolvedValue({ address: '93.184.216.34', family: 4 }) }));

describe('extractFirstUrl', () => {
    it('finds an http(s) url anywhere in the text', () => {
        expect(extractFirstUrl('have a look at https://example.com/article ok?')).toBe('https://example.com/article');
    });

    // The card must never disagree with what the message text made clickable, so this rule is the
    // same one linkify.ts uses on the frontend.
    it('accepts a www. url and gives it a scheme so it can be fetched', () => {
        expect(extractFirstUrl('www.example.com is good')).toBe('https://www.example.com');
    });

    it('does not treat a bare domain as a link', () => {
        expect(extractFirstUrl('open config.json and look at v2.1')).toBeNull();
    });

    it('leaves trailing sentence punctuation out of the url', () => {
        expect(extractFirstUrl('read https://example.com/a.')).toBe('https://example.com/a');
    });

    it('returns null for text with no url', () => {
        expect(extractFirstUrl('just a normal message')).toBeNull();
    });

    it('takes the first url when there are several', () => {
        expect(extractFirstUrl('https://one.example.com and https://two.example.com')).toBe('https://one.example.com');
    });
});

describe('LinkPreviewService', () => {
    const fetchMock = jest.fn();
    let uploadAttachment: jest.Mock;
    let service: LinkPreviewService;

    /** A 1x1 PNG — real magic bytes, so ChatMediaService's sniff would accept it. */
    const PNG_BYTES = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

    function htmlResponse(html: string): Response {
        return {
            status: 200,
            ok: true,
            headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
            body: bodyOf(Buffer.from(html, 'utf8')),
        } as unknown as Response;
    }

    function imageResponse(bytes: Buffer, contentType = 'image/png'): Response {
        return { status: 200, ok: true, headers: new Headers({ 'content-type': contentType }), body: bodyOf(bytes) } as unknown as Response;
    }

    function bodyOf(buffer: Buffer) {
        let sent = false;
        return {
            getReader: () => ({
                read: () => {
                    const result = sent ? { done: true, value: undefined } : { done: false, value: new Uint8Array(buffer) };
                    sent = true;
                    return Promise.resolve(result);
                },
                cancel: () => Promise.resolve(),
            }),
        };
    }

    beforeEach(() => {
        fetchMock.mockReset();
        global.fetch = fetchMock as unknown as typeof fetch;
        uploadAttachment = jest.fn().mockResolvedValue({ url: 'https://storage.googleapis.com/our-bucket/room/x.png', storagePath: 'room/x.png', mimeType: 'image/png' });
        service = new LinkPreviewService({ uploadAttachment } as unknown as ChatMediaService);
    });

    it('prefers Open Graph tags', async () => {
        fetchMock.mockResolvedValueOnce(
            htmlResponse(`
                <html><head>
                    <title>Ignored fallback</title>
                    <meta property="og:title" content="The real title" />
                    <meta property="og:description" content="A summary." />
                    <meta property="og:site_name" content="Example" />
                </head></html>`),
        );

        const preview = await service.fetchPreview('https://example.com/a', 'lobby');

        expect(preview).toMatchObject({ title: 'The real title', description: 'A summary.', siteName: 'Example' });
    });

    it('falls back to <title> and meta description when there are no og tags', async () => {
        fetchMock.mockResolvedValueOnce(
            htmlResponse('<html><head><title>Plain title</title><meta name="description" content="Plain summary"></head></html>'),
        );

        const preview = await service.fetchPreview('https://example.com/b', 'lobby');

        expect(preview).toMatchObject({ title: 'Plain title', description: 'Plain summary' });
    });

    it('reads attributes written in either order', async () => {
        fetchMock.mockResolvedValueOnce(htmlResponse('<html><head><meta content="Reversed" property="og:title"></head></html>'));

        expect((await service.fetchPreview('https://example.com/c', 'lobby'))?.title).toBe('Reversed');
    });

    // A card of empty strings reads as a broken preview; no card at all reads as a plain link.
    it('returns null for a page with no usable metadata', async () => {
        fetchMock.mockResolvedValueOnce(htmlResponse('<html><head></head><body>hi</body></html>'));

        expect(await service.fetchPreview('https://example.com/d', 'lobby')).toBeNull();
    });

    it('ignores a response that is not html', async () => {
        fetchMock.mockResolvedValueOnce({
            status: 200,
            ok: true,
            headers: new Headers({ 'content-type': 'application/pdf' }),
            body: bodyOf(Buffer.from('%PDF-1.4')),
        } as unknown as Response);

        expect(await service.fetchPreview('https://example.com/e.pdf', 'lobby')).toBeNull();
    });

    it('decodes the entities that actually show up in titles', async () => {
        fetchMock.mockResolvedValueOnce(htmlResponse('<html><head><meta property="og:title" content="Tom &amp; Jerry&#39;s &quot;day&quot;"></head></html>'));

        expect((await service.fetchPreview('https://example.com/f', 'lobby'))?.title).toBe('Tom & Jerry\'s "day"');
    });

    describe('image re-hosting', () => {
        const pageWithImage = `<html><head>
            <meta property="og:title" content="Titled">
            <meta property="og:image" content="https://cdn.example.com/pic.png">
        </head></html>`;

        // The whole reason for re-hosting: the card must not point a viewer's browser at whatever
        // host the sender linked to.
        it('stores the image and returns OUR url, not the origin', async () => {
            fetchMock.mockResolvedValueOnce(htmlResponse(pageWithImage)).mockResolvedValueOnce(imageResponse(PNG_BYTES));

            const preview = await service.fetchPreview('https://example.com/g', 'lobby');

            expect(uploadAttachment).toHaveBeenCalled();
            expect(preview?.imageUrl).toBe('https://storage.googleapis.com/our-bucket/room/x.png');
            expect(preview?.imageUrl).not.toContain('cdn.example.com');
        });

        it('resolves a relative og:image against the page url', async () => {
            fetchMock
                .mockResolvedValueOnce(htmlResponse('<html><head><meta property="og:title" content="T"><meta property="og:image" content="/pic.png"></head></html>'))
                .mockResolvedValueOnce(imageResponse(PNG_BYTES));

            await service.fetchPreview('https://example.com/deep/page', 'lobby');

            expect(fetchMock.mock.calls[1][0].toString()).toBe('https://example.com/pic.png');
        });

        // uploadAttachment sniffs magic bytes and throws on a mismatch — the card should survive
        // without a picture rather than failing wholesale.
        it('keeps the card when the image is rejected as not really an image', async () => {
            fetchMock.mockResolvedValueOnce(htmlResponse(pageWithImage)).mockResolvedValueOnce(imageResponse(Buffer.from('<html>not a png')));
            uploadAttachment.mockRejectedValue(new Error('Unsupported or unrecognized file type'));

            const preview = await service.fetchPreview('https://example.com/h', 'lobby');

            expect(preview).toMatchObject({ title: 'Titled', imageUrl: null });
        });

        it('skips an image whose response is not an image content type', async () => {
            fetchMock.mockResolvedValueOnce(htmlResponse(pageWithImage)).mockResolvedValueOnce(imageResponse(PNG_BYTES, 'text/html'));

            expect((await service.fetchPreview('https://example.com/i', 'lobby'))?.imageUrl).toBeNull();
            expect(uploadAttachment).not.toHaveBeenCalled();
        });
    });

    it('caches by url so the same link is scraped once', async () => {
        fetchMock.mockResolvedValue(htmlResponse('<html><head><meta property="og:title" content="Cached"></head></html>'));

        await service.fetchPreview('https://example.com/j', 'lobby');
        await service.fetchPreview('https://example.com/j', 'lobby');

        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    // Runs detached from the send path, so a throw here would be an unhandled rejection rather than
    // anything a user could see.
    it('never throws when the fetch fails', async () => {
        fetchMock.mockRejectedValue(new Error('network is down'));

        await expect(service.fetchPreview('https://example.com/k', 'lobby')).resolves.toBeNull();
    });
});
