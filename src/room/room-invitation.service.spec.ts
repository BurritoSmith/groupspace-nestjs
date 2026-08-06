import { BadRequestException, NotFoundException } from '@nestjs/common';
import { IModuleManifest } from './module-manifest';
import { RoomInvitationService } from './room-invitation.service';

const catalog: IModuleManifest[] = [
    { id: 'chat', requiresPrivate: false, defaultEnabled: true, creatorRole: null, isRole: () => false, capabilities: null },
    {
        id: 'iep',
        requiresPrivate: true,
        defaultEnabled: false,
        creatorRole: 'administrator',
        isRole: (value) => ['administrator', 'parent', 'instructor'].includes(value as string),
        capabilities: null,
    },
];

const FUTURE = new Date(Date.now() + 60 * 60 * 1000);
const PAST = new Date(Date.now() - 60 * 60 * 1000);

function createFakePrisma() {
    const fake = {
        roomInvitation: {
            create: jest.fn(async ({ data, select: _select }: { data: Record<string, unknown>; select?: unknown }) => ({
                id: 'inv-1',
                expiresAt: FUTURE,
                ...data,
            })),
            findUnique: jest.fn().mockResolvedValue(null),
            findMany: jest.fn().mockResolvedValue([]),
            update: jest.fn().mockResolvedValue({}),
            deleteMany: jest.fn().mockResolvedValue({}),
        },
        roomMember: {
            findUnique: jest.fn().mockResolvedValue(null),
            upsert: jest.fn().mockResolvedValue({}),
        },
        roomMemberModuleRole: {
            upsert: jest.fn().mockResolvedValue({}),
        },
        roomModule: {
            findMany: jest.fn().mockResolvedValue([{ moduleId: 'chat' }, { moduleId: 'iep' }]),
        },
        user: {
            findUnique: jest.fn().mockResolvedValue({ email: 'parent@example.com' }),
        },
        $transaction: jest.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(fake)),
    };
    return fake;
}

function createService(fake = createFakePrisma()) {
    return { service: new RoomInvitationService(fake as never, catalog), fake };
}

describe('RoomInvitationService.issue', () => {
    it('normalises the address, so casing from a paste does not stop it matching later', async () => {
        const { service } = createService();
        const invitation = await service.issue('iep-meeting', 'admin-1', { email: '  Parent@Example.COM ' });

        expect(invitation.email).toBe('parent@example.com');
    });

    it('defaults to member', async () => {
        const { service } = createService();
        const invitation = await service.issue('iep-meeting', 'admin-1', { email: 'parent@example.com' });

        expect(invitation.roomRole).toBe('member');
    });

    it('mints an unguessable single-use token', async () => {
        const { service } = createService();
        const invitation = await service.issue('iep-meeting', 'admin-1', { email: 'parent@example.com' });

        expect(invitation.token.length).toBeGreaterThan(32);
    });

    // Otherwise a moderator holding room:invite could mint themselves a co-owner. Ownership moves
    // deliberately, in its own act.
    it('refuses to invite somebody as an owner', async () => {
        const { service } = createService();
        await expect(service.issue('iep-meeting', 'admin-1', { email: 'parent@example.com', roomRole: 'owner' })).rejects.toBeInstanceOf(BadRequestException);
    });

    it.each([['not-an-address'], ['@example.com'], ['parent@'], ['two@at@example.com'], ['has space@example.com']])('refuses %p', async (email) => {
        const { service } = createService();
        await expect(service.issue('iep-meeting', 'admin-1', { email })).rejects.toBeInstanceOf(BadRequestException);
    });

    describe('module roles', () => {
        it('accepts a role the module recognises, on a module the room has', async () => {
            const { service } = createService();
            const invitation = await service.issue('iep-meeting', 'admin-1', { email: 'parent@example.com', moduleRoles: { iep: 'parent' } });

            expect(invitation.moduleRoles).toEqual({ iep: 'parent' });
        });

        // A plausible word the module does not use. The row would grant nothing, and the failure
        // would surface in a meeting rather than here where it is cheap.
        it('refuses a role the module does not recognise', async () => {
            const { service } = createService();
            await expect(service.issue('iep-meeting', 'admin-1', { email: 'parent@example.com', moduleRoles: { iep: 'guardian' } })).rejects.toThrow(/guardian/);
        });

        it('refuses a role for a module the room does not have enabled', async () => {
            const { service, fake } = createService();
            fake.roomModule.findMany.mockResolvedValue([{ moduleId: 'chat' }]);

            await expect(service.issue('standup', 'admin-1', { email: 'parent@example.com', moduleRoles: { iep: 'parent' } })).rejects.toThrow(/iep/);
        });

        it('does not query the enabled modules when no module roles were asked for', async () => {
            const { service, fake } = createService();
            await service.issue('standup', 'admin-1', { email: 'parent@example.com' });

            expect(fake.roomModule.findMany).not.toHaveBeenCalled();
        });
    });

    // A slider dragged too far is not an attack; refusing the whole request over it helps nobody.
    it('clamps an unreasonable expiry rather than rejecting it', async () => {
        const { service, fake } = createService();
        await service.issue('standup', 'admin-1', { email: 'parent@example.com', expiresInDays: 10_000 });

        const written = fake.roomInvitation.create.mock.calls[0][0].data as { expiresAt: Date };
        const days = (written.expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
        expect(days).toBeLessThanOrEqual(91);
        expect(days).toBeGreaterThan(89);
    });
});

describe('RoomInvitationService.accept', () => {
    const invitation = {
        id: 'inv-1',
        roomName: 'iep-meeting',
        email: 'parent@example.com',
        roomRole: 'member',
        moduleRoles: { iep: 'parent' },
        acceptedAt: null as Date | null,
        expiresAt: FUTURE,
    };

    it('makes the invitee a member with the roles the invitation carried', async () => {
        const { service, fake } = createService();
        fake.roomInvitation.findUnique.mockResolvedValue({ ...invitation });

        await expect(service.accept('token', 'user-9')).resolves.toEqual({ roomName: 'iep-meeting' });

        expect(fake.roomMember.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: { userId: 'user-9', roomName: 'iep-meeting', role: 'member' } }));
        expect(fake.roomMemberModuleRole.upsert).toHaveBeenCalledWith(
            expect.objectContaining({ create: { roomName: 'iep-meeting', userId: 'user-9', moduleId: 'iep', role: 'parent' } }),
        );
        expect(fake.roomInvitation.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'inv-1' } }));
    });

    // An owner emailed an invitation to their own room as a member must not accept their way out
    // of owning it.
    it('never lowers a role the invitee already holds', async () => {
        const { service, fake } = createService();
        fake.roomInvitation.findUnique.mockResolvedValue({ ...invitation });
        fake.roomMember.findUnique.mockResolvedValue({ role: 'owner' });

        await service.accept('token', 'user-9');

        expect(fake.roomMember.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: { role: 'owner' } }));
    });

    it('raises a role when the invitation offers more', async () => {
        const { service, fake } = createService();
        fake.roomInvitation.findUnique.mockResolvedValue({ ...invitation, roomRole: 'moderator' });
        fake.roomMember.findUnique.mockResolvedValue({ role: 'member' });

        await service.accept('token', 'user-9');

        expect(fake.roomMember.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: { role: 'moderator' } }));
    });

    it('refuses a token nobody issued', async () => {
        const { service } = createService();
        await expect(service.accept('nope', 'user-9')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('refuses one that has already been used', async () => {
        const { service, fake } = createService();
        fake.roomInvitation.findUnique.mockResolvedValue({ ...invitation, acceptedAt: new Date() });

        await expect(service.accept('token', 'user-9')).rejects.toThrow(/already been used/);
    });

    it('refuses one that has expired', async () => {
        const { service, fake } = createService();
        fake.roomInvitation.findUnique.mockResolvedValue({ ...invitation, expiresAt: PAST });

        await expect(service.accept('token', 'user-9')).rejects.toThrow(/expired/);
    });

    it('refuses an account whose verified address is different', async () => {
        const { service, fake } = createService();
        fake.roomInvitation.findUnique.mockResolvedValue({ ...invitation });
        fake.user.findUnique.mockResolvedValue({ email: 'someone.else@example.com' });

        await expect(service.accept('token', 'user-9')).rejects.toThrow(/not for this account/);
        expect(fake.roomMember.upsert).not.toHaveBeenCalled();
    });

    // An invitation names a person. Telling an unintended recipient which address it was for leaks
    // who is involved in a child's education.
    it('says the same thing whether the address is wrong or missing entirely', async () => {
        const { service, fake } = createService();
        fake.roomInvitation.findUnique.mockResolvedValue({ ...invitation });

        fake.user.findUnique.mockResolvedValue({ email: 'someone.else@example.com' });
        const wrong = await service.accept('token', 'user-9').catch((error: Error) => error.message);

        fake.user.findUnique.mockResolvedValue({ email: null });
        const missing = await service.accept('token', 'user-9').catch((error: Error) => error.message);

        expect(wrong).toBe(missing);
    });

    // A passcode guest has no email at all, which is correct: an invitation names a person and a
    // shared passcode does not.
    it('refuses a guest, who has no verified address to match', async () => {
        const { service, fake } = createService();
        fake.roomInvitation.findUnique.mockResolvedValue({ ...invitation });
        fake.user.findUnique.mockResolvedValue({ email: null });

        await expect(service.accept('token', 'guest-1')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('matches the address case-insensitively', async () => {
        const { service, fake } = createService();
        fake.roomInvitation.findUnique.mockResolvedValue({ ...invitation, email: 'Parent@Example.com' });
        fake.user.findUnique.mockResolvedValue({ email: 'parent@EXAMPLE.com' });

        await expect(service.accept('token', 'user-9')).resolves.toEqual({ roomName: 'iep-meeting' });
    });

    it('writes membership, roles and the acceptance together', async () => {
        const { service, fake } = createService();
        fake.roomInvitation.findUnique.mockResolvedValue({ ...invitation });

        await service.accept('token', 'user-9');

        expect(fake.$transaction).toHaveBeenCalledTimes(1);
    });
});

describe('RoomInvitationService.listPending', () => {
    it('never returns the token, which is the credential itself', async () => {
        const { service, fake } = createService();
        await service.listPending('iep-meeting');

        const select = fake.roomInvitation.findMany.mock.calls[0][0].select as Record<string, boolean>;
        expect(select.token).toBeUndefined();
    });

    it('only lists ones nobody has used', async () => {
        const { service, fake } = createService();
        await service.listPending('iep-meeting');

        expect(fake.roomInvitation.findMany.mock.calls[0][0].where).toEqual({ roomName: 'iep-meeting', acceptedAt: null });
    });
});

describe('RoomInvitationService.revoke', () => {
    // Otherwise an id from one room could revoke an invitation in another.
    it('scopes the delete by room', async () => {
        const { service, fake } = createService();
        await service.revoke('iep-meeting', 'inv-1');

        expect(fake.roomInvitation.deleteMany).toHaveBeenCalledWith({ where: { id: 'inv-1', roomName: 'iep-meeting', acceptedAt: null } });
    });
});
