import { canonicalRoomName } from './room-name';
import { generateRoomIdentifier, isGeneratedRoomIdentifier } from './room-identifier';

describe('generateRoomIdentifier', () => {
    it('is 16 characters', () => {
        expect(generateRoomIdentifier()).toHaveLength(16);
    });

    it('uses only Crockford base32, lowercased', () => {
        for (let attempt = 0; attempt < 200; attempt++) {
            expect(generateRoomIdentifier()).toMatch(/^[0-9abcdefghjkmnpqrstvwxyz]{16}$/);
        }
    });

    /*
     * The whole reason for the alphabet. Every room name in this app passes through
     * canonicalRoomName, which lowercases — so an identifier that is not already lowercase would
     * come back as a DIFFERENT string, silently pointing at a room that does not exist. Base64url
     * and base58 both fail this; that is why neither was used.
     */
    it('survives canonicalisation unchanged', () => {
        for (let attempt = 0; attempt < 200; attempt++) {
            const identifier = generateRoomIdentifier();
            expect(canonicalRoomName(identifier)).toBe(identifier);
        }
    });

    /* Read aloud over a call is a real delivery path for these, and these are the characters people
     * get wrong when they are. */
    it('never emits the characters Crockford drops for being confusable', () => {
        for (let attempt = 0; attempt < 200; attempt++) {
            expect(generateRoomIdentifier()).not.toMatch(/[ilou]/);
        }
    });

    it('does not repeat itself', () => {
        const seen = new Set<string>();
        for (let attempt = 0; attempt < 1000; attempt++) {
            seen.add(generateRoomIdentifier());
        }
        expect(seen.size).toBe(1000);
    });

    /* Not a uniformity proof — just enough to catch a generator stuck on a subset of the alphabet,
     * which is what a masking or indexing mistake actually looks like. */
    it('reaches the whole alphabet', () => {
        const seen = new Set<string>();
        for (let attempt = 0; attempt < 500; attempt++) {
            for (const character of generateRoomIdentifier()) {
                seen.add(character);
            }
        }
        expect(seen.size).toBe(32);
    });
});

describe('isGeneratedRoomIdentifier', () => {
    it('recognises what the generator produces', () => {
        for (let attempt = 0; attempt < 50; attempt++) {
            expect(isGeneratedRoomIdentifier(generateRoomIdentifier())).toBe(true);
        }
    });

    it('rejects an ordinary room name', () => {
        expect(isGeneratedRoomIdentifier('standup')).toBe(false);
        expect(isGeneratedRoomIdentifier('iep-jimmy-smith')).toBe(false);
    });

    it('rejects the right length in the wrong alphabet', () => {
        expect(isGeneratedRoomIdentifier('iiiiiiiiiiiiiiii')).toBe(false);
        expect(isGeneratedRoomIdentifier('ABCDEFGHJKMNPQRS')).toBe(false);
    });

    it('rejects the right alphabet at the wrong length', () => {
        expect(isGeneratedRoomIdentifier('abcdef')).toBe(false);
        expect(isGeneratedRoomIdentifier('abcdefghjkmnpqrst')).toBe(false);
    });
});
