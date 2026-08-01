import { Injectable, Logger } from '@nestjs/common';
import { IGifSummary } from './interfaces/room.interfaces';

const GIPHY_API_BASE = 'https://api.giphy.com/v1/gifs';
/** Giphy's own ceiling per request is 50; a picker grid never needs more in one go. */
const PAGE_SIZE = 24;
/** Giphy is not in the critical path of anything — if it's slow, the tab shows an error and the
 *  rest of chat is unaffected. Short enough that a hung provider can't tie up a request handler. */
const REQUEST_TIMEOUT_MS = 6000;
/** 'g' — this drops into a general chat app with no age gating of its own. */
const CONTENT_RATING = 'g';

/** Shape of the subset of Giphy's response this reads. Everything is optional because it is
 *  somebody else's API: a missing rendition must degrade to "skip this GIF", never throw. */
interface GiphyApiResponse {
    data?: {
        id?: string;
        title?: string;
        images?: {
            fixed_width?: { url?: string; width?: string; height?: string };
            fixed_width_small?: { url?: string };
            original?: { url?: string; width?: string; height?: string };
        };
    }[];
}

/**
 * Server-side proxy for Giphy search/trending.
 *
 * The API key lives here rather than in the Angular app on purpose: anything shipped to the browser
 * is readable by anyone who opens devtools, and this key is billable-by-quota against our account.
 * Proxying also means it can be rotated without a frontend deploy, and that Giphy never sees our
 * users' IPs.
 *
 * The response is narrowed to IGifSummary rather than forwarded verbatim — Giphy returns ~40
 * renditions per GIF and a great deal of metadata the picker has no use for, and forwarding an
 * upstream shape wholesale would let it change under us.
 *
 * Not configured is a normal state, not an error: GIPHY_API_KEY is genuinely optional (local dev
 * without one still runs), so isConfigured() lets the controller answer honestly and the picker say
 * so, rather than every search failing with a 500.
 */
@Injectable()
export class GiphyService {
    private readonly logger = new Logger(GiphyService.name);
    private readonly apiKey = process.env.GIPHY_API_KEY || undefined;

    isConfigured(): boolean {
        return Boolean(this.apiKey);
    }

    search(query: string, offset: number): Promise<IGifSummary[]> {
        const trimmed = query.trim();
        // An empty query is what the tab opens with, and Giphy's /search rejects it — trending is
        // the sensible answer to "show me GIFs" with nothing typed.
        if (!trimmed) {
            return this.trending(offset);
        }
        return this.fetchGifs(`${GIPHY_API_BASE}/search`, { q: trimmed, offset });
    }

    trending(offset: number): Promise<IGifSummary[]> {
        return this.fetchGifs(`${GIPHY_API_BASE}/trending`, { offset });
    }

    private async fetchGifs(endpoint: string, params: { q?: string; offset: number }): Promise<IGifSummary[]> {
        if (!this.apiKey) {
            return [];
        }
        const url = new URL(endpoint);
        url.searchParams.set('api_key', this.apiKey);
        url.searchParams.set('limit', String(PAGE_SIZE));
        url.searchParams.set('offset', String(Math.max(0, Math.trunc(params.offset))));
        url.searchParams.set('rating', CONTENT_RATING);
        if (params.q) {
            url.searchParams.set('q', params.q);
        }

        try {
            const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
            if (!response.ok) {
                // Deliberately does not include the URL in the log — it carries the API key.
                this.logger.warn(`Giphy request failed with ${response.status}`);
                return [];
            }
            const body = (await response.json()) as GiphyApiResponse;
            return (body.data ?? []).map((gif) => toSummary(gif)).filter((gif): gif is IGifSummary => gif !== null);
        } catch (error) {
            this.logger.warn(`Giphy request errored: ${error instanceof Error ? error.message : 'unknown'}`);
            return [];
        }
    }
}

/** Narrows one Giphy record to what the picker needs, or null if it lacks a usable rendition.
 *
 *  `fixed_width` (a ~200px-wide GIF) is what gets SENT, not `original`: original renditions are
 *  routinely several megabytes, and a chat thumbnail is displayed at a couple of hundred pixels
 *  regardless — sending the full-size file would cost every recipient the download for no visible
 *  difference. */
function toSummary(gif: NonNullable<GiphyApiResponse['data']>[number]): IGifSummary | null {
    const rendition = gif.images?.fixed_width;
    if (!gif.id || !rendition?.url) {
        return null;
    }
    return {
        id: gif.id,
        title: gif.title?.trim() || 'GIF',
        url: rendition.url,
        // The small rendition is the grid preview, so scrolling the picker doesn't pull down the
        // full-size version of every result. Falls back to the same URL when absent.
        previewUrl: gif.images?.fixed_width_small?.url ?? rendition.url,
        width: parsePositiveInt(rendition.width),
        height: parsePositiveInt(rendition.height),
    };
}

function parsePositiveInt(value: string | undefined): number | null {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : null;
}
