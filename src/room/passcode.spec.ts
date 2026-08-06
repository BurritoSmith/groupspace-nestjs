import { MAX_PASSCODE_LENGTH, MIN_PASSCODE_LENGTH, hashPasscode, isAcceptablePasscode, verifyPasscode } from './passcode';

describe('isAcceptablePasscode', () => {
    it('accepts one at the minimum length', () => {
        expect(isAcceptablePasscode('a'.repeat(MIN_PASSCODE_LENGTH))).toBe(true);
    });

    it('rejects one a character short', () => {
        expect(isAcceptablePasscode('a'.repeat(MIN_PASSCODE_LENGTH - 1))).toBe(false);
    });

    it('rejects one past the maximum, so a huge body cannot make us scrypt it', () => {
        expect(isAcceptablePasscode('a'.repeat(MAX_PASSCODE_LENGTH + 1))).toBe(false);
    });

    it.each([[''], [null], [undefined], [123456], [{}], [['abcdef']]])('rejects %p', (value) => {
        expect(isAcceptablePasscode(value)).toBe(false);
    });
});

describe('hashPasscode', () => {
    it('produces a self-describing digest carrying its own parameters', async () => {
        const digest = await hashPasscode('open sesame');
        const [algorithm, cost, blockSize, parallelism, salt, key] = digest.split('$');
        expect(algorithm).toBe('scrypt');
        expect(Number(cost)).toBeGreaterThan(1);
        expect(Number(blockSize)).toBeGreaterThan(0);
        expect(Number(parallelism)).toBeGreaterThan(0);
        expect(Buffer.from(salt, 'base64').length).toBeGreaterThan(0);
        expect(Buffer.from(key, 'base64').length).toBeGreaterThan(0);
    });

    it('never contains the passcode itself', async () => {
        const digest = await hashPasscode('open sesame');
        expect(digest).not.toContain('open sesame');
    });

    // Distinct salts, so two rooms sharing a passcode do not share a digest — otherwise the column
    // itself would reveal which rooms let the same people in.
    it('produces a different digest every time for the same passcode', async () => {
        const [first, second] = await Promise.all([hashPasscode('open sesame'), hashPasscode('open sesame')]);
        expect(first).not.toBe(second);
    });
});

describe('verifyPasscode', () => {
    it('accepts the passcode it was made from', async () => {
        const digest = await hashPasscode('open sesame');
        await expect(verifyPasscode('open sesame', digest)).resolves.toBe(true);
    });

    it.each([['open Sesame'], ['open sesam'], ['open sesame '], ['']])('rejects %p', async (attempt) => {
        const digest = await hashPasscode('open sesame');
        await expect(verifyPasscode(attempt, digest)).resolves.toBe(false);
    });

    it('still verifies a digest made with different parameters than today’s defaults', async () => {
        const digest = await hashPasscode('open sesame');
        const [, cost, ...rest] = digest.split('$');
        // Sanity: the digest really does carry the cost, so raising it later cannot orphan old rows.
        expect(Number(cost)).toBeGreaterThan(1);
        expect(rest).toHaveLength(4);
        await expect(verifyPasscode('open sesame', digest)).resolves.toBe(true);
    });

    // A corrupted or unrecognised column must keep people out and stay repairable by the owner —
    // never take the endpoint down with it.
    it.each([
        ['null', null],
        ['undefined', undefined],
        ['empty', ''],
        ['not a digest', 'open sesame'],
        ['too few fields', 'scrypt$16384$8$1$c2FsdA=='],
        ['an unknown algorithm', 'bcrypt$16384$8$1$c2FsdA==$a2V5'],
        ['a non-numeric cost', 'scrypt$lots$8$1$c2FsdA==$a2V5'],
        ['a cost of 1', 'scrypt$1$8$1$c2FsdA==$a2V5'],
        ['an empty salt', 'scrypt$16384$8$1$$a2V5'],
        ['an empty key', 'scrypt$16384$8$1$c2FsdA==$'],
    ])('returns false for %s rather than throwing', async (_label, stored) => {
        await expect(verifyPasscode('open sesame', stored as string | null | undefined)).resolves.toBe(false);
    });

    it('returns false when scrypt refuses the stored parameters outright', async () => {
        // A cost this large exceeds scrypt's memory limit and makes it reject rather than grind.
        await expect(verifyPasscode('open sesame', 'scrypt$1073741824$8$1$c2FsdA==$a2V5')).resolves.toBe(false);
    });
});
