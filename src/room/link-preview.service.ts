import { Injectable, Logger } from '@nestjs/common';
import { ChatMediaService } from './chat-media.service';
import { ILinkPreview } from './interfaces/room.interfaces';
import {
    LINK_PREVIEW_MAX_BYTES,
    LINK_PREVIEW_MAX_IMAGE_BYTES,
    fetchWithRedirectGuard,
    readCapped,
} from './link-preview-url';

/** Matches the frontend's own linkify rule (shared/linkify.ts) deliberately: a bare `example.com`
 *  is NOT a link, so the card can never disagree with what the message text made clickable. */
const URL_PATTERN = /\b(?:https?:\/\/|www\.)[^\s<>"']+/i;
/** Trailing punctuation belongs to the sentence, not the URL — "see https://example.com." */
const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"]+$/;

/** Cheap protection against re-scraping the same link every time someone pastes it. Bounded so a
 *  long-lived process can't grow this without limit. */
const CACHE_TTL_MS = 30 * 60 * 1000;
const CACHE_MAX_ENTRIES = 500;

/** Preview text is a display hint from an untrusted page — clamp it rather than storing whatever a
 *  hostile <title> contains. */
const MAX_TITLE_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 400;
const MAX_SITE_NAME_LENGTH = 100;

/** The first URL in a message, normalized to something fetchable, or null when there isn't one.
 *  `www.` forms get an explicit https:// so `new URL()` can parse them at all. */
export function extractFirstUrl(text: string): string | null {
    const match = URL_PATTERN.exec(text);
    if (!match) {
        return null;
    }
    const trimmed = match[0].replace(TRAILING_PUNCTUATION, '');
    if (!trimmed) {
        return null;
    }
    return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/** Undoes the handful of entities that actually show up in title/description attributes. Not a
 *  general HTML-entity decoder — these values are rendered as TEXT by Angular, never as markup, so
 *  the only goal is readability rather than correctness against every entity in the spec. */
function decodeEntities(value: string): string {
    return value
        .replace(/&quot;/gi, '"')
        .replace(/&#0?39;/g, "'")
        .replace(/&apos;/gi, "'")
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&'); // last, or &amp;lt; would decode twice
}

function clean(value: string | null, maxLength: number): string | null {
    if (value === null) {
        return null;
    }
    const collapsed = decodeEntities(value).replace(/\s+/g, ' ').trim();
    return collapsed ? collapsed.slice(0, maxLength) : null;
}

/**
 * Pulls one `<meta>` value out of an HTML document by its property/name attribute.
 *
 * Hand-rolled rather than parsed, because this needs four specific tags out of a document's head
 * and the codebase has no HTML parser (nor much appetite for a dependency). The tradeoff is real:
 * this understands well-formed `<meta>` tags with quoted attributes, which is what every site that
 * bothers with Open Graph at all emits, and gives up rather than guessing on anything stranger.
 * Attribute order is handled both ways round, since `content` before `property` is common.
 */
function readMetaContent(html: string, key: string): string | null {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const patterns = [
        new RegExp(`<meta[^>]+(?:property|name)\\s*=\\s*["']${escaped}["'][^>]*?content\\s*=\\s*["']([^"']*)["']`, 'i'),
        new RegExp(`<meta[^>]+content\\s*=\\s*["']([^"']*)["'][^>]*?(?:property|name)\\s*=\\s*["']${escaped}["']`, 'i'),
    ];
    for (const pattern of patterns) {
        const match = pattern.exec(html);
        if (match) {
            return match[1];
        }
    }
    return null;
}

function readTitleTag(html: string): string | null {
    return /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? null;
}

@Injectable()
export class LinkPreviewService {
    private readonly logger = new Logger(LinkPreviewService.name);
    private readonly cache = new Map<string, { preview: ILinkPreview | null; expiresAt: number }>();

    constructor(private readonly chatMediaService: ChatMediaService) {}

    /**
     * Scrapes a URL into a preview card, or returns null when there's nothing worth showing.
     *
     * Never throws: this runs detached from the send path (see room.gateway.ts), so a failure has to
     * mean "no card" and nothing else — the message itself has already been delivered.
     */
    async fetchPreview(rawUrl: string, roomName: string): Promise<ILinkPreview | null> {
        const cached = this.cache.get(rawUrl);
        if (cached && cached.expiresAt > Date.now()) {
            return cached.preview;
        }

        let preview: ILinkPreview | null = null;
        try {
            preview = await this.scrape(rawUrl, roomName);
        } catch (error) {
            // Debug, not error: an unreachable or hostile link is an ordinary outcome here, not a
            // fault in this server, and logging it loudly would be noise on every dead link pasted.
            this.logger.debug(`Link preview failed for ${rawUrl}: ${error}`);
        }

        this.remember(rawUrl, preview);
        return preview;
    }

    private remember(url: string, preview: ILinkPreview | null): void {
        if (this.cache.size >= CACHE_MAX_ENTRIES) {
            // Oldest insertion first — Map preserves insertion order, so this is a plain FIFO
            // eviction. Good enough for a cache whose entries all expire on a timer anyway.
            const oldest = this.cache.keys().next();
            if (!oldest.done) {
                this.cache.delete(oldest.value);
            }
        }
        this.cache.set(url, { preview, expiresAt: Date.now() + CACHE_TTL_MS });
    }

    private async scrape(rawUrl: string, roomName: string): Promise<ILinkPreview | null> {
        const fetched = await fetchWithRedirectGuard(rawUrl, 'text/html,application/xhtml+xml');
        if (!fetched) {
            return null;
        }
        const { response, url } = fetched;

        // Only parse things claiming to be HTML. A link straight to a PDF or a zip has no metadata
        // to read, and pulling bytes we'll never use is wasted transfer.
        const contentType = response.headers.get('content-type') ?? '';
        if (!/^(?:text\/html|application\/xhtml\+xml)/i.test(contentType)) {
            return null;
        }

        const html = (await readCapped(response, LINK_PREVIEW_MAX_BYTES)).toString('utf8');

        const title = clean(readMetaContent(html, 'og:title') ?? readTitleTag(html), MAX_TITLE_LENGTH);
        const description = clean(
            readMetaContent(html, 'og:description') ?? readMetaContent(html, 'description'),
            MAX_DESCRIPTION_LENGTH,
        );
        const siteName = clean(readMetaContent(html, 'og:site_name'), MAX_SITE_NAME_LENGTH) ?? url.hostname;

        // Nothing to show. Returning a card of empty strings would be worse than no card — it reads
        // as a broken preview rather than as a plain link.
        if (!title && !description) {
            return null;
        }

        const rawImage = readMetaContent(html, 'og:image') ?? readMetaContent(html, 'twitter:image');
        const imageUrl = rawImage ? await this.rehostImage(rawImage, url, roomName) : null;

        return {
            // The FINAL url, after redirects — what the user actually lands on, which is what the
            // card should point at. See ILinkPreview's own comment.
            url: url.toString(),
            title,
            description,
            imageUrl,
            siteName,
        };
    }

    /**
     * Copies a preview image into our own chat-media storage and returns OUR url for it.
     *
     * Three reasons this isn't just a hotlink: every viewer would otherwise reveal their IP to
     * whatever host the sender linked; sites that block hotlinking would show a broken card; and the
     * bytes behind a third-party URL can change after the preview was generated. Re-hosting also
     * means the frontend renders it exactly like any other attachment.
     *
     * Reuses ChatMediaService.uploadAttachment, so the same magic-byte sniff that guards real
     * uploads applies here — a "png" that isn't a png is rejected rather than stored.
     */
    private async rehostImage(rawImage: string, pageUrl: URL, roomName: string): Promise<string | null> {
        let absolute: string;
        try {
            absolute = new URL(rawImage, pageUrl).toString(); // og:image is often relative
        } catch {
            return null;
        }

        const fetched = await fetchWithRedirectGuard(absolute, 'image/*');
        if (!fetched) {
            return null;
        }
        const contentType = fetched.response.headers.get('content-type')?.split(';')[0]?.trim() ?? '';
        if (!contentType.startsWith('image/')) {
            return null;
        }

        const buffer = await readCapped(fetched.response, LINK_PREVIEW_MAX_IMAGE_BYTES);
        if (buffer.length === 0) {
            return null;
        }

        try {
            const uploaded = await this.chatMediaService.uploadAttachment(buffer, roomName, contentType);
            return uploaded.url;
        } catch {
            // uploadAttachment throws for a sniff mismatch or an oversized file. Either way the
            // card is still useful without a picture.
            return null;
        }
    }
}
