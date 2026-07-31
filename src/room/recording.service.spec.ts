import { Test, TestingModule } from '@nestjs/testing';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
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
        function buildState(recordingService: RecordingService): IRoomRecordingState {
            const state: IRoomRecordingState = {
                roomName: 'room1',
                sessionDbId: 'session-1',
                sessionName: 'Test Session',
                startedAt: new Date(),
                videoSessions: new Map(),
                streamNumberCounters: new Map(),
                pendingFinalizations: new Set(),
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
                        filename: 'a.webm',
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
                filename: 'a.webm',
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
                filename: 'a.webm',
                gcsPath: 'room/session/a.webm',
                gcsUploadedAt: null,
                stoppedAt: new Date(),
                hasContent: true,
                thumbnailStatus: null,
                thumbnailUpdatedAt: null,
            });
            expect(url).toContain('/recordings/a.webm');
        });

        it('returns a null url when the recording stopped but never captured any content, even though stoppedAt is set', () => {
            return call({
                filename: 'a.webm',
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
                filename: 'a.webm',
                gcsPath: 'room/session/a.webm',
                gcsUploadedAt: new Date(),
                stoppedAt: new Date(),
                hasContent: false,
                thumbnailStatus: null,
                thumbnailUpdatedAt: null,
            }).then(({ url }) => expect(url).toBeNull());
        });

        it('returns a null thumbnailUrl when thumbnailStatus is null', async () => {
            const { thumbnailUrl } = await call({
                filename: 'a.webm',
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
                filename: 'a.webm',
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
            const result = (service as unknown as { tempRecordingPath: (p: string) => string }).tempRecordingPath('/recordings/a.webm');
            expect(result).toBe('/recordings/a.recording.webm');
        });

        it('derives the thumbnail path via string replace', () => {
            const result = (service as unknown as { thumbnailPath: (p: string) => string }).thumbnailPath('/recordings/a.webm');
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
            expect(result).toBe('lobby-mixed-audio-20260727T074320-audio-1.webm');
        });
    });

    describe('remuxToFinalFile', () => {
        it('returns false without invoking ffmpeg when the temp file is missing', async () => {
            const result = await (
                service as unknown as { remuxToFinalFile: (tempPath: string, finalPath: string) => Promise<boolean> }
            ).remuxToFinalFile('/nonexistent/path/does-not-exist.recording.webm', '/nonexistent/path/does-not-exist.webm');
            expect(result).toBe(false);
        });
    });

    // PlaybackSync lays every stream on one timeline as (recording.startedAt - session.startedAt),
    // so this value IS the stream's sync offset. Stamping it after the start verification made the
    // offset absorb however long that verification took — which differs per stream by construction
    // (audio resolves at the first ~500ms cluster; video also waits for a keyframe whose PLI is
    // only retried every 2s). Mic and webcam captured at the same instant were filed seconds apart,
    // and playback faithfully pulled them out of sync.
    describe('startVideoSession — startedAt is the media start, not the verification finish', () => {
        const RESUME_TIME = new Date('2026-01-01T00:00:00.000Z');
        const VERIFY_SECONDS = 3;

        let scratchDir: string;

        async function runStart(source: 'mic' | 'webcam'): Promise<Date> {
            const create = jest.fn().mockResolvedValue(null);
            const recordingService = new RecordingService({ recording: { create } } as never);
            // start() is what normally creates these, and this test calls startVideoSession
            // directly. Pointed at a fresh temp dir rather than relying on the service's default,
            // which otherwise only exists on a machine that has already run a recording — the
            // reason this passed locally and failed on a clean CI runner.
            Object.assign(recordingService as unknown as { sdpScratchDir: string; recordingsDir: string }, {
                sdpScratchDir: scratchDir,
                recordingsDir: scratchDir,
            });

            const consumer = {
                rtpParameters: { codecs: [{ mimeType: 'audio/opus', payloadType: 111, clockRate: 48000, channels: 2 }] },
                resume: jest.fn().mockResolvedValue(undefined),
                requestKeyFrame: jest.fn().mockResolvedValue(undefined),
                close: jest.fn(),
            };
            const router = {
                createPlainTransport: jest.fn().mockResolvedValue({
                    connect: jest.fn().mockResolvedValue(undefined),
                    consume: jest.fn().mockResolvedValue(consumer),
                    close: jest.fn(),
                }),
            };

            const internals = recordingService as unknown as {
                spawnFfmpegAndWaitReady: jest.Mock;
                waitForRecordingToStart: jest.Mock;
                generateLiveThumbnail: jest.Mock;
                startVideoSession: (state: unknown, router: unknown, info: unknown) => Promise<void>;
            };
            internals.spawnFfmpegAndWaitReady = jest.fn().mockResolvedValue({ exitCode: null, signalCode: null, kill: jest.fn() });
            // Stands in for the real verification's variable, per-stream delay.
            internals.waitForRecordingToStart = jest.fn().mockImplementation(async () => {
                jest.setSystemTime(new Date(RESUME_TIME.getTime() + VERIFY_SECONDS * 1000));
            });
            internals.generateLiveThumbnail = jest.fn().mockResolvedValue(undefined);

            const state = {
                roomName: 'mackie',
                sessionDbId: 'session-1',
                videoSessions: new Map(),
                streamNumberCounters: new Map(),
                pendingFinalizations: new Set(),
            };

            jest.setSystemTime(RESUME_TIME);
            await internals.startVideoSession(state, router, {
                producerId: `producer-${source}`,
                peerId: 'peer-1',
                userId: 'user-1',
                displayName: 'Clay',
                source,
            });

            return (create.mock.calls[0][0] as { data: { startedAt: Date } }).data.startedAt;
        }

        beforeEach(async () => {
            scratchDir = path.join(os.tmpdir(), `recording-start-test-${randomUUID()}`);
            await fs.mkdir(scratchDir, { recursive: true });
            jest.useFakeTimers();
        });

        afterEach(async () => {
            jest.useRealTimers();
            await fs.rm(scratchDir, { recursive: true, force: true }).catch(() => undefined);
        });

        it('files an audio stream at the moment its media started, not seconds later', async () => {
            expect(await runStart('mic')).toEqual(RESUME_TIME);
        });

        it('files a video stream at the same reference, so the two stay in sync', async () => {
            expect(await runStart('webcam')).toEqual(RESUME_TIME);
        });
    });

    describe('buildRecordingFfmpegArgs', () => {
        type BuildArgs = (sdpPath: string, tempOutputPath: string) => string[];

        it('stream-copies (no transcode) for any producer — mediasoup only ever negotiates VP8/Opus, which is already directly playable', () => {
            const buildArgs = (service as unknown as { buildRecordingFfmpegArgs: BuildArgs }).buildRecordingFfmpegArgs.bind(service);
            const args = buildArgs('/tmp/a.sdp', '/recordings/a.recording.webm');
            expect(args).toContain('-c');
            expect(args).toContain('copy');
            expect(args).toContain('-flush_packets');
            // No re-encode, so none of the old transcode-only flags should be present.
            expect(args).not.toContain('-c:v');
            expect(args).not.toContain('-c:a');
            expect(args).not.toContain('libx264');
            expect(args).not.toContain('aac');
            expect(args).not.toContain('-preset');
            expect(args).not.toContain('-force_key_frames');
            expect(args).not.toContain('-fps_mode');
            expect(args).not.toContain('-movflags');
        });

        it('targets the given temp output path', () => {
            const buildArgs = (service as unknown as { buildRecordingFfmpegArgs: BuildArgs }).buildRecordingFfmpegArgs.bind(service);
            const args = buildArgs('/tmp/a.sdp', '/recordings/a.recording.webm');
            expect(args[args.length - 1]).toBe('/recordings/a.recording.webm');
        });

        // Regression guard with a measured origin: without this, matroskaenc buffers a whole
        // cluster in memory before AVIO ever sees it, so the temp file stays at its 469-byte
        // header for ~5s (measured 4.84s mean cluster spacing on a real 27kbps mic capture).
        // waitForRecordingToStart polls for that file GROWING, so the default cluster interval put
        // ~5s of latency on every recording start. -flush_packets does not and cannot substitute.
        it('caps the muxer cluster interval so the temp file grows sub-second, not once per default 5s cluster', () => {
            const buildArgs = (service as unknown as { buildRecordingFfmpegArgs: BuildArgs }).buildRecordingFfmpegArgs.bind(service);
            const args = buildArgs('/tmp/a.sdp', '/recordings/a.recording.webm');

            const flagIndex = args.indexOf('-cluster_time_limit');
            expect(flagIndex).toBeGreaterThan(-1);
            expect(args[flagIndex + 1]).toBe('500');
            // A muxer private option — ffmpeg only applies it to the output it precedes.
            expect(flagIndex).toBeLessThan(args.length - 1);
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
            };
        }

        it('notifyProducerClosing() removes the session from videoSessions synchronously but tracks it in pendingFinalizations until it settles', async () => {
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
            await Promise.resolve();
            await Promise.resolve();
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

    describe('waitForRecordingToStart — failsafe for a producer that spawns fine but never delivers data', () => {
        type WaitFn = (tempPath: string, consumer: { requestKeyFrame: jest.Mock }, requestKeyframes: boolean) => Promise<void>;
        let tempPath: string;

        beforeEach(async () => {
            jest.useFakeTimers();
            tempPath = path.join(os.tmpdir(), `recording-test-${randomUUID()}.recording.webm`);
        });

        afterEach(async () => {
            jest.useRealTimers();
            await fs.unlink(tempPath).catch(() => undefined);
        });

        function callWait(consumer: { requestKeyFrame: jest.Mock }, requestKeyframes: boolean): Promise<void> {
            return (service as unknown as { waitForRecordingToStart: WaitFn }).waitForRecordingToStart(tempPath, consumer, requestKeyframes);
        }

        /** ffmpeg writes the container header the moment it opens the output, then appends media as
         *  it arrives — so "started" means the file GREW, which takes two polls to observe. */
        async function writeHeaderThenMedia(): Promise<void> {
            await fs.writeFile(tempPath, 'HEADER');
            await jest.advanceTimersByTimeAsync(500); // poll 1 records the header size
            await fs.writeFile(tempPath, 'HEADER+MEDIA');
            await jest.advanceTimersByTimeAsync(500); // poll 2 sees it grow
        }

        it('resolves once the temp file starts growing, without waiting for the full timeout', async () => {
            const consumer = { requestKeyFrame: jest.fn().mockResolvedValue(undefined) };
            const promise = callWait(consumer, true);
            let settled = false;
            void promise.then(() => (settled = true));

            await jest.advanceTimersByTimeAsync(500); // first poll tick — file still doesn't exist
            expect(settled).toBe(false);

            await writeHeaderThenMedia();

            await promise;
            expect(settled).toBe(true);
        });

        // The bug this check exists for: a capture that receives zero RTP still produces a
        // container header on disk (469 bytes of WebM/EBML in the real case), so treating
        // "non-empty" as success reported a working recording that held no media at all — and
        // stopped startVideoSession's retry loop from ever trying again.
        it('does not treat a header-only file that never grows as a successful start', async () => {
            const consumer = { requestKeyFrame: jest.fn().mockResolvedValue(undefined) };
            const promise = callWait(consumer, false);
            const assertion = expect(promise).rejects.toThrow(/No recording data received/);

            await fs.writeFile(tempPath, 'HEADER'); // written once, then never appended to
            await jest.advanceTimersByTimeAsync(15_000);

            await assertion;
        });

        it('re-requests a keyframe periodically (video) while waiting for data to arrive', async () => {
            const consumer = { requestKeyFrame: jest.fn().mockResolvedValue(undefined) };
            const promise = callWait(consumer, true);

            await jest.advanceTimersByTimeAsync(2000);
            expect(consumer.requestKeyFrame).toHaveBeenCalledTimes(1);
            await jest.advanceTimersByTimeAsync(2000);
            expect(consumer.requestKeyFrame).toHaveBeenCalledTimes(2);

            await writeHeaderThenMedia();
            await promise;
        });

        it('never requests a keyframe for audio — Opus has no keyframe concept', async () => {
            const consumer = { requestKeyFrame: jest.fn().mockResolvedValue(undefined) };
            const promise = callWait(consumer, false);

            await writeHeaderThenMedia();
            await promise;

            expect(consumer.requestKeyFrame).not.toHaveBeenCalled();
        });

        it('rejects once the verification timeout elapses with the file still empty/missing — the actual failsafe', async () => {
            const consumer = { requestKeyFrame: jest.fn().mockResolvedValue(undefined) };
            const promise = callWait(consumer, true);
            const assertion = expect(promise).rejects.toThrow(/No recording data received/);

            await jest.advanceTimersByTimeAsync(15_000);

            await assertion;
        });

        it('stops polling and stops re-requesting keyframes once settled — no lingering timers', async () => {
            const consumer = { requestKeyFrame: jest.fn().mockResolvedValue(undefined) };
            const promise = callWait(consumer, true);
            await writeHeaderThenMedia();
            await promise;

            expect(jest.getTimerCount()).toBe(0);
        });
    });
});
