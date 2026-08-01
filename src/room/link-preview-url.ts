import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * Guards the one place this server fetches a URL a *user* chose: link-preview scraping.
 *
 * The mirror image of chat-attachment-url.ts. That one allowlists our own storage and rejects
 * everything else; this one has to permit the entire public internet while keeping the server from
 * being turned into a proxy into its own network — the classic SSRF shape.
 *
 * On GCP specifically the prize is the metadata server at 169.254.169.254, which hands out
 * service-account access tokens to anything that can reach it. A link preview is an unauthenticated
 * "make the server fetch this URL for me" primitive, so that address (and the rest of the private
 * space) has to be unreachable through it by construction.
 */

/** Deliberately small. A preview is a nicety; a slow or enormous page isn't worth waiting on, and
 *  every one of these limits is also a denial-of-service bound. */
export const LINK_PREVIEW_TIMEOUT_MS = 5_000;
export const LINK_PREVIEW_MAX_BYTES = 64 * 1024; // enough for <head>; we never need the body
export const LINK_PREVIEW_MAX_REDIRECTS = 3;
/** Preview images are re-hosted, so this bounds what we're willing to pull down and store. */
export const LINK_PREVIEW_MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * True for an address that must never be reachable through a user-supplied URL.
 *
 * Checked against a RESOLVED address, never a hostname — see resolveToPublicAddress. Covers the
 * IPv4-mapped IPv6 forms too (`::ffff:169.254.169.254` is the same host as `169.254.169.254`, and
 * a check that only understood dotted-quad notation would wave it straight through).
 */
export function isBlockedAddress(address: string): boolean {
    const version = isIP(address);
    if (version === 0) {
        return true; // not an address at all — nothing here should ever see a hostname
    }

    if (version === 6) {
        const lower = address.toLowerCase();
        // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d) — unwrap and judge as IPv4,
        // or every v4 rule below could be bypassed by writing the address the other way round.
        const mapped = /^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
        if (mapped) {
            return isBlockedAddress(mapped[1]);
        }
        if (lower === '::' || lower === '::1') {
            return true; // unspecified, loopback
        }
        // fc00::/7 unique-local, fe80::/10 link-local. The metadata server has an IPv6 form too.
        return /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower);
    }

    const octets = address.split('.').map(Number);
    if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
        return true;
    }
    const [a, b] = octets;
    return (
        a === 0 || // 0.0.0.0/8 "this network"
        a === 10 || // private
        a === 127 || // loopback
        (a === 169 && b === 254) || // link-local — THE GCP METADATA SERVER (169.254.169.254)
        (a === 172 && b >= 16 && b <= 31) || // private
        (a === 192 && b === 168) || // private
        (a === 100 && b >= 64 && b <= 127) || // 100.64/10 carrier-grade NAT
        (a === 192 && b === 0) || // 192.0.0/24 IETF protocol assignments, 192.0.2/24 TEST-NET-1
        a >= 224 // multicast (224/4) and reserved (240/4), including 255.255.255.255
    );
}

export interface SafeUrl {
    /** The URL to request. */
    url: URL;
    /** The address it resolved to, already checked. Passed to the fetch as the connection target
     *  would be in a stricter implementation — see resolveToPublicAddress's note on rebinding. */
    address: string;
}

/**
 * Parses a candidate URL and resolves it to a public address, or returns null if anything about it
 * is unacceptable.
 *
 * Resolution is the point. Blocking the literal string "169.254.169.254" is trivially defeated by
 * pointing a hostname you control at it, which is why the check has to run against what DNS
 * actually returns rather than against what the user typed.
 *
 * A residual gap worth naming: between this lookup and the socket that fetch() opens, DNS could
 * change its answer (a "DNS rebinding" attack). Closing that completely means pinning the
 * connection to the address checked here, which Node's fetch has no clean hook for. The exposure is
 * small — an attacker gets one unauthenticated GET whose response we only parse for meta tags and
 * never return verbatim — but it is a real limit of this approach rather than something handled.
 */
export async function resolveToPublicAddress(candidate: string): Promise<SafeUrl | null> {
    let url: URL;
    try {
        url = new URL(candidate);
    } catch {
        return null;
    }
    // Anything else (file:, data:, gopher:, ftp:) has no business here — some of them can read the
    // server's own disk.
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return null;
    }
    // Credentials in the URL are a phishing/confusion vector and never needed for a preview.
    if (url.username || url.password) {
        return null;
    }

    // A literal address skips DNS but must still be judged — this is the direct-hit case.
    const literal = url.hostname.replace(/^\[|\]$/g, ''); // URL keeps IPv6 hosts in brackets
    if (isIP(literal) !== 0) {
        return isBlockedAddress(literal) ? null : { url, address: literal };
    }

    try {
        const { address } = await lookup(literal);
        return isBlockedAddress(address) ? null : { url, address };
    } catch {
        return null; // unresolvable — nothing to preview
    }
}

/**
 * Follows a URL through its redirects, re-checking every hop, and returns the final response.
 *
 * The per-hop re-check is the part that is easy to leave out and fatal to omit: validating only the
 * URL the user typed is defeated by any public host that answers with
 * `302 Location: http://169.254.169.254/...`. `redirect: 'manual'` is what makes each hop visible;
 * fetch's default would follow them internally with no opportunity to inspect anything.
 *
 * Returns null if any hop fails validation, the redirect budget is exhausted, or the request errors.
 */
export async function fetchWithRedirectGuard(candidate: string, accept: string): Promise<{ response: Response; url: URL } | null> {
    let next: string | null = candidate;

    for (let hop = 0; hop <= LINK_PREVIEW_MAX_REDIRECTS; hop += 1) {
        const safe: SafeUrl | null = await resolveToPublicAddress(next);
        if (!safe) {
            return null;
        }

        let response: Response;
        try {
            response = await fetch(safe.url, {
                redirect: 'manual',
                signal: AbortSignal.timeout(LINK_PREVIEW_TIMEOUT_MS),
                headers: { Accept: accept, 'User-Agent': 'ConvergeLinkPreview/1.0' },
            });
        } catch {
            return null; // timeout, DNS failure, TLS failure — all "no preview"
        }

        if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get('location');
            if (!location) {
                return null;
            }
            // Relative Location headers are legal and common — resolve against the hop we're on, so
            // the next iteration validates an absolute URL.
            next = new URL(location, safe.url).toString();
            continue;
        }

        return response.ok ? { response, url: safe.url } : null;
    }

    return null; // too many redirects — likely a loop, and not worth chasing further
}

/**
 * Reads at most `maxBytes` from a response body, then abandons the rest.
 *
 * A Content-Length header is a claim, not a fact: a hostile (or merely broken) server can omit it
 * and stream forever. Counting what actually arrives is the only bound that holds.
 */
export async function readCapped(response: Response, maxBytes: number): Promise<Buffer> {
    const reader = response.body?.getReader();
    if (!reader) {
        return Buffer.alloc(0);
    }
    const chunks: Buffer[] = [];
    let total = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            chunks.push(Buffer.from(value));
            total += value.byteLength;
            if (total >= maxBytes) {
                break;
            }
        }
    } finally {
        await reader.cancel().catch(() => undefined);
    }
    return Buffer.concat(chunks).subarray(0, maxBytes);
}
