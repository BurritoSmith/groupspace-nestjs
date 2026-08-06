/**
 * The one place a room name is turned into its canonical form.
 *
 * Extracted from RoomGateway.normalizeRoomName, which has been the single normalization point for
 * the whole app since room names became case-insensitive — every in-memory Map key, every Socket.IO
 * room string and every Prisma row derives from it. Now that rooms can also be created over REST,
 * there is a second entry point, and two copies of "trim and lowercase" would eventually disagree.
 * They only have to disagree once: a room created as `Study Hall` that nobody can then join is
 * indistinguishable from the room simply not existing.
 *
 * (There is already one row in the wild from before that rule — a `Billie` that the gateway can no
 * longer reach, because what it lowercases never matches. That is the failure this file exists to
 * stop happening a second time.)
 */

/** Long enough for a sentence-ish name, short enough to render in a nav button and an invitation
 *  email without truncation. Nothing enforced this before; it applies only to CREATION, so no
 *  existing room is invalidated by it. */
export const MAX_ROOM_NAME_LENGTH = 64;

const UNIT_SEPARATOR = 0x1f;
const DELETE = 0x7f;

/**
 * C0 controls and DEL, by code point rather than a regex character class.
 *
 * A class written with escapes is the obvious way to say this, but the escapes do not reliably
 * survive being written to disk — they arrive as the literal bytes they denote, which makes the
 * source a binary file, renders the rule invisible in a diff, and looks exactly like an empty
 * character class on screen. Comparing code points says the same thing in characters that cannot
 * be mangled.
 */
function hasControlCharacter(value: string): boolean {
    for (const character of value) {
        const code = character.codePointAt(0) ?? 0;
        if (code <= UNIT_SEPARATOR || code === DELETE) {
            return true;
        }
    }
    return false;
}

/**
 * Trim and lowercase — exactly what the gateway has always done, and deliberately nothing more.
 *
 * Returns '' for anything empty, which callers treat as invalid in whatever way suits their
 * transport (the gateway throws a WsException; the controller returns a 400). Throwing from here
 * would force a socket concern into a function the REST layer also uses.
 */
export function canonicalRoomName(raw: string | undefined | null): string {
    return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

/** Whether a name is already in canonical form — i.e. joining it would land in the room you just
 *  looked at, rather than somewhere else. */
export function isCanonicalRoomName(raw: string): boolean {
    return raw.length > 0 && raw === canonicalRoomName(raw);
}

/**
 * Whether a name may be used to CREATE a room.
 *
 * Stricter than what joining accepts, and only applied at creation, so that every existing room —
 * including any with characters this would now reject — keeps working exactly as it does today.
 * Tightening the join path instead would lock people out of rooms they are already using.
 *
 * Control characters are excluded rather than an allow-list of letters: room names are typed by
 * people, in nine languages, and an allow-list would quietly refuse most of them.
 */
export function isCreatableRoomName(raw: string | undefined | null): boolean {
    const canonical = canonicalRoomName(raw);
    if (!canonical || canonical.length > MAX_ROOM_NAME_LENGTH) {
        return false;
    }
    return !hasControlCharacter(canonical);
}
