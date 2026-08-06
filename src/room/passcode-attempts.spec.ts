import { PasscodeAttempts } from './passcode-attempts';

const MINUTE = 60 * 1000;

function createAttempts() {
    let now = Date.now();
    const attempts = new PasscodeAttempts(() => now);
    return { attempts, advance: (ms: number) => (now += ms) };
}

function failTimes(attempts: PasscodeAttempts, count: number, room = 'standup', user = 'user-1'): void {
    for (let index = 0; index < count; index++) {
        attempts.recordFailure(room, user);
    }
}

describe('PasscodeAttempts', () => {
    it('starts unlocked', () => {
        const { attempts } = createAttempts();
        expect(attempts.isLocked('standup', 'user-1')).toBe(false);
    });

    // Generous, because a passcode is read out loud down a phone line and mistyped by people who
    // are nervous.
    it('tolerates a handful of wrong guesses', () => {
        const { attempts } = createAttempts();
        failTimes(attempts, 7);

        expect(attempts.isLocked('standup', 'user-1')).toBe(false);
    });

    it('locks out once the run gets long', () => {
        const { attempts } = createAttempts();
        failTimes(attempts, 8);

        expect(attempts.isLocked('standup', 'user-1')).toBe(true);
    });

    it('reports the moment the lockout begins', () => {
        const { attempts } = createAttempts();
        failTimes(attempts, 7);
        expect(attempts.recordFailure('standup', 'user-1')).toBe(true);
    });

    it('releases after the lockout elapses', () => {
        const { attempts, advance } = createAttempts();
        failTimes(attempts, 8);

        advance(16 * MINUTE);

        expect(attempts.isLocked('standup', 'user-1')).toBe(false);
    });

    // One person fat-fingering it must not lock the rest of a meeting out of joining — which, for a
    // scheduled IEP with an already-anxious parent, would be the worse failure.
    it('counts each person separately within the same room', () => {
        const { attempts } = createAttempts();
        failTimes(attempts, 8, 'standup', 'user-1');

        expect(attempts.isLocked('standup', 'user-1')).toBe(true);
        expect(attempts.isLocked('standup', 'user-2')).toBe(false);
    });

    it('counts each room separately for the same person', () => {
        const { attempts } = createAttempts();
        failTimes(attempts, 8, 'standup', 'user-1');

        expect(attempts.isLocked('other-room', 'user-1')).toBe(false);
    });

    it('forgets the run after a correct passcode', () => {
        const { attempts } = createAttempts();
        failTimes(attempts, 7);
        attempts.clear('standup', 'user-1');
        failTimes(attempts, 7);

        expect(attempts.isLocked('standup', 'user-1')).toBe(false);
    });

    // Patient guessing should not reset its way through, but a bad afternoon is forgotten by
    // tomorrow.
    it('starts a new run once the window has gone quiet', () => {
        const { attempts, advance } = createAttempts();
        failTimes(attempts, 7);

        advance(16 * MINUTE);
        failTimes(attempts, 7);

        expect(attempts.isLocked('standup', 'user-1')).toBe(false);
    });

    describe('prune', () => {
        it('drops entries nobody is counting any more', () => {
            const { attempts, advance } = createAttempts();
            failTimes(attempts, 1);

            advance(16 * MINUTE);
            attempts.prune();

            // Observable only through behaviour: a pruned entry means the next failure starts a
            // fresh run rather than continuing the old one.
            failTimes(attempts, 7);
            expect(attempts.isLocked('standup', 'user-1')).toBe(false);
        });

        it('keeps an active lockout', () => {
            const { attempts } = createAttempts();
            failTimes(attempts, 8);

            attempts.prune();

            expect(attempts.isLocked('standup', 'user-1')).toBe(true);
        });
    });
});
