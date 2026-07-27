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
    IRecordingProducerInfo,
    IRecordingSessionDetail,
    IRecordingSessionSummary,
    IRecordingSnapshot,
    IRecordingVideoSession,
    IRoomRecordingState,
} from './interfaces/recording.interfaces';

interface IPlaybackUrlSourceRow {
    filename: string;
    gcsPath: string | null;
    gcsUploadedAt: Date | null;
    stoppedAt: Date | null;
    hasContent: boolean;
    thumbnailStatus: string | null;
    thumbnailUpdatedAt: Date | null;
}

/**
 * Records every active stream in a room by forwarding each producer's RTP to
 * a local ffmpeg process via a mediasoup PlainTransport (loopback-only —
 * network_mode: host means ffmpeg shares the app container's network
 * namespace directly, no Docker port-mapping needed). Video streams are
 * transcoded to H.264 (mediasoup's own codec is VP8; VP8-in-MP4 has patchy
 * playback support, so we pay the transcode cost for universal .mp4 output).
 * Every producer — webcam, screen, AND mic — gets its own fully independent
 * recording session (one PlainTransport, one ffmpeg process, one Recording
 * row), synced together afterward on the shared playback timeline via each
 * row's own startedAt/stoppedAt. Mic audio is no longer mixed into one
 * combined track; each participant's mic is recorded and attributed to them
 * individually.
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
            include: { recordings: { include: { user: true } } },
        });
        if (!session) {
            return null;
        }
        const recordings = await Promise.all(
            session.recordings.map(async (recording) => {
                const { url, thumbnailUrl } = await this.buildPlaybackUrls(recording);
                return {
                    id: recording.id,
                    filename: recording.filename,
                    streamType: recording.streamType,
                    displayName: recording.displayName,
                    userId: recording.userId,
                    pictureUrl: recording.user?.pictureUrl ?? null,
                    url,
                    thumbnailUrl,
                    // Lets the frontend align streams on one shared timeline even when they
                    // started at genuinely different real-world moments (e.g. a screen share
                    // that began well after the session's webcam stream) — see PlaybackSync.
                    // stoppedAt lets it compute each recording's actual duration directly from
                    // our own bookkeeping, rather than trusting the browser's <video>.duration
                    // (which can be Infinity/wrong immediately after loadedmetadata and only
                    // self-correct later via a separate durationchange event).
                    startedAt: recording.startedAt.toISOString(),
                    stoppedAt: recording.stoppedAt?.toISOString() ?? null,
                    hasContent: recording.hasContent,
                };
            }),
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

    /** SSLIP_HOSTNAME is the public HTTPS domain Caddy already TLS-terminates for and reverse-proxies
     *  straight through to this app (its catch-all `reverse_proxy 127.0.0.1:3001` has no path matcher,
     *  so /recordings/* is already publicly reachable with zero deploy changes) — set in production,
     *  unset in local dev where localhost is correct instead. */
    private publicBaseUrl(): string {
        return process.env.SSLIP_HOSTNAME ? `https://${process.env.SSLIP_HOSTNAME}` : `http://localhost:${process.env.PORT ?? 3001}`;
    }

    /** Points at the static route main.ts mounts over recordingsDir. Used as the immediately-available
     *  link the instant a recording finishes locally, before (or instead of, if it never lands) the
     *  separate GCS upload step completes — see buildPlaybackUrls. */
    private buildLocalFileUrl(filename: string): string {
        return `${this.publicBaseUrl()}/recordings/${encodeURIComponent(filename)}`;
    }

    /** Same derive-by-string-replace convention as tempRecordingPath — no DB column needed for the path itself. */
    private thumbnailPath(finalPath: string): string {
        return finalPath.replace(/\.mp4$/, '.thumb.jpg');
    }

    /** thumbnailUpdatedAt doubles as a cache-busting query param — the derived thumbnail filename is
     *  identical across the grayscale ('live') -> color ('final') regeneration, so without this the
     *  browser would keep serving whichever version it first cached at that URL. */
    private buildLocalThumbnailUrl(filename: string, updatedAt: Date | null): string | null {
        if (!updatedAt) {
            return null;
        }
        const thumbFilename = this.thumbnailPath(filename);
        return `${this.publicBaseUrl()}/recordings/${encodeURIComponent(thumbFilename)}?v=${updatedAt.getTime()}`;
    }

    /** Single source of truth for "what URL should this recording show right now" — reused by the
     *  initial getSessionDetail fetch and every real-time event payload, so both are always computed
     *  identically. Serves the local VM file until gcsUploadedAt confirms the upload actually landed
     *  (not merely that gcsPath, the deterministic intended path, has been assigned). */
    private async buildPlaybackUrls(r: IPlaybackUrlSourceRow): Promise<{ url: string | null; thumbnailUrl: string | null }> {
        const url =
            !r.stoppedAt || !r.hasContent
                ? null // final file doesn't exist yet, or never will (the recording captured nothing)
                : r.gcsUploadedAt && this.gcsBucketName
                  ? await this.getSignedUrl(r.gcsPath)
                  : this.buildLocalFileUrl(r.filename);
        const thumbnailUrl = r.thumbnailStatus ? this.buildLocalThumbnailUrl(r.filename, r.thumbnailUpdatedAt) : null;
        return { url, thumbnailUrl };
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
            streamNumberCounters: new Map(),
        };
        // Set before awaiting so a concurrent start-recording call for the same room fails fast.
        this.rooms.set(roomName, state);

        try {
            // webcam, screen, AND mic all go through the same per-producer session now.
            for (const producer of snapshot.producers) {
                await this.startVideoSession(state, snapshot.router, producer);
            }
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

    /** Fire-and-forget hook for a newly created producer — webcam, screen, or mic, each gets its
     *  own fully independent recording session. No-op if the room isn't being recorded. */
    notifyProducerCreated(roomName: string, router: mediasoupTypes.Router, producer: IRecordingProducerInfo): void {
        const state = this.rooms.get(roomName);
        if (!state) {
            return;
        }
        void this.startVideoSession(state, router, producer).catch((error: unknown) =>
            this.logger.error(`Failed to start recording ${producer.source} producer ${producer.producerId} in room ${roomName}: ${error}`),
        );
    }

    /** Fire-and-forget hook for a closing producer — webcam, screen, or mic. No-op if there's no recording session for it. */
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

    private async startVideoSession(
        state: IRoomRecordingState,
        router: mediasoupTypes.Router,
        info: IRecordingProducerInfo,
    ): Promise<void> {
        const isAudio = info.source === 'mic';
        const timestamp = this.formatTimestampUtc(new Date());
        const streamNumber = this.nextStreamNumber(state, `${info.peerId}:${info.source}`);
        const outputPath = path.join(
            this.recordingsDir,
            this.buildFilename(state.roomName, info.displayName, info.source, streamNumber, timestamp, info.peerId),
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
                await fs.writeFile(sdpPath, this.buildSdp(destPort, codec, isAudio ? 'audio' : 'video'));

                const ffmpeg = await this.spawnFfmpegAndWaitReady(
                    this.buildRecordingFfmpegArgs(isAudio, sdpPath, this.tempRecordingPath(outputPath)),
                    `${info.source} ${info.producerId} port=${destPort} attempt=${attempt}`,
                );

                await consumer.resume();
                if (!isAudio) {
                    await consumer.requestKeyFrame();
                }

                const dbId = randomUUID();
                const startedAt = new Date();
                const created = await this.prisma.recording
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
                            startedAt,
                        },
                        include: { user: true },
                    })
                    .catch((error: unknown) => {
                        this.logger.error(`Failed to persist recording metadata for producer ${info.producerId}: ${error}`);
                        return null;
                    });
                // Lets a viewer already on this session's (still-recording) playback page see this
                // stream appear live, instead of only ever reflecting whatever existed when their
                // page first loaded — only emitted once the row genuinely exists, matching the
                // hasContent lesson: never tell playback clients about something that isn't there.
                if (created) {
                    this.events.emit('recording-added', {
                        sessionId: state.sessionDbId,
                        recordingId: dbId,
                        filename: path.basename(outputPath),
                        streamType: info.source,
                        displayName: info.displayName,
                        userId: created.userId,
                        pictureUrl: created.user?.pictureUrl ?? null,
                        startedAt: startedAt.toISOString(),
                    });
                }

                state.videoSessions.set(info.producerId, {
                    producerId: info.producerId,
                    peerId: info.peerId,
                    displayName: info.displayName,
                    source: info.source,
                    transport,
                    consumer,
                    destPort,
                    sdpPath,
                    outputPath,
                    ffmpeg,
                    dbId,
                });

                // Audio has no thumbnail concept — only schedule this for video sources.
                if (!isAudio) {
                    // Grace period comfortably after the first forced-keyframe fragment flush (2s
                    // interval, see the -force_key_frames comment above) so there's actually something
                    // in the temp file to extract a frame from. Re-reads the live map by dbId at fire
                    // time rather than tracking a cancelable timer handle — a session that's since
                    // stopped or been replaced simply won't match, and generateFinalThumbnail covers it.
                    const GRACE_MS = 3000;
                    setTimeout(() => {
                        const current = state.videoSessions.get(info.producerId);
                        if (!current || current.dbId !== dbId) {
                            return;
                        }
                        void this.generateLiveThumbnail(state, current).catch((error: unknown) =>
                            this.logger.warn(`Live thumbnail generation failed for producer ${info.producerId}: ${error}`),
                        );
                    }, GRACE_MS);
                }
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

    /** Pulled out of startVideoSession as its own pure function so the audio-vs-video branch is
     *  directly unit-testable without spinning up a real mediasoup Router/ffmpeg process. */
    private buildRecordingFfmpegArgs(isAudio: boolean, sdpPath: string, tempOutputPath: string): string[] {
        const codecArgs = isAudio
            ? ['-c:a', 'aac', '-b:a', '128k']
            : [
                  '-c:v',
                  'libx264',
                  '-preset',
                  'veryfast',
                  // Disables B-frames/lookahead buffering — without this, x264 can hold several
                  // frames internally before any encoded output is available to write at all,
                  // regardless of forced keyframe timing. A stream stopped within that first
                  // ~second could flush nothing even with a keyframe forced at t=0.
                  '-tune',
                  'zerolatency',
                  // Forces a keyframe (and therefore a flushed fragment, since frag_keyframe
                  // below fragments AT each keyframe) every 2s starting at t=0 — without this,
                  // libx264's default ~8-10s keyframe interval means a stream stopped shortly
                  // after starting can flush nothing at all (moov atom not found).
                  '-force_key_frames',
                  'expr:gte(t,n_forced*2)',
                  // Pins the OUTPUT to a real, fixed frame rate — the other half of the
                  // duplicate-frame/bogus-duration fix below. Without this, ffmpeg still has to
                  // guess an output cadence from the (now wall-clock) input timestamps.
                  '-r',
                  '30',
                  '-fps_mode',
                  'cfr',
              ];
        // Audio has no keyframe concept — fragment after literally every AAC frame (~21ms)
        // rather than on a timer, so even a mic on for under a second still flushes something
        // valid instead of an empty/unremuxable temp file.
        const movflags = isAudio ? '+frag_every_frame+empty_moov+faststart' : '+frag_keyframe+empty_moov+faststart';
        return [
            '-n',
            '-protocol_whitelist',
            'file,udp,rtp',
            // Without this, ffmpeg trusts the RTP stream's raw clock timestamps as-is, which
            // (combined with no explicit output frame rate for video) led it to infer a bogus
            // output cadence and pad in duplicate frames/mis-derive the container duration
            // (players then show 0:00/no scrubber, since that IS the file's real declared
            // duration). Wall-clock timestamps reflect when packets actually arrived instead.
            '-use_wallclock_as_timestamps',
            '1',
            '-i',
            sdpPath,
            ...codecArgs,
            // empty_moov means this recording target has no upfront duration index — needed for
            // resilience against an abrupt kill, but it's why players show 0:00/no scrubber.
            // finalizeVideoSession remuxes this temp file into a normal indexed mp4 once the
            // stream stops, which is what actually gets kept.
            '-movflags',
            movflags,
            tempOutputPath,
        ];
    }

    /** Splits into two phases on purpose: the recording becomes locally available and its
     *  `stoppedAt` lands the moment remux finishes, WITHOUT waiting on the GCS upload (which can
     *  lag well behind) — the fire-and-forget thumbnail/upload steps below run after this method
     *  itself is done, notifying playback clients over RecordingService.events as each completes. */
    private async finalizeVideoSession(state: IRoomRecordingState, session: IRecordingVideoSession): Promise<void> {
        await this.stopFfmpegGracefully(session.ffmpeg);
        session.consumer.close();
        session.transport.close();
        this.releasePort(session.destPort);
        void fs.unlink(session.sdpPath).catch(() => undefined);

        const hasContent = await this.remuxToFinalFile(this.tempRecordingPath(session.outputPath), session.outputPath);

        // Locally available now — independent of GCS, which is why this write can't wait on it.
        const stoppedAt = new Date();
        await this.prisma.recording
            .update({ where: { id: session.dbId }, data: { stoppedAt, hasContent } })
            .catch((error: unknown) => this.logger.error(`Failed to record stoppedAt for recording ${session.dbId}: ${error}`));
        this.events.emit('recording-ready', {
            sessionId: state.sessionDbId,
            recordingId: session.dbId,
            url: hasContent ? this.buildLocalFileUrl(path.basename(session.outputPath)) : null,
            stoppedAt: stoppedAt.toISOString(),
            hasContent,
        });

        // Nothing to thumbnail or upload for a recording that captured no data. Audio has no
        // thumbnail concept at all, regardless of hasContent.
        if (hasContent) {
            if (session.source !== 'mic') {
                void this.generateFinalThumbnail(state, session).catch((error: unknown) =>
                    this.logger.warn(`Final thumbnail generation failed for recording ${session.dbId}: ${error}`),
                );
            }
            void this.uploadAndNotify(state, session.outputPath, session.dbId).catch((error: unknown) =>
                this.logger.error(`Post-finalize GCS upload failed for recording ${session.dbId}: ${error}`),
            );
        }
    }

    private async teardownRoom(state: IRoomRecordingState): Promise<void> {
        await Promise.all([...state.videoSessions.values()].map((session) => this.finalizeVideoSession(state, session)));
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
     *
     * Returns whether a real, playable final file actually exists now — callers use this to set
     * Recording.hasContent. A producer that never emitted a keyframe (a separate, already-diagnosed
     * browser/encoder issue) or a stream stopped before any frame arrived leaves the temp file
     * missing/empty; without this signal, a zero-content recording still got a plausible-looking
     * stoppedAt and a URL pointing at a file that doesn't exist, silently poisoning every consumer
     * of it (the shared playback timeline waits forever for a 'seeked' event that a 404'd <video>
     * can never fire).
     */
    private async remuxToFinalFile(tempPath: string, finalPath: string): Promise<boolean> {
        try {
            const stat = await fs.stat(tempPath).catch(() => null);
            if (!stat || stat.size === 0) {
                this.logger.warn(`Recording temp file ${tempPath} is missing or empty — nothing to remux`);
                return false;
            }
            await this.runFfmpegToCompletion(
                ['-y', '-i', tempPath, '-c', 'copy', '-movflags', '+faststart', finalPath],
                `remux ${path.basename(finalPath)}`,
            );
            void fs.unlink(tempPath).catch(() => undefined);
            return true;
        } catch (error) {
            this.logger.error(
                `Failed to remux ${tempPath} -> ${finalPath} (temp file kept): ${error instanceof Error ? error.message : error}`,
            );
            return false;
        }
    }

    /** Best-effort grayscale snapshot pulled from the LIVE temp file while the recording is still
     *  running, so a thumbnail exists the moment someone browses to the playback page instead of
     *  only after the recording stops. Reading a still-being-appended fragmented mp4 with a second
     *  ffmpeg process is a real (if generally safe on Linux) race against the writer — this never
     *  throws into its caller, it just silently leaves thumbnailStatus null on failure, and
     *  generateFinalThumbnail always covers it properly once the recording actually stops. */
    private async generateLiveThumbnail(state: IRoomRecordingState, session: IRecordingVideoSession): Promise<void> {
        const tempPath = this.tempRecordingPath(session.outputPath);
        const thumbPath = this.thumbnailPath(session.outputPath);
        await this.runFfmpegToCompletion(
            ['-y', '-ss', '1', '-i', tempPath, '-frames:v', '1', '-vf', 'scale=320:-1,hue=s=0', thumbPath],
            `live-thumbnail ${path.basename(thumbPath)}`,
        );
        const updatedAt = new Date();
        await this.prisma.recording.update({ where: { id: session.dbId }, data: { thumbnailStatus: 'live', thumbnailUpdatedAt: updatedAt } });
        this.events.emit('thumbnail-updated', {
            sessionId: state.sessionDbId,
            recordingId: session.dbId,
            thumbnailStatus: 'live',
            thumbnailUrl: this.buildLocalThumbnailUrl(path.basename(session.outputPath), updatedAt),
        });
    }

    /** The "real" thumbnail, extracted from the final indexed mp4 once the recording has actually
     *  stopped and remuxed — replaces the live grayscale one (same derived filename, different
     *  thumbnailUpdatedAt cache-busts it) with a full-color frame. Best-effort, same as above. */
    private async generateFinalThumbnail(state: IRoomRecordingState, session: IRecordingVideoSession): Promise<void> {
        const thumbPath = this.thumbnailPath(session.outputPath);
        await this.runFfmpegToCompletion(
            ['-y', '-ss', '1', '-i', session.outputPath, '-frames:v', '1', '-vf', 'scale=320:-1', thumbPath],
            `final-thumbnail ${path.basename(thumbPath)}`,
        );
        const updatedAt = new Date();
        await this.prisma.recording.update({ where: { id: session.dbId }, data: { thumbnailStatus: 'final', thumbnailUpdatedAt: updatedAt } });
        this.events.emit('thumbnail-updated', {
            sessionId: state.sessionDbId,
            recordingId: session.dbId,
            thumbnailStatus: 'final',
            thumbnailUrl: this.buildLocalThumbnailUrl(path.basename(session.outputPath), updatedAt),
        });
    }

    private deterministicGcsObjectPath(roomName: string, sessionName: string, localPath: string): string {
        return `${this.sanitize(roomName)}/${this.sanitize(sessionName)}/${path.basename(localPath)}`;
    }

    /** Uploads a finalized local recording to Cloud Storage, deleting the local copy on success —
     *  RECORDINGS_GCS_BUCKET moves storage off the VM's disk entirely, it isn't a backup/mirror.
     *  Local file is kept if the upload fails, matching this file's established "never lose a
     *  recording over a best-effort step" philosophy. Returns whether it actually succeeded —
     *  callers decide what that means for gcsUploadedAt/notifications (see uploadAndNotify). */
    private async uploadToGcsIfConfigured(localPath: string, objectPath: string): Promise<boolean> {
        if (!this.storage || !this.gcsBucketName) {
            return false;
        }
        try {
            await this.storage.bucket(this.gcsBucketName).upload(localPath, { destination: objectPath });
            void fs.unlink(localPath).catch(() => undefined);
            return true;
        } catch (error) {
            this.logger.error(`Failed to upload ${localPath} to gs://${this.gcsBucketName}/${objectPath} (local file kept): ${error}`);
            return false;
        }
    }

    /** The fire-and-forget step finalizeVideoSession/finalizeAudioMix kick off after the recording
     *  is already locally available — persists gcsPath regardless of outcome (matches the existing
     *  "always show a link" behavior for signing purposes) but only sets gcsUploadedAt, and only
     *  emits 'recording-uploaded' to swap playback clients over to the signed URL, on confirmed
     *  success. No-ops entirely when GCS isn't configured (local dev) — gcsPath/gcsUploadedAt stay
     *  null forever, buildPlaybackUrls keeps serving the local file, which is correct there. */
    private async uploadAndNotify(state: IRoomRecordingState, outputPath: string, dbId: string): Promise<void> {
        if (!this.gcsBucketName) {
            return;
        }
        const objectPath = this.deterministicGcsObjectPath(state.roomName, state.sessionName, outputPath);
        const uploaded = await this.uploadToGcsIfConfigured(outputPath, objectPath);
        await this.prisma.recording
            .update({ where: { id: dbId }, data: { gcsPath: objectPath, ...(uploaded ? { gcsUploadedAt: new Date() } : {}) } })
            .catch((error: unknown) => this.logger.error(`Failed to persist gcsPath for recording ${dbId}: ${error}`));
        if (uploaded) {
            const url = await this.getSignedUrl(objectPath);
            this.events.emit('recording-uploaded', { sessionId: state.sessionDbId, recordingId: dbId, url });
        }
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

    /**
     * Only ever hands out even ports. RTP conventionally pairs with an adjacent RTCP port
     * (RTP on an even port, RTCP on port+1) — even though both sides of this pipeline
     * request rtcp-mux, ffmpeg's SDP-based rtp demuxer still opens (and holds for the
     * entire life of the process) a companion socket on destPort+1 regardless. Handing out
     * odd ports here would eventually assign one recording's destPort to the exact port
     * another, unrelated, still-active recording's ffmpeg is already squatting on for RTCP
     * — a real bind collision that only appears once two recordings overlap and disappears
     * by the time anyone looks afterward, which is what made this so hard to pin down.
     */
    private allocatePort(): number {
        const firstEven = this.portMin % 2 === 0 ? this.portMin : this.portMin + 1;
        for (let port = firstEven; port + 1 <= this.portMax; port += 2) {
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

    /** peerId is optional because it doesn't apply to the room's single mixed-audio track (no
     *  one peer owns it) — every per-peer stream (webcam/screen/mic) must pass it. Without it,
     *  two peers sharing a display name (e.g. the same Google account signed in on two devices)
     *  who start the same stream type within the same second-resolution timestamp produce the
     *  exact same filename — and since the temp recording path is derived from this one, that
     *  meant two ffmpeg processes writing to the same file on disk, silently corrupting one of
     *  the two recordings (hasContent: false). peerId is the one thing that's actually unique
     *  per connection, unlike streamNumber (which resets to 1 independently for each peer). */
    private buildFilename(roomName: string, username: string, streamType: string, streamNumber: number, timestamp: string, peerId?: string): string {
        const peerSegment = peerId ? `-${this.sanitizeKebab(peerId)}` : '';
        return `${this.sanitize(roomName)}-${this.sanitize(username)}${peerSegment}-${timestamp}-${streamType}-${streamNumber}.mp4`;
    }

    private sanitize(value: string): string {
        const cleaned = value
            .replace(/[^A-Za-z0-9_-]/g, '_')
            .replace(/_+/g, '_')
            .replace(/^_|_$/g, '');
        return cleaned || 'x';
    }

    /** Same cleanup as sanitize(), but kebab-case (hyphens) rather than underscores — used for
     *  the peerId segment so it reads visually distinct from the underscore-joined display name
     *  next to it, rather than blending in as if it were part of the name. */
    private sanitizeKebab(value: string): string {
        const cleaned = value
            .replace(/[^A-Za-z0-9_-]/g, '-')
            .replace(/_/g, '-')
            .replace(/-+/g, '-')
            .replace(/^-|-$/g, '');
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
