import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

/**
 * Hashing and checking a room passcode.
 *
 * scrypt from node:crypto rather than bcrypt or argon2, because neither is already a dependency and
 * both are native builds — this repo runs on Windows in development and Linux in CI, and a KDF is
 * not worth a compiler in that path. scrypt is memory-hard and in the standard library, which is
 * the trade actually worth making here.
 *
 * A passcode is NOT a password: it is shared among everyone invited to one room, it is typed by
 * people who were handed it verbally, and it protects a room rather than an account. That is why
 * the capability resolver still refuses a passcode guest the most sensitive things even after they
 * are through this door — see `iep:view-executed`. Hashing it properly is about not leaking it if
 * the database ever walks; it is not a claim that the passcode is a strong authenticator.
 */

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number, options: { N: number; r: number; p: number }) => Promise<Buffer>;

/** 2^14 — ~16MB per hash, the usual interactive baseline. Encoded into the stored string so these
 *  can be raised later without invalidating every existing passcode. */
const COST = 16384;
const BLOCK_SIZE = 8;
const PARALLELISM = 1;
const SALT_BYTES = 16;
const KEY_BYTES = 32;

/** Short enough that someone can read it down a phone line to a parent, long enough not to fall to
 *  a handful of guesses — which is the rate limiter's job anyway, not the length's. */
export const MIN_PASSCODE_LENGTH = 6;
export const MAX_PASSCODE_LENGTH = 128;

export function isAcceptablePasscode(passcode: unknown): passcode is string {
    return typeof passcode === 'string' && passcode.length >= MIN_PASSCODE_LENGTH && passcode.length <= MAX_PASSCODE_LENGTH;
}

/** `scrypt$N$r$p$salt$key`, all base64. Self-describing so the parameters can change without a
 *  migration: an old digest still carries the cost it was made with. */
export async function hashPasscode(passcode: string): Promise<string> {
    const salt = randomBytes(SALT_BYTES);
    const key = await scryptAsync(passcode, salt, KEY_BYTES, { N: COST, r: BLOCK_SIZE, p: PARALLELISM });
    return ['scrypt', COST, BLOCK_SIZE, PARALLELISM, salt.toString('base64'), key.toString('base64')].join('$');
}

/**
 * Whether a passcode matches a stored digest.
 *
 * Never throws — a malformed or unrecognised digest is `false`, not a 500. A row that cannot be
 * parsed should keep people out, and a room whose passcode column got corrupted should fail closed
 * and be repairable by its owner rather than take the endpoint down.
 */
export async function verifyPasscode(passcode: string, stored: string | null | undefined): Promise<boolean> {
    if (typeof passcode !== 'string' || typeof stored !== 'string') {
        return false;
    }

    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') {
        return false;
    }

    const [, cost, blockSize, parallelism, saltB64, keyB64] = parts;
    const options = { N: Number(cost), r: Number(blockSize), p: Number(parallelism) };
    if (!Number.isInteger(options.N) || !Number.isInteger(options.r) || !Number.isInteger(options.p) || options.N <= 1) {
        return false;
    }

    let expected: Buffer;
    let salt: Buffer;
    try {
        expected = Buffer.from(keyB64, 'base64');
        salt = Buffer.from(saltB64, 'base64');
    } catch {
        return false;
    }
    if (expected.length === 0 || salt.length === 0) {
        return false;
    }

    let actual: Buffer;
    try {
        actual = await scryptAsync(passcode, salt, expected.length, options);
    } catch {
        // scrypt rejects absurd parameters (a cost that would exceed its memory limit, say) rather
        // than grinding — a digest carrying those is unusable, and unusable means denied.
        return false;
    }

    // Lengths are equal by construction above, but timingSafeEqual throws rather than returning
    // false when they are not, and this must not be the thing that 500s an auth endpoint.
    return actual.length === expected.length && timingSafeEqual(actual, expected);
}
