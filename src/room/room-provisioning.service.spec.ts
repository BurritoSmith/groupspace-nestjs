import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { IModuleManifest } from './module-manifest';
import { verifyPasscode } from './passcode';
import { RoomProvisioningService } from './room-provisioning.service';

const manifest = (id: string, overrides: Partial<IModuleManifest> = {}): IModuleManifest => ({
    id,
    requiresPrivate: false,
    defaultEnabled: true,
    creatorRole: null,
    isRole: () => false,
    ...overrides,
});

const catalog: IModuleManifest[] = [
    manifest('chat'),
    manifest('live'),
    manifest('playback'),
    manifest('iep', { requiresPrivate: true, defaultEnabled: false, creatorRole: 'administrator', isRole: (value) => value === 'administrator' }),
];

function createFakePrisma() {
    const fake = {
        room: {
            findUnique: jest.fn().mockResolvedValue(null),
            create: jest.fn().mockResolvedValue({}),
            update: jest.fn().mockResolvedValue({}),
        },
        roomMember: {
            create: jest.fn().mockResolvedValue({}),
            findUnique: jest.fn().mockResolvedValue(null),
        },
        roomModule: {
            createMany: jest.fn().mockResolvedValue({}),
            upsert: jest.fn().mockResolvedValue({}),
            deleteMany: jest.fn().mockResolvedValue({}),
            findMany: jest.fn().mockResolvedValue([]),
        },
        roomMemberModuleRole: {
            createMany: jest.fn().mockResolvedValue({}),
            upsert: jest.fn().mockResolvedValue({}),
            findMany: jest.fn().mockResolvedValue([]),
        },
        user: {
            findUnique: jest.fn().mockResolvedValue({ authKind: 'google' }),
        },
        // Runs the callback against the same fake, which is what makes the assertions below able to
        // see writes made inside the transaction.
        $transaction: jest.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(fake)),
    };
    return fake;
}

function createService(fake = createFakePrisma()) {
    return { service: new RoomProvisioningService(fake as never, catalog), fake };
}

describe('RoomProvisioningService.create', () => {
    it('canonicalises the name, so the room can actually be joined afterwards', async () => {
        const { service, fake } = createService();
        const summary = await service.create('user-1', { name: '  Study Hall  ' });

        expect(summary.name).toBe('study hall');
        expect(fake.room.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ name: 'study hall' }) }));
    });

    it.each([[''], ['   '], ['a'.repeat(65)]])('refuses %p', async (name) => {
        const { service } = createService();
        await expect(service.create('user-1', { name })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('gives a room the default modules when none are named', async () => {
        const { service, fake } = createService();
        await service.create('user-1', { name: 'standup' });

        expect(fake.roomModule.createMany).toHaveBeenCalledWith({
            data: [
                { roomName: 'standup', moduleId: 'chat' },
                { roomName: 'standup', moduleId: 'live' },
                { roomName: 'standup', moduleId: 'playback' },
            ],
        });
    });

    it('names every unknown module at once', async () => {
        const { service } = createService();
        await expect(service.create('user-1', { name: 'standup', moduleIds: ['chat', 'whiteboard', 'polls'] })).rejects.toThrow(/whiteboard, polls/);
    });

    // Two RoomModule rows for the same module would race the unique index; reporting the same bad
    // id twice would also be noise.
    it('deduplicates repeated module ids', async () => {
        const { service, fake } = createService();
        await service.create('user-1', { name: 'standup', moduleIds: ['chat', 'chat'] });

        expect(fake.roomModule.createMany).toHaveBeenCalledWith({ data: [{ roomName: 'standup', moduleId: 'chat' }] });
    });

    it('makes the creator the owner', async () => {
        const { service, fake } = createService();
        await service.create('user-7', { name: 'standup' });

        expect(fake.roomMember.create).toHaveBeenCalledWith({ data: { roomName: 'standup', userId: 'user-7', role: 'owner' } });
    });

    it('refuses to create a room that already exists', async () => {
        const { service, fake } = createService();
        fake.room.findUnique.mockResolvedValue({ name: 'standup' });

        await expect(service.create('user-1', { name: 'standup' })).rejects.toBeInstanceOf(ConflictException);
    });

    describe('with a module that demands privacy', () => {
        it('forces the room private even when public was asked for', async () => {
            const { service, fake } = createService();
            const summary = await service.create('user-1', { name: 'iep-meeting', visibility: 'public', moduleIds: ['chat', 'iep'] });

            expect(summary.visibility).toBe('private');
            expect(fake.room.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ visibility: 'private' }) }));
        });

        it('gives the creator the role that module names, so somebody can run the meeting', async () => {
            const { service, fake } = createService();
            await service.create('user-7', { name: 'iep-meeting', moduleIds: ['iep'] });

            expect(fake.roomMemberModuleRole.createMany).toHaveBeenCalledWith({
                data: [{ roomName: 'iep-meeting', userId: 'user-7', moduleId: 'iep', role: 'administrator' }],
            });
        });
    });

    it('does not write a module-role row when nothing grants one', async () => {
        const { service, fake } = createService();
        await service.create('user-1', { name: 'standup' });

        expect(fake.roomMemberModuleRole.createMany).not.toHaveBeenCalled();
    });

    describe('the passcode', () => {
        it('is stored only as a verifiable digest', async () => {
            const { service, fake } = createService();
            const summary = await service.create('user-1', { name: 'standup', passcode: 'open sesame' });

            const stored = fake.room.create.mock.calls[0][0].data.passcodeHash as string;
            expect(stored).not.toContain('open sesame');
            await expect(verifyPasscode('open sesame', stored)).resolves.toBe(true);
            expect(summary.hasPasscode).toBe(true);
        });

        it('is absent when none was given', async () => {
            const { service, fake } = createService();
            const summary = await service.create('user-1', { name: 'standup' });

            expect(fake.room.create.mock.calls[0][0].data.passcodeHash).toBeNull();
            expect(summary.hasPasscode).toBe(false);
        });

        it('is refused when too short to be worth hashing', async () => {
            const { service } = createService();
            await expect(service.create('user-1', { name: 'standup', passcode: 'abc' })).rejects.toBeInstanceOf(BadRequestException);
        });
    });

    // A room with no owner cannot be configured, invited to, or have a module turned off. Every
    // write here has to land together or not at all.
    it('writes everything inside one transaction', async () => {
        const { service, fake } = createService();
        await service.create('user-1', { name: 'standup' });

        expect(fake.$transaction).toHaveBeenCalledTimes(1);
    });
});

describe('RoomProvisioningService.setVisibility', () => {
    it('refuses to make a room public while a module demands privacy, and says which', async () => {
        const { service, fake } = createService();
        fake.roomModule.findMany.mockResolvedValue([{ moduleId: 'chat' }, { moduleId: 'iep' }]);

        await expect(service.setVisibility('iep-meeting', 'public')).rejects.toThrow(/iep/);
        expect(fake.room.update).not.toHaveBeenCalled();
    });

    it('allows it once nothing is blocking', async () => {
        const { service, fake } = createService();
        fake.roomModule.findMany.mockResolvedValue([{ moduleId: 'chat' }]);

        await service.setVisibility('standup', 'public');

        expect(fake.room.update).toHaveBeenCalledWith({ where: { name: 'standup' }, data: { visibility: 'public' } });
    });

    it('never blocks going private', async () => {
        const { service, fake } = createService();
        fake.roomModule.findMany.mockResolvedValue([{ moduleId: 'iep' }]);

        await service.setVisibility('iep-meeting', 'private');

        expect(fake.room.update).toHaveBeenCalled();
    });
});

describe('RoomProvisioningService.enableModule', () => {
    it('refuses an unknown module', async () => {
        const { service } = createService();
        await expect(service.enableModule('standup', 'whiteboard', 'user-1')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses a room that does not exist', async () => {
        const { service } = createService();
        await expect(service.enableModule('nowhere', 'chat', 'user-1')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('flips the room private when the module demands it', async () => {
        const { service, fake } = createService();
        fake.room.findUnique.mockResolvedValue({ name: 'standup' });

        await service.enableModule('standup', 'iep', 'user-7');

        expect(fake.room.update).toHaveBeenCalledWith({ where: { name: 'standup' }, data: { visibility: 'private' } });
        expect(fake.roomMemberModuleRole.upsert).toHaveBeenCalled();
    });

    it('leaves visibility alone for a module that does not care', async () => {
        const { service, fake } = createService();
        fake.room.findUnique.mockResolvedValue({ name: 'standup' });

        await service.enableModule('standup', 'chat', 'user-7');

        expect(fake.room.update).not.toHaveBeenCalled();
        expect(fake.roomMemberModuleRole.upsert).not.toHaveBeenCalled();
    });
});

describe('RoomProvisioningService.disableModule', () => {
    // Privacy is easy to loosen by accident and hard to notice afterwards. A room that held an IEP
    // discussion must not quietly reopen because somebody tidied the module list.
    it('does not restore public visibility', async () => {
        const { service, fake } = createService();
        await service.disableModule('iep-meeting', 'iep');

        expect(fake.roomModule.deleteMany).toHaveBeenCalledWith({ where: { roomName: 'iep-meeting', moduleId: 'iep' } });
        expect(fake.room.update).not.toHaveBeenCalled();
    });
});

describe('RoomProvisioningService.checkPasscode', () => {
    it('accepts the right passcode', async () => {
        const { service, fake } = createService();
        await service.create('user-1', { name: 'standup', passcode: 'open sesame' });
        const digest = fake.room.create.mock.calls[0][0].data.passcodeHash as string;
        fake.room.findUnique.mockResolvedValue({ passcodeHash: digest });

        await expect(service.checkPasscode('standup', 'open sesame')).resolves.toBe(true);
        await expect(service.checkPasscode('standup', 'guess')).resolves.toBe(false);
    });

    // "No passcode set" must not become "every passcode works".
    it('refuses everything when the room has no passcode', async () => {
        const { service, fake } = createService();
        fake.room.findUnique.mockResolvedValue({ passcodeHash: null });

        await expect(service.checkPasscode('standup', 'anything')).resolves.toBe(false);
    });

    it('refuses everything for a room that does not exist', async () => {
        const { service } = createService();
        await expect(service.checkPasscode('nowhere', 'anything')).resolves.toBe(false);
    });
});

describe('RoomProvisioningService.contextFor', () => {
    it('is null for someone who is not a member', async () => {
        const { service } = createService();
        await expect(service.contextFor('standup', 'stranger')).resolves.toBeNull();
    });

    it('reports the room role and auth kind', async () => {
        const { service, fake } = createService();
        fake.roomMember.findUnique.mockResolvedValue({ role: 'owner' });
        fake.user.findUnique.mockResolvedValue({ authKind: 'guest' });

        await expect(service.contextFor('standup', 'user-1')).resolves.toEqual({ roomRole: 'owner', authKind: 'guest', moduleRoles: {} });
    });

    // The load-bearing one. capabilitiesFor takes moduleRoles at face value and has no idea which
    // modules a room has enabled — so if a disabled module's roles were reported here, turning the
    // IEP module off would leave every iep: capability still granted.
    it('drops roles belonging to modules that are switched off', async () => {
        const { service, fake } = createService();
        fake.roomMember.findUnique.mockResolvedValue({ role: 'member' });
        fake.roomModule.findMany.mockResolvedValue([{ moduleId: 'chat' }]);
        fake.roomMemberModuleRole.findMany.mockResolvedValue([
            { moduleId: 'iep', role: 'administrator' },
            { moduleId: 'chat', role: 'scribe' },
        ]);

        const context = await service.contextFor('standup', 'user-1');

        expect(context?.moduleRoles).toEqual({ chat: 'scribe' });
    });

    it('keeps roles for modules that are on', async () => {
        const { service, fake } = createService();
        fake.roomMember.findUnique.mockResolvedValue({ role: 'member' });
        fake.roomModule.findMany.mockResolvedValue([{ moduleId: 'iep' }]);
        fake.roomMemberModuleRole.findMany.mockResolvedValue([{ moduleId: 'iep', role: 'parent' }]);

        const context = await service.contextFor('iep-meeting', 'user-1');

        expect(context?.moduleRoles).toEqual({ iep: 'parent' });
    });
});
