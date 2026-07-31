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
        // rejects raw IPs outright, and requires https for anything other than localhost.
        'http://192.168.1.222:4200',
        'https://192-168-1-222.sslip.io:4200',
        ...configured,
    ];
}
