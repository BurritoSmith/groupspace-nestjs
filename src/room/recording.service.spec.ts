import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { RecordingService } from './recording.service';
import { IRecordingVideoSession, IRoomRecordingState } from './interfaces/recording.interfaces';

describe('RecordingService', () => {
    let service: RecordingService;

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [RecordingService, { provide: PrismaService, useValue: {} }],
        }).compile();
        service = module.get<RecordingService>(RecordingService);
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
                videoSessions: new Map([['producer-1', {} as IRecordingVideoSession]]),
                streamNumberCounters: new Map(),
                pendingFinalizations: new Set(),
                startQueue: Promise.resolve(),
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
            await Promise.resolve(); // let the .finally() cleanup microtask run
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

    describe('enqueueStart — throttling concurrent recording starts within a room', () => {
        // Regression test for the "hunch"/"hunchimus prime" incident: several producers (a
        // user's webcam+screen+mic, or several users' streams) starting within the same few
        // seconds spawned that many CPU-heavy ffmpeg encoders at once, starving one or more of
        // them badly enough that they never wrote a usable frame. enqueueStart() serializes
        // starts per room with a settle pause between them instead.
        function buildState(): IRoomRecordingState {
            return {
                roomName: 'room1',
                sessionDbId: 'session-1',
                sessionName: 'Test Session',
                videoSessions: new Map(),
                streamNumberCounters: new Map(),
                pendingFinalizations: new Set(),
                startQueue: Promise.resolve(),
            };
        }

        type EnqueueStart = (state: IRoomRecordingState, run: () => Promise<void>) => Promise<void>;
        const enqueueStart = (state: IRoomRecordingState, run: () => Promise<void>) =>
            (service as unknown as { enqueueStart: EnqueueStart }).enqueueStart.call(service, state, run);

        afterEach(() => {
            jest.useRealTimers();
        });

        it('does not begin the second queued start until the first has settled plus the stagger delay', async () => {
            jest.useFakeTimers();
            const state = buildState();
            const order: string[] = [];

            const first = enqueueStart(state, async () => {
                order.push('first-start');
            });
            const second = enqueueStart(state, async () => {
                order.push('second-start');
            });

            await Promise.resolve();
            await Promise.resolve();
            expect(order).toEqual(['first-start']); // second is still waiting on the stagger delay

            await jest.advanceTimersByTimeAsync(2000);
            expect(order).toEqual(['first-start', 'second-start']);

            await Promise.all([first, second]);
        });

        it("a rejected start doesn't jam the queue for the next one", async () => {
            jest.useFakeTimers();
            const state = buildState();
            const order: string[] = [];

            const first = enqueueStart(state, async () => {
                throw new Error('boom');
            });
            first.catch(() => undefined); // observed below via expect().rejects — prevents an unhandled-rejection warning in the meantime
            const second = enqueueStart(state, async () => {
                order.push('second-start');
            });

            await jest.advanceTimersByTimeAsync(2000);

            expect(order).toEqual(['second-start']);
            await expect(first).rejects.toThrow('boom');
            await second;
        });
    });
});
