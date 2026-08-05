/** Always allows local dev; FRONTEND_ORIGIN (comma-separated) adds the real deployed origin(s). */
export function getAllowedOrigins(): string[] {
    const configured = (process.env.FRONTEND_ORIGIN ?? '')
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean);
    return [
        'http://localhost:4200',
        'https://localhost:4200',
        // Lets the dev server be reached from a phone on the same LAN (see the frontend's
        // `npm run start:lan`) without opening this up generally — a fixed dev-machine IP, not a
        // wildcard. The sslip.io form (public wildcard DNS resolving straight back to the same
        // IP) is what Google Identity Services actually needs as an authorized origin — it
        // rejects raw IPs outright, and requires https for anything other than localhost. BOTH
        // forms are listed for https because a phone that never typed the sslip.io hostname (it
        // just followed a bookmark/history entry to the raw IP) sends `https://192.168.1.222:4200`
        // as its Origin — without this, every REST call (Push, chat media, settings) from that tab
        // silently fails CORS even though sign-in and the socket connection both still work.
        'http://192.168.1.222:4200',
        'https://192.168.1.222:4200',
        'https://192-168-1-222.sslip.io:4200',
        // The packaged Electron desktop app. It serves the Angular build from a loopback HTTP
        // server rather than file://, precisely so it has a real origin — file:// reports `null`,
        // which Google Identity Services rejects outright. That makes the desktop app a distinct
        // origin from the deployed site even though it runs the same bundle, so it needs its own
        // entry here. The port is fixed (not chosen at runtime) because it is part of the origin
        // registered with Google; see electron/static-server.ts.
        'http://localhost:41730',
        ...configured,
    ];
}
