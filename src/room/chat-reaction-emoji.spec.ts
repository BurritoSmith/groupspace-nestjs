import { sanitizeReactionEmoji } from './chat-reaction-emoji';

// Built from code points rather than pasted, so the cases stay legible and a stray editor
// normalization can't silently change what's under test.
const ZWJ = '\u{200D}';
const VS16 = '\u{FE0F}';
const THUMBS_UP = '\u{1F44D}';
const RED_HEART = '❤';
const MAN = '\u{1F468}';
const WOMAN = '\u{1F469}';
const GIRL = '\u{1F467}';
const BOY = '\u{1F466}';
const REGIONAL_U = '\u{1F1FA}';
const REGIONAL_S = '\u{1F1F8}';

describe('sanitizeReactionEmoji', () => {
    describe('accepts', () => {
        it('a plain single-code-point emoji', () => {
            expect(sanitizeReactionEmoji(THUMBS_UP)).toBe(THUMBS_UP);
        });

        it('an emoji carrying a variation selector', () => {
            // The heart as it actually arrives from a picker: U+2764 is a dingbat that only renders
            // as an emoji with VS16 appended, so rejecting VS16 would reject one of the six defaults.
            expect(sanitizeReactionEmoji(RED_HEART + VS16)).toBe(RED_HEART + VS16);
        });

        it('a multi-person ZWJ sequence', () => {
            const family = MAN + ZWJ + WOMAN + ZWJ + GIRL + ZWJ + BOY;
            expect(family.length).toBeLessThanOrEqual(16); // guards the length cap against this real case
            expect(sanitizeReactionEmoji(family)).toBe(family);
        });

        it('a regional-indicator flag pair', () => {
            expect(sanitizeReactionEmoji(REGIONAL_U + REGIONAL_S)).toBe(REGIONAL_U + REGIONAL_S);
        });

        it('an emoji carrying a skin-tone modifier', () => {
            const waveDark = '\u{1F44B}\u{1F3FF}';
            expect(sanitizeReactionEmoji(waveDark)).toBe(waveDark);
        });

        it('a keycap sequence', () => {
            // Nothing pictographic in it at all — a plain ASCII digit, VS16, and the combining
            // enclosing keycap. The picker offers these, so rejecting them would be a live bug.
            const keycapOne = '1' + VS16 + '\u{20E3}';
            expect(sanitizeReactionEmoji(keycapOne)).toBe(keycapOne);
        });
    });

    describe('rejects', () => {
        // These four are the whole point of the function: a validator that degraded to
        // `typeof raw === 'string' && raw.length <= 16` would pass every accept-case above, so
        // without these the suite would be vacuous.
        it('ordinary text', () => {
            expect(sanitizeReactionEmoji('hello')).toBeNull();
        });

        it('bare digits, which are Emoji_Component but not pictographic', () => {
            expect(sanitizeReactionEmoji('123')).toBeNull();
        });

        it('markup', () => {
            // Deliberately short enough to fit under the length cap, so this exercises the
            // character rule rather than passing for the wrong reason.
            expect(sanitizeReactionEmoji('<b>x</b>')).toBeNull();
            expect(sanitizeReactionEmoji('<img src=x onerror=alert(1)>')).toBeNull();
        });

        it('an emoji with anything else attached to it', () => {
            expect(sanitizeReactionEmoji(THUMBS_UP + ' ')).toBeNull();
            expect(sanitizeReactionEmoji(THUMBS_UP + 'ok')).toBeNull();
        });

        it('an empty string', () => {
            expect(sanitizeReactionEmoji('')).toBeNull();
        });

        it('a string of emoji longer than one reaction', () => {
            expect(sanitizeReactionEmoji(THUMBS_UP.repeat(20))).toBeNull();
        });

        it('a non-string', () => {
            expect(sanitizeReactionEmoji(undefined)).toBeNull();
            expect(sanitizeReactionEmoji(null)).toBeNull();
            expect(sanitizeReactionEmoji(42)).toBeNull();
            expect(sanitizeReactionEmoji({ emoji: THUMBS_UP })).toBeNull();
        });
    });
});
