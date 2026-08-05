import { getAllowedOrigins } from './cors-origins';

describe('getAllowedOrigins', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        process.env = { ...originalEnv };
        delete process.env.FRONTEND_ORIGIN;
    });

    afterAll(() => {
        process.env = originalEnv;
    });

    it('allows the local dev server', () => {
        expect(getAllowedOrigins()).toContain('http://localhost:4200');
    });

    // The desktop app serves the same Angular bundle from its own loopback origin, so it is not
    // covered by the deployed site's entry. Without this the packaged app cannot reach the API at
    // all — and the failure surfaces as an opaque socket error, not as a CORS message the user
    // would recognise.
    it('allows the packaged Electron app on its fixed loopback port', () => {
        expect(getAllowedOrigins()).toContain('http://localhost:41730');
    });

    // A phone that reaches the LAN dev server via a bookmark/history entry (rather than typing the
    // sslip.io hostname fresh each time) sends the raw IP as its Origin — both forms have to be
    // allowed or every REST call from that tab (Push, chat media, settings) silently fails CORS
    // even though sign-in and the socket connection both still work.
    it('allows both the raw LAN IP and its sslip.io form over https', () => {
        const origins = getAllowedOrigins();

        expect(origins).toContain('https://192.168.1.222:4200');
        expect(origins).toContain('https://192-168-1-222.sslip.io:4200');
    });

    // The Capacitor WebView serves the bundle from a built-in origin rather than over the network,
    // and it differs per platform: iOS uses the custom `capacitor` scheme, Android is configured
    // with androidScheme 'https' so the WebView counts as a secure context (getUserMedia and the
    // Notification API both refuse to run otherwise). Neither has a port or a host that varies, so
    // these two cover every install on every device.
    it('allows both native app origins', () => {
        const origins = getAllowedOrigins();

        expect(origins).toContain('capacitor://localhost');
        expect(origins).toContain('https://localhost');
    });

    it('appends FRONTEND_ORIGIN entries, trimmed, without dropping the built-ins', () => {
        process.env.FRONTEND_ORIGIN = 'https://one.example , https://two.example';

        const origins = getAllowedOrigins();

        expect(origins).toContain('https://one.example');
        expect(origins).toContain('https://two.example');
        expect(origins).toContain('http://localhost:4200');
    });

    it('ignores an empty or whitespace-only FRONTEND_ORIGIN rather than allowing an empty origin', () => {
        process.env.FRONTEND_ORIGIN = ' , ,';

        expect(getAllowedOrigins()).not.toContain('');
    });
});
