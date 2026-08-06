/**
 * What a person may do, derived once from what they are.
 *
 * Everything downstream guards on a CAPABILITY, never on a role. The difference matters the first
 * time a role is added or split: with capability checks that is one line here, and with role checks
 * it is an archaeology exercise across two codebases looking for `role === 'owner'`.
 *
 * Pure and synchronous on purpose — no Prisma, no request, nothing to await. The caller loads the
 * membership row once and passes the answer in, which is also what makes every rule below testable
 * as a table rather than through a mocked database.
 */

/** Governance: what you may do to the ROOM. Deliberately small and module-agnostic — see
 *  RoomMember.role, which explains why adding a module must never widen this. */
export type RoomRole = 'owner' | 'moderator' | 'member' | 'guest';

/** Whether this identity was verified by Google, or merely admitted with a room passcode. */
export type AuthKind = 'google' | 'guest';

/**
 * Namespaced so a module's capabilities can never collide with the room's or with another
 * module's. `room:` is defined here; everything else is contributed by whichever module owns that
 * prefix.
 */
export type Capability = string;

export const ROOM_CONFIGURE: Capability = 'room:configure';
export const ROOM_INVITE: Capability = 'room:invite';
export const ROOM_REMOVE_MEMBER: Capability = 'room:remove-member';
export const ROOM_ENABLE_MODULE: Capability = 'room:enable-module';

export interface IRoomContext {
    roomRole: RoomRole;
    authKind: AuthKind;
    /** moduleId -> the role this person holds inside that module, e.g. { iep: 'parent' }. Absent
     *  means they take no part in that module's process, which is not the same as being an
     *  observer — an observer is a role someone was deliberately given. */
    moduleRoles: Record<string, string>;
    /**
     * Whether this person is a recorded signer of the session's executed document.
     *
     * Here rather than inside the IEP resolver because it is the one fact a module cannot derive
     * from roles alone, and because it is what keeps the guest rule honest: a passcode guest is
     * refused the executed document precisely because a shared passcode is not an identity — but a
     * guest who actually SIGNED was authenticated by the e-signature provider, and has every right
     * to a copy of what they put their name to. Denying them that would be a worse bug than the
     * leak the rule exists to prevent.
     */
    hasSignedExecutedDocument?: boolean;
}

/** A module's contribution: given the same context, which of ITS capabilities this person holds. */
export type ModuleCapabilityResolver = (context: IRoomContext) => Capability[];

const ROOM_CAPABILITIES_BY_ROLE: Record<RoomRole, Capability[]> = {
    owner: [ROOM_CONFIGURE, ROOM_INVITE, ROOM_REMOVE_MEMBER, ROOM_ENABLE_MODULE],
    moderator: [ROOM_INVITE, ROOM_REMOVE_MEMBER],
    member: [],
    guest: [],
};

/**
 * Every capability this person holds, room's and modules' together.
 *
 * Module resolvers are passed in rather than imported, so this file never learns the name of a
 * module — which is the whole point of the boundary. The IEP module supplies its own from
 * `src/modules/iep/iep-capabilities.ts`.
 */
export function capabilitiesFor(context: IRoomContext, moduleResolvers: ModuleCapabilityResolver[] = []): Set<Capability> {
    const granted = new Set<Capability>();

    // A guest holds no governance capability regardless of the role column. Belt and braces: a
    // guest should never have been given anything above 'guest' in the first place, but "the row
    // said moderator" must not be enough to let someone who typed a shared passcode reconfigure the
    // room or invite others into it.
    if (context.authKind !== 'guest') {
        for (const capability of ROOM_CAPABILITIES_BY_ROLE[context.roomRole] ?? []) {
            granted.add(capability);
        }
    }

    for (const resolve of moduleResolvers) {
        for (const capability of resolve(context)) {
            granted.add(capability);
        }
    }

    return granted;
}

/** The form guards actually use. */
export function can(context: IRoomContext, capability: Capability, moduleResolvers: ModuleCapabilityResolver[] = []): boolean {
    return capabilitiesFor(context, moduleResolvers).has(capability);
}
