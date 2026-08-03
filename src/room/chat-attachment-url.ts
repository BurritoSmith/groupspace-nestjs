import { randomUUID } from 'node:crypto';
import { IChatAttachment } from './interfaces/room.interfaces';

// A gif attachment is either one of our own uploaded files (a user dragged/pasted an actual .gif
// file — same path as any other image) or a hotlink straight to Giphy's media CDN (the GIF picker
// never re-uploads the file it lets someone pick). Both are 'gif' kind; only the second needs this
// second allowlist entry.
const GIPHY_HOST_PATTERN = /^(media\d*\.giphy\.com|i\.giphy\.com)$/;

const MAX_DIMENSION_PX = 8000;
const MAX_DURATION_MS = 4 * 60 * 60 * 1000; // generous — real duration limits are an upload-time concern, not this
const MAX_SIZE_BYTES = 500 * 1024 * 1024; // same — this is just clamping a display hint, not an enforcement point
const MAX_NAME_LENGTH = 255;
const MAX_ALBUM_ID_LENGTH = 64; // a uuid is 36; the slack is for a client that formats it differently

/** True if `url` points at our own chat-media storage (GCS public base, or the local-dev
 *  `/chat-media/...` static mount) — or, when `allowGiphyCdn`, at Giphy's media CDN. Used both for
 *  the primary attachment URL and (with kind-appropriate allowGiphyCdn) its thumbnailUrl. */
function isAllowedMediaUrl(url: string, allowGiphyCdn: boolean, chatMediaPublicBase: string): boolean {
    if (!url) {
        return false;
    }
    // Covers both forms of "our own storage" without branching: the GCS public base is an absolute
    // https origin, and the local-dev fallback is the root-relative `/chat-media/` path
    // ChatMediaService hands back when no bucket is configured (see main.ts's matching static
    // mount). A prefix test is correct for each — an absolute URL can't start with `/chat-media/`,
    // and a root-relative one can't start with `https://…`.
    if (url.startsWith(chatMediaPublicBase)) {
        return true;
    }
    // Deliberately NOT inside an else-branch on the base's shape. This used to return early for the
    // local-dev base, which made the Giphy allowlist below unreachable in local dev: every
    // hotlinked GIF was dropped, and a GIF-only message was then discarded entirely by the gateway
    // (no text, no surviving attachments) with nothing shown to the sender. Whether a Giphy hotlink
    // is acceptable has nothing to do with where OUR uploads happen to live.
    if (!allowGiphyCdn) {
        return false;
    }
    try {
        const parsed = new URL(url);
        return parsed.protocol === 'https:' && GIPHY_HOST_PATTERN.test(parsed.hostname);
    } catch {
        return false;
    }
}

export function isAllowedAttachmentUrl(url: string, kind: IChatAttachment['kind'], chatMediaPublicBase: string): boolean {
    return isAllowedMediaUrl(url, kind === 'gif', chatMediaPublicBase);
}

function clampPositiveInt(value: unknown, max: number): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        return null;
    }
    return Math.min(Math.round(value), max);
}

/** Validates and normalizes one client-supplied attachment before it's ever persisted or
 *  broadcast to other peers — returns null (drop it) if the attachment's own URL doesn't resolve
 *  to somewhere we trust. Every other field is either passed through narrowly-typed or clamped —
 *  none of it is trusted as anything more than a display hint (see IChatAttachment's own comment). */
export function sanitizeAttachment(attachment: unknown, chatMediaPublicBase: string): IChatAttachment | null {
    if (!attachment || typeof attachment !== 'object') {
        return null;
    }
    const candidate = attachment as Partial<IChatAttachment>;
    if (candidate.kind !== 'image' && candidate.kind !== 'video' && candidate.kind !== 'gif') {
        return null;
    }
    if (typeof candidate.url !== 'string' || !isAllowedAttachmentUrl(candidate.url, candidate.kind, chatMediaPublicBase)) {
        return null;
    }
    const thumbnailUrl =
        typeof candidate.thumbnailUrl === 'string' && isAllowedMediaUrl(candidate.thumbnailUrl, candidate.kind === 'gif', chatMediaPublicBase)
            ? candidate.thumbnailUrl
            : null;
    // allowGiphyCdn is deliberately FALSE here, unlike thumbnailUrl above. A display rendition is
    // something we generated and uploaded ourselves, so there is no legitimate case for one pointing
    // at a third-party CDN — including for a gif, which never has one at all.
    const displayUrl =
        typeof candidate.displayUrl === 'string' && isAllowedMediaUrl(candidate.displayUrl, false, chatMediaPublicBase) ? candidate.displayUrl : null;

    return {
        id: typeof candidate.id === 'string' && candidate.id ? candidate.id : randomUUID(),
        kind: candidate.kind,
        url: candidate.url,
        // Nothing of ours to point at for a Giphy hotlink, regardless of what the client sent.
        storagePath: candidate.kind !== 'gif' && typeof candidate.storagePath === 'string' ? candidate.storagePath : null,
        thumbnailUrl,
        displayUrl,
        mimeType: typeof candidate.mimeType === 'string' ? candidate.mimeType.slice(0, 100) : '',
        width: clampPositiveInt(candidate.width, MAX_DIMENSION_PX),
        height: clampPositiveInt(candidate.height, MAX_DIMENSION_PX),
        durationMs: clampPositiveInt(candidate.durationMs, MAX_DURATION_MS),
        sizeBytes: clampPositiveInt(candidate.sizeBytes, MAX_SIZE_BYTES),
        name: typeof candidate.name === 'string' ? candidate.name.slice(0, MAX_NAME_LENGTH) : null,
        // Opaque grouping token, bounded like any other client string. This object literal names
        // every field explicitly rather than spreading `candidate`, so anything not listed here is
        // silently dropped on its way to the wire — a new attachment field that isn't added here
        // fails by quietly not existing for other peers, with nothing logged.
        albumId: typeof candidate.albumId === 'string' && candidate.albumId ? candidate.albumId.slice(0, MAX_ALBUM_ID_LENGTH) : null,
        // A URL, so it goes through the SAME allowlist as the attachment's own — a cover is an
        // ordinary upload of ours, and accepting an arbitrary client-supplied URL here would hand
        // anyone a way to point every album in a room at a host they control.
        albumCoverUrl:
            typeof candidate.albumCoverUrl === 'string' && isAllowedMediaUrl(candidate.albumCoverUrl, false, chatMediaPublicBase)
                ? candidate.albumCoverUrl
                : null,
    };
}
