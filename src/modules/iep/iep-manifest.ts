import { IModuleManifest } from '../../room/module-manifest';
import { IEP_MODULE_ID, iepCapabilities, isIepRole } from './iep-capabilities';

/**
 * How the IEP module declares itself to the room layer.
 *
 * `requiresPrivate` is the whole reason this field exists. An IEP meeting is about a named child's
 * disabilities and evaluations — FERPA-protected records, and among the most sensitive a school
 * holds. Leaving that to "the administrator will remember to set the room private" is how it
 * eventually does not get set. Declaring it here means the room layer enforces it without knowing
 * why, and the only way to make such a room public again is to turn this module off.
 *
 * `requiresGeneratedName` is the same argument applied to the name itself. Privacy that stops at
 * the door still leaks if the door is labelled: `iep-jimmy-smith` in the address bar reaches
 * browser history, access logs, referrer headers, and — because this app shares screens — the
 * recording of the meeting. So the typed title moves to `Room.displayName` and the identifier is
 * generated.
 *
 * `defaultEnabled` is false: nobody wants an IEP workflow attached to a stand-up.
 */
export const iepManifest: IModuleManifest = {
    id: IEP_MODULE_ID,
    requiresPrivate: true,
    requiresGeneratedName: true,
    defaultEnabled: false,
    // Whoever switches this on is running the meeting until they say otherwise. Handing them the
    // administrator role at that moment is what stops a room existing with an IEP module and nobody
    // able to facilitate it.
    creatorRole: 'administrator',
    isRole: isIepRole,
    capabilities: iepCapabilities,
};
