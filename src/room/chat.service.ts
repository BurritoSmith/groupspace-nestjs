import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { IChatMessage } from './interfaces/room.interfaces';

export const HISTORY_PAGE_SIZE = 100;

@Injectable()
export class ChatService {
    private readonly logger = new Logger(ChatService.name);
    constructor(private readonly prisma: PrismaService) {}

    /** Fire-and-forget from the gateway — a slow/failed DB write must never delay real-time delivery. */
    saveMessage(id: string, roomName: string, userId: string, displayName: string, text: string, sentAt: Date): void {
        void this.prisma.chatMessage
            .create({
                data: {
                    id,
                    room: { connectOrCreate: { where: { name: roomName }, create: { name: roomName } } },
                    user: { connect: { id: userId } },
                    displayName,
                    text,
                    sentAt,
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

    private async queryPage(where: { roomName: string; sentAt?: { lt: Date } }, limit: number): Promise<IChatMessage[]> {
        const rows = await this.prisma.chatMessage.findMany({ where, orderBy: { sentAt: 'desc' }, take: limit });
        return rows.reverse().map((row) => ({
            id: row.id,
            userId: row.userId,
            displayName: row.displayName,
            text: row.text,
            at: row.sentAt.toISOString(),
        }));
    }
}
