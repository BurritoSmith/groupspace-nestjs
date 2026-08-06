import { Capability, IRoomContext, ModuleCapabilityResolver } from '../../room/capabilities';

/**
 * The IEP module's own capabilities, and the roles that hold them.
 *
 * Owned here rather than in `room/capabilities.ts` so that the room never learns what a `parent`
 * is. The room contributes governance; a module contributes the vocabulary of its own process.
 */

export const IEP_MODULE_ID = 'iep';

/** Drives the wizard: advances steps for everyone, and is the only role that can. */
export const IEP_FACILITATE: Capability = 'iep:facilitate';
/** Is a recipient on the envelope, and can complete their own embedded signing session. */
export const IEP_SIGN: Capability = 'iep:sign';
/** Can open the executed document after the fact. */
export const IEP_VIEW_EXECUTED: Capability = 'iep:view-executed';

/**
 * The vocabulary the module owns and validates. Roles are stored as plain strings in
 * RoomMemberModuleRole precisely so this list can grow without a migration; anything not on it is
 * rejected at assignment time rather than silently granting nothing later.
 */
export const IEP_ROLES = ['administrator', 'parent', 'student', 'instructor', 'observer'] as const;
export type IepRole = (typeof IEP_ROLES)[number];

export function isIepRole(value: unknown): value is IepRole {
    return typeof value === 'string' && (IEP_ROLES as readonly string[]).includes(value);
}

/** Everyone with a stake in the document signs it. An observer — a student teacher sitting in, an
 *  advocate attending to listen — deliberately does not: they are in the meeting, not on the plan. */
const SIGNING_ROLES = new Set<string>(['administrator', 'parent', 'student', 'instructor']);

export const iepCapabilities: ModuleCapabilityResolver = (context: IRoomContext): Capability[] => {
    const role = context.moduleRoles[IEP_MODULE_ID];
    if (!role) {
        return [];
    }

    const granted: Capability[] = [];

    if (role === 'administrator') {
        granted.push(IEP_FACILITATE);
    }

    if (SIGNING_ROLES.has(role)) {
        granted.push(IEP_SIGN);

        // The executed IEP is the most sensitive artifact this app will ever hold, and a room
        // passcode is a shared secret rather than an identity — so being a guest is normally
        // disqualifying here even though it is not for signing.
        //
        // The exception is the case the guest path exists for: a parent with no Google account who
        // was invited, joined by passcode, and signed. The e-signature provider authenticated them
        // at that moment, and a parent has an unambiguous right to a copy of the plan they signed.
        // Refusing them would be a worse failure than the leak this rule guards against.
        if (context.authKind !== 'guest' || context.hasSignedExecutedDocument === true) {
            granted.push(IEP_VIEW_EXECUTED);
        }
    }

    return granted;
};
