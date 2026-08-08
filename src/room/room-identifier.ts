import { randomBytes } from 'node:crypto';

/**
 * Generated identifiers for rooms whose name must not describe them.
 *
 * A room called `iep-jimmy-smith` puts a child's name into browser history, access logs, referrer
 * headers, and — in an app with screen sharing — into the recording of the meeting itself. So a room
 * created for a module that asks for it gets an identifier with no meaning in it, and its readable
 * title lives separately in `Room.displayName`.
 *
 * **Crockford base32, lowercased.** The alphabet choice is load-bearing twice over:
 *
 * - `canonicalRoomName` lowercases every room name, everywhere, and has since names became
 *   case-insensitive. A case-SENSITIVE alphabet (base64url, base58) would therefore be mangled the
 *   moment it round-tripped through a join: two different identifiers can fold to the same string,
 *   and a link can point at a room that does not exist. Neither failure announces itself.
 * - Crockford omits `i`, `l`, `o` and `u` — the characters people confuse when reading one aloud
 *   over a call, which is exactly how a parent will receive it.
 *
 * 16 characters of a 32-symbol alphabet is 80 bits. These are not secrets — a private room is
 * defended by membership, passcodes and invitations, not by its name being hard to guess — but 80
 * bits means collisions never happen in practice and enumeration is not a way in either.
 */

/** Crockford's alphabet, lowercased. No i, l, o, u. */
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
const LENGTH = 16;

export function generateRoomIdentifier(): string {
    // Rejection sampling, not `% 32`. The bias from modulo on a 256-value byte would be zero here
    // because 256 is a multiple of 32 — but that is a property of these two constants, and a later
    // change to either would introduce a silent bias. Masking the low 5 bits is exact regardless.
    const bytes = randomBytes(LENGTH);
    let identifier = '';
    for (let index = 0; index < LENGTH; index++) {
        identifier += ALPHABET[bytes[index] & 0x1f];
    }
    return identifier;
}

/** Whether a string looks like one of ours. Used to keep generated identifiers out of the
 *  create-room form's own validation path, not as a security check — anyone can type sixteen
 *  characters from this alphabet. */
export function isGeneratedRoomIdentifier(value: string): boolean {
    if (value.length !== LENGTH) {
        return false;
    }
    for (const character of value) {
        if (!ALPHABET.includes(character)) {
            return false;
        }
    }
    return true;
}
