import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { RoomRole, highestRoomRole, isRoomRole } from './capabilities';
import { IModuleManifest, MODULE_CATALOG, findManifest } from './module-manifest';
import { canonicalRoomName } from './room-name';

export interface IIssueInvitationInput {
    email: string;
    /** What they will be in the room. Defaults to `member`. */
    roomRole?: RoomRole;
    /** { moduleId: role } — validated against each module's own vocabulary. */
    moduleRoles?: Record<string, string>;
    expiresInDays?: number;
}

export interface IIssuedInvitation {
    id: string;
    token: string;
    email: string;
    roomRole: RoomRole;
    moduleRoles: Record<string, string>;
    expiresAt: Date;
}

const DEFAULT_EXPIRY_DAYS = 14;
const MAX_EXPIRY_DAYS = 90;
const TOKEN_BYTES = 32;

/** Ownership is not something you invite somebody into — it is transferred deliberately, by the
 *  owner, in its own act. Allowing it here would mean a moderator with room:invite could mint
 *  themselves a co-owner. */
const INVITABLE_ROLES: RoomRole[] = ['member', 'moderator'];

/**
 * Invitations into one room, carrying the roles the invitee will hold when they accept.
 *
 * Roles ride along on the invitation because an IEP meeting is convened before anybody joins: the
 * administrator knows the parent's address and what they are to the process days ahead. A meeting
 * that opens with everyone unroled, while the facilitator does admin and the team waits, is a
 * worse meeting.
 *
 * Note this is NOT `InvitationsService`, which is the global app-signup gate — a code that gets you
 * an account at all. The two were nearly given the same name and anything that conflates them hands
 * out the wrong kind of access.
 */
@Injectable()
export class RoomInvitationService {
    constructor(
        private readonly prisma: PrismaService,
        @Inject(MODULE_CATALOG) private readonly catalog: IModuleManifest[],
    ) {}

    async issue(roomName: string, invitedByUserId: string, input: IIssueInvitationInput): Promise<IIssuedInvitation> {
        const name = canonicalRoomName(roomName);
        const email = normalizeEmail(input.email);
        if (!looksLikeEmail(email)) {
            throw new BadRequestException('That does not look like an email address.');
        }

        const roomRole = input.roomRole ?? 'member';
        if (!isRoomRole(roomRole) || !INVITABLE_ROLES.includes(roomRole)) {
            throw new BadRequestException(`Cannot invite somebody as ${roomRole}.`);
        }

        const moduleRoles = input.moduleRoles ?? {};
        await this.validateModuleRoles(name, moduleRoles);

        // Clamped rather than rejected: an unreasonable expiry is a slider dragged too far, not an
        // attack, and refusing the whole request over it helps nobody.
        const days = Math.min(Math.max(Math.trunc(input.expiresInDays ?? DEFAULT_EXPIRY_DAYS), 1), MAX_EXPIRY_DAYS);
        const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

        const created = await this.prisma.roomInvitation.create({
            data: { roomName: name, email, roomRole, moduleRoles, token: randomBytes(TOKEN_BYTES).toString('base64url'), invitedByUserId, expiresAt },
            select: { id: true, token: true, email: true, roomRole: true, moduleRoles: true, expiresAt: true },
        });

        return {
            id: created.id,
            token: created.token,
            email: created.email,
            roomRole: created.roomRole as RoomRole,
            moduleRoles: created.moduleRoles as Record<string, string>,
            expiresAt: created.expiresAt,
        };
    }

    /**
     * Redeems an invitation for the signed-in user.
     *
     * The address is matched against `User.email`, which came from the verified Google profile at
     * sign-in — not from anything the client sends. A guest has no email at all and therefore can
     * never accept one, which is correct: an invitation names a person, and a passcode does not.
     */
    async accept(token: string, userId: string): Promise<{ roomName: string }> {
        const invitation = await this.prisma.roomInvitation.findUnique({ where: { token } });
        if (!invitation) {
            throw new NotFoundException('That invitation is not valid.');
        }
        if (invitation.acceptedAt) {
            throw new BadRequestException('That invitation has already been used.');
        }
        if (invitation.expiresAt.getTime() <= Date.now()) {
            throw new BadRequestException('That invitation has expired.');
        }

        const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
        if (!user?.email || normalizeEmail(user.email) !== normalizeEmail(invitation.email)) {
            // Deliberately the same message either way. Telling an unintended recipient WHICH
            // address an invitation was for leaks the attendee list of a meeting they are not part
            // of — which, for an IEP, names a child and who is involved in their education.
            throw new BadRequestException('That invitation is not for this account.');
        }

        const existing = await this.prisma.roomMember.findUnique({
            where: { userId_roomName: { userId, roomName: invitation.roomName } },
            select: { role: true },
        });
        // Never a demotion: an owner emailed an invitation to their own room as a member must not
        // accept their way out of owning it.
        const role = existing ? highestRoomRole(existing.role as RoomRole, invitation.roomRole as RoomRole) : (invitation.roomRole as RoomRole);
        const moduleRoles = (invitation.moduleRoles ?? {}) as Record<string, string>;

        await this.prisma.$transaction(async (tx) => {
            await tx.roomMember.upsert({
                where: { userId_roomName: { userId, roomName: invitation.roomName } },
                create: { userId, roomName: invitation.roomName, role },
                update: { role },
            });

            for (const [moduleId, moduleRole] of Object.entries(moduleRoles)) {
                await tx.roomMemberModuleRole.upsert({
                    where: { roomName_userId_moduleId: { roomName: invitation.roomName, userId, moduleId } },
                    create: { roomName: invitation.roomName, userId, moduleId, role: moduleRole },
                    update: { role: moduleRole },
                });
            }

            await tx.roomInvitation.update({ where: { id: invitation.id }, data: { acceptedByUserId: userId, acceptedAt: new Date() } });
        });

        return { roomName: invitation.roomName };
    }

    /** Outstanding invitations, for the room's own management screen. The token is NOT included —
     *  it is the credential, and a list endpoint should not hand out everybody else's. */
    async listPending(roomName: string): Promise<{ id: string; email: string; roomRole: string; expiresAt: Date }[]> {
        return this.prisma.roomInvitation.findMany({
            where: { roomName: canonicalRoomName(roomName), acceptedAt: null },
            select: { id: true, email: true, roomRole: true, expiresAt: true },
            orderBy: { createdAt: 'desc' },
        });
    }

    async revoke(roomName: string, invitationId: string): Promise<void> {
        // Scoped by room so an id from one room cannot revoke an invitation in another.
        await this.prisma.roomInvitation.deleteMany({ where: { id: invitationId, roomName: canonicalRoomName(roomName), acceptedAt: null } });
    }

    /**
     * A module role is only meaningful if the module is on and the module recognises the role.
     *
     * Both halves matter. Inviting somebody as an `iep:parent` to a room with no IEP module gives
     * them a row that grants nothing; inviting them as `iep:guardian` — a plausible word the module
     * does not use — does the same. Either way the failure is silent at the moment it matters, in a
     * meeting, so it is refused at the moment it is cheap.
     */
    private async validateModuleRoles(roomName: string, moduleRoles: Record<string, string>): Promise<void> {
        const entries = Object.entries(moduleRoles);
        if (entries.length === 0) {
            return;
        }

        const enabled = new Set((await this.prisma.roomModule.findMany({ where: { roomName }, select: { moduleId: true } })).map((row) => row.moduleId));

        for (const [moduleId, role] of entries) {
            if (!enabled.has(moduleId)) {
                throw new BadRequestException(`This room does not have the ${moduleId} module enabled.`);
            }
            const manifest = findManifest(this.catalog, moduleId);
            if (!manifest?.isRole(role)) {
                throw new BadRequestException(`${role} is not a role the ${moduleId} module recognises.`);
            }
        }
    }
}

function normalizeEmail(value: string): string {
    return value.trim().toLowerCase();
}

/** Deliberately shallow. Anything stricter rejects addresses that are perfectly valid — RFC 5322
 *  permits far more than people expect — and the real proof is whether it matches the verified
 *  Google address at accept time, which no amount of syntax checking here can substitute for. */
function looksLikeEmail(value: string): boolean {
    const at = value.indexOf('@');
    return at > 0 && at === value.lastIndexOf('@') && at < value.length - 1 && !/\s/.test(value);
}
