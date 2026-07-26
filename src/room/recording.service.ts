import { Injectable, Logger } from '@nestjs/common';
import { Storage } from '@google-cloud/storage';
import { ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { types as mediasoupTypes } from 'mediasoup';
import { PrismaService } from '../prisma/prisma.service';
import {
    IRecordingAudioInput,
    IRecordingAudioMixSession,
    IRecordingProducerInfo,
    IRecordingSessionDetail,
    IRecordingSessionSummary,
    IRecordingSnapshot,
    IRecordingVideoSession,
    IRoomRecordingState,
} from './interfaces/recording.interfaces';

/**
 * Records every active stream in a room by forwarding each producer's RTP to
 * a local ffmpeg process via a mediasoup PlainTransport (loopback-only —
 * network_mode: host means ffmpeg shares the app container's network
 * namespace directly, no Docker port-mapping needed). Video streams are
 * transcoded to H.264 (mediasoup's own codec is VP8; VP8-in-MP4 has patchy
 * playback support, so we pay the transcode cost for universal .mp4 output).
 * All mic producers are mixed into one combined-audio track per ffmpeg's
 * `amix` filter, which requires a fixed input set at process start — so the
 * audio mix is fully restarted (new file, fresh timestamp) whenever the set
 * of active mics changes, mirroring the "new stream = new timestamped file"
 * rule that already applies to video.
 */
@Injectable()
export class RecordingService {
    private readonly logger = new Logger(RecordingService.name);

    /** Notifies RoomGateway of recording-state changes it needs to broadcast to the room. */
    readonly events = new EventEmitter();

    private readonly rooms = new Map<string, IRoomRecordingState>();
    private readonly usedPorts = new Set<number>();
    private readonly portMin = Number(process.env.RECORDING_PORT_MIN ?? 45000);
    private readonly portMax = Number(process.env.RECORDING_PORT_MAX ?? 45199);
    private readonly recordingsDir = process.env.RECORDINGS_DIR ?? path.join(process.cwd(), 'recordings');
    private readonly sdpScratchDir = path.join(os.tmpdir(), 'spaces-recording-sdp');
    // Plain 'ffmpeg' relies on PATH, which is correct in the deployed Docker image (installed via
    // apt-get) — but some local Windows dev setups (notably VS Code's integrated terminal, which
    // inherits its environment from the VS Code process rather than re-reading it live) don't pick
    // up a PATH change until a full process restart. FFMPEG_PATH lets local dev point directly at
    // the binary without fighting that.
    // '||' not '??' — FFMPEG_PATH= (blank, the documented production convention) sets the
    // env var to an empty string, not undefined, so '??' would pass '' straight through to
    // spawn() and fail with "The argument 'file' cannot be empty."
    private readonly ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';

    // Unset in local dev — recordings just stay on disk under recordingsDir, same as always.
    // Set on the deployed VM: finalized recordings are uploaded to this bucket at
    // <roomName>/<sessionName>/<filename> and the local copy is deleted (not mirrored).
    private readonly gcsBucketName = process.env.RECORDINGS_GCS_BUCKET || undefined;
    private readonly storage = this.gcsBucketName ? new Storage() : null;

    constructor(private readonly prisma: PrismaService) {}

    isRecording(roomName: string): boolean {
        return this.rooms.has(roomName);
    }

    /** Most recent recording sessions for a room, for the toolbar's recordings dropdown. */
    async listRecentSessions(roomName: string, limit = 10): Promise<IRecordingSessionSummary[]> {
        const sessions = await this.prisma.recordingSession.findMany({
            where: { roomName },
            orderBy: { startedAt: 'desc' },
            take: limit,
        });
        return sessions.map((session) => ({
            id: session.id,
            name: session.name,
            startedAt: session.startedAt.toISOString(),
            stoppedAt: session.stoppedAt?.toISOString() ?? null,
        }));
    }

    /** One session plus every recording in it — looked up by id alone (not scoped to the
     *  requesting socket's current room), so a direct navigation/refresh on the playback
     *  route works even without having joined a room in this connection. */
    async getSessionDetail(sessionId: string): Promise<IRecordingSessionDetail | null> {
        const session = await this.prisma.recordingSession.findUnique({
            where: { id: sessionId },
            include: { recordings: true },
        });
        if (!session) {
            return null;
        }
        const recordings = await Promise.all(
            session.recordings.map(async (recording) => ({
                id: recording.id,
                filename: recording.filename,
                streamType: recording.streamType,
                displayName: recording.displayName,
                url: await this.getSignedUrl(recording.gcsPath),
            })),
        );
        return {
            id: session.id,
            name: session.name,
            roomName: session.roomName,
            startedAt: session.startedAt.toISOString(),
            stoppedAt: session.stoppedAt?.toISOString() ?? null,
            recordings,
        };
    }

    /** Fresh signed URL for a GCS object — never persisted, since signed URLs expire.
     *  Returns null when GCS isn't configured (local dev) or the recording has no gcsPath. */
    private async getSignedUrl(gcsPath: string | null): Promise<string | null> {
        if (!gcsPath || !this.storage || !this.gcsBucketName) {
            return null;
        }
        try {
            const [url] = await this.storage
                .bucket(this.gcsBucketName)
                .file(gcsPath)
                .getSignedUrl({ action: 'read', expires: Date.now() + 60 * 60 * 1000 });
            return url;
        } catch (error) {
            this.logger.error(`Failed to sign URL for gs://${this.gcsBucketName}/${gcsPath}: ${error}`);
            return null;
        }
    }

    /** Starts recording every currently active producer in the room. Throws if already recording. */
    async start(roomName: string, snapshot: IRecordingSnapshot): Promise<void> {
        if (this.rooms.has(roomName)) {
            throw new Error('Recording is already active for this room.');
        }
        await fs.mkdir(this.recordingsDir, { recursive: true });
        await fs.mkdir(this.sdpScratchDir, { recursive: true });

        const sessionDbId = randomUUID();
        const defaultSessionName = this.buildDefaultSessionName(roomName, new Date());
        await this.prisma.recordingSession.create({
            data: {
                id: sessionDbId,
                room: { connectOrCreate: { where: { name: roomName }, create: { name: roomName } } },
                // Failsafe default — overwritten if RoomGateway.onStopRecording gets a
                // user-supplied name from the stop dialog; left as-is for any stop path
                // that never goes through that dialog (room-empties auto-stop, a crash, etc.).
                name: defaultSessionName,
            },
        });

        const state: IRoomRecordingState = {
            roomName,
            sessionDbId,
            sessionName: defaultSessionName,
            videoSessions: new Map(),
            audioMix: null,
            audioMixLock: Promise.resolve(),
            streamNumberCounters: new Map(),
        };
        // Set before awaiting so a concurrent start-recording call for the same room fails fast.
        this.rooms.set(roomName, state);

        try {
            for (const producer of snapshot.producers.filter((p) => p.source !== 'mic')) {
                await this.startVideoSession(state, snapshot.router, producer);
            }
            const mics = snapshot.producers.filter((p) => p.source === 'mic');
            await this.withAudioMixLock(state, () => this.startAudioMix(state, snapshot.router, mics));
        } catch (error) {
            this.rooms.delete(roomName);
            await this.teardownRoom(state);
            throw error;
        }
        this.events.emit('recording-state', { roomName, isRecording: true });
    }

    /** Stops recording and finalizes every open file for the room. Idempotent — a no-op if not recording.
     *  `name`, if provided (from the stop-recording naming dialog), overwrites the session's failsafe default. */
    async stop(roomName: string, name?: string): Promise<void> {
        const state = this.rooms.get(roomName);
        if (!state) {
            return;
        }
        this.rooms.delete(roomName);
        if (name) {
            // Must happen BEFORE teardownRoom(): finalize hooks (which run during teardown)
            // read state.sessionName to build each upload's <roomName>/<sessionName>/ path —
            // renaming after the fact would leave already-uploaded files under the old name.
            state.sessionName = name;
            await this.prisma.recordingSession
                .update({ where: { id: state.sessionDbId }, data: { name } })
                .catch((error: unknown) => this.logger.error(`Failed to rename recording session ${state.sessionDbId}: ${error}`));
        }
        await this.teardownRoom(state);
        await this.prisma.recordingSession
            .update({ where: { id: state.sessionDbId }, data: { stoppedAt: new Date() } })
            .catch((error: unknown) => this.logger.error(`Failed to finalize recording session ${state.sessionDbId}: ${error}`));
        this.events.emit('recording-state', { roomName, isRecording: false });
    }

    /** Fire-and-forget hook for a newly created webcam/screen producer. No-op if the room isn't being recorded. */
    notifyProducerCreated(roomName: string, router: mediasoupTypes.Router, producer: IRecordingProducerInfo): void {
        const state = this.rooms.get(roomName);
        if (!state || producer.source === 'mic') {
            return;
        }
        void this.startVideoSession(state, router, producer).catch((error: unknown) =>
            this.logger.error(`Failed to start recording ${producer.source} producer ${producer.producerId} in room ${roomName}: ${error}`),
        );
    }

    /** Fire-and-forget hook for a closing webcam/screen producer. No-op if there's no recording session for it. */
    notifyProducerClosing(roomName: string, producerId: string): void {
        const state = this.rooms.get(roomName);
        const session = state?.videoSessions.get(producerId);
        if (!state || !session) {
            return;
        }
        state.videoSessions.delete(producerId);
        void this.finalizeVideoSession(state, session).catch((error: unknown) =>
            this.logger.error(`Error finalizing recording for producer ${producerId}: ${error}`),
        );
    }

    /** Fire-and-forget hook called whenever the room's active-mic set changes (add or remove). No-op if unchanged or not recording. */
    notifyMicProducersChanged(roomName: string, router: mediasoupTypes.Router, activeMics: IRecordingProducerInfo[]): void {
        const state = this.rooms.get(roomName);
        if (!state) {
            return;
        }
        const currentIds = new Set(state.audioMix?.inputs.map((i) => i.producerId) ?? []);
        const newIds = new Set(activeMics.map((m) => m.producerId));
        if (currentIds.size === newIds.size && [...currentIds].every((id) => newIds.has(id))) {
            return;
        }
        void this.withAudioMixLock(state, () => this.restartAudioMix(state, router, activeMics)).catch((error: unknown) =>
            this.logger.error(`Failed to restart audio mix for room ${roomName}: ${error}`),
        );
    }

    /**
     * Serializes every audio-mix mutation for a room onto one chain, so a mic
     * changing state while the initial snapshot is still being processed
     * can't run concurrently with it and silently orphan an untracked ffmpeg
     * process (two overlapping calls both reading/overwriting state.audioMix
     * is the failure mode this prevents).
     */
    private withAudioMixLock(state: IRoomRecordingState, fn: () => Promise<void>): Promise<void> {
        const run = state.audioMixLock.then(fn, fn);
        state.audioMixLock = run.catch(() => undefined);
        return run;
    }

    private async startVideoSession(
        state: IRoomRecordingState,
        router: mediasoupTypes.Router,
        info: IRecordingProducerInfo,
    ): Promise<void> {
        const timestamp = this.formatTimestampUtc(new Date());
        const streamNumber = this.nextStreamNumber(state, `${info.peerId}:${info.source}`);
        const outputPath = path.join(
            this.recordingsDir,
            this.buildFilename(state.roomName, info.displayName, info.source, streamNumber, timestamp),
        );

        // Retries with a fresh PlainTransport + freshly allocated port on failure — our own
        // port bookkeeping only tracks what THIS process has handed out, so it can't guarantee
        // a chosen port is actually free at the OS level (e.g. something outside our control
        // transiently holding it). A retry with a different port is far more useful than
        // failing the whole recording over what's very likely a one-off collision.
        const MAX_ATTEMPTS = 3;
        let lastError: unknown;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            const transport = await router.createPlainTransport({
                listenInfo: { protocol: 'udp', ip: '127.0.0.1' },
                rtcpMux: true,
                comedia: false,
            });
            const destPort = this.allocatePort();
            let sdpPath: string | null = null;
            try {
                await transport.connect({ ip: '127.0.0.1', port: destPort });
                const consumer = await transport.consume({
                    producerId: info.producerId,
                    rtpCapabilities: router.rtpCapabilities,
                    paused: true,
                });
                const codec = consumer.rtpParameters.codecs[0];
                sdpPath = path.join(this.sdpScratchDir, `${info.producerId}-${Date.now()}-${attempt}.sdp`);
                await fs.writeFile(sdpPath, this.buildSdp(destPort, codec, 'video'));

                const ffmpeg = await this.spawnFfmpegAndWaitReady(
                    [
                        '-n',
                        '-protocol_whitelist',
                        'file,udp,rtp',
                        '-i',
                        sdpPath,
                        '-c:v',
                        'libx264',
                        '-preset',
                        'veryfast',
                        // Disables B-frames/lookahead buffering — without this, x264 can
                        // hold several frames internally before any encoded output is
                        // available to write at all, regardless of forced keyframe timing.
                        // A stream stopped within that first ~second could flush nothing
                        // even with a keyframe forced at t=0.
                        '-tune',
                        'zerolatency',
                        // Forces a keyframe (and therefore a flushed fragment, since
                        // frag_keyframe below fragments AT each keyframe) every 2s
                        // starting at t=0 — without this, libx264's default ~8-10s
                        // keyframe interval means a stream stopped shortly after starting
                        // can flush nothing at all (moov atom not found).
                        '-force_key_frames',
                        'expr:gte(t,n_forced*2)',
                        // empty_moov means this recording target has no upfront duration
                        // index — needed for resilience against an abrupt kill, but it's
                        // why players show 0:00/no scrubber. finalizeVideoSession remuxes
                        // this temp file into a normal indexed mp4 at outputPath once the
                        // stream stops, which is what actually gets kept.
                        '-movflags',
                        '+frag_keyframe+empty_moov+faststart',
                        this.tempRecordingPath(outputPath),
                    ],
                    `video ${info.producerId} port=${destPort} attempt=${attempt}`,
                );

                await consumer.resume();
                await consumer.requestKeyFrame();

                const dbId = randomUUID();
                await this.prisma.recording
                    .create({
                        data: {
                            id: dbId,
                            room: { connectOrCreate: { where: { name: state.roomName }, create: { name: state.roomName } } },
                            session: { connect: { id: state.sessionDbId } },
                            user: { connect: { id: info.userId } },
                            displayName: info.displayName,
                            streamType: info.source,
                            streamNumber,
                            filename: path.basename(outputPath),
                            startedAt: new Date(),
                        },
                    })
                    .catch((error: unknown) =>
                        this.logger.error(`Failed to persist recording metadata for producer ${info.producerId}: ${error}`),
                    );

                state.videoSessions.set(info.producerId, {
                    producerId: info.producerId,
                    peerId: info.peerId,
                    displayName: info.displayName,
                    source: info.source as 'webcam' | 'screen',
                    transport,
                    consumer,
                    destPort,
                    sdpPath,
                    outputPath,
                    ffmpeg,
                    dbId,
                });
                return;
            } catch (error) {
                lastError = error;
                this.releasePort(destPort);
                transport.close();
                if (sdpPath) {
                    void fs.unlink(sdpPath).catch(() => undefined);
                }
                this.logger.warn(
                    `Recording start attempt ${attempt}/${MAX_ATTEMPTS} failed for producer ${info.producerId} (port=${destPort}): ${error instanceof Error ? error.message : error}`,
                );
            }
        }
        throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }

    private async finalizeVideoSession(state: IRoomRecordingState, session: IRecordingVideoSession): Promise<void> {
        await this.stopFfmpegGracefully(session.ffmpeg);
        session.consumer.close();
        session.transport.close();
        this.releasePort(session.destPort);
        void fs.unlink(session.sdpPath).catch(() => undefined);
        await this.remuxToFinalFile(this.tempRecordingPath(session.outputPath), session.outputPath);
        const gcsPath = await this.uploadToGcsIfConfigured(session.outputPath, state.roomName, state.sessionName);
        await this.prisma.recording
            .update({ where: { id: session.dbId }, data: { stoppedAt: new Date(), ...(gcsPath ? { gcsPath } : {}) } })
            .catch((error: unknown) => this.logger.error(`Failed to record stoppedAt for recording ${session.dbId}: ${error}`));
    }

    private async startAudioMix(
        state: IRoomRecordingState,
        router: mediasoupTypes.Router,
        mics: IRecordingProducerInfo[],
    ): Promise<void> {
        if (mics.length === 0) {
            return; // nothing to record yet — wait for the first mic
        }
        const timestamp = this.formatTimestampUtc(new Date());
        const streamNumber = this.nextStreamNumber(state, 'mixed-audio:audio');
        const outputPath = path.join(
            this.recordingsDir,
            this.buildFilename(state.roomName, 'mixed-audio', 'audio', streamNumber, timestamp),
        );

        // Same rationale as startVideoSession: our port bookkeeping can't guarantee a chosen
        // port is actually free at the OS level, so retry the whole input set (fresh transports,
        // fresh ports) if the shared ffmpeg process fails to start.
        const MAX_ATTEMPTS = 3;
        let lastError: unknown;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            const inputs: IRecordingAudioInput[] = [];
            try {
                for (const mic of mics) {
                    const transport = await router.createPlainTransport({
                        listenInfo: { protocol: 'udp', ip: '127.0.0.1' },
                        rtcpMux: true,
                        comedia: false,
                    });
                    const destPort = this.allocatePort();
                    await transport.connect({ ip: '127.0.0.1', port: destPort });
                    const consumer = await transport.consume({
                        producerId: mic.producerId,
                        rtpCapabilities: router.rtpCapabilities,
                        paused: true,
                    });
                    const codec = consumer.rtpParameters.codecs[0];
                    const sdpPath = path.join(this.sdpScratchDir, `${mic.producerId}-${Date.now()}-${attempt}.sdp`);
                    await fs.writeFile(sdpPath, this.buildSdp(destPort, codec, 'audio'));
                    inputs.push({ producerId: mic.producerId, peerId: mic.peerId, transport, consumer, destPort, sdpPath });
                }

                const args = ['-n'];
                for (const input of inputs) {
                    args.push('-protocol_whitelist', 'file,udp,rtp', '-i', input.sdpPath);
                }
                args.push(
                    '-filter_complex',
                    `amix=inputs=${inputs.length}:duration=longest:dropout_transition=0`,
                    '-c:a',
                    'aac',
                    '-b:a',
                    '128k',
                    // Audio has no keyframe concept, and this track's duration is
                    // unpredictable (an amix restart can be very short-lived) — fragment
                    // after literally every AAC frame (~21ms) rather than on a timer, so
                    // even a mic that's on for under a second still flushes something
                    // valid rather than producing an empty/unremuxable temp file.
                    '-movflags',
                    '+frag_every_frame+empty_moov+faststart',
                    this.tempRecordingPath(outputPath),
                );
                const ffmpeg = await this.spawnFfmpegAndWaitReady(args, `audio-mix ${state.roomName} attempt=${attempt}`);

                for (const input of inputs) {
                    await input.consumer.resume();
                }

                const dbId = randomUUID();
                await this.prisma.recording
                    .create({
                        data: {
                            id: dbId,
                            room: { connectOrCreate: { where: { name: state.roomName }, create: { name: state.roomName } } },
                            session: { connect: { id: state.sessionDbId } },
                            displayName: 'mixed-audio',
                            streamType: 'audio',
                            streamNumber,
                            filename: path.basename(outputPath),
                            startedAt: new Date(),
                        },
                    })
                    .catch((error: unknown) => this.logger.error(`Failed to persist audio-mix recording metadata for room ${state.roomName}: ${error}`));

                state.audioMix = { inputs, outputPath, ffmpeg, dbId };
                return;
            } catch (error) {
                lastError = error;
                for (const input of inputs) {
                    input.consumer.close();
                    input.transport.close();
                    this.releasePort(input.destPort);
                    void fs.unlink(input.sdpPath).catch(() => undefined);
                }
                this.logger.warn(
                    `Audio-mix start attempt ${attempt}/${MAX_ATTEMPTS} failed for room ${state.roomName}: ${error instanceof Error ? error.message : error}`,
                );
            }
        }
        throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }

    private async restartAudioMix(
        state: IRoomRecordingState,
        router: mediasoupTypes.Router,
        mics: IRecordingProducerInfo[],
    ): Promise<void> {
        const old = state.audioMix;
        state.audioMix = null;
        if (old) {
            await this.finalizeAudioMix(state, old);
        }
        await this.startAudioMix(state, router, mics);
    }

    private async finalizeAudioMix(state: IRoomRecordingState, mix: IRecordingAudioMixSession): Promise<void> {
        await this.stopFfmpegGracefully(mix.ffmpeg);
        for (const input of mix.inputs) {
            input.consumer.close();
            input.transport.close();
            this.releasePort(input.destPort);
            void fs.unlink(input.sdpPath).catch(() => undefined);
        }
        await this.remuxToFinalFile(this.tempRecordingPath(mix.outputPath), mix.outputPath);
        const gcsPath = await this.uploadToGcsIfConfigured(mix.outputPath, state.roomName, state.sessionName);
        await this.prisma.recording
            .update({ where: { id: mix.dbId }, data: { stoppedAt: new Date(), ...(gcsPath ? { gcsPath } : {}) } })
            .catch((error: unknown) => this.logger.error(`Failed to record stoppedAt for audio-mix recording ${mix.dbId}: ${error}`));
    }

    private async teardownRoom(state: IRoomRecordingState): Promise<void> {
        await Promise.all([
            ...[...state.videoSessions.values()].map((session) => this.finalizeVideoSession(state, session)),
            this.withAudioMixLock(state, () => (state.audioMix ? this.finalizeAudioMix(state, state.audioMix) : Promise.resolve())),
        ]);
    }

    /**
     * Spawns ffmpeg and waits ~300ms for it to bind its listening socket before
     * mediasoup starts sending (so the first packets/keyframe aren't dropped).
     * Critically, this also attaches an 'error' listener for the entire life of
     * the process — child_process.spawn() doesn't throw synchronously if the
     * binary is missing (e.g. ffmpeg not installed/on PATH); it emits 'error'
     * asynchronously instead, and Node re-throws an unhandled 'error' event as
     * an uncaught exception, which crashes the whole process (every socket in
     * every room disconnects). Without this listener, a single missing ffmpeg
     * binary or bad argument takes down the entire server, not just this one
     * recording attempt.
     */
    private spawnFfmpegAndWaitReady(args: string[], logLabel: string): Promise<ChildProcess> {
        return new Promise((resolve, reject) => {
            const ffmpeg = spawn(this.ffmpegPath, args, { stdio: ['pipe', 'ignore', 'pipe'] });
            let settled = false;

            const onStartupError = (error: Error) => {
                this.logger.error(`ffmpeg (${logLabel}) failed to start: ${error.message}`);
                if (!settled) {
                    settled = true;
                    reject(error);
                }
            };
            const onStartupExit = (code: number | null, signal: NodeJS.Signals | null) => {
                if (!settled) {
                    settled = true;
                    reject(new Error(`ffmpeg (${logLabel}) exited immediately (code=${code}, signal=${signal})`));
                }
            };

            ffmpeg.once('error', onStartupError);
            ffmpeg.once('exit', onStartupExit);
            ffmpeg.stderr?.on('data', (chunk: Buffer) => this.logger.debug(`[ffmpeg ${logLabel}] ${chunk}`));

            setTimeout(() => {
                if (settled) {
                    return;
                }
                settled = true;
                ffmpeg.removeListener('error', onStartupError);
                ffmpeg.removeListener('exit', onStartupExit);
                // Long-lived handler for the rest of this process's life, so a later
                // crash (e.g. OOM-killed) logs instead of taking the server down.
                ffmpeg.on('error', (error) => this.logger.error(`ffmpeg (${logLabel}) error after startup: ${error.message}`));
                resolve(ffmpeg);
            }, 300);
        });
    }

    /**
     * The live recording writes to a temp fragmented mp4 (empty_moov — no
     * upfront duration index, but resilient to an abrupt kill). Once that
     * process has exited, this does a fast `-c copy` remux into the real,
     * final path WITHOUT empty_moov — a normal mp4 with correct top-level
     * duration/seek metadata, since ffmpeg's demuxer can read the fragmented
     * temp file's actual total duration even though it has no central index.
     * Best-effort: logs and keeps the temp file (rather than throwing) if the
     * remux itself fails, so a stop/close action never fails because of this.
     */
    private async remuxToFinalFile(tempPath: string, finalPath: string): Promise<void> {
        try {
            const stat = await fs.stat(tempPath).catch(() => null);
            if (!stat || stat.size === 0) {
                this.logger.warn(`Recording temp file ${tempPath} is missing or empty — nothing to remux`);
                return;
            }
            await this.runFfmpegToCompletion(
                ['-y', '-i', tempPath, '-c', 'copy', '-movflags', '+faststart', finalPath],
                `remux ${path.basename(finalPath)}`,
            );
            void fs.unlink(tempPath).catch(() => undefined);
        } catch (error) {
            this.logger.error(
                `Failed to remux ${tempPath} -> ${finalPath} (temp file kept): ${error instanceof Error ? error.message : error}`,
            );
        }
    }

    /** Uploads a finalized local recording to Cloud Storage at <roomName>/<sessionName>/<filename>,
     *  deleting the local copy on success — RECORDINGS_GCS_BUCKET moves storage off the VM's disk
     *  entirely, it isn't a backup/mirror. Returns the deterministic object path whenever GCS is
     *  configured, even if THIS upload attempt failed (local file is kept in that case, matching
     *  this file's established "never lose a recording over a best-effort step" philosophy) — a
     *  signed URL built from that path is a pure cryptographic signature, it doesn't require the
     *  object to already exist, so the playback page can show a link immediately and it'll simply
     *  start working once the object lands (this upload succeeding, or a future manual retry).
     *  Returns null only when GCS isn't configured at all (local dev). */
    private async uploadToGcsIfConfigured(localPath: string, roomName: string, sessionName: string): Promise<string | null> {
        if (!this.storage || !this.gcsBucketName) {
            return null;
        }
        const objectPath = `${this.sanitize(roomName)}/${this.sanitize(sessionName)}/${path.basename(localPath)}`;
        try {
            await this.storage.bucket(this.gcsBucketName).upload(localPath, { destination: objectPath });
            void fs.unlink(localPath).catch(() => undefined);
        } catch (error) {
            this.logger.error(
                `Failed to upload ${localPath} to gs://${this.gcsBucketName}/${objectPath} (local file kept): ${error}`,
            );
        }
        return objectPath;
    }

    private tempRecordingPath(finalPath: string): string {
        return finalPath.replace(/\.mp4$/, '.recording.mp4');
    }

    /** Runs ffmpeg on a finite local-file input to completion (unlike spawnFfmpegAndWaitReady, which is for live RTP input and never awaits full completion). */
    private runFfmpegToCompletion(args: string[], logLabel: string): Promise<void> {
        return new Promise((resolve, reject) => {
            const ffmpeg = spawn(this.ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
            let settled = false;
            ffmpeg.once('error', (error) => {
                if (!settled) {
                    settled = true;
                    reject(error);
                }
            });
            ffmpeg.stderr?.on('data', (chunk: Buffer) => this.logger.debug(`[ffmpeg ${logLabel}] ${chunk}`));
            ffmpeg.once('exit', (code, signal) => {
                if (settled) {
                    return;
                }
                settled = true;
                if (code === 0) {
                    resolve();
                } else {
                    reject(new Error(`ffmpeg (${logLabel}) exited with code=${code} signal=${signal}`));
                }
            });
        });
    }

    private stopFfmpegGracefully(proc: ChildProcess, timeoutMs = 5000): Promise<void> {
        return new Promise((resolve) => {
            if (proc.exitCode !== null || proc.signalCode !== null) {
                resolve();
                return;
            }
            const timer = setTimeout(() => {
                this.logger.warn(`ffmpeg pid ${proc.pid} did not exit within ${timeoutMs}ms — sending SIGKILL`);
                proc.kill('SIGKILL');
            }, timeoutMs);
            proc.once('exit', (code, signal) => {
                clearTimeout(timer);
                this.logger.log(`ffmpeg pid ${proc.pid} exited (code=${code}, signal=${signal})`);
                resolve();
            });
            proc.stdin?.write('q'); // ffmpeg's documented clean-quit keystroke — finalizes the moov atom/flushes buffers properly
        });
    }

    private allocatePort(): number {
        for (let port = this.portMin; port <= this.portMax; port++) {
            if (!this.usedPorts.has(port)) {
                this.usedPorts.add(port);
                return port;
            }
        }
        throw new Error(`No free recording ports in range ${this.portMin}-${this.portMax}`);
    }

    private releasePort(port: number): void {
        this.usedPorts.delete(port);
    }

    private buildSdp(port: number, codec: mediasoupTypes.RtpCodecParameters, kind: 'audio' | 'video'): string {
        const codecName = codec.mimeType.split('/')[1];
        const rtpmap =
            kind === 'audio'
                ? `a=rtpmap:${codec.payloadType} ${codecName}/${codec.clockRate}/${codec.channels}`
                : `a=rtpmap:${codec.payloadType} ${codecName}/${codec.clockRate}`;
        return [
            'v=0',
            'o=- 0 0 IN IP4 127.0.0.1',
            's=recording',
            'c=IN IP4 127.0.0.1',
            't=0 0',
            `m=${kind} ${port} RTP/AVP ${codec.payloadType}`,
            rtpmap,
            'a=rtcp-mux',
        ].join('\n');
    }

    private nextStreamNumber(state: IRoomRecordingState, key: string): number {
        const next = (state.streamNumberCounters.get(key) ?? 0) + 1;
        state.streamNumberCounters.set(key, next);
        return next;
    }

    private buildFilename(roomName: string, username: string, streamType: string, streamNumber: number, timestamp: string): string {
        return `${this.sanitize(roomName)}-${this.sanitize(username)}-${timestamp}-${streamType}-${streamNumber}.mp4`;
    }

    private sanitize(value: string): string {
        const cleaned = value
            .replace(/[^A-Za-z0-9_-]/g, '_')
            .replace(/_+/g, '_')
            .replace(/^_|_$/g, '');
        return cleaned || 'x';
    }

    private formatTimestampUtc(date: Date): string {
        return date.toISOString().replace(/[-:]/g, '').split('.')[0];
    }

    /** Human-readable failsafe session name — "<roomname> - MM/DD/YYYY h:mm AM/PM" — distinct
     *  from formatTimestampUtc's sortable/filesystem-safe format used for filenames. */
    private buildDefaultSessionName(roomName: string, date: Date): string {
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const year = date.getFullYear();
        const time = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        return `${roomName} - ${month}/${day}/${year} ${time}`;
    }
}
