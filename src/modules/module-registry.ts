import { IModuleManifest } from '../room/module-manifest';
import { iepManifest } from './iep/iep-manifest';

/**
 * Every module this deployment knows about — the composition root for the module boundary.
 *
 * This is the only file that names every module, which is what lets `src/room` name none of them.
 * Adding a module is one import and one array entry here; removing one is deleting both, plus its
 * directory, and nothing in the room layer notices.
 *
 * The frontend has the mirror of this in `src/app/modules/module-registry.ts`, and the two must
 * agree on ids — they are the values stored in `RoomModule.moduleId`.
 */

/** Chat, live and playback were never optional: they were simply what a room was, and every room
 *  that existed before modules did has them recorded as enabled by the backfill. They are listed
 *  as DATA only — their code still lives where it always did and reads a flag, rather than being
 *  rehomed under src/modules. Doing that properly is its own piece of work, and bundling it into
 *  this one would have meant moving most of the app to add a boundary. */
const builtInManifest = (id: string): IModuleManifest => ({
    id,
    requiresPrivate: false,
    defaultEnabled: true,
    creatorRole: null,
    // No roles of their own. Being in the room is the only status chat has ever recognised.
    isRole: () => false,
    capabilities: null,
});

export const MODULE_CATALOG_VALUE: IModuleManifest[] = [builtInManifest('chat'), builtInManifest('live'), builtInManifest('playback'), iepManifest];
