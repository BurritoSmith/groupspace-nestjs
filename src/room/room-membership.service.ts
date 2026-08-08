import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface IMyRoom {
    name: string;
    /** What to CALL this room, when its name is a generated identifier. Null for an ordinary room,
     *  whose name is already its title. Never send one WITHOUT the other: the name is what a click
     *  navigates to, and the display name is the only part a person can recognise. */
    displayName: string | null;
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
                // `connect`, NOT connectOrCreate. This upsert is how every ownerless room in the
                // database was made: recording a visit quietly created whatever room had been
                // visited, so a room came into existence by being typed rather than by anybody
                // deciding to make one. The gateway refuses an unknown room before this runs, so a
                // missing room here is a bug rather than a case to paper over.
                room: { connect: { name: roomName } },
            },
            /*
             * Written explicitly, NOT left to `@updatedAt`.
             *
             * `update: {}` looks like the right way to say "the row already exists, just touch it",
             * and it is the wrong one: Prisma skips the UPDATE altogether when there is no data to
             * set, so @updatedAt never fires. lastJoinedAt then holds the moment the membership was
             * CREATED, for the rest of its life — and every feature that ranks rooms by recency
             * silently ranks them by first visit instead. Measured against the dev database: a room
             * joined minutes ago still reported a timestamp from a fortnight earlier.
             */
            update: { lastJoinedAt: new Date() },
        });
    }

    /** A room's human title, or null when its name IS its title (every ordinary room). Written only
     *  at creation and never updated, which is what lets callers cache the answer. */
    async findDisplayName(roomName: string): Promise<string | null> {
        const room = await this.prisma.room.findUnique({ where: { name: roomName }, select: { displayName: true } });
        return room?.displayName ?? null;
    }

    async listForUser(userId: string): Promise<IMyRoom[]> {
        const rows = await this.prisma.roomMember.findMany({
            where: { userId },
            orderBy: { lastJoinedAt: 'desc' },
            take: MY_ROOMS_LIMIT,
            // displayName comes along because a room whose NAME is a generated identifier has
            // nothing readable about it — the join screen would list sixteen random characters and
            // expect somebody to recognise their own meeting in it.
            select: { roomName: true, lastJoinedAt: true, room: { select: { displayName: true } } },
        });
        return rows.map((row) => ({ name: row.roomName, displayName: row.room.displayName, lastJoinedAt: row.lastJoinedAt }));
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
