import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { MODULE_CATALOG_VALUE } from '../modules/module-registry';
import { MODULE_CATALOG } from './module-manifest';
import { PasscodeAttempts } from './passcode-attempts';
import { RoomCapabilityGuard } from './room-capability.guard';
import { RoomInvitationService } from './room-invitation.service';
import { RoomMembershipService } from './room-membership.service';
import { RoomProvisioningService } from './room-provisioning.service';
import { RoomsController } from './rooms.controller';
import { SessionAuthGuard } from './session-auth.guard';
import { SessionService } from './session.service';

/**
 * Can Nest actually build these.
 *
 * Every other spec in this directory constructs its subject with `new`, which is fast, keeps the
 * tests readable, and completely fails to notice a class Nest cannot instantiate. That gap is not
 * hypothetical: PasscodeAttempts took a clock as a defaulted constructor parameter, compiled
 * cleanly, passed 29 of its own tests, and then killed the application at boot —
 *
 *     Nest can't resolve dependencies of the PasscodeAttempts (?)
 *
 * — because Nest reads constructor parameters as dependencies to resolve, and `() => number` has no
 * provider. `nest build` cannot catch that, and neither can a unit test that never asks the
 * injector. This does, in about a second, without needing mediasoup or a database.
 */
describe('RoomModule wiring', () => {
    async function buildInjector() {
        return Test.createTestingModule({
            controllers: [RoomsController],
            providers: [
                { provide: MODULE_CATALOG, useValue: MODULE_CATALOG_VALUE },
                // Nothing here calls the database; resolution is the whole subject.
                { provide: PrismaService, useValue: {} },
                Reflector,
                // Pulled in by the controller's @UseGuards, which is itself part of what this
                // asserts: a guard whose dependencies cannot be resolved fails at startup, not at
                // the first request.
                SessionAuthGuard,
                { provide: SessionService, useValue: {} },
                PasscodeAttempts,
                RoomProvisioningService,
                RoomInvitationService,
                RoomCapabilityGuard,
                RoomMembershipService,
            ],
        }).compile();
    }

    it('resolves every provider the room’s REST surface needs', async () => {
        const injector = await buildInjector();

        expect(injector.get(PasscodeAttempts)).toBeInstanceOf(PasscodeAttempts);
        expect(injector.get(RoomProvisioningService)).toBeInstanceOf(RoomProvisioningService);
        expect(injector.get(RoomInvitationService)).toBeInstanceOf(RoomInvitationService);
        expect(injector.get(RoomCapabilityGuard)).toBeInstanceOf(RoomCapabilityGuard);
    });

    it('resolves the controller, so its constructor signature stays injectable', async () => {
        const injector = await buildInjector();

        expect(injector.get(RoomsController)).toBeInstanceOf(RoomsController);
    });

    // The catalog is a value provider rather than a class, which is easy to forget when adding a
    // service that injects it — and forgetting is another startup failure rather than a test one.
    it('injects the module catalog into the services that take it', async () => {
        const injector = await buildInjector();

        expect(injector.get<typeof MODULE_CATALOG_VALUE>(MODULE_CATALOG).map((manifest) => manifest.id)).toContain('iep');
    });

    it('gives PasscodeAttempts a working default clock when nothing overrides it', async () => {
        const injector = await buildInjector();
        const attempts = injector.get(PasscodeAttempts);

        expect(typeof attempts.now()).toBe('number');
        expect(attempts.isLocked('standup', 'user-1')).toBe(false);
    });
});
