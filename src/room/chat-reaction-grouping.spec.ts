import { groupReactions } from './chat-reaction-grouping';

const THUMBS_UP = '\u{1F44D}';
const JOY = '\u{1F602}';
const HEART = '\u{2764}\u{FE0F}';

function row(userId: string, displayName: string, emoji: string, isoAt: string) {
    return { userId, displayName, emoji, createdAt: new Date(isoAt) };
}

describe('groupReactions', () => {
    it('orders groups by their first reaction, not by size', () => {
        // 👍 arrives first but ends up smaller. Ordering by count would put 😂 in front, and every
        // badge would then hop sideways the moment someone else reacted — the row is a tap target,
        // so it has to stay put.
        const groups = groupReactions([
            row('user-1', 'Clay', THUMBS_UP, '2026-08-01T10:00:00Z'),
            row('user-2', 'Kristin', JOY, '2026-08-01T10:00:01Z'),
            row('user-3', 'Iffy', JOY, '2026-08-01T10:00:02Z'),
            row('user-4', 'Sam', JOY, '2026-08-01T10:00:03Z'),
        ]);

        expect(groups.map((group) => group.emoji)).toEqual([THUMBS_UP, JOY]);
        expect(groups[1].reactors).toHaveLength(3);
    });

    it('orders reactors within a group oldest first', () => {
        const groups = groupReactions([
            row('user-2', 'Kristin', HEART, '2026-08-01T10:00:05Z'),
            row('user-1', 'Clay', HEART, '2026-08-01T10:00:01Z'),
        ]);

        expect(groups[0].reactors.map((reactor) => reactor.displayName)).toEqual(['Clay', 'Kristin']);
    });

    it('sorts rows itself rather than trusting the caller order', () => {
        // Prisma's nested `include` returns related rows unordered, so a caller that forgot an
        // orderBy would otherwise get badges in whatever order Postgres happened to hand back.
        const groups = groupReactions([
            row('user-3', 'Iffy', JOY, '2026-08-01T10:00:09Z'),
            row('user-1', 'Clay', THUMBS_UP, '2026-08-01T10:00:01Z'),
            row('user-2', 'Kristin', JOY, '2026-08-01T10:00:04Z'),
        ]);

        expect(groups.map((group) => group.emoji)).toEqual([THUMBS_UP, JOY]);
        expect(groups[1].reactors.map((reactor) => reactor.displayName)).toEqual(['Kristin', 'Iffy']);
    });

    it('keeps one user separate reactions as separate groups', () => {
        const groups = groupReactions([
            row('user-1', 'Clay', THUMBS_UP, '2026-08-01T10:00:01Z'),
            row('user-1', 'Clay', JOY, '2026-08-01T10:00:02Z'),
        ]);

        expect(groups).toHaveLength(2);
        expect(groups.every((group) => group.reactors.length === 1)).toBe(true);
    });

    it('returns nothing for no rows', () => {
        expect(groupReactions([])).toEqual([]);
    });
});
