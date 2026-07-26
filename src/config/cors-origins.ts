/** Always allows local dev; FRONTEND_ORIGIN (comma-separated) adds the real deployed origin(s). */
export function getAllowedOrigins(): string[] {
    const configured = (process.env.FRONTEND_ORIGIN ?? '')
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean);
    return ['http://localhost:4200', 'https://localhost:4200', ...configured];
}
