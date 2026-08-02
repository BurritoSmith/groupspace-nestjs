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
