import { normalizeNativePushPlatform, normalizePushPlatform, suppressNativeDuplicates } from './push-platform';

describe('normalizePushPlatform', () => {
    it.each(['android', 'ios', 'desktop', 'web'])('accepts %s', (value) => {
        expect(normalizePushPlatform(value)).toBe(value);
    });

    it('trims and lowercases, so a client sending "Android " still matches an FCM token', () => {
        expect(normalizePushPlatform('  Android ')).toBe('android');
    });

    it.each([['windows'], [''], ['   '], [null], [undefined], [42], [{}]])('rejects %p', (value) => {
        expect(normalizePushPlatform(value)).toBeNull();
    });
});

describe('normalizeNativePushPlatform', () => {
    it.each(['android', 'ios'])('accepts %s', (value) => {
        expect(normalizeNativePushPlatform(value)).toBe(value);
    });

    // 'desktop' and 'web' are real platforms for a web-push subscription but meaningless for an FCM
    // token — no native app runs there to have registered one.
    it.each(['desktop', 'web', 'nonsense'])('rejects %s', (value) => {
        expect(normalizeNativePushPlatform(value)).toBeNull();
    });
});

describe('suppressNativeDuplicates', () => {
    const androidSub = { id: 'a', platform: 'android' };
    const desktopSub = { id: 'd', platform: 'desktop' };
    const iosSub = { id: 'i', platform: 'ios' };
    const legacySub = { id: 'l', platform: 'web' };

    it('returns every subscription when the user has no native app at all', () => {
        expect(suppressNativeDuplicates([androidSub, desktopSub], [])).toEqual([androidSub, desktopSub]);
    });

    it('drops only the subscriptions matching a platform the user has a token on', () => {
        expect(suppressNativeDuplicates([androidSub, desktopSub, iosSub], [{ platform: 'android' }])).toEqual([desktopSub, iosSub]);
    });

    it('drops both when the user runs the native app on both platforms', () => {
        expect(suppressNativeDuplicates([androidSub, desktopSub, iosSub], [{ platform: 'android' }, { platform: 'ios' }])).toEqual([desktopSub]);
    });

    // The safe direction: an un-backfilled row keeps working exactly as it did before the column
    // existed, rather than going silently dark.
    it("never drops the unknown 'web' platform", () => {
        expect(suppressNativeDuplicates([legacySub], [{ platform: 'android' }, { platform: 'ios' }])).toEqual([legacySub]);
    });

    it('does not mutate the array it was given', () => {
        const subscriptions = [androidSub, desktopSub];
        suppressNativeDuplicates(subscriptions, [{ platform: 'android' }]);
        expect(subscriptions).toEqual([androidSub, desktopSub]);
    });
});
