import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuthKind, IRoomContext, RoomRole } from './capabilities';
import { IModuleManifest, MODULE_CATALOG, creatorRolesFor, defaultModuleIds, findManifest, forcesGeneratedName, forcesPrivate, unknownModuleIds } from './module-manifest';
import { generateRoomIdentifier } from './room-identifier';
import { hashPasscode, isAcceptablePasscode, verifyPasscode } from './passcode';
import { canonicalRoomName, isCreatableRoomName } from './room-name';

export type RoomVisibility = 'public' | 'private';

export interface ICreateRoomInput {
    name: string;
    visibility?: RoomVisibility;
    passcode?: string | null;
    /** Omitted means "the defaults" — not "none". A room with no modules can do nothing at all. */
    moduleIds?: string[];
}

export interface IRoomSummary {
    name: string;
    /** The title to show when the name is a generated identifier; null for an ordinary room, where
     *  the name is the title. Never render `name` in preference to this when it is set — that is
     *  what puts a child's name back on screen. */
    displayName: string | null;
    visibility: RoomVisibility;
    /** Whether a passcode is set — never the passcode, and never its digest. */
    hasPasscode: boolean;
    moduleIds: string[];
    createdByUserId: string | null;
}

/**
 * Creating and configuring rooms.
 *
 * Separate from RoomService, which is the mediasoup router and peer state and has nothing to do
 * with any of this, and separate from RoomMembershipService, whose `recordVisit` used to be the
 * only thing that ever made a Room row — implicitly, through a connectOrCreate, the first time
 * anybody joined. That is the behaviour this service replaces: rooms are now made deliberately, by
 * somebody, who owns them.
 */
@Injectable()
export class RoomProvisioningService {
    constructor(
        private readonly prisma: PrismaService,
        @Inject(MODULE_CATALOG) private readonly catalog: IModuleManifest[],
    ) {}

    /**
     * Creates a room and makes its creator the owner.
     *
     * In one transaction — the first in this codebase — because a room that exists with no owner is
     * a room nobody can configure, invite to, or turn a module off in. Every failure mode here
     * produces that if the writes are allowed to land separately.
     */
    async create(userId: string, input: ICreateRoomInput): Promise<IRoomSummary> {
        // Validated even when the typed name is about to become a displayName rather than the
        // identifier: it is still shown to people, still stored, and the length and control-character
        // rules exist for reasons that do not stop applying because it moved column.
        if (!isCreatableRoomName(input.name)) {
            throw new BadRequestException('That room name cannot be used.');
        }

        // Deduplicated before validation so a request naming the same module twice is not reported
        // as two problems, and cannot create two RoomModule rows racing the unique index.
        const moduleIds = [...new Set(input.moduleIds ?? defaultModuleIds(this.catalog))];
        const unknown = unknownModuleIds(this.catalog, moduleIds);
        if (unknown.length > 0) {
            throw new BadRequestException(`Unknown module(s): ${unknown.join(', ')}.`);
        }

        // A module may declare that the room's name must not describe it. The typed title then
        // becomes displayName and the identifier is generated — see room-identifier.ts for why the
        // alphabet matters. Trimmed but NOT lowercased: displayName is a title shown to people, not
        // a key anything is looked up by, so "Jimmy's Annual Review" should keep its capitals.
        const generatedName = forcesGeneratedName(this.catalog, moduleIds);
        const name = generatedName ? generateRoomIdentifier() : canonicalRoomName(input.name);
        const displayName = generatedName ? input.name.trim() : null;

        // A module that demands privacy gets it, whatever the request asked for. Silently upgrading
        // rather than rejecting: the caller asked for something contradictory, and the safe reading
        // of "public IEP room" is that they did not realise, not that they meant it.
        const visibility: RoomVisibility = forcesPrivate(this.catalog, moduleIds) ? 'private' : (input.visibility ?? 'public');

        const passcodeHash = await this.digestFor(input.passcode);

        const existing = await this.prisma.room.findUnique({ where: { name } });
        if (existing) {
            throw new ConflictException('A room with that name already exists.');
        }

        const creatorRoles = creatorRolesFor(this.catalog, moduleIds);

        await this.prisma.$transaction(async (tx) => {
            await tx.room.create({ data: { name, displayName, visibility, passcodeHash, createdByUserId: userId } });
            await tx.roomMember.create({ data: { roomName: name, userId, role: 'owner' } });
            await tx.roomModule.createMany({ data: moduleIds.map((moduleId) => ({ roomName: name, moduleId })) });
            if (creatorRoles.length > 0) {
                await tx.roomMemberModuleRole.createMany({
                    data: creatorRoles.map(({ moduleId, role }) => ({ roomName: name, userId, moduleId, role })),
                });
            }
        });

        return { name, displayName, visibility, hasPasscode: passcodeHash !== null, moduleIds, createdByUserId: userId };
    }

    /** What a room is, for anyone allowed to ask. Null rather than throwing, because "does this
     *  room exist" is a question the join screen asks about names that mostly will not. */
    async describe(roomName: string): Promise<IRoomSummary | null> {
        const name = canonicalRoomName(roomName);
        const room = await this.prisma.room.findUnique({
            where: { name },
            select: { name: true, displayName: true, visibility: true, passcodeHash: true, createdByUserId: true, modules: { select: { moduleId: true } } },
        });
        if (!room) {
            return null;
        }
        return {
            name: room.name,
            displayName: room.displayName,
            visibility: room.visibility as RoomVisibility,
            hasPasscode: room.passcodeHash !== null,
            moduleIds: room.modules.map((module) => module.moduleId),
            createdByUserId: room.createdByUserId,
        };
    }

    /**
     * Changes visibility, unless an enabled module forbids it.
     *
     * Named in the error rather than a flat refusal: "you cannot make this public" is infuriating
     * without "because the IEP module is on", and the fix — turn that module off — is not guessable.
     */
    async setVisibility(roomName: string, visibility: RoomVisibility): Promise<void> {
        const name = canonicalRoomName(roomName);
        const enabled = await this.enabledModuleIds(name);

        if (visibility === 'public') {
            const blocking = enabled.filter((id) => findManifest(this.catalog, id)?.requiresPrivate === true);
            if (blocking.length > 0) {
                throw new BadRequestException(`This room must stay private while these modules are enabled: ${blocking.join(', ')}.`);
            }
        }

        await this.prisma.room.update({ where: { name }, data: { visibility } });
    }

    /** Sets or clears the passcode. Clearing a private room's passcode leaves invitation as the
     *  only way in, which is a legitimate configuration rather than an error. */
    async setPasscode(roomName: string, passcode: string | null): Promise<void> {
        const name = canonicalRoomName(roomName);
        await this.prisma.room.update({ where: { name }, data: { passcodeHash: await this.digestFor(passcode) } });
    }

    async checkPasscode(roomName: string, passcode: string): Promise<boolean> {
        const name = canonicalRoomName(roomName);
        const room = await this.prisma.room.findUnique({ where: { name }, select: { passcodeHash: true } });
        // A room with no passcode cannot be entered BY passcode. Returning true here would turn
        // "no passcode set" into "every passcode works", which is the opposite of the intent.
        if (!room?.passcodeHash) {
            return false;
        }
        return verifyPasscode(passcode, room.passcodeHash);
    }

    /** Turns a module on, applying whatever the manifest demands as a consequence. */
    async enableModule(roomName: string, moduleId: string, byUserId: string): Promise<void> {
        const name = canonicalRoomName(roomName);
        const manifest = findManifest(this.catalog, moduleId);
        if (!manifest) {
            throw new BadRequestException(`Unknown module: ${moduleId}.`);
        }
        if (!(await this.prisma.room.findUnique({ where: { name }, select: { name: true } }))) {
            throw new NotFoundException('No such room.');
        }

        await this.prisma.$transaction(async (tx) => {
            await tx.roomModule.upsert({ where: { roomName_moduleId: { roomName: name, moduleId } }, create: { roomName: name, moduleId }, update: {} });

            if (manifest.requiresPrivate) {
                await tx.room.update({ where: { name }, data: { visibility: 'private' } });
            }

            if (manifest.creatorRole) {
                await tx.roomMemberModuleRole.upsert({
                    where: { roomName_userId_moduleId: { roomName: name, userId: byUserId, moduleId } },
                    create: { roomName: name, userId: byUserId, moduleId, role: manifest.creatorRole },
                    update: {},
                });
            }
        });
    }

    /**
     * Turns a module off.
     *
     * Deliberately does NOT restore public visibility, even if the module that forced it private is
     * the one being disabled. Privacy is easy to loosen by accident and hard to notice afterwards,
     * and a room that held an IEP discussion should not quietly become open to anyone with the name
     * because somebody tidied up the module list. Making it public again is a separate, deliberate
     * act — which setVisibility now permits, since nothing is blocking it.
     *
     * Role rows are kept, not deleted, so that re-enabling restores who was who. They grant nothing
     * meanwhile — see `contextFor`, which only reports roles for modules that are actually on.
     */
    async disableModule(roomName: string, moduleId: string): Promise<void> {
        const name = canonicalRoomName(roomName);
        await this.prisma.roomModule.deleteMany({ where: { roomName: name, moduleId } });
    }

    /**
     * The context a capability check needs, assembled from what is true right now.
     *
     * The filtering here is load-bearing. `capabilitiesFor` takes moduleRoles at face value and has
     * no idea which modules a room has enabled — so if a disabled module's role rows were reported,
     * turning the IEP module off would leave every `iep:` capability still granted, which is
     * precisely the opposite of what turning it off means. Roles for disabled modules are dropped
     * here, once, rather than every caller being trusted to remember.
     */
    async contextFor(roomName: string, userId: string): Promise<IRoomContext | null> {
        const name = canonicalRoomName(roomName);
        const [member, user, enabled] = await Promise.all([
            this.prisma.roomMember.findUnique({ where: { userId_roomName: { userId, roomName: name } }, select: { role: true } }),
            this.prisma.user.findUnique({ where: { id: userId }, select: { authKind: true } }),
            this.enabledModuleIds(name),
        ]);

        if (!member || !user) {
            return null;
        }

        const enabledSet = new Set(enabled);
        const roleRows = await this.prisma.roomMemberModuleRole.findMany({
            where: { roomName: name, userId },
            select: { moduleId: true, role: true },
        });

        const moduleRoles: Record<string, string> = {};
        for (const row of roleRows) {
            if (enabledSet.has(row.moduleId)) {
                moduleRoles[row.moduleId] = row.role;
            }
        }

        return { roomRole: member.role as RoomRole, authKind: user.authKind as AuthKind, moduleRoles };
    }

    private async enabledModuleIds(roomName: string): Promise<string[]> {
        const rows = await this.prisma.roomModule.findMany({ where: { roomName }, select: { moduleId: true } });
        return rows.map((row) => row.moduleId);
    }

    private async digestFor(passcode: string | null | undefined): Promise<string | null> {
        if (passcode === null || passcode === undefined || passcode === '') {
            return null;
        }
        if (!isAcceptablePasscode(passcode)) {
            throw new BadRequestException('That passcode is too short or too long.');
        }
        return hashPasscode(passcode);
    }
}
