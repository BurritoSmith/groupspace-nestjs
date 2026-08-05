import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface IMyRoom {
    name: string;
    lastJoinedAt: Date;
}

export interface IRoomMemberProfile {
    userId: string;
    displayName: string;
    pictureUrl: string;
}

/** How many of a user's most-recently-visited rooms the join-room typeahead offers — generous
 *  next to how many rooms any one person is likely to have ever typed in, not a hard product cap. */
const MY_ROOMS_LIMIT = 20;

/** Scaffolding for "has this user ever been in this room" — no permissions/roles yet, just enough
 *  to drive the join-room typeahead and gate push-notification eligibility. A row here is created
 *  (or its lastJoinedAt bumped) every time a user joins a room; see room.gateway.ts's onJoinRoom. */
@Injectable()
export class RoomMembershipService {
    constructor(private readonly prisma: PrismaService) {}

    async recordVisit(userId: string, roomName: string): Promise<void> {
        await this.prisma.roomMember.upsert({
            where: { userId_roomName: { userId, roomName } },
            create: {
                user: { connect: { id: userId } },
                room: { connectOrCreate: { where: { name: roomName }, create: { name: roomName } } },
            },
            update: {},
        });
    }

    async listForUser(userId: string): Promise<IMyRoom[]> {
        const rows = await this.prisma.roomMember.findMany({
            where: { userId },
            orderBy: { lastJoinedAt: 'desc' },
            take: MY_ROOMS_LIMIT,
            select: { roomName: true, lastJoinedAt: true },
        });
        return rows.map((row) => ({ name: row.roomName, lastJoinedAt: row.lastJoinedAt }));
    }

    /** Live profile fields, not a point-in-time snapshot — this feeds a presence-style avatar
     *  roster (who's ever been in this room, greyed out if not currently online), not chat
     *  history, so a since-renamed display name or new picture should show immediately. */
    async listMembersWithProfile(roomName: string): Promise<IRoomMemberProfile[]> {
        const rows = await this.prisma.roomMember.findMany({
            where: { roomName },
            select: { user: { select: { id: true, displayName: true, pictureUrl: true } } },
        });
        return rows.map((row) => ({ userId: row.user.id, displayName: row.user.displayName, pictureUrl: row.user.pictureUrl }));
    }
}
