import { IChatReactionGroup } from './interfaces/room.interfaces';

/** The columns of a ChatMessageReaction row this folding actually needs. */
export interface IChatReactionRow {
    userId: string;
    displayName: string;
    emoji: string;
    createdAt: Date;
}

/**
 * Folds raw reaction rows into the per-emoji groups the clients render.
 *
 * Lives here rather than on either service because both need the identical result: ChatService
 * attaches groups to every message in a history page, and ChatReactionService returns them for the
 * one message just toggled. Two implementations would eventually order differently, and a badge row
 * that reshuffles depending on whether it arrived via history or via a live update is exactly the
 * kind of drift that's invisible in tests and obvious in use.
 *
 * Ordering is by FIRST reaction, both between groups and within one. That's what keeps badges
 * stable: ordering groups by count instead would make them hop past each other every time someone
 * reacted, which is disorienting when the row is a fixed target you're trying to tap.
 */
export function groupReactions(rows: readonly IChatReactionRow[]): IChatReactionGroup[] {
    const byEmoji = new Map<string, { firstAt: number; group: IChatReactionGroup }>();
    // Sorted here rather than relying on the caller's query order, so the guarantee above holds for
    // any caller — including a Prisma `include`, whose nested rows come back unordered unless the
    // include itself asks otherwise.
    const sorted = [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

    for (const row of sorted) {
        const existing = byEmoji.get(row.emoji);
        if (existing) {
            existing.group.reactors.push({ userId: row.userId, displayName: row.displayName });
            continue;
        }
        byEmoji.set(row.emoji, {
            firstAt: row.createdAt.getTime(),
            group: { emoji: row.emoji, reactors: [{ userId: row.userId, displayName: row.displayName }] },
        });
    }

    return [...byEmoji.values()].sort((a, b) => a.firstAt - b.firstAt).map((entry) => entry.group);
}
