import { Logger } from '@nestjs/common';
import { GiphyService } from './giphy.service';

/** One Giphy record, in their wire shape, with only the fields the service reads. */
function giphyRecord(overrides: Record<string, unknown> = {}) {
    return {
        id: 'abc123',
        title: 'A dancing cat',
        images: {
            fixed_width: { url: 'https://media0.giphy.com/abc123/200w.gif', width: '200', height: '150' },
            fixed_width_small: { url: 'https://media0.giphy.com/abc123/100w.gif' },
            original: { url: 'https://media0.giphy.com/abc123/giphy.gif', width: '480', height: '360' },
        },
        ...overrides,
    };
}

function mockFetch(body: unknown, ok = true) {
    const fetchMock = jest.fn().mockResolvedValue({ ok, status: ok ? 200 : 500, json: async () => body });
    global.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
}

/** The service reads process.env at construction, so the key has to be in place before `new`. */
function createService(apiKey: string | undefined): GiphyService {
    if (apiKey === undefined) {
        delete process.env.GIPHY_API_KEY;
    } else {
        process.env.GIPHY_API_KEY = apiKey;
    }
    return new GiphyService();
}

/** The URL a call was made to, parsed. */
function calledUrl(fetchMock: jest.Mock): URL {
    return new URL(String(fetchMock.mock.calls[0][0]));
}

describe('GiphyService', () => {
    const originalKey = process.env.GIPHY_API_KEY;
    const originalFetch = global.fetch;

    afterEach(() => {
        if (originalKey === undefined) {
            delete process.env.GIPHY_API_KEY;
        } else {
            process.env.GIPHY_API_KEY = originalKey;
        }
        global.fetch = originalFetch;
        jest.restoreAllMocks();
    });

    describe('isConfigured', () => {
        it('is false with no key set', () => {
            expect(createService(undefined).isConfigured()).toBe(false);
        });

        it('is false for an empty key, which is how an unset .env line arrives', () => {
            expect(createService('').isConfigured()).toBe(false);
        });

        it('is true once a key is present', () => {
            expect(createService('key-123').isConfigured()).toBe(true);
        });
    });

    // Not configured is a normal state, not an error — local dev without a key still runs, and every
    // search 500ing would be a far worse experience than an empty tab that says so.
    it('returns nothing, without calling out, when no key is configured', async () => {
        const fetchMock = mockFetch({ data: [giphyRecord()] });
        const service = createService(undefined);

        expect(await service.search('cats', 0)).toEqual([]);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    describe('search', () => {
        it('narrows a Giphy record to just what the picker needs', async () => {
            mockFetch({ data: [giphyRecord()] });

            const [gif] = await createService('key-123').search('cats', 0);

            expect(gif).toEqual({
                id: 'abc123',
                title: 'A dancing cat',
                url: 'https://media0.giphy.com/abc123/200w.gif',
                previewUrl: 'https://media0.giphy.com/abc123/100w.gif',
                width: 200,
                height: 150,
            });
        });

        // Original renditions run to several megabytes and are displayed at a couple of hundred
        // pixels regardless — sending one would cost every recipient the download for no visible
        // difference.
        it('sends the fixed-width rendition, never the full-size original', async () => {
            mockFetch({ data: [giphyRecord()] });

            const [gif] = await createService('key-123').search('cats', 0);

            expect(gif.url).not.toContain('giphy.gif');
            expect(gif.url).toContain('200w.gif');
        });

        it('falls back to the sendable rendition when there is no small preview', async () => {
            mockFetch({
                data: [giphyRecord({ images: { fixed_width: { url: 'https://media0.giphy.com/x/200w.gif', width: '200', height: '150' } } })],
            });

            const [gif] = await createService('key-123').search('cats', 0);

            expect(gif.previewUrl).toBe(gif.url);
        });

        it('skips a record with no usable rendition rather than emitting a broken entry', async () => {
            mockFetch({ data: [giphyRecord(), giphyRecord({ id: 'no-images', images: {} })] });

            const gifs = await createService('key-123').search('cats', 0);

            expect(gifs.map((gif) => gif.id)).toEqual(['abc123']);
        });

        it('passes the query, and asks for G-rated results only', async () => {
            const fetchMock = mockFetch({ data: [] });

            await createService('key-123').search('cats', 0);

            const url = calledUrl(fetchMock);
            expect(url.pathname).toContain('/search');
            expect(url.searchParams.get('q')).toBe('cats');
            expect(url.searchParams.get('rating')).toBe('g');
            expect(url.searchParams.get('api_key')).toBe('key-123');
        });

        // The tab opens with nothing typed, and Giphy's /search rejects an empty q.
        it('falls back to trending for an empty or whitespace query', async () => {
            const fetchMock = mockFetch({ data: [] });

            await createService('key-123').search('   ', 0);

            expect(calledUrl(fetchMock).pathname).toContain('/trending');
        });

        it('clamps a negative offset rather than passing it through', async () => {
            const fetchMock = mockFetch({ data: [] });

            await createService('key-123').search('cats', -5);

            expect(calledUrl(fetchMock).searchParams.get('offset')).toBe('0');
        });
    });

    // A GIF picker failing is a cosmetic disappointment; it must never surface as a 500 from our own
    // API or take a request handler down with it.
    describe('when Giphy misbehaves', () => {
        it('returns nothing on a non-OK response', async () => {
            mockFetch({}, false);

            await expect(createService('key-123').search('cats', 0)).resolves.toEqual([]);
        });

        it('returns nothing when the request throws', async () => {
            global.fetch = jest.fn().mockRejectedValue(new Error('network down')) as unknown as typeof fetch;

            await expect(createService('key-123').search('cats', 0)).resolves.toEqual([]);
        });

        it('returns nothing when the body has no data array', async () => {
            mockFetch({ meta: { status: 200 } });

            await expect(createService('key-123').search('cats', 0)).resolves.toEqual([]);
        });
    });

    // The request URL carries the API key as a query parameter, so it must never reach a log line.
    // Spied on Logger.prototype, not on console: Nest's Logger writes through its own transport, and
    // a console spy captures none of it — which would make this assert over an empty array and pass
    // no matter what the service logged.
    it('never logs the request URL, which carries the key', async () => {
        const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        mockFetch({}, false);

        await createService('super-secret-key').search('cats', 0);

        // Proves the spy is actually capturing before drawing any conclusion from what it captured.
        expect(warn).toHaveBeenCalled();
        for (const call of warn.mock.calls) {
            expect(JSON.stringify(call)).not.toContain('super-secret-key');
        }
    });
});
