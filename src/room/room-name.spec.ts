import { MAX_ROOM_NAME_LENGTH, canonicalRoomName, isCanonicalRoomName, isCreatableRoomName } from './room-name';

/** Built rather than typed as literals: a control character written straight into a source file
 *  arrives as the raw byte, which turns the file binary and makes the test unreadable in a diff. */
const NUL = String.fromCharCode(0);
const TAB = String.fromCharCode(9);
const NEWLINE = String.fromCharCode(10);
const DEL = String.fromCharCode(127);

describe('canonicalRoomName', () => {
    it('lowercases, so "Lobby" and "lobby" are the same room', () => {
        expect(canonicalRoomName('Lobby')).toBe('lobby');
    });

    it('trims, so a stray space from a paste does not fork a room', () => {
        expect(canonicalRoomName('  study hall  ')).toBe('study hall');
    });

    it.each([[''], ['   '], [undefined], [null]])('returns empty for %p rather than throwing', (value) => {
        expect(canonicalRoomName(value)).toBe('');
    });

    // The gateway threw a WsException for empty input; that stays the gateway's job. A shared helper
    // used by both a socket handler and a REST controller cannot pick one transport's error type.
    it('never throws, so both transports can decide what empty means', () => {
        expect(() => canonicalRoomName(undefined)).not.toThrow();
    });

    it('is idempotent — canonicalising twice changes nothing', () => {
        const once = canonicalRoomName('  MiXeD Case  ');
        expect(canonicalRoomName(once)).toBe(once);
    });
});

describe('isCanonicalRoomName', () => {
    it('accepts a name that is already canonical', () => {
        expect(isCanonicalRoomName('lobby')).toBe(true);
    });

    // This is the exact shape of the `Billie` row already in the database: stored uncanonical, so
    // what the gateway lowercases can never match it, and the room is unreachable.
    it('rejects a name that would not survive a round trip', () => {
        expect(isCanonicalRoomName('Billie')).toBe(false);
    });

    it('rejects empty', () => {
        expect(isCanonicalRoomName('')).toBe(false);
    });
});

describe('isCreatableRoomName', () => {
    it('accepts an ordinary name', () => {
        expect(isCreatableRoomName('study hall')).toBe(true);
    });

    it('accepts a name needing canonicalisation, since creation canonicalises it', () => {
        expect(isCreatableRoomName('Study Hall')).toBe(true);
    });

    // Room names are typed by people in nine languages. An allow-list of ASCII letters would refuse
    // most of them, which is why the rule excludes control characters instead.
    it.each([['salle détude'], ['Übungsraum'], ['サポート'], ['sala-de-reunião']])('accepts %s', (name) => {
        expect(isCreatableRoomName(name)).toBe(true);
    });

    it('accepts a name exactly at the length limit and rejects one past it', () => {
        expect(isCreatableRoomName('a'.repeat(MAX_ROOM_NAME_LENGTH))).toBe(true);
        expect(isCreatableRoomName('a'.repeat(MAX_ROOM_NAME_LENGTH + 1))).toBe(false);
    });

    it.each([[''], ['   '], [undefined], [null]])('rejects %p', (value) => {
        expect(isCreatableRoomName(value)).toBe(false);
    });

    it.each([
        ['a NUL', `lob${NUL}by`],
        ['a newline', `lob${NEWLINE}by`],
        ['a tab', `lob${TAB}by`],
        ['a DEL', `lob${DEL}by`],
    ])('rejects %s inside the name', (_label, name) => {
        expect(isCreatableRoomName(name)).toBe(false);
    });

    // The length check runs against the canonical form, so trailing whitespace cannot smuggle a
    // name past the limit and then shrink below it.
    it('measures the canonical form, not the raw input', () => {
        expect(isCreatableRoomName(`  ${'a'.repeat(MAX_ROOM_NAME_LENGTH)}  `)).toBe(true);
    });
});
