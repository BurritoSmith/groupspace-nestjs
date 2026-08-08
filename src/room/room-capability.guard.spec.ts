import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { IModuleManifest } from './module-manifest';
import { RoomCapabilityGuard } from './room-capability.guard';

const catalog: IModuleManifest[] = [
    {
        id: 'iep',
        requiresPrivate: true,
        requiresGeneratedName: true,
        defaultEnabled: false,
        creatorRole: 'administrator',
        isRole: () => true,
        capabilities: (context) => (context.moduleRoles.iep === 'administrator' ? ['iep:facilitate'] : []),
    },
];

function createContext(params: Record<string, string>, userId?: string) {
    const request = { params, userId } as Record<string, unknown>;
    return {
        request,
        executionContext: {
            getHandler: () => 'handler',
            getClass: () => 'class',
            switchToHttp: () => ({ getRequest: () => request }),
        } as unknown as ExecutionContext,
    };
}

function createGuard(required: string | undefined, contextFor: jest.Mock) {
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue(required) };
    return new RoomCapabilityGuard(reflector as never, { contextFor } as never, catalog);
}

describe('RoomCapabilityGuard', () => {
    // An unannotated route is not implicitly public — it is simply not this guard's business.
    // SessionAuthGuard has already established who is asking.
    it('lets an unannotated route through', async () => {
        const contextFor = jest.fn();
        const guard = createGuard(undefined, contextFor);
        const { executionContext } = createContext({ roomName: 'standup' }, 'user-1');

        await expect(guard.canActivate(executionContext)).resolves.toBe(true);
        expect(contextFor).not.toHaveBeenCalled();
    });

    it('allows a caller who holds the capability', async () => {
        const contextFor = jest.fn().mockResolvedValue({ roomRole: 'owner', authKind: 'google', moduleRoles: {} });
        const guard = createGuard('room:configure', contextFor);
        const { executionContext } = createContext({ roomName: 'standup' }, 'user-1');

        await expect(guard.canActivate(executionContext)).resolves.toBe(true);
    });

    it('refuses a caller who does not', async () => {
        const contextFor = jest.fn().mockResolvedValue({ roomRole: 'member', authKind: 'google', moduleRoles: {} });
        const guard = createGuard('room:configure', contextFor);
        const { executionContext } = createContext({ roomName: 'standup' }, 'user-1');

        await expect(guard.canActivate(executionContext)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('consults the module catalog for module capabilities', async () => {
        const contextFor = jest.fn().mockResolvedValue({ roomRole: 'member', authKind: 'google', moduleRoles: { iep: 'administrator' } });
        const guard = createGuard('iep:facilitate', contextFor);
        const { executionContext } = createContext({ roomName: 'iep-meeting' }, 'user-1');

        await expect(guard.canActivate(executionContext)).resolves.toBe(true);
    });

    // Telling a stranger that a room exists but they are not in it is a membership oracle, and for
    // a room named after a child that is worth more than it sounds. Same exception either way.
    it('says the same thing to a non-member as to somebody merely unauthorised', async () => {
        const missing = createGuard('room:configure', jest.fn().mockResolvedValue(null));
        const unauthorised = createGuard('room:configure', jest.fn().mockResolvedValue({ roomRole: 'member', authKind: 'google', moduleRoles: {} }));
        const { executionContext } = createContext({ roomName: 'iep-meeting' }, 'user-1');

        const first = await missing.canActivate(executionContext).catch((error: Error) => error.message);
        const second = await unauthorised.canActivate(executionContext).catch((error: Error) => error.message);

        expect(first).toBe(second);
    });

    it('refuses a route with no room in its path, rather than guessing', async () => {
        const guard = createGuard('room:configure', jest.fn());
        const { executionContext } = createContext({}, 'user-1');

        await expect(guard.canActivate(executionContext)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('refuses when the session guard stamped no user', async () => {
        const guard = createGuard('room:configure', jest.fn());
        const { executionContext } = createContext({ roomName: 'standup' }, undefined);

        await expect(guard.canActivate(executionContext)).rejects.toBeInstanceOf(ForbiddenException);
    });

    // So a handler needing more than yes/no does not load it a second time.
    it('leaves the resolved context on the request', async () => {
        const roomContext = { roomRole: 'owner', authKind: 'google', moduleRoles: {} };
        const guard = createGuard('room:configure', jest.fn().mockResolvedValue(roomContext));
        const { executionContext, request } = createContext({ roomName: 'standup' }, 'user-1');

        await guard.canActivate(executionContext);

        expect(request.roomContext).toBe(roomContext);
    });
});
