import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { IChatReactionRow, groupReactions } from './chat-reaction-grouping';
import { IChatAttachment, IChatMessage, ILinkPreview } from './interfaces/room.interfaces';

export const HISTORY_PAGE_SIZE = 100;

/** Pulled with every history query. Only the four columns the grouping needs — a history page can
 *  carry hundreds of messages, and there's no reason to ship reaction ids and message back-refs
 *  across for each one. */
const REACTIONS_INCLUDE = {
    reactions: { select: { userId: true, displayName: true, emoji: true, createdAt: true } },
} as const;

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

    /**
     * Attaches a scraped link preview to an already-persisted message.
     *
     * Separate from saveMessage because the scrape is far too slow to sit on the send path — the
     * message is broadcast and saved first, and this patches it a moment later (see
     * room.gateway.ts's follow-up 'chat-message-updated' emit).
     *
     * Tolerates the row not existing: saveMessage is itself fire-and-forget, so a preview can
     * genuinely finish before the insert it belongs to, and neither ordering is worth blocking on
     * for a decoration.
     */
    async updateLinkPreview(id: string, linkPreview: ILinkPreview): Promise<void> {
        try {
            await this.prisma.chatMessage.update({
                where: { id },
                data: { linkPreview: linkPreview as unknown as Prisma.InputJsonValue },
            });
        } catch (error: unknown) {
            this.logger.warn(`Failed to persist link preview for chat message ${id}: ${error}`);
        }
    }

    /**
     * Replaces an already-persisted message's whole attachments array — used to patch in a
     * server-regenerated video poster (see RoomGateway.ensureVideoPosters). Mirrors
     * updateLinkPreview exactly: same fire-and-forget-tolerant shape (the row may not exist yet,
     * since saveMessage is itself fire-and-forget), same try/catch/log-warning on failure.
     */
    async updateAttachments(id: string, attachments: IChatAttachment[]): Promise<void> {
        try {
            await this.prisma.chatMessage.update({
                where: { id },
                data: { attachments: attachments as unknown as Prisma.InputJsonValue },
            });
        } catch (error: unknown) {
            this.logger.warn(`Failed to persist updated attachments for chat message ${id}: ${error}`);
        }
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
     *  whole thing in one shot, oldest-first. Excludes deleted messages, same as the live history —
     *  see queryPage's own comment. */
    async getHistoryForSession(roomName: string, startedAt: Date, stoppedAt: Date | null): Promise<IChatMessage[]> {
        const rows = await this.prisma.chatMessage.findMany({
            where: { roomName, sentAt: { gte: startedAt, lte: stoppedAt ?? new Date() }, deleted: false },
            orderBy: { sentAt: 'asc' },
            include: REACTIONS_INCLUDE,
        });
        return rows.map((row) => this.toChatMessage(row));
    }

    /** `deleted: false` on every history query — a soft-deleted message is a database concern only
     *  (see softDelete's own comment), not something a fresh page load or a later rejoin should ever
     *  see. A client already viewing the room when a delete happens instead reacts to the live
     *  'chat-message-updated' broadcast — see RoomGateway.onChatMessageDelete and Chat.messages on
     *  the frontend, which filters a flagged message out of what it renders. */
    private async queryPage(where: { roomName: string; sentAt?: { lt: Date } }, limit: number): Promise<IChatMessage[]> {
        const rows = await this.prisma.chatMessage.findMany({
            where: { ...where, deleted: false },
            orderBy: { sentAt: 'desc' },
            take: limit,
            include: REACTIONS_INCLUDE,
        });
        return rows.reverse().map((row) => this.toChatMessage(row));
    }

    /**
     * Soft-deletes a message — flips `deleted` rather than removing the row, so the underlying
     * record survives, but every history query above excludes it from that point on: the sender's
     * own request was to remove it from the conversation, not merely mark it, so nothing renders a
     * "deleted" placeholder in its place either. A client already viewing the room when this happens
     * gets the same result via the live 'chat-message-updated' broadcast below.
     *
     * Authorization IS the write: `updateMany({ where: { id, userId } })` only touches a row that
     * both exists AND belongs to this user, so `count === 0` covers "not found" and "not yours" in
     * one check — same idiom as ChatReactionService.toggle's own deleteMany/count check.
     */
    async softDelete(messageId: string, userId: string): Promise<boolean> {
        const result = await this.prisma.chatMessage.updateMany({
            where: { id: messageId, userId },
            data: { deleted: true },
        });
        return result.count > 0;
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
        deleted: boolean;
        reactions?: IChatReactionRow[];
    }): IChatMessage {
        // Folded into groups here rather than by the query: the shape clients render is per-emoji,
        // and Postgres has no reason to know that. groupReactions is shared with
        // ChatReactionService so a live toggle and a history page can't order badges differently.
        const reactions = row.reactions && row.reactions.length > 0 ? groupReactions(row.reactions) : undefined;
        return {
            id: row.id,
            userId: row.userId,
            displayName: row.displayName,
            pictureUrl: row.pictureUrl ?? '',
            text: row.text,
            at: row.sentAt.toISOString(),
            attachments: (row.attachments as IChatAttachment[] | null) ?? undefined,
            linkPreview: (row.linkPreview as ILinkPreview | null) ?? undefined,
            reactions,
            deleted: row.deleted || undefined,
        };
    }
}
