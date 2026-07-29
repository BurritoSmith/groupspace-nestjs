import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { RecordingService } from './recording.service';
import { IRecordingVideoSession, IRoomRecordingState } from './interfaces/recording.interfaces';

function createFakePrisma() {
    return {
        recordingSession: { findUnique: jest.fn() },
        recordingEvent: { findMany: jest.fn().mockResolvedValue([]), create: jest.fn().mockResolvedValue({}) },
    };
}

describe('RecordingService', () => {
    let service: RecordingService;

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [RecordingService, { provide: PrismaService, useValue: {} }],
        }).compile();
        service = module.get<RecordingService>(RecordingService);
    });

    describe('getRecordingStartedAt', () => {
        // Regression coverage: a client joining mid-recording needs this to compute the true
        // elapsed time instead of starting its timer at 00:00 — see IJoinRoomResult
        // .recordingStartedAt's comment.
        it('returns the startedAt of the active recording session for a room', () => {
            const startedAt = new Date('2026-07-28T12:00:00.000Z');
            (service as unknown as { rooms: Map<string, IRoomRecordingState> }).rooms.set('room1', {
                roomName: 'room1',
                sessionDbId: 'session-1',
                sessionName: 'Test Session',
                startedAt,
                videoSessions: new Map(),
                streamNumberCounters: new Map(),
                pendingFinalizations: new Set(),
                opQueue: Promise.resolve(),
            });

            expect(service.getRecordingStartedAt('room1')).toBe(startedAt);
        });

        it('returns null for a room that is not currently recording', () => {
            expect(service.getRecordingStartedAt('room1')).toBeNull();
        });
    });

    describe('logEvent (private — exercised via notifyProducerCreated/notifyProducerClosing below)', () => {
        it('creates a RecordingEvent row with the given fields', () => {
            const fakePrisma = createFakePrisma();
            const recordingService = new RecordingService(fakePrisma as never);

            (
                recordingService as unknown as {
                    logEvent: (sessionId: string, type: 'join' | 'leave', peerId: string, userId: string | null, displayName: string) => void;
                }
            ).logEvent('session-1', 'join', 'peer-1', 'user-1', 'Alice');

            expect(fakePrisma.recordingEvent.create).toHaveBeenCalledWith({
                data: { sessionId: 'session-1', type: 'join', peerId: 'peer-1', userId: 'user-1', displayName: 'Alice' },
            });
        });
    });

    describe('notifyProducerCreated / notifyProducerClosing — join/leave timeline events', () => {
        // enqueueStart/enqueueStop's stagger pause (see RECORDING_STAGGER_MS) schedules a real
        // setTimeout otherwise, which outlives these synchronous tests and leaves Jest's worker
        // unable to exit cleanly — same reasoning as the enqueueStart/enqueueStop describe blocks
        // further down this file.
        beforeEach(() => jest.useFakeTimers());
        afterEach(() => jest.useRealTimers());

        function buildState(recordingService: RecordingService): IRoomRecordingState {
            const state: IRoomRecordingState = {
                roomName: 'room1',
                sessionDbId: 'session-1',
                sessionName: 'Test Session',
                startedAt: new Date(),
                videoSessions: new Map(),
                streamNumberCounters: new Map(),
                pendingFinalizations: new Set(),
                opQueue: Promise.resolve(),
            };
            (recordingService as unknown as { rooms: Map<string, IRoomRecordingState> }).rooms.set('room1', state);
            return state;
        }

        it("logs a 'join' event for a newly created mic producer", () => {
            const fakePrisma = createFakePrisma();
            const recordingService = new RecordingService(fakePrisma as never);
            buildState(recordingService);
            // startVideoSession itself isn't under test here — stub it out so this test only
            // exercises the join-logging side effect, not the real ffmpeg/mediasoup pipeline.
            (recordingService as unknown as { startVideoSession: jest.Mock }).startVideoSession = jest.fn().mockResolvedValue(undefined);

            recordingService.notifyProducerCreated('room1', {} as never, {
                producerId: 'producer-1',
                peerId: 'peer-1',
                userId: 'user-1',
                displayName: 'Alice',
                source: 'mic',
            });

            expect(fakePrisma.recordingEvent.create).toHaveBeenCalledWith({
                data: { sessionId: 'session-1', type: 'join', peerId: 'peer-1', userId: 'user-1', displayName: 'Alice' },
            });
        });

        it("does not log anything for a newly created webcam/screen producer", () => {
            const fakePrisma = createFakePrisma();
            const recordingService = new RecordingService(fakePrisma as never);
            buildState(recordingService);
            (recordingService as unknown as { startVideoSession: jest.Mock }).startVideoSession = jest.fn().mockResolvedValue(undefined);

            recordingService.notifyProducerCreated('room1', {} as never, {
                producerId: 'producer-1',
                peerId: 'peer-1',
                userId: 'user-1',
                displayName: 'Alice',
                source: 'webcam',
            });

            expect(fakePrisma.recordingEvent.create).not.toHaveBeenCalled();
        });

        it('does not log anything when the room is not being recorded', () => {
            const fakePrisma = createFakePrisma();
            const recordingService = new RecordingService(fakePrisma as never);

            recordingService.notifyProducerCreated('room1', {} as never, {
                producerId: 'producer-1',
                peerId: 'peer-1',
                userId: 'user-1',
                displayName: 'Alice',
                source: 'mic',
            });

            expect(fakePrisma.recordingEvent.create).not.toHaveBeenCalled();
        });

        it("logs a 'leave' event for a closing mic producer", () => {
            const fakePrisma = createFakePrisma();
            const recordingService = new RecordingService(fakePrisma as never);
            const state = buildState(recordingService);
            // notifyProducerClosing() kicks off a real finalizeVideoSession() otherwise, which
            // isn't under test here and would fail against this fake session.
            (recordingService as unknown as { finalizeVideoSession: jest.Mock }).finalizeVideoSession = jest.fn().mockResolvedValue(undefined);
            state.videoSessions.set('producer-1', {
                producerId: 'producer-1',
                peerId: 'peer-1',
                userId: 'user-1',
                displayName: 'Alice',
                source: 'mic',
            } as IRecordingVideoSession);

            recordingService.notifyProducerClosing('room1', 'producer-1');

            expect(fakePrisma.recordingEvent.create).toHaveBeenCalledWith({
                data: { sessionId: 'session-1', type: 'leave', peerId: 'peer-1', userId: 'user-1', displayName: 'Alice' },
            });
        });

        it('does not log anything for a closing webcam/screen producer', () => {
            const fakePrisma = createFakePrisma();
            const recordingService = new RecordingService(fakePrisma as never);
            const state = buildState(recordingService);
            (recordingService as unknown as { finalizeVideoSession: jest.Mock }).finalizeVideoSession = jest.fn().mockResolvedValue(undefined);
            state.videoSessions.set('producer-1', {
                producerId: 'producer-1',
                peerId: 'peer-1',
                userId: 'user-1',
                displayName: 'Alice',
                source: 'screen',
            } as IRecordingVideoSession);

            recordingService.notifyProducerClosing('room1', 'producer-1');

            expect(fakePrisma.recordingEvent.create).not.toHaveBeenCalled();
        });

        it('logs a fresh join/leave pair for every join/leave cycle of the same person within one recording', () => {
            const fakePrisma = createFakePrisma();
            const recordingService = new RecordingService(fakePrisma as never);
            const state = buildState(recordingService);
            (recordingService as unknown as { startVideoSession: jest.Mock }).startVideoSession = jest.fn().mockResolvedValue(undefined);
            // Stubbed the same way — notifyProducerClosing() kicks off a real finalizeVideoSession()
            // otherwise, which isn't under test here and would fail against these fake sessions.
            (recordingService as unknown as { finalizeVideoSession: jest.Mock }).finalizeVideoSession = jest.fn().mockResolvedValue(undefined);
            const micInfo = { producerId: 'producer-1', peerId: 'peer-1', userId: 'user-1', displayName: 'Alice', source: 'mic' as const };

            recordingService.notifyProducerCreated('room1', {} as never, micInfo); // 1st join
            state.videoSessions.set('producer-1', micInfo as unknown as IRecordingVideoSession);
            recordingService.notifyProducerClosing('room1', 'producer-1'); // 1st leave

            recordingService.notifyProducerCreated('room1', {} as never, { ...micInfo, producerId: 'producer-2' }); // 2nd join
            state.videoSessions.set('producer-2', { ...micInfo, producerId: 'producer-2' } as unknown as IRecordingVideoSession);
            recordingService.notifyProducerClosing('room1', 'producer-2'); // 2nd leave

            const types = (fakePrisma.recordingEvent.create as jest.Mock).mock.calls.map((call) => call[0].data.type);
            expect(types).toEqual(['join', 'leave', 'join', 'leave']);
        });
    });

    describe('getSessionDetail — timeline events', () => {
        it('merges persisted join/leave events with screenshare-start/end synthesized from screen recordings, sorted by time', async () => {
            const fakePrisma = createFakePrisma();
            fakePrisma.recordingSession.findUnique.mockResolvedValue({
                id: 'session-1',
                name: 'Test Session',
                roomName: 'room1',
                startedAt: new Date('2026-07-28T12:00:00.000Z'),
                stoppedAt: null,
                recordings: [
                    {
                        id: 'rec-1',
                        filename: 'a.mp4',
                        streamType: 'screen',
                        displayName: 'Alice',
                        userId: 'user-1',
                        user: { pictureUrl: null },
                        gcsPath: null,
                        gcsUploadedAt: null,
                        thumbnailStatus: null,
                        thumbnailUpdatedAt: null,
                        startedAt: new Date('2026-07-28T12:04:00.000Z'),
                        stoppedAt: new Date('2026-07-28T12:05:00.000Z'),
                        hasContent: true,
                    },
                ],
            });
            fakePrisma.recordingEvent.findMany.mockResolvedValue([
                { type: 'join', displayName: 'Alice', at: new Date('2026-07-28T12:00:00.000Z') },
                { type: 'leave', displayName: 'Bob', at: new Date('2026-07-28T12:10:00.000Z') },
            ]);
            const recordingService = new RecordingService(fakePrisma as never);

            const result = await recordingService.getSessionDetail('session-1');

            expect(result?.events.map((e) => e.type)).toEqual(['join', 'screenshare-start', 'screenshare-end', 'leave']);
            expect(result?.events[1]).toEqual({
                type: 'screenshare-start',
                displayName: 'Alice',
                at: '2026-07-28T12:04:00.000Z',
            });
        });

        it('returns an empty chatHistory — populated by RoomGateway, not RecordingService', async () => {
            const fakePrisma = createFakePrisma();
            fakePrisma.recordingSession.findUnique.mockResolvedValue({
                id: 'session-1',
                name: 'Test Session',
                roomName: 'room1',
                startedAt: new Date(),
                stoppedAt: null,
                recordings: [],
            });
            const recordingService = new RecordingService(fakePrisma as never);

            const result = await recordingService.getSessionDetail('session-1');

            expect(result?.chatHistory).toEqual([]);
        });
    });

    describe('buildPlaybackUrls (no RECORDINGS_GCS_BUCKET configured — local dev)', () => {
        const call = (row: Parameters<(typeof service)['buildPlaybackUrls']>[0]) =>
            (service as unknown as { buildPlaybackUrls: typeof service.buildPlaybackUrls }).buildPlaybackUrls(row);

        it('returns a null url before the recording has stopped', async () => {
            const { url } = await call({
                filename: 'a.mp4',
                gcsPath: null,
                gcsUploadedAt: null,
                stoppedAt: null,
                hasContent: true,
                thumbnailStatus: null,
                thumbnailUpdatedAt: null,
            });
            expect(url).toBeNull();
        });

        it('serves the local file URL once stopped, even with a gcsPath assigned but not yet uploaded', async () => {
            const { url } = await call({
                filename: 'a.mp4',
                gcsPath: 'room/session/a.mp4',
                gcsUploadedAt: null,
                stoppedAt: new Date(),
                hasContent: true,
                thumbnailStatus: null,
                thumbnailUpdatedAt: null,
            });
            expect(url).toContain('/recordings/a.mp4');
        });

        it('returns a null url when the recording stopped but never captured any content, even though stoppedAt is set', () => {
            return call({
                filename: 'a.mp4',
                gcsPath: null,
                gcsUploadedAt: null,
                stoppedAt: new Date(),
                hasContent: false,
                thumbnailStatus: null,
                thumbnailUpdatedAt: null,
            }).then(({ url }) => expect(url).toBeNull());
        });

        it('returns a null url for a zero-content recording even once a gcsPath/gcsUploadedAt exist', () => {
            // Shouldn't happen in practice (uploadAndNotify is gated on hasContent too), but
            // buildPlaybackUrls must never link to a nonexistent file regardless of upload state.
            return call({
                filename: 'a.mp4',
                gcsPath: 'room/session/a.mp4',
                gcsUploadedAt: new Date(),
                stoppedAt: new Date(),
                hasContent: false,
                thumbnailStatus: null,
                thumbnailUpdatedAt: null,
            }).then(({ url }) => expect(url).toBeNull());
        });

        it('returns a null thumbnailUrl when thumbnailStatus is null', async () => {
            const { thumbnailUrl } = await call({
                filename: 'a.mp4',
                gcsPath: null,
                gcsUploadedAt: null,
                stoppedAt: new Date(),
                hasContent: true,
                thumbnailStatus: null,
                thumbnailUpdatedAt: null,
            });
            expect(thumbnailUrl).toBeNull();
        });

        it('builds a cache-busted thumbnail URL when a thumbnail exists', async () => {
            const updatedAt = new Date('2026-01-01T00:00:00Z');
            const { thumbnailUrl } = await call({
                filename: 'a.mp4',
                gcsPath: null,
                gcsUploadedAt: null,
                stoppedAt: new Date(),
                hasContent: true,
                thumbnailStatus: 'live',
                thumbnailUpdatedAt: updatedAt,
            });
            expect(thumbnailUrl).toContain('a.thumb.jpg');
            expect(thumbnailUrl).toContain(`?v=${updatedAt.getTime()}`);
        });
    });

    describe('path helpers', () => {
        it('derives the temp recording path via string replace', () => {
            const result = (service as unknown as { tempRecordingPath: (p: string) => string }).tempRecordingPath('/recordings/a.mp4');
            expect(result).toBe('/recordings/a.recording.mp4');
        });

        it('derives the thumbnail path via string replace', () => {
            const result = (service as unknown as { thumbnailPath: (p: string) => string }).thumbnailPath('/recordings/a.mp4');
            expect(result).toBe('/recordings/a.thumb.jpg');
        });
    });

    describe('buildFilename', () => {
        type BuildFilename = (
            roomName: string,
            username: string,
            streamType: string,
            streamNumber: number,
            timestamp: string,
            peerId?: string,
        ) => string;

        it('produces different filenames for two peers with the same display name, stream type, and timestamp', () => {
            const buildFilename = (service as unknown as { buildFilename: BuildFilename }).buildFilename.bind(service);
            // Regression test: this exact collision (same displayName — e.g. the same Google
            // account signed in on two devices — same streamType, same second-resolution
            // timestamp, and each peer's own streamNumber independently starting at 1) produced
            // an identical filename for both peers, so their ffmpeg processes wrote to the same
            // temp file on disk and silently corrupted one of the two recordings.
            const first = buildFilename('lobby', 'Clay Crosland', 'webcam', 1, '20260727T074320', 'peer-aaa');
            const second = buildFilename('lobby', 'Clay Crosland', 'webcam', 1, '20260727T074320', 'peer-bbb');
            expect(first).not.toBe(second);
        });

        it('omits the peerId segment entirely when none is given', () => {
            const buildFilename = (service as unknown as { buildFilename: BuildFilename }).buildFilename.bind(service);
            const result = buildFilename('lobby', 'mixed-audio', 'audio', 1, '20260727T074320');
            expect(result).toBe('lobby-mixed-audio-20260727T074320-audio-1.mp4');
        });
    });

    describe('remuxToFinalFile', () => {
        it('returns false without invoking ffmpeg when the temp file is missing', async () => {
            const result = await (
                service as unknown as { remuxToFinalFile: (tempPath: string, finalPath: string) => Promise<boolean> }
            ).remuxToFinalFile('/nonexistent/path/does-not-exist.recording.mp4', '/nonexistent/path/does-not-exist.mp4');
            expect(result).toBe(false);
        });
    });

    describe('buildRecordingFfmpegArgs', () => {
        type BuildArgs = (isAudio: boolean, sdpPath: string, tempOutputPath: string) => string[];

        it('chooses the AAC audio codec (no video codec) when recording a mic producer', () => {
            const buildArgs = (service as unknown as { buildRecordingFfmpegArgs: BuildArgs }).buildRecordingFfmpegArgs.bind(service);
            const args = buildArgs(true, '/tmp/a.sdp', '/recordings/a.recording.mp4');
            expect(args).toContain('-c:a');
            expect(args).toContain('aac');
            expect(args).not.toContain('-c:v');
            expect(args).not.toContain('libx264');
            // Audio has no keyframe concept — fragments every frame instead.
            expect(args).toContain('+frag_every_frame+empty_moov+faststart');
        });

        it('chooses the H.264 video codec (no audio codec) when recording a webcam/screen producer', () => {
            const buildArgs = (service as unknown as { buildRecordingFfmpegArgs: BuildArgs }).buildRecordingFfmpegArgs.bind(service);
            const args = buildArgs(false, '/tmp/a.sdp', '/recordings/a.recording.mp4');
            expect(args).toContain('-c:v');
            expect(args).toContain('libx264');
            expect(args).not.toContain('-c:a');
            expect(args).not.toContain('aac');
            expect(args).toContain('+frag_keyframe+empty_moov+faststart');
        });
    });

    describe('pendingFinalizations — race between an individually-stopped stream and stopping the whole recording', () => {
        // Regression test: "stop all streams" closes several producers individually (each
        // removed from videoSessions synchronously, with its finalization kicked off
        // fire-and-forget) immediately before stopping the recording itself. Without
        // pendingFinalizations, teardownRoom() would see an empty videoSessions map for an
        // already-closing producer and not wait for it, letting the recording session get
        // marked stopped while that producer's file was still mid-finalization.
        function buildState(): IRoomRecordingState {
            return {
                roomName: 'room1',
                sessionDbId: 'session-1',
                sessionName: 'Test Session',
                startedAt: new Date('2026-07-28T12:00:00.000Z'),
                videoSessions: new Map([['producer-1', {} as IRecordingVideoSession]]),
                streamNumberCounters: new Map(),
                pendingFinalizations: new Set(),
                opQueue: Promise.resolve(),
            };
        }

        afterEach(() => {
            jest.useRealTimers();
        });

        it('notifyProducerClosing() removes the session from videoSessions synchronously but tracks it in pendingFinalizations until it settles', async () => {
            jest.useFakeTimers();
            const state = buildState();
            let resolveFinalize!: () => void;
            const finalizeSpy = jest
                .fn()
                .mockReturnValue(new Promise<void>((resolve) => (resolveFinalize = resolve)));
            (service as unknown as { finalizeVideoSession: typeof finalizeSpy }).finalizeVideoSession = finalizeSpy;
            (service as unknown as { rooms: Map<string, IRoomRecordingState> }).rooms.set('room1', state);

            (service as unknown as { notifyProducerClosing: (roomName: string, producerId: string) => void }).notifyProducerClosing(
                'room1',
                'producer-1',
            );

            expect(state.videoSessions.size).toBe(0); // removed immediately, before finalization even starts
            expect(state.pendingFinalizations.size).toBe(1); // but tracked as in-flight

            resolveFinalize();
            // Now routed through enqueueStop() (see notifyProducerClosing()), which adds an extra
            // promise-chain hop before the .finally() cleanup fires — advancing timers also drains
            // the extra microtask ticks that plain awaits below no longer reliably cover.
            await jest.advanceTimersByTimeAsync(500);
            expect(state.pendingFinalizations.size).toBe(0); // cleaned up once settled
        });

        it("teardownRoom() waits for a finalization already kicked off by notifyProducerClosing, not just what's still in videoSessions", async () => {
            const state = buildState();
            let finalized = false;
            const finalizeSpy = jest.fn().mockImplementation(
                () =>
                    new Promise<void>((resolve) =>
                        setTimeout(() => {
                            finalized = true;
                            resolve();
                        }, 10),
                    ),
            );
            (service as unknown as { finalizeVideoSession: typeof finalizeSpy }).finalizeVideoSession = finalizeSpy;
            (service as unknown as { rooms: Map<string, IRoomRecordingState> }).rooms.set('room1', state);

            // Simulates "stop all streams": the producer closes individually, moments before
            // the recording itself is stopped — videoSessions is already empty by the time
            // teardownRoom() runs.
            (service as unknown as { notifyProducerClosing: (roomName: string, producerId: string) => void }).notifyProducerClosing(
                'room1',
                'producer-1',
            );
            expect(state.videoSessions.size).toBe(0);

            await (service as unknown as { teardownRoom: (state: IRoomRecordingState) => Promise<void> }).teardownRoom(state);

            expect(finalized).toBe(true); // teardownRoom() genuinely waited for it, not a no-op
        });
    });

    describe('enqueueOp — throttling concurrent recording starts/stops within a room', () => {
        // Regression coverage for two incidents plus the gap between them:
        // - "hunch"/"hunchimus prime": several producers starting within the same few seconds
        //   spawned that many CPU-heavy ffmpeg encoders at once, starving one or more of them
        //   badly enough that they never wrote a usable frame.
        // - room "afcu", session "Checking": several finalizes (ffmpeg graceful-quit + remux)
        //   firing at once starved one out of its 5s SIGKILL grace period, corrupting its file.
        // - the gap: starts and stops used to run on two INDEPENDENT queues, so a stream's
        //   finalize (stop) and a *different* stream's start could still land in the same
        //   instant — exactly what corrupted a rejoining participant's mic recording when their
        //   leave's finalize and their rejoin's start happened close together. enqueueOp() is the
        //   single shared FIFO chain that closes all three cases at once.
        function buildState(): IRoomRecordingState {
            return {
                roomName: 'room1',
                sessionDbId: 'session-1',
                sessionName: 'Test Session',
                startedAt: new Date('2026-07-28T12:00:00.000Z'),
                videoSessions: new Map(),
                streamNumberCounters: new Map(),
                pendingFinalizations: new Set(),
                opQueue: Promise.resolve(),
            };
        }

        type EnqueueOp = (state: IRoomRecordingState, run: () => Promise<void>) => Promise<void>;
        const enqueueOp = (state: IRoomRecordingState, run: () => Promise<void>) =>
            (service as unknown as { enqueueOp: EnqueueOp }).enqueueOp.call(service, state, run);

        afterEach(() => {
            jest.useRealTimers();
        });

        it('does not begin the second queued start until the first has settled plus the stagger delay', async () => {
            jest.useFakeTimers();
            const state = buildState();
            const order: string[] = [];

            const first = enqueueOp(state, async () => {
                order.push('first-start');
            });
            const second = enqueueOp(state, async () => {
                order.push('second-start');
            });

            await Promise.resolve();
            await Promise.resolve();
            expect(order).toEqual(['first-start']); // second is still waiting on the stagger delay

            await jest.advanceTimersByTimeAsync(500);
            expect(order).toEqual(['first-start', 'second-start']);

            await Promise.all([first, second]);
        });

        it("a rejected start doesn't jam the queue for the next one", async () => {
            jest.useFakeTimers();
            const state = buildState();
            const order: string[] = [];

            const first = enqueueOp(state, async () => {
                throw new Error('boom');
            });
            first.catch(() => undefined); // observed below via expect().rejects — prevents an unhandled-rejection warning in the meantime
            const second = enqueueOp(state, async () => {
                order.push('second-start');
            });

            await jest.advanceTimersByTimeAsync(500);

            expect(order).toEqual(['second-start']);
            await expect(first).rejects.toThrow('boom');
            await second;
        });

        it('does not begin the second queued stop until the first has settled plus the stagger delay', async () => {
            jest.useFakeTimers();
            const state = buildState();
            const order: string[] = [];

            const first = enqueueOp(state, async () => {
                order.push('first-stop');
            });
            const second = enqueueOp(state, async () => {
                order.push('second-stop');
            });

            await Promise.resolve();
            await Promise.resolve();
            expect(order).toEqual(['first-stop']); // second is still waiting on the stagger delay

            await jest.advanceTimersByTimeAsync(500);
            expect(order).toEqual(['first-stop', 'second-stop']);

            await Promise.all([first, second]);
        });

        it("a rejected stop doesn't jam the queue for the next one", async () => {
            jest.useFakeTimers();
            const state = buildState();
            const order: string[] = [];

            const first = enqueueOp(state, async () => {
                throw new Error('boom');
            });
            first.catch(() => undefined);
            const second = enqueueOp(state, async () => {
                order.push('second-stop');
            });

            await jest.advanceTimersByTimeAsync(500);

            expect(order).toEqual(['second-stop']);
            await expect(first).rejects.toThrow('boom');
            await second;
        });

        it('a queued start does not begin until an earlier-queued stop for a DIFFERENT stream has settled plus the stagger delay', async () => {
            jest.useFakeTimers();
            const state = buildState();
            const order: string[] = [];

            const stop = enqueueOp(state, async () => {
                order.push('stop');
            });
            const start = enqueueOp(state, async () => {
                order.push('start');
            });

            await Promise.resolve();
            await Promise.resolve();
            expect(order).toEqual(['stop']); // the start is still waiting on the stop's stagger delay

            await jest.advanceTimersByTimeAsync(500);
            expect(order).toEqual(['stop', 'start']);

            await Promise.all([stop, start]);
        });

        it('teardownRoom() staggers finalizing every still-open session instead of finalizing them all at once', async () => {
            jest.useFakeTimers();
            const state = buildState();
            state.videoSessions.set('producer-1', { producerId: 'producer-1' } as IRecordingVideoSession);
            state.videoSessions.set('producer-2', { producerId: 'producer-2' } as IRecordingVideoSession);
            const order: string[] = [];
            const finalizeSpy = jest.fn().mockImplementation(async (_state: IRoomRecordingState, session: IRecordingVideoSession) => {
                order.push(session.producerId);
            });
            (service as unknown as { finalizeVideoSession: typeof finalizeSpy }).finalizeVideoSession = finalizeSpy;

            const teardown = (service as unknown as { teardownRoom: (state: IRoomRecordingState) => Promise<void> }).teardownRoom(state);

            await Promise.resolve();
            await Promise.resolve();
            expect(order).toEqual(['producer-1']); // second session's finalize hasn't started yet

            await jest.advanceTimersByTimeAsync(500);
            expect(order).toEqual(['producer-1', 'producer-2']);

            await teardown;
        });
    });
});
