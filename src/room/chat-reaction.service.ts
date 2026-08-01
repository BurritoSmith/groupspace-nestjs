import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { groupReactions } from './chat-reaction-grouping';
import { IChatReactionGroup } from './interfaces/room.interfaces';

/**
 * How many distinct emoji one person may hold on a single message.
 *
 * Stacking is deliberately allowed (one user can react with several different emoji), so without a
 * cap a single participant could paper a bubble with a hundred badges and push everyone else's chat
 * around. Twenty is far past what anyone does on purpose.
 */
export const MAX_REACTIONS_PER_USER_PER_MESSAGE = 20;

@Injectable()
export class ChatReactionService {
    private readonly logger = new Logger(ChatReactionService.name);

    constructor(private readonly prisma: PrismaService) {}

    /**
     * Adds this user's reaction, or removes it if they already had that exact emoji.
     *
     * Delete-first rather than create-and-catch-P2002: ordinary toggling off is then a normal query
     * result instead of exception-driven control flow, and the unique index still backs the "one row
     * per (message, user, emoji)" guarantee if two of this user's devices tap at the same instant.
     *
     * Awaited by the caller, unlike ChatService.saveMessage's fire-and-forget insert — see the
     * gateway handler for why a reaction persists before it broadcasts.
     */
    async toggle(messageId: string, userId: string, displayName: string, emoji: string): Promise<void> {
        const removed = await this.prisma.chatMessageReaction.deleteMany({ where: { messageId, userId, emoji } });
        if (removed.count > 0) {
            return;
        }
        const held = await this.prisma.chatMessageReaction.count({ where: { messageId, userId } });
        if (held >= MAX_REACTIONS_PER_USER_PER_MESSAGE) {
            this.logger.warn(`User ${userId} hit the reaction cap on message ${messageId}`);
            return;
        }
        await this.prisma.chatMessageReaction.create({ data: { messageId, userId, displayName, emoji } });
    }

    /** Every reaction on one message, folded into the shape clients render. */
    async listGrouped(messageId: string): Promise<IChatReactionGroup[]> {
        const rows = await this.prisma.chatMessageReaction.findMany({
            where: { messageId },
            orderBy: { createdAt: 'asc' },
            select: { userId: true, displayName: true, emoji: true, createdAt: true },
        });
        return groupReactions(rows);
    }
}
