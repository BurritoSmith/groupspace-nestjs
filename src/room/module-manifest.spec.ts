import { IModuleManifest, creatorRolesFor, defaultModuleIds, findManifest, forcesPrivate, unknownModuleIds } from './module-manifest';

const manifest = (id: string, overrides: Partial<IModuleManifest> = {}): IModuleManifest => ({
    id,
    requiresPrivate: false,
    defaultEnabled: true,
    creatorRole: null,
    isRole: () => false,
    capabilities: null,
    ...overrides,
});

const catalog: IModuleManifest[] = [
    manifest('chat'),
    manifest('live'),
    manifest('playback'),
    manifest('iep', { requiresPrivate: true, defaultEnabled: false, creatorRole: 'administrator', isRole: (value) => value === 'administrator' }),
];

describe('findManifest', () => {
    it('finds by id', () => {
        expect(findManifest(catalog, 'iep')?.requiresPrivate).toBe(true);
    });

    it('returns undefined for a module this deployment does not have', () => {
        expect(findManifest(catalog, 'whiteboard')).toBeUndefined();
    });
});

describe('defaultModuleIds', () => {
    // The three that were never optional. IEP is not among them: nobody wants an IEP workflow
    // attached to a stand-up.
    it('is the modules a room gets when the creator expresses no preference', () => {
        expect(defaultModuleIds(catalog)).toEqual(['chat', 'live', 'playback']);
    });
});

describe('unknownModuleIds', () => {
    it('is empty when everything is recognised', () => {
        expect(unknownModuleIds(catalog, ['chat', 'iep'])).toEqual([]);
    });

    // All of them at once, so a client sending three bad ids does not have to round-trip three
    // times to find that out.
    it('reports every unrecognised id, not just the first', () => {
        expect(unknownModuleIds(catalog, ['chat', 'whiteboard', 'polls'])).toEqual(['whiteboard', 'polls']);
    });
});

describe('forcesPrivate', () => {
    it('is false for modules that do not care', () => {
        expect(forcesPrivate(catalog, ['chat', 'live'])).toBe(false);
    });

    it('is true as soon as one module demands it', () => {
        expect(forcesPrivate(catalog, ['chat', 'iep'])).toBe(true);
    });

    // Validation of unknown ids is unknownModuleIds' job and runs first; this must not also throw.
    it('ignores unknown ids rather than throwing', () => {
        expect(forcesPrivate(catalog, ['whiteboard'])).toBe(false);
    });
});

describe('creatorRolesFor', () => {
    it('is empty for modules with no roles of their own', () => {
        expect(creatorRolesFor(catalog, ['chat', 'live'])).toEqual([]);
    });

    it('gives the enabler the role their module names', () => {
        expect(creatorRolesFor(catalog, ['chat', 'iep'])).toEqual([{ moduleId: 'iep', role: 'administrator' }]);
    });

    it('skips unknown ids', () => {
        expect(creatorRolesFor(catalog, ['whiteboard'])).toEqual([]);
    });
});
