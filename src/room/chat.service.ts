import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { IChatAttachment, IChatMessage, ILinkPreview } from './interfaces/room.interfaces';

export const HISTORY_PAGE_SIZE = 100;

@Injectable()
export class ChatService {
    private readonly logger = new Logger(ChatService.name);
    constructor(private readonly prisma: PrismaService) {}

    /** Fire-and-forget from the gateway — a slow/failed DB write must never delay real-time delivery. */
    saveMessage(
        id: string,
        roomName: string,
        userId: string,
        displayName: string,
        pictureUrl: string,
        text: string,
        sentAt: Date,
        attachments?: IChatAttachment[],
    ): void {
        void this.prisma.chatMessage
            .create({
                data: {
                    id,
                    room: { connectOrCreate: { where: { name: roomName }, create: { name: roomName } } },
                    user: { connect: { id: userId } },
                    displayName,
                    pictureUrl: pictureUrl || null,
                    text,
                    sentAt,
                    attachments: attachments && attachments.length > 0 ? (attachments as unknown as Prisma.InputJsonValue) : undefined,
                },
            })
            .catch((error: unknown) => this.logger.error(`Failed to persist chat message ${id} in room ${roomName}: ${error}`));
    }

    /** Awaited — a read for the join-room ack, not a write; no "don't block" concern applies. Most recent page, oldest-first. */
    async getRecentHistory(roomName: string, limit = HISTORY_PAGE_SIZE): Promise<IChatMessage[]> {
        return this.queryPage({ roomName }, limit);
    }

    /** Next OLDER page, for infinite-scroll-up pagination — everything strictly before the oldest currently-loaded message. */
    async getMessagesBefore(roomName: string, before: Date, limit = HISTORY_PAGE_SIZE): Promise<IChatMessage[]> {
        return this.queryPage({ roomName, sentAt: { lt: before } }, limit);
    }

    /** Every message sent in a room during one recording session's time window — for the playback
     *  page's read-only chat replay panel. Unlike getRecentHistory/getMessagesBefore (unbounded
     *  room history, paginated), a session's own window is inherently bounded, so this fetches the
     *  whole thing in one shot, oldest-first. */
    async getHistoryForSession(roomName: string, startedAt: Date, stoppedAt: Date | null): Promise<IChatMessage[]> {
        const rows = await this.prisma.chatMessage.findMany({
            where: { roomName, sentAt: { gte: startedAt, lte: stoppedAt ?? new Date() } },
            orderBy: { sentAt: 'asc' },
        });
        return rows.map((row) => this.toChatMessage(row));
    }

    private async queryPage(where: { roomName: string; sentAt?: { lt: Date } }, limit: number): Promise<IChatMessage[]> {
        const rows = await this.prisma.chatMessage.findMany({ where, orderBy: { sentAt: 'desc' }, take: limit });
        return rows.reverse().map((row) => this.toChatMessage(row));
    }

    private toChatMessage(row: {
        id: string;
        userId: string;
        displayName: string;
        pictureUrl: string | null;
        text: string;
        sentAt: Date;
        attachments: unknown;
        linkPreview: unknown;
    }): IChatMessage {
        return {
            id: row.id,
            userId: row.userId,
            displayName: row.displayName,
            pictureUrl: row.pictureUrl ?? '',
            text: row.text,
            at: row.sentAt.toISOString(),
            attachments: (row.attachments as IChatAttachment[] | null) ?? undefined,
            linkPreview: (row.linkPreview as ILinkPreview | null) ?? undefined,
        };
    }
}
