import { ModuleCapabilityResolver } from './capabilities';

/**
 * What the room layer knows about a module: the little it has to, and nothing else.
 *
 * The room needs four facts to provision correctly — does enabling this force the room private, is
 * it on by default, what role does the person enabling it get, and is a given role string one this
 * module recognises. It deliberately does not know what any of those roles MEAN. `parent` is a
 * concept the video grid should never have to hold.
 *
 * Manifests are injected as a catalog rather than imported, so nothing in `src/room` ever names a
 * module. That is the boundary this epic exists to establish, and this is the file where it would
 * be easiest to quietly break.
 */
export interface IModuleManifest {
    /** Matches the frontend registry's id and the `RoomModule.moduleId` column. */
    id: string;
    /**
     * Enabling this module forces the room private, and the room cannot be made public again while
     * it stays enabled.
     *
     * The point of putting it here rather than in a policy document: privacy for an IEP room is
     * then enforced by the module's own declaration, not by an administrator remembering.
     */
    requiresPrivate: boolean;
    /** On for a new room unless the creator turns it off. True for the three that were never
     *  optional — chat, live and playback were simply what a room was. */
    defaultEnabled: boolean;
    /** The module role granted to whoever enables it, or null for a module with no roles of its
     *  own. The IEP module gives its enabler `administrator`; chat gives nobody anything. */
    creatorRole: string | null;
    /** Whether a role string is one this module recognises. Roles are stored as free strings so a
     *  module can add one without a migration, which only works if something validates them at
     *  assignment time rather than discovering the typo when a capability silently never appears. */
    isRole: (value: unknown) => boolean;
    /** How this module's roles become capabilities, or null for a module that grants none. Carried
     *  on the manifest rather than in a second array kept alongside it — two parallel lists keyed by
     *  module id drift the first time somebody adds an entry to one of them. */
    capabilities: ModuleCapabilityResolver | null;
}

/** Injection token for the catalog. A string token rather than a class, because the catalog is a
 *  plain array assembled at the composition root. */
export const MODULE_CATALOG = 'MODULE_CATALOG';

export function findManifest(catalog: IModuleManifest[], moduleId: string): IModuleManifest | undefined {
    return catalog.find((manifest) => manifest.id === moduleId);
}

/** What a new room gets when the creator expresses no preference. */
export function defaultModuleIds(catalog: IModuleManifest[]): string[] {
    return catalog.filter((manifest) => manifest.defaultEnabled).map((manifest) => manifest.id);
}

/** Ids in the request that no manifest claims. Returned rather than thrown so the caller can name
 *  all of them at once instead of the first — a client sending three bad ids should not have to
 *  round-trip three times to learn that. */
export function unknownModuleIds(catalog: IModuleManifest[], moduleIds: string[]): string[] {
    return moduleIds.filter((id) => !findManifest(catalog, id));
}

/** Whether any of these modules forces the room private. Unknown ids are ignored here; validating
 *  them is `unknownModuleIds`'s job and happens first. */
export function forcesPrivate(catalog: IModuleManifest[], moduleIds: string[]): boolean {
    return moduleIds.some((id) => findManifest(catalog, id)?.requiresPrivate === true);
}

/** Every enabled module's capability resolver, for handing to `capabilitiesFor`. Derived from the
 *  catalog so there is exactly one place a module is registered. */
export function capabilityResolvers(catalog: IModuleManifest[]): ModuleCapabilityResolver[] {
    return catalog.map((manifest) => manifest.capabilities).filter((resolver): resolver is ModuleCapabilityResolver => resolver !== null);
}

/** The module roles the creator should hold, given what they just enabled. */
export function creatorRolesFor(catalog: IModuleManifest[], moduleIds: string[]): { moduleId: string; role: string }[] {
    return moduleIds
        .map((id) => findManifest(catalog, id))
        .filter((manifest): manifest is IModuleManifest => manifest !== undefined && manifest.creatorRole !== null)
        .map((manifest) => ({ moduleId: manifest.id, role: manifest.creatorRole as string }));
}
