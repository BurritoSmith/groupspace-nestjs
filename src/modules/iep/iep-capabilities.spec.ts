import { AuthKind, IRoomContext, capabilitiesFor } from '../../room/capabilities';
import { IEP_FACILITATE, IEP_MODULE_ID, IEP_SIGN, IEP_VIEW_EXECUTED, IepRole, iepCapabilities, isIepRole } from './iep-capabilities';

function context(role: IepRole | null, authKind: AuthKind = 'google', hasSignedExecutedDocument = false): IRoomContext {
    return {
        roomRole: 'member',
        authKind,
        moduleRoles: role ? { [IEP_MODULE_ID]: role } : {},
        hasSignedExecutedDocument,
    };
}

function granted(...args: Parameters<typeof context>): string[] {
    return [...capabilitiesFor(context(...args), [iepCapabilities])].sort();
}

describe('iepCapabilities', () => {
    it('grants nothing to someone with no role in the process', () => {
        expect(granted(null)).toEqual([]);
    });

    it('lets only the administrator drive the wizard', () => {
        expect(granted('administrator')).toContain(IEP_FACILITATE);
        for (const role of ['parent', 'student', 'instructor', 'observer'] as IepRole[]) {
            expect(granted(role)).not.toContain(IEP_FACILITATE);
        }
    });

    it.each<IepRole>(['administrator', 'parent', 'student', 'instructor'])('puts %s on the document as a signer', (role) => {
        expect(granted(role)).toContain(IEP_SIGN);
    });

    // An observer is in the meeting, not on the plan — a student teacher sitting in, an advocate
    // attending to listen. Deliberately given a role rather than left roleless, so their presence is
    // recorded, and deliberately not a signer.
    it('does not let an observer sign or read the executed document', () => {
        expect(granted('observer')).toEqual([]);
    });

    it('grants an unrecognised role nothing rather than throwing', () => {
        expect(granted('principal' as IepRole)).toEqual([]);
    });

    describe('the executed document', () => {
        it('is readable by a signed-in participant who signs it', () => {
            expect(granted('parent', 'google')).toContain(IEP_VIEW_EXECUTED);
        });

        // A room passcode is a shared secret, not an identity. Someone who merely had it must not
        // reach the most sensitive artifact the app holds.
        it('is refused to a passcode guest who has not signed', () => {
            const capabilities = granted('parent', 'guest', false);
            expect(capabilities).toContain(IEP_SIGN);
            expect(capabilities).not.toContain(IEP_VIEW_EXECUTED);
        });

        // ...but the guest path exists so a parent without a Google account can take part at all.
        // Once they have signed, the e-signature provider has authenticated them, and a parent has
        // an unambiguous right to a copy of the plan they put their name to.
        it('is readable by a guest once they have actually signed it', () => {
            expect(granted('parent', 'guest', true)).toContain(IEP_VIEW_EXECUTED);
        });

        // The signing exception must not become a general-purpose key: an observer cannot sign, so
        // the flag can never be true for one, and it grants them nothing if it somehow is.
        it('stays refused to an observer even with the signed flag set', () => {
            expect(granted('observer', 'guest', true)).toEqual([]);
        });
    });
});

describe('isIepRole', () => {
    it.each(['administrator', 'parent', 'student', 'instructor', 'observer'])('accepts %s', (value) => {
        expect(isIepRole(value)).toBe(true);
    });

    it.each([['principal'], ['ADMINISTRATOR'], [''], [null], [undefined], [42], [{}]])('rejects %p', (value) => {
        expect(isIepRole(value)).toBe(false);
    });
});
