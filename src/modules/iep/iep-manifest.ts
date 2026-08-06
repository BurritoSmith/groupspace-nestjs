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
 * `defaultEnabled` is false: nobody wants an IEP workflow attached to a stand-up.
 */
export const iepManifest: IModuleManifest = {
    id: IEP_MODULE_ID,
    requiresPrivate: true,
    defaultEnabled: false,
    // Whoever switches this on is running the meeting until they say otherwise. Handing them the
    // administrator role at that moment is what stops a room existing with an IEP module and nobody
    // able to facilitate it.
    creatorRole: 'administrator',
    isRole: isIepRole,
    capabilities: iepCapabilities,
};
