import {
    AuthKind,
    Capability,
    IRoomContext,
    ROOM_CONFIGURE,
    ROOM_ENABLE_MODULE,
    ROOM_INVITE,
    ROOM_REMOVE_MEMBER,
    RoomRole,
    can,
    capabilitiesFor,
} from './capabilities';

function context(roomRole: RoomRole, authKind: AuthKind = 'google', moduleRoles: Record<string, string> = {}): IRoomContext {
    return { roomRole, authKind, moduleRoles };
}

describe('capabilitiesFor', () => {
    it('gives an owner every governance capability', () => {
        expect([...capabilitiesFor(context('owner'))].sort()).toEqual([ROOM_CONFIGURE, ROOM_ENABLE_MODULE, ROOM_INVITE, ROOM_REMOVE_MEMBER].sort());
    });

    it('gives a moderator the people capabilities but not the room ones', () => {
        const granted = capabilitiesFor(context('moderator'));
        expect(granted.has(ROOM_INVITE)).toBe(true);
        expect(granted.has(ROOM_REMOVE_MEMBER)).toBe(true);
        expect(granted.has(ROOM_CONFIGURE)).toBe(false);
        expect(granted.has(ROOM_ENABLE_MODULE)).toBe(false);
    });

    it.each<RoomRole>(['member', 'guest'])('gives %s no governance capability at all', (role) => {
        expect(capabilitiesFor(context(role)).size).toBe(0);
    });

    // Belt and braces. Nothing should ever write 'moderator' onto a guest, but a shared passcode is
    // not an identity, and one bad row must not be enough to hand out the room.
    it.each<RoomRole>(['owner', 'moderator'])('refuses a guest the %s capabilities even when the row says so', (role) => {
        expect(capabilitiesFor(context(role, 'guest')).size).toBe(0);
    });

    it('does not know about modules until one is passed in', () => {
        const withIepRole = context('member', 'google', { iep: 'administrator' });
        expect(capabilitiesFor(withIepRole).size).toBe(0);
    });

    it('merges module resolvers on top, without letting one shadow another', () => {
        const alpha = (): Capability[] => ['alpha:do', 'shared:do'];
        const beta = (): Capability[] => ['beta:do', 'shared:do'];
        const granted = capabilitiesFor(context('member'), [alpha, beta]);
        expect([...granted].sort()).toEqual(['alpha:do', 'beta:do', 'shared:do']);
    });

    it('passes the whole context through to module resolvers', () => {
        const seen: IRoomContext[] = [];
        const spy = (given: IRoomContext): Capability[] => {
            seen.push(given);
            return [];
        };
        const given = context('owner', 'guest', { iep: 'parent' });
        capabilitiesFor(given, [spy]);
        expect(seen).toEqual([given]);
    });

    // A role string that no longer exists (or never did) grants nothing rather than throwing —
    // this runs inside request guards, and a stale row should mean "denied", not a 500.
    it('grants nothing for an unrecognised room role', () => {
        expect(capabilitiesFor(context('archivist' as RoomRole)).size).toBe(0);
    });
});

describe('can', () => {
    it('answers true only for a capability actually held', () => {
        expect(can(context('owner'), ROOM_CONFIGURE)).toBe(true);
        expect(can(context('moderator'), ROOM_CONFIGURE)).toBe(false);
    });

    it('sees capabilities contributed by a module', () => {
        const resolver = (): Capability[] => ['demo:act'];
        expect(can(context('member'), 'demo:act', [resolver])).toBe(true);
        expect(can(context('member'), 'demo:act')).toBe(false);
    });
});
