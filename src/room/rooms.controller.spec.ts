import { BadRequestException, ForbiddenException, HttpException, HttpStatus } from '@nestjs/common';
import { Request } from 'express';
import { RoomsController } from './rooms.controller';

function fakeRequest(userId?: string) {
    return { userId } as Request & { userId?: string };
}

function createController(overrides: Partial<Record<'membership' | 'provisioning' | 'invitations' | 'attempts', unknown>> = {}) {
    const membership = { listForUser: jest.fn().mockResolvedValue([]), recordVisit: jest.fn().mockResolvedValue(undefined) };
    const provisioning = {
        create: jest.fn().mockResolvedValue({ name: 'standup' }),
        describe: jest.fn().mockResolvedValue(null),
        contextFor: jest.fn().mockResolvedValue(null),
        setVisibility: jest.fn().mockResolvedValue(undefined),
        setPasscode: jest.fn().mockResolvedValue(undefined),
        enableModule: jest.fn().mockResolvedValue(undefined),
        disableModule: jest.fn().mockResolvedValue(undefined),
        checkPasscode: jest.fn().mockResolvedValue(true),
    };
    const invitations = {
        issue: jest.fn().mockResolvedValue({ id: 'inv-1' }),
        accept: jest.fn().mockResolvedValue({ roomName: 'standup' }),
        listPending: jest.fn().mockResolvedValue([]),
        revoke: jest.fn().mockResolvedValue(undefined),
    };
    const attempts = { isLocked: jest.fn().mockReturnValue(false), recordFailure: jest.fn(), clear: jest.fn(), prune: jest.fn() };

    const parts = { membership, provisioning, invitations, attempts, ...overrides } as {
        membership: typeof membership;
        provisioning: typeof provisioning;
        invitations: typeof invitations;
        attempts: typeof attempts;
    };
    return {
        controller: new RoomsController(parts.membership as never, parts.provisioning as never, parts.invitations as never, parts.attempts as never),
        ...parts,
    };
}

describe('GET /rooms/mine', () => {
    it("returns the caller's own visited rooms", async () => {
        const rooms = [{ name: 'lobby', lastJoinedAt: new Date('2026-08-01T00:00:00Z') }];
        const { controller, membership } = createController();
        membership.listForUser.mockResolvedValue(rooms);

        await expect(controller.mine(fakeRequest('user-1'))).resolves.toEqual({ rooms });
    });

    // The userId comes from the session guard's stamp, never from the caller — same rationale as
    // UserSettingsController.
    it('reads the user id from the guard, not from anything the caller sent', async () => {
        const { controller, membership } = createController();
        await controller.mine(fakeRequest('user-1'));

        expect(membership.listForUser).toHaveBeenCalledWith('user-1');
    });
});

describe('POST /rooms', () => {
    it('creates on behalf of the caller the guard identified', async () => {
        const { controller, provisioning } = createController();
        await controller.create(fakeRequest('user-7'), { name: 'standup' });

        expect(provisioning.create).toHaveBeenCalledWith('user-7', { name: 'standup' });
    });
});

describe('GET /rooms/:roomName', () => {
    it('returns null for a room that does not exist, so the join screen can offer to create it', async () => {
        const { controller } = createController();
        await expect(controller.describe(fakeRequest('user-1'), 'nowhere')).resolves.toBeNull();
    });

    it('describes a public room fully', async () => {
        const summary = { name: 'standup', visibility: 'public', hasPasscode: false, moduleIds: ['chat'], createdByUserId: 'user-1' };
        const { controller, provisioning } = createController();
        provisioning.describe.mockResolvedValue(summary);

        await expect(controller.describe(fakeRequest('user-9'), 'standup')).resolves.toEqual(summary);
    });

    // A non-member gets the door, not the room: enough to render "this needs a passcode", and
    // nothing describing a meeting they are not part of.
    it('tells a non-member only how to get into a private room', async () => {
        const { controller, provisioning } = createController();
        provisioning.describe.mockResolvedValue({
            name: 'iep-meeting',
            visibility: 'private',
            hasPasscode: true,
            moduleIds: ['chat', 'iep'],
            createdByUserId: 'admin-1',
        });

        const result = await controller.describe(fakeRequest('stranger'), 'iep-meeting');

        expect(result).toEqual({ name: 'iep-meeting', visibility: 'private', hasPasscode: true, isMember: false });
        expect(result).not.toHaveProperty('moduleIds');
        expect(result).not.toHaveProperty('createdByUserId');
    });

    it('describes a private room fully to somebody who is in it', async () => {
        const summary = { name: 'iep-meeting', visibility: 'private', hasPasscode: true, moduleIds: ['iep'], createdByUserId: 'admin-1' };
        const { controller, provisioning } = createController();
        provisioning.describe.mockResolvedValue(summary);
        provisioning.contextFor.mockResolvedValue({ roomRole: 'member', authKind: 'google', moduleRoles: {} });

        await expect(controller.describe(fakeRequest('user-9'), 'iep-meeting')).resolves.toEqual(summary);
    });
});

describe('PATCH /rooms/:roomName', () => {
    // undefined means "leave it alone" and null means "remove it". Conflating them would make
    // clearing a passcode impossible.
    it('leaves the passcode untouched when the field is absent', async () => {
        const { controller, provisioning } = createController();
        await controller.configure('standup', { visibility: 'private' });

        expect(provisioning.setVisibility).toHaveBeenCalledWith('standup', 'private');
        expect(provisioning.setPasscode).not.toHaveBeenCalled();
    });

    it('clears the passcode when the field is explicitly null', async () => {
        const { controller, provisioning } = createController();
        await controller.configure('standup', { passcode: null });

        expect(provisioning.setPasscode).toHaveBeenCalledWith('standup', null);
    });
});

describe('modules', () => {
    it('refuses an enable with no module named', async () => {
        const { controller } = createController();
        await expect(controller.enableModule(fakeRequest('user-1'), 'standup', {})).rejects.toBeInstanceOf(BadRequestException);
    });

    it('enables on behalf of the caller, who gets the module’s creator role', async () => {
        const { controller, provisioning } = createController();
        await controller.enableModule(fakeRequest('user-7'), 'standup', { moduleId: 'iep' });

        expect(provisioning.enableModule).toHaveBeenCalledWith('standup', 'iep', 'user-7');
    });

    it('disables by route parameters', async () => {
        const { controller, provisioning } = createController();
        await controller.disableModule('standup', 'iep');

        expect(provisioning.disableModule).toHaveBeenCalledWith('standup', 'iep');
    });
});

describe('invitations', () => {
    it('refuses one with no address', async () => {
        const { controller } = createController();
        await expect(controller.invite(fakeRequest('admin-1'), 'iep-meeting', { email: '' })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('records who issued it', async () => {
        const { controller, invitations } = createController();
        await controller.invite(fakeRequest('admin-1'), 'iep-meeting', { email: 'parent@example.com' });

        expect(invitations.issue).toHaveBeenCalledWith('iep-meeting', 'admin-1', { email: 'parent@example.com' });
    });

    it('refuses an accept with no token', async () => {
        const { controller } = createController();
        await expect(controller.acceptInvitation(fakeRequest('user-9'), {})).rejects.toBeInstanceOf(BadRequestException);
    });

    it('accepts on behalf of the signed-in caller', async () => {
        const { controller, invitations } = createController();
        await controller.acceptInvitation(fakeRequest('user-9'), { token: 'abc' });

        expect(invitations.accept).toHaveBeenCalledWith('abc', 'user-9');
    });
});

describe('POST /rooms/:roomName/join', () => {
    it('admits somebody with the right passcode, and records the visit', async () => {
        const { controller, membership, attempts } = createController();
        await expect(controller.joinWithPasscode(fakeRequest('user-9'), 'Study Hall', { passcode: 'open sesame' })).resolves.toEqual({ joined: true });

        // Canonicalised, or the membership row would name a room nobody can join.
        expect(membership.recordVisit).toHaveBeenCalledWith('user-9', 'study hall');
        expect(attempts.clear).toHaveBeenCalledWith('study hall', 'user-9');
    });

    it('counts a wrong passcode and refuses', async () => {
        const { controller, provisioning, membership, attempts } = createController();
        provisioning.checkPasscode.mockResolvedValue(false);

        await expect(controller.joinWithPasscode(fakeRequest('user-9'), 'standup', { passcode: 'guess' })).rejects.toBeInstanceOf(ForbiddenException);
        expect(attempts.recordFailure).toHaveBeenCalledWith('standup', 'user-9');
        expect(membership.recordVisit).not.toHaveBeenCalled();
    });

    // Somebody locked out needs to know that waiting is the fix, rather than being told they got it
    // wrong again and typing faster.
    it('reports a lockout as a lockout, before even looking at the passcode', async () => {
        const { controller, provisioning, attempts } = createController();
        attempts.isLocked.mockReturnValue(true);

        const error = await controller.joinWithPasscode(fakeRequest('user-9'), 'standup', { passcode: 'open sesame' }).catch((thrown: HttpException) => thrown);

        expect(error).toBeInstanceOf(HttpException);
        expect((error as HttpException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
        expect(provisioning.checkPasscode).not.toHaveBeenCalled();
    });

    it('refuses a request with no passcode at all', async () => {
        const { controller } = createController();
        await expect(controller.joinWithPasscode(fakeRequest('user-9'), 'standup', {})).rejects.toBeInstanceOf(BadRequestException);
    });
});
