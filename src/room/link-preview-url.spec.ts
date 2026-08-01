import { fetchWithRedirectGuard, isBlockedAddress, readCapped, resolveToPublicAddress } from './link-preview-url';

jest.mock('node:dns/promises', () => ({ lookup: jest.fn() }));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { lookup } = require('node:dns/promises') as { lookup: jest.Mock };

/** Everything a hostname resolves to unless a test says otherwise. */
function resolvesTo(address: string, family = 4): void {
    lookup.mockResolvedValue({ address, family });
}

beforeEach(() => {
    jest.clearAllMocks();
    resolvesTo('93.184.216.34'); // an ordinary public address
});

describe('isBlockedAddress', () => {
    // The one that matters most on GCP: this address hands out service-account access tokens to
    // anything that can reach it, and a link preview is an unauthenticated "fetch this for me".
    it('blocks the cloud metadata server', () => {
        expect(isBlockedAddress('169.254.169.254')).toBe(true);
    });

    it.each([
        ['loopback', '127.0.0.1'],
        ['private 10/8', '10.0.0.5'],
        ['private 172.16/12', '172.20.1.1'],
        ['private 192.168/16', '192.168.1.1'],
        ['this-network 0/8', '0.0.0.0'],
        ['carrier-grade NAT', '100.64.0.1'],
        ['broadcast', '255.255.255.255'],
        ['IPv6 loopback', '::1'],
        ['IPv6 unspecified', '::'],
        ['IPv6 unique-local', 'fd00::1'],
        ['IPv6 link-local', 'fe80::1'],
    ])('blocks %s', (_label, address) => {
        expect(isBlockedAddress(address)).toBe(true);
    });

    // Writing the same host the other way round must not get a different answer — a check that only
    // understood dotted-quad notation would wave this straight through to the metadata server.
    it('blocks IPv4-mapped IPv6 forms of a blocked address', () => {
        expect(isBlockedAddress('::ffff:169.254.169.254')).toBe(true);
        expect(isBlockedAddress('::ffff:127.0.0.1')).toBe(true);
    });

    it('allows ordinary public addresses', () => {
        expect(isBlockedAddress('93.184.216.34')).toBe(false);
        expect(isBlockedAddress('2606:2800:220:1:248:1893:25c8:1946')).toBe(false);
    });
});

describe('resolveToPublicAddress', () => {
    it('rejects a literal blocked address', async () => {
        await expect(resolveToPublicAddress('http://169.254.169.254/computeMetadata/v1/')).resolves.toBeNull();
    });

    // THE test for this whole guard. Blocking the literal string is trivially defeated by pointing a
    // hostname you control at the metadata server, so the check has to run against what DNS
    // actually returns rather than against what the user typed.
    it('rejects a public-looking hostname that RESOLVES to a blocked address', async () => {
        resolvesTo('169.254.169.254');

        await expect(resolveToPublicAddress('https://totally-innocent.example.com/')).resolves.toBeNull();
    });

    it.each(['file:///etc/passwd', 'gopher://example.com/', 'data:text/html,hi', 'ftp://example.com/'])(
        'rejects the non-http scheme %s',
        async (candidate) => {
            await expect(resolveToPublicAddress(candidate)).resolves.toBeNull();
        },
    );

    it('rejects embedded credentials', async () => {
        await expect(resolveToPublicAddress('https://user:pass@example.com/')).resolves.toBeNull();
    });

    it('rejects a hostname that will not resolve', async () => {
        lookup.mockRejectedValue(new Error('ENOTFOUND'));

        await expect(resolveToPublicAddress('https://no-such-host.example/')).resolves.toBeNull();
    });

    it('accepts an ordinary public URL', async () => {
        const safe = await resolveToPublicAddress('https://example.com/article');

        expect(safe?.url.toString()).toBe('https://example.com/article');
        expect(safe?.address).toBe('93.184.216.34');
    });
});

describe('fetchWithRedirectGuard', () => {
    const fetchMock = jest.fn();

    beforeEach(() => {
        global.fetch = fetchMock as unknown as typeof fetch;
        fetchMock.mockReset();
    });

    function redirectTo(location: string): Response {
        return { status: 302, ok: false, headers: new Headers({ location }) } as unknown as Response;
    }
    function page(): Response {
        return { status: 200, ok: true, headers: new Headers({ 'content-type': 'text/html' }) } as unknown as Response;
    }

    it('follows a redirect between two public hosts', async () => {
        fetchMock.mockResolvedValueOnce(redirectTo('https://example.com/final')).mockResolvedValueOnce(page());

        const result = await fetchWithRedirectGuard('https://example.com/start', 'text/html');

        expect(result?.url.toString()).toBe('https://example.com/final');
    });

    // The case a naive implementation passes: validating only the URL the user typed is defeated by
    // any public host that answers with a redirect into the private network.
    it('rejects a redirect from a public host to a blocked one', async () => {
        fetchMock.mockResolvedValueOnce(redirectTo('http://169.254.169.254/computeMetadata/v1/'));

        await expect(fetchWithRedirectGuard('https://example.com/start', 'text/html')).resolves.toBeNull();
    });

    // Same attack, one step further out — a check that only looked at the FIRST hop would let this
    // through even if it re-checked the second.
    it('rejects a blocked host reached on a later hop', async () => {
        fetchMock
            .mockResolvedValueOnce(redirectTo('https://example.com/second'))
            .mockResolvedValueOnce(redirectTo('http://127.0.0.1:8080/admin'));

        await expect(fetchWithRedirectGuard('https://example.com/start', 'text/html')).resolves.toBeNull();
    });

    it('gives up rather than following a redirect loop forever', async () => {
        fetchMock.mockResolvedValue(redirectTo('https://example.com/again'));

        await expect(fetchWithRedirectGuard('https://example.com/start', 'text/html')).resolves.toBeNull();
        // Bounded — the point is that it stops, not the exact number.
        expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(5);
    });

    it('returns null when the request throws (timeout, TLS failure, DNS failure)', async () => {
        fetchMock.mockRejectedValue(new Error('timed out'));

        await expect(fetchWithRedirectGuard('https://example.com/', 'text/html')).resolves.toBeNull();
    });
});

describe('readCapped', () => {
    /** A body that streams far more than the cap, and never a Content-Length — the shape a hostile
     *  or broken server uses to make a "read it all" implementation run out of memory. */
    function endlessBody(chunkSize: number): Response {
        let sent = 0;
        return {
            body: {
                getReader: () => ({
                    read: () => {
                        sent += chunkSize;
                        return Promise.resolve({ done: sent > chunkSize * 100, value: new Uint8Array(chunkSize) });
                    },
                    cancel: () => Promise.resolve(),
                }),
            },
        } as unknown as Response;
    }

    it('stops reading once the cap is reached', async () => {
        const buffer = await readCapped(endlessBody(1024), 4096);

        expect(buffer.length).toBe(4096);
    });

    it('returns what there is when the body ends early', async () => {
        const response = {
            body: {
                getReader: () => {
                    let done = false;
                    return {
                        read: () => {
                            const result = done ? { done: true, value: undefined } : { done: false, value: new Uint8Array(10) };
                            done = true;
                            return Promise.resolve(result);
                        },
                        cancel: () => Promise.resolve(),
                    };
                },
            },
        } as unknown as Response;

        expect((await readCapped(response, 4096)).length).toBe(10);
    });
});
