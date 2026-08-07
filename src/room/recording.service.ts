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
import { StreamSource } from './interfaces/room.interfaces';
import {
    ICombinedCameraSession,
    IRecordingProducerInfo,
    IRecordingSessionDetail,
    IRecordingSessionSummary,
    IRecordingSnapshot,
    IRecordingTimelineEvent,
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
 * namespace directly, no Docker port-mapping needed). ffmpeg stream-copies
 * (no transcode) straight into .webm — mediasoup only ever negotiates VP8
 * (video) + Opus (audio), which is WebM's own native codec pair, so there's
 * nothing to re-encode; this is a direct passthrough of whatever the sending
 * browser's own encoder already produced.
 *
 * Screen share still gets its own fully independent recording session per
 * producer (one PlainTransport, one ffmpeg process, one Recording row), synced
 * afterward on the shared playback timeline via its own startedAt/stoppedAt —
 * unaffected by the rest of this comment.
 *
 * A participant's MIC and WEBCAM, when both are already active together, are
 * instead recorded as ONE combined session (see startCombinedCameraSession) —
 * a single ffmpeg process with two RTP inputs muxed into one file, so playback
 * gets the browser's own native, frame-accurate A/V sync instead of two
 * separately wall-clock-synced files (the previous design here — kept for
 * screen share, and for a mic/webcam pair that never end up combined — was
 * deliberately NOT combining them, on the reasoning that only lining up
 * `startedAt` more precisely would fix every stream type uniformly, including
 * screen share, which muxing alone never could. That fix (capturing
 * `startedAt` right when RTP starts, not after keyframe verification — still
 * true today, see startVideoSession) closed most of the gap but wasn't tight
 * enough for lip sync specifically, which is what motivated actually combining
 * mic+webcam here).
 *
 * Combining only ever happens when BOTH producers are already known and
 * producing real data at the moment the combined ffmpeg process launches —
 * never speculatively. A validation spike confirmed a video RTP input that's
 * declared upfront but silent for a while doesn't just delay, it fails outright
 * (WebM needs a video track's real pixel dimensions at header-write time,
 * which nothing but a decoded frame can supply). So a webcam enabled well
 * after mic already started recording solo falls back to today's independent
 * `'webcam'` file + wall-clock sync, unchanged — see notifyProducerCreated.
 *
 * A participant's mic and webcam Producers, once combined, stay alive across
 * camera on/off toggles (see MediaRoom.stopWebcam()/resumeWebcamProducer() on
 * the frontend, which pause/resume rather than close/recreate) — the mediasoup
 * worker automatically stops/resumes forwarding RTP through this file's
 * Consumers with no action needed here, so one combined recording spans the
 * whole camera-toggle history of a session with no re-syncing ever required.
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

    /** When the room's currently-active recording session started, or null if it isn't recording
     *  — see IJoinRoomResult.recordingStartedAt's comment for why this exists. */
    getRecordingStartedAt(roomName: string): Date | null {
        return this.rooms.get(roomName)?.startedAt ?? null;
    }

    /** Fire-and-forget, matching ChatService.saveMessage's convention — a slow/failed write must
     *  never delay the join/leave flow it's called from. Only ever called while a recording is
     *  actually active for the room (see notifyProducerCreated/notifyProducerClosing). */
    private logEvent(sessionId: string, type: 'join' | 'leave', peerId: string, userId: string | null, displayName: string): void {
        this.prisma.recordingEvent
            .create({ data: { sessionId, type, peerId, userId, displayName } })
            .catch((error: unknown) => this.logger.error(`Failed to log ${type} event for recording session ${sessionId}: ${error}`));
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
            events: await this.getTimelineEvents(sessionId, session.recordings),
            chatHistory: [], // populated by RoomGateway's onGetRecordingSession via ChatService, not here
        };
    }

    /** Merges persisted join/leave RecordingEvent rows with screenshare-start/end markers
     *  synthesized from the session's own streamType: 'screen' Recording rows (no separate
     *  persistence needed for those — see IRecordingTimelineEvent's comment), sorted by time. */
    private async getTimelineEvents(
        sessionId: string,
        recordings: { streamType: string; displayName: string; startedAt: Date; stoppedAt: Date | null }[],
    ): Promise<IRecordingTimelineEvent[]> {
        const persisted = await this.prisma.recordingEvent.findMany({ where: { sessionId }, orderBy: { at: 'asc' } });
        const events: IRecordingTimelineEvent[] = persisted.map((event) => ({
            type: event.type as 'join' | 'leave',
            displayName: event.displayName,
            at: event.at.toISOString(),
        }));
        for (const recording of recordings.filter((r) => r.streamType === 'screen')) {
            events.push({ type: 'screenshare-start', displayName: recording.displayName, at: recording.startedAt.toISOString() });
            if (recording.stoppedAt) {
                events.push({ type: 'screenshare-end', displayName: recording.displayName, at: recording.stoppedAt.toISOString() });
            }
        }
        return events.sort((a, b) => a.at.localeCompare(b.at));
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

    /** Points at the static route main.ts mounts over recordingsDir. Used as the immediately-available
     *  link the instant a recording finishes locally, before (or instead of, if it never lands) the
     *  separate GCS upload step completes — see buildPlaybackUrls.
     *
     *  Root-relative, not an absolute origin — mirrors ChatMediaService.publicBase's identical
     *  `/chat-media/` convention for the same reason: this server has no reliable way to know what
     *  hostname/protocol a given client actually reached it on (previously hardcoded
     *  `http://localhost:${PORT}`, which broke for every client except one on the exact same
     *  machine, and broke outright once local dev started terminating TLS — see DEV_HTTPS_CERT —
     *  since that guess was always plain http). The frontend resolves this against whatever origin
     *  it's already talking to the API on (see resolveMediaUrl()), which is correct in every case:
     *  local dev on any hostname/LAN-IP/port, the Electron app (a different origin than the API,
     *  which is exactly why this can't just be resolved against window.location instead), and
     *  production, where Caddy reverse-proxies /recordings/* on the very same origin anyway. */
    private buildLocalFileUrl(filename: string): string {
        return `/recordings/${encodeURIComponent(filename)}`;
    }

    /** Same derive-by-string-replace convention as tempRecordingPath — no DB column needed for the path itself. */
    private thumbnailPath(finalPath: string): string {
        return finalPath.replace(/\.webm$/, '.thumb.jpg');
    }

    /** thumbnailUpdatedAt doubles as a cache-busting query param — the derived thumbnail filename is
     *  identical across the grayscale ('live') -> color ('final') regeneration, so without this the
     *  browser would keep serving whichever version it first cached at that URL. Root-relative for
     *  the same reason as buildLocalFileUrl above. */
    private buildLocalThumbnailUrl(filename: string, updatedAt: Date | null): string | null {
        if (!updatedAt) {
            return null;
        }
        const thumbFilename = this.thumbnailPath(filename);
        return `/recordings/${encodeURIComponent(thumbFilename)}?v=${updatedAt.getTime()}`;
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
        const startedAt = new Date();
        const defaultSessionName = this.buildDefaultSessionName(roomName, startedAt);
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
            startedAt,
            videoSessions: new Map(),
            cameraSessions: new Map(),
            streamNumberCounters: new Map(),
            pendingFinalizations: new Set(),
        };
        // Set before awaiting so a concurrent start-recording call for the same room fails fast.
        this.rooms.set(roomName, state);

        try {
            // Pair up any peer who already has BOTH a mic and a webcam producer in this initial
            // snapshot — both are already producing real data, so combining them is always safe
            // here (see the class doc comment's "Validation spike" note on why that's NOT true for
            // a producer that doesn't exist yet). Everyone/everything else — a lone mic, a lone
            // webcam, and every screen producer — goes through the original one-producer-one-session
            // path, started concurrently since each is just a cheap RTP stream-copy.
            const combinedPeerIds = new Set<string>();
            const tasks: Promise<void>[] = [];
            for (const producer of snapshot.producers) {
                if (producer.source !== 'mic' || combinedPeerIds.has(producer.peerId)) {
                    continue;
                }
                const webcamSibling = snapshot.producers.find((p) => p.peerId === producer.peerId && p.source === 'webcam');
                if (webcamSibling) {
                    combinedPeerIds.add(producer.peerId);
                    tasks.push(this.startCombinedCameraSession(state, snapshot.router, producer, webcamSibling));
                }
            }
            for (const producer of snapshot.producers) {
                if (combinedPeerIds.has(producer.peerId) && (producer.source === 'mic' || producer.source === 'webcam')) {
                    continue;
                }
                tasks.push(this.startVideoSession(state, snapshot.router, producer));
            }
            // allSettled (not all) so a slower producer still gets to register itself even if an
            // earlier one has already failed — teardownRoom() below only cleans up what's actually
            // registered, so racing ahead on the first rejection could leak a still-in-flight one.
            const results = await Promise.allSettled(tasks);
            const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
            if (failure) {
                throw failure.reason;
            }
        } catch (error) {
            this.rooms.delete(roomName);
            await this.teardownRoom(state);
            throw error;
        }
        this.events.emit('recording-state', { roomName, isRecording: true, startedAt: startedAt.toISOString() });
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
        this.events.emit('recording-state', { roomName, isRecording: false, startedAt: null });
    }

    /** Fire-and-forget hook for a newly created producer — webcam, screen, or mic. No-op if the
     *  room isn't being recorded.
     *
     *  A mic producer specifically also logs a 'join' timeline event — this is the ONLY path that
     *  does, deliberately: it's reached exclusively for a producer created WHILE a recording is
     *  already running (start()'s own initial-snapshot producers go straight to
     *  startVideoSession/startCombinedCameraSession, never through here), so it naturally excludes
     *  anyone already on a live mic when recording begins and naturally covers every later join,
     *  however many times someone joins over the session's lifetime. Mic start/stop is also exactly
     *  the frontend's own MediaRoom.startMic()/stopMic() — i.e. "joined/left the call" — regardless
     *  of self-mute state (a muted mic still produces a silent track, so the producer/recording
     *  still exists).
     *
     *  Mic and webcam combine here too, but ONLY when the sibling already exists and is already
     *  recording — see the class doc comment's "Validation spike" note for why a not-yet-existing
     *  sibling can never be speculatively combined. */
    notifyProducerCreated(roomName: string, router: mediasoupTypes.Router, producer: IRecordingProducerInfo): void {
        const state = this.rooms.get(roomName);
        if (!state) {
            return;
        }
        if (producer.source === 'mic') {
            this.logEvent(state.sessionDbId, 'join', producer.peerId, producer.userId, producer.displayName);
            // Webcam turned on before mic did (this session) — its solo recording is already
            // running. Upgrade it into a combined session rather than leaving them separate.
            const webcamSession = this.findVideoSessionByPeerAndSource(state, producer.peerId, 'webcam');
            if (webcamSession) {
                void this.upgradeToCombinedCameraSession(state, router, producer, webcamSession).catch((error: unknown) =>
                    this.logger.error(`Failed to upgrade to a combined camera session for peer ${producer.peerId}: ${error}`),
                );
                return;
            }
        } else if (producer.source === 'webcam') {
            // A camera session whose video half detached earlier (a rare edge case — see
            // ICombinedCameraSession's own comment) gets this fresh webcam producer attached back
            // into its still-open video transport, rather than starting a whole new recording.
            const cameraSession = state.cameraSessions.get(producer.peerId);
            if (cameraSession && !cameraSession.videoConsumer) {
                void this.attachWebcamToCameraSession(state, router, cameraSession, producer).catch((error: unknown) =>
                    this.logger.error(`Failed to attach webcam producer ${producer.producerId} to its camera session: ${error}`),
                );
                return;
            }
            // Otherwise: a webcam turning on after mic already has its OWN solo recording running
            // (the common case — most sessions start audio-only) is deliberately NOT retrofitted
            // into that already-launched ffmpeg process — see the class doc comment. It gets its
            // own independent 'webcam' file, exactly like today, falling through below.
        }
        void this.startVideoSession(state, router, producer).catch((error: unknown) =>
            this.logger.error(`Failed to start recording ${producer.source} producer ${producer.producerId} in room ${roomName}: ${error}`),
        );
    }

    /** Fire-and-forget hook for a closing producer — webcam, screen, or mic. No-op if there's no
     *  recording session for it. Registers the finalization in state.pendingFinalizations so a
     *  concurrent stop() (e.g. "stop all streams" closing several producers immediately before
     *  stopping the recording) waits for it instead of racing ahead — see that field's comment.
     *  Mirrors notifyProducerCreated's 'join' logging — a mic producer closing is "left the call". */
    notifyProducerClosing(roomName: string, producerId: string): void {
        const state = this.rooms.get(roomName);
        if (!state) {
            return;
        }
        for (const [peerId, cameraSession] of state.cameraSessions) {
            if (cameraSession.audioProducerId === producerId) {
                // The mic anchoring this combined session closed — "left the call" (or stopped
                // mic), same as any solo mic session. Ends the whole combined recording; the video
                // half closing (if it hasn't already, e.g. a peer disconnect closing both at once)
                // is handled defensively inside finalizeCombinedCameraSession itself.
                this.logEvent(state.sessionDbId, 'leave', cameraSession.peerId, cameraSession.userId, cameraSession.displayName);
                state.cameraSessions.delete(peerId);
                const finalizing = this.finalizeCombinedCameraSession(state, cameraSession).catch((error: unknown) =>
                    this.logger.error(`Error finalizing combined camera session for producer ${producerId}: ${error}`),
                );
                state.pendingFinalizations.add(finalizing);
                void finalizing.finally(() => state.pendingFinalizations.delete(finalizing));
                return;
            }
            if (cameraSession.videoProducerId === producerId) {
                // The video half closing for real — not the normal pause/resume toggle (see
                // MediaRoom.stopWebcam(), which no longer closes), so this should be rare (e.g. an
                // ICE failure closing the producer server-side). The mic keeps recording solo into
                // the same file; just detach this slot so a fresh webcam producer can reattach.
                cameraSession.videoConsumer?.close();
                cameraSession.videoConsumer = null;
                cameraSession.videoProducerId = null;
                return;
            }
        }
        const session = state.videoSessions.get(producerId);
        if (!session) {
            return;
        }
        if (session.source === 'mic') {
            this.logEvent(state.sessionDbId, 'leave', session.peerId, session.userId, session.displayName);
        }
        state.videoSessions.delete(producerId);
        const finalizing = this.finalizeVideoSession(state, session).catch((error: unknown) =>
            this.logger.error(`Error finalizing recording for producer ${producerId}: ${error}`),
        );
        state.pendingFinalizations.add(finalizing);
        void finalizing.finally(() => state.pendingFinalizations.delete(finalizing));
    }

    private findVideoSessionByPeerAndSource(state: IRoomRecordingState, peerId: string, source: StreamSource): IRecordingVideoSession | undefined {
        return [...state.videoSessions.values()].find((session) => session.peerId === peerId && session.source === source);
    }

    /** A webcam that was already recording solo (it turned on before mic did, this session) gets
     *  upgraded into a combined session once mic arrives: its solo file is finalized as a short
     *  leading clip, and a fresh combined recording starts using the SAME webcam producerId (a new
     *  Consumer is created for it as part of the new session) — not a retrofit of the already-
     *  running solo ffmpeg process, which the class doc comment's validation spike ruled out. */
    private async upgradeToCombinedCameraSession(
        state: IRoomRecordingState,
        router: mediasoupTypes.Router,
        micInfo: IRecordingProducerInfo,
        existingWebcamSession: IRecordingVideoSession,
    ): Promise<void> {
        state.videoSessions.delete(existingWebcamSession.producerId);
        const finalizing = this.finalizeVideoSession(state, existingWebcamSession).catch((error: unknown) =>
            this.logger.error(`Error finalizing pre-combine solo webcam recording for producer ${existingWebcamSession.producerId}: ${error}`),
        );
        state.pendingFinalizations.add(finalizing);
        void finalizing.finally(() => state.pendingFinalizations.delete(finalizing));

        await this.startCombinedCameraSession(state, router, micInfo, {
            producerId: existingWebcamSession.producerId,
            peerId: existingWebcamSession.peerId,
            userId: existingWebcamSession.userId ?? micInfo.userId,
            displayName: existingWebcamSession.displayName,
            source: 'webcam',
        });
    }

    /** Attaches a fresh webcam producer into an existing combined session's already-open video
     *  transport — used only for the rare "video half detached" case (see notifyProducerClosing's
     *  videoProducerId branch); the common camera-off/on toggle never reaches this at all, since
     *  that pauses/resumes the SAME producer rather than closing and recreating it. */
    private async attachWebcamToCameraSession(
        state: IRoomRecordingState,
        router: mediasoupTypes.Router,
        session: ICombinedCameraSession,
        webcamInfo: IRecordingProducerInfo,
    ): Promise<void> {
        const consumer = await session.videoTransport.consume({
            producerId: webcamInfo.producerId,
            rtpCapabilities: router.rtpCapabilities,
            paused: true,
        });
        consumer.on('producerresume', () => {
            consumer.requestKeyFrame().catch((error: unknown) =>
                this.logger.warn(`requestKeyFrame after producerresume failed for recording consumer ${consumer.id}: ${error}`),
            );
        });
        session.videoConsumer = consumer;
        session.videoProducerId = webcamInfo.producerId;
        await consumer.resume();
        await consumer.requestKeyFrame().catch(() => undefined);
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
        // failing the whole recording over what's very likely a one-off collision. Also the
        // failsafe for a producer that spawns everything fine but never actually delivers any
        // data — waitForRecordingToStart() below throws into this same catch/retry path, so a
        // stalled attempt gets exactly the same fresh-port treatment as an outright collision.
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
            let ffmpeg: ChildProcess | null = null;
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

                ffmpeg = await this.spawnFfmpegAndWaitReady(
                    this.buildRecordingFfmpegArgs(sdpPath, this.tempRecordingPath(outputPath)),
                    `${info.source} ${info.producerId} port=${destPort} attempt=${attempt}`,
                );

                await consumer.resume();
                // THE reference point for this recording's place on the playback timeline, captured
                // here rather than after the verification below — see its use as `startedAt`.
                const mediaStartedAt = new Date();
                if (!isAudio) {
                    await consumer.requestKeyFrame();
                }

                // Confirms real data is actually flowing before this attempt counts as
                // successful, re-requesting a keyframe in the meantime — see
                // waitForRecordingToStart's own doc comment for why (a single, possibly-dropped
                // request previously left a recording silently waiting forever, with nothing
                // retrying it and nothing noticing — exactly what emptied a real screen-share
                // recording once already). A timeout here is caught below like any other failed
                // attempt: fresh port, fresh transport, fresh consumer, fresh ffmpeg.
                await this.waitForRecordingToStart(this.tempRecordingPath(outputPath), consumer, !isAudio);

                const dbId = randomUUID();
                // Deliberately the time media started flowing (consumer.resume above), NOT the time
                // the verification above finished.
                //
                // PlaybackSync lays every stream on one timeline as
                // (recording.startedAt - session.startedAt), so this value IS the stream's sync
                // offset. Stamping it after waitForRecordingToStart made that offset include however
                // long verification happened to take — and that differs per stream by construction:
                // audio resolves at the first ~500ms cluster, while video additionally waits for a
                // keyframe whose PLI is only retried every 2s. Mic and webcam captured at the same
                // instant were therefore filed as starting up to seconds apart, and playback
                // faithfully pulled them out of sync. Nothing about the media differed; only the
                // moment we happened to notice it.
                //
                // Fixes screen-share drift for the same reason, which is why this is preferable to
                // muxing mic and webcam into a single file — that would only ever sync those two.
                const startedAt = mediaStartedAt;
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
                    userId: info.userId,
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
                    // Grace period so there's actually a keyframe in the temp file to extract a
                    // frame from — with -c copy the browser's own encoder decides keyframe timing
                    // (see consumer.requestKeyFrame() above), not a forced interval, so this is a
                    // generous cushion rather than tuned to a known cadence. Re-reads the live map
                    // by dbId at fire time rather than tracking a cancelable timer handle — a
                    // session that's since stopped or been replaced simply won't match, and
                    // generateFinalThumbnail covers it.
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
                // If ffmpeg already spawned successfully but a later step (consumer.resume(),
                // requestKeyFrame()) rejected, it's still running and would otherwise leak — kill
                // it before the next attempt, both so it stops holding destPort at the OS level
                // (our releasePort() above only frees our own bookkeeping) and because ffmpeg's
                // `-n` flag refuses to overwrite the temp output path a retry would reuse.
                if (ffmpeg && ffmpeg.exitCode === null && ffmpeg.signalCode === null) {
                    ffmpeg.kill('SIGKILL');
                }
                void fs.unlink(this.tempRecordingPath(outputPath)).catch(() => undefined);
                this.logger.warn(
                    `Recording start attempt ${attempt}/${MAX_ATTEMPTS} failed for producer ${info.producerId} (port=${destPort}): ${error instanceof Error ? error.message : error}`,
                );
            }
        }
        throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }

    /** Starts ONE combined recording spanning a peer's mic AND webcam — a single ffmpeg process
     *  with two RTP inputs muxed into one file (see buildCombinedRecordingFfmpegArgs), so playback
     *  gets the browser's own native A/V sync instead of two wall-clock-synced files. Both
     *  producers must already exist and be producing real data by the time this is called — see
     *  the class doc comment's "Validation spike" note for why a not-yet-live input can't work.
     *  Otherwise mirrors startVideoSession's shape closely: same retry-with-fresh-ports policy on
     *  any failure, same reasoning throughout for what's captured when. */
    private async startCombinedCameraSession(
        state: IRoomRecordingState,
        router: mediasoupTypes.Router,
        micInfo: IRecordingProducerInfo,
        webcamInfo: IRecordingProducerInfo,
    ): Promise<void> {
        const timestamp = this.formatTimestampUtc(new Date());
        const streamNumber = this.nextStreamNumber(state, `${micInfo.peerId}:camera`);
        const outputPath = path.join(
            this.recordingsDir,
            this.buildFilename(state.roomName, micInfo.displayName, 'camera', streamNumber, timestamp, micInfo.peerId),
        );

        const MAX_ATTEMPTS = 3;
        let lastError: unknown;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            const audioTransport = await router.createPlainTransport({
                listenInfo: { protocol: 'udp', ip: '127.0.0.1' },
                rtcpMux: true,
                comedia: false,
            });
            const videoTransport = await router.createPlainTransport({
                listenInfo: { protocol: 'udp', ip: '127.0.0.1' },
                rtcpMux: true,
                comedia: false,
            });
            const destPortAudio = this.allocatePort();
            const destPortVideo = this.allocatePort();
            let audioSdpPath: string | null = null;
            let videoSdpPath: string | null = null;
            let ffmpeg: ChildProcess | null = null;
            try {
                await audioTransport.connect({ ip: '127.0.0.1', port: destPortAudio });
                const audioConsumer = await audioTransport.consume({
                    producerId: micInfo.producerId,
                    rtpCapabilities: router.rtpCapabilities,
                    paused: true,
                });
                await videoTransport.connect({ ip: '127.0.0.1', port: destPortVideo });
                const videoConsumer = await videoTransport.consume({
                    producerId: webcamInfo.producerId,
                    rtpCapabilities: router.rtpCapabilities,
                    paused: true,
                });
                // Mirrors RoomService.consume()'s identical listener for a live remote viewer's
                // consumer — a producer resume (camera back on) doesn't itself trigger a keyframe,
                // so without this the recording would wait on the sender's own next natural
                // keyframe interval after every camera toggle instead of getting one immediately.
                videoConsumer.on('producerresume', () => {
                    videoConsumer.requestKeyFrame().catch((error: unknown) =>
                        this.logger.warn(`requestKeyFrame after producerresume failed for recording consumer ${videoConsumer.id}: ${error}`),
                    );
                });

                const audioCodec = audioConsumer.rtpParameters.codecs[0];
                const videoCodec = videoConsumer.rtpParameters.codecs[0];
                audioSdpPath = path.join(this.sdpScratchDir, `${micInfo.producerId}-${Date.now()}-${attempt}.sdp`);
                videoSdpPath = path.join(this.sdpScratchDir, `${webcamInfo.producerId}-${Date.now()}-${attempt}.sdp`);
                await fs.writeFile(audioSdpPath, this.buildSdp(destPortAudio, audioCodec, 'audio'));
                await fs.writeFile(videoSdpPath, this.buildSdp(destPortVideo, videoCodec, 'video'));

                ffmpeg = await this.spawnFfmpegAndWaitReady(
                    this.buildCombinedRecordingFfmpegArgs(audioSdpPath, videoSdpPath, this.tempRecordingPath(outputPath)),
                    `camera ${micInfo.peerId} audioPort=${destPortAudio} videoPort=${destPortVideo} attempt=${attempt}`,
                );

                await audioConsumer.resume();
                // Same discipline as startVideoSession: the reference point for this recording's
                // place on the playback timeline is when media actually started flowing, not when
                // the verification below finishes.
                const mediaStartedAt = new Date();
                await videoConsumer.resume();
                await videoConsumer.requestKeyFrame();

                await this.waitForRecordingToStart(this.tempRecordingPath(outputPath), videoConsumer, true);

                const dbId = randomUUID();
                const startedAt = mediaStartedAt;
                const created = await this.prisma.recording
                    .create({
                        data: {
                            id: dbId,
                            room: { connectOrCreate: { where: { name: state.roomName }, create: { name: state.roomName } } },
                            session: { connect: { id: state.sessionDbId } },
                            user: { connect: { id: micInfo.userId } },
                            displayName: micInfo.displayName,
                            streamType: 'camera',
                            streamNumber,
                            filename: path.basename(outputPath),
                            startedAt,
                        },
                        include: { user: true },
                    })
                    .catch((error: unknown) => {
                        this.logger.error(`Failed to persist combined camera recording metadata for peer ${micInfo.peerId}: ${error}`);
                        return null;
                    });
                if (created) {
                    this.events.emit('recording-added', {
                        sessionId: state.sessionDbId,
                        recordingId: dbId,
                        filename: path.basename(outputPath),
                        streamType: 'camera',
                        displayName: micInfo.displayName,
                        userId: created.userId,
                        pictureUrl: created.user?.pictureUrl ?? null,
                        startedAt: startedAt.toISOString(),
                    });
                }

                state.cameraSessions.set(micInfo.peerId, {
                    peerId: micInfo.peerId,
                    userId: micInfo.userId,
                    displayName: micInfo.displayName,
                    dbId,
                    audioProducerId: micInfo.producerId,
                    videoProducerId: webcamInfo.producerId,
                    audioTransport,
                    audioConsumer,
                    videoTransport,
                    videoConsumer,
                    audioSdpPath,
                    videoSdpPath,
                    destPortAudio,
                    destPortVideo,
                    outputPath,
                    ffmpeg,
                });

                // Same grace-period reasoning as startVideoSession's own live-thumbnail scheduling.
                const GRACE_MS = 3000;
                setTimeout(() => {
                    const current = state.cameraSessions.get(micInfo.peerId);
                    if (!current || current.dbId !== dbId) {
                        return;
                    }
                    void this.generateLiveThumbnail(state, current).catch((error: unknown) =>
                        this.logger.warn(`Live thumbnail generation failed for combined camera recording (peer ${micInfo.peerId}): ${error}`),
                    );
                }, GRACE_MS);
                return;
            } catch (error) {
                lastError = error;
                this.releasePort(destPortAudio);
                this.releasePort(destPortVideo);
                audioTransport.close();
                videoTransport.close();
                if (audioSdpPath) {
                    void fs.unlink(audioSdpPath).catch(() => undefined);
                }
                if (videoSdpPath) {
                    void fs.unlink(videoSdpPath).catch(() => undefined);
                }
                if (ffmpeg && ffmpeg.exitCode === null && ffmpeg.signalCode === null) {
                    ffmpeg.kill('SIGKILL');
                }
                void fs.unlink(this.tempRecordingPath(outputPath)).catch(() => undefined);
                this.logger.warn(
                    `Combined camera session start attempt ${attempt}/${MAX_ATTEMPTS} failed for peer ${micInfo.peerId}: ${error instanceof Error ? error.message : error}`,
                );
            }
        }
        throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }

    /**
     * Confirms the temp recording file has actually started receiving real bytes before
     * startVideoSession treats an attempt as successful. consumer.requestKeyFrame() sends a
     * single RTCP PLI/FIR request — like any RTP-level signaling packet, delivery isn't
     * guaranteed over UDP — and until now that was the ONLY request ever made: a dropped or
     * ignored one left the recording silently waiting forever for a keyframe that was never
     * coming, with nothing retrying it and nothing noticing. That's exactly what happened to a
     * real screen-share recording that stopped ~17s later having captured nothing at all.
     *
     * Re-requests a keyframe every KEYFRAME_RETRY_MS (video only — audio has no keyframe
     * concept, every Opus packet is independently decodable) while polling the temp file's size
     * every POLL_MS, so a dropped request gets a fresh chance quickly instead of relying on
     * ffmpeg's own eventual GOP cadence (or nothing). Resolves once the file is GROWING (see the
     * poll below for why "non-empty" was not good enough) — which is only sub-second because
     * buildRecordingFfmpegArgs pins the muxer's cluster interval to 500ms; at matroska's 5s
     * default this check cannot resolve for ~5s no matter what else is done. Throws if it never grows within
     * START_VERIFY_TIMEOUT_MS — startVideoSession's own MAX_ATTEMPTS retry loop treats that
     * exactly like any other failed attempt (fresh port/transport/consumer/ffmpeg), which is the
     * actual failsafe: a producer that doesn't deliver real data on one attempt gets a genuinely
     * fresh one, rather than a permanently broken, silently-empty recording nothing ever revisits.
     */
    private waitForRecordingToStart(tempPath: string, consumer: mediasoupTypes.Consumer, requestKeyframes: boolean): Promise<void> {
        const START_VERIFY_TIMEOUT_MS = 15_000;
        const KEYFRAME_RETRY_MS = 2000;
        // Half the muxer's 500ms cluster interval (see buildRecordingFfmpegArgs' -cluster_time_limit),
        // so a completed cluster is noticed on the very next tick rather than up to one full
        // cluster later.
        const POLL_MS = 250;
        return new Promise((resolve, reject) => {
            let settled = false;
            let pollTimer: ReturnType<typeof setInterval>;
            let keyframeTimer: ReturnType<typeof setInterval> | undefined;
            let timeoutTimer: ReturnType<typeof setTimeout>;

            const finish = (error?: Error) => {
                if (settled) {
                    return;
                }
                settled = true;
                clearInterval(pollTimer);
                clearTimeout(timeoutTimer);
                if (keyframeTimer) {
                    clearInterval(keyframeTimer);
                }
                if (error) {
                    reject(error);
                } else {
                    resolve();
                }
            };

            // Looks for the file GROWING between polls, not merely being non-empty. ffmpeg writes
            // the container header the instant it opens the output — 469 bytes of WebM/EBML for an
            // audio recording — whether or not a single RTP packet ever arrives. A `size > 0` check
            // therefore reported success for captures that recorded nothing at all, which also
            // meant the MAX_ATTEMPTS retry below never fired, since attempt 1 always "succeeded".
            // Growth is container-agnostic and can only happen once real media is being written.
            // It is only PROMPT, though, because buildRecordingFfmpegArgs sets -cluster_time_limit
            // 500 — an earlier version of this comment credited -flush_packets 1 for that, which
            // was simply wrong (matroskaenc buffers a whole cluster before AVIO ever sees it) and
            // cost every recording ~5s of startup until it was measured.
            let lastSize: number | null = null;
            pollTimer = setInterval(() => {
                fs.stat(tempPath)
                    .then((stat) => {
                        if (lastSize !== null && stat.size > lastSize) {
                            finish();
                            return;
                        }
                        lastSize = stat.size;
                    })
                    .catch(() => undefined); // doesn't exist yet on early polls — not an error
            }, POLL_MS);

            if (requestKeyframes) {
                keyframeTimer = setInterval(() => void consumer.requestKeyFrame().catch(() => undefined), KEYFRAME_RETRY_MS);
            }

            timeoutTimer = setTimeout(() => {
                // Which half failed is otherwise unknowable from the logs, and the two have nothing
                // in common: either mediasoup never sent (paused producer, no keyframe, dead
                // consumer) or it sent and ffmpeg never received (port bound late, wrong port,
                // dropped). packetCount answers that in one number, and a timeout is rare enough
                // that asking for stats on the way out costs nothing.
                Promise.resolve(typeof consumer.getStats === 'function' ? consumer.getStats() : [])
                    .then((stats) => {
                        const sent = stats.map((s) => `${s.type} packets=${'packetCount' in s ? s.packetCount : '?'} bytes=${'byteCount' in s ? s.byteCount : '?'}`).join('; ');
                        // score.producerScore is the part that matters when packets=0: it reports
                        // how well the SFU is RECEIVING from the browser. Zero packets out with a
                        // healthy producerScore means the consumer is the problem; zero with a dead
                        // producerScore means the browser was never sending, and no amount of
                        // consumer-side fixing would have helped.
                        const score = consumer.score as { score?: number; producerScore?: number; producerScores?: number[] } | undefined;
                        this.logger.warn(
                            `[recording-timeout] consumer ${consumer.id} kind=${consumer.kind} paused=${consumer.paused} producerPaused=${consumer.producerPaused} ` +
                                `score=${score?.score ?? '?'} producerScore=${score?.producerScore ?? '?'} producerScores=[${(score?.producerScores ?? []).join(',')}] ` +
                                `currentLayers=${JSON.stringify(consumer.currentLayers ?? null)} preferredLayers=${JSON.stringify(consumer.preferredLayers ?? null)} — ${sent || 'no stats'}`,
                        );
                    })
                    .catch(() => undefined)
                    .finally(() => finish(new Error(`No recording data received within ${START_VERIFY_TIMEOUT_MS}ms`)));
            }, START_VERIFY_TIMEOUT_MS);
        });
    }

    /** Pulled out of startVideoSession as its own pure function so it's directly unit-testable
     *  without spinning up a real mediasoup Router/ffmpeg process.
     *
     *  Stream-copies (`-c copy`) rather than transcodes: mediasoup only ever negotiates VP8
     *  (video) + Opus (audio) — see room.service.ts's MEDIA_CODECS — so the RTP arriving here is
     *  already a directly browser-playable codec pair. There's nothing to re-encode, which is
     *  also why there's no separate audio/video arg branch anymore (both are just `-c copy` into
     *  a `.webm` — VP8/Opus's own native container). This is a straight passthrough of whatever
     *  quality the sending browser's own encoder chose, instead of the previous decode-and-
     *  re-encode-at-ultrafast pipeline, which was both the CPU cost behind repeated recording
     *  corruption and a real (if secondary) quality loss on its own.
     *
     *  No mp4-style `empty_moov`/`faststart` equivalent is needed for the live-write output:
     *  Matroska (WebM's container format) writes self-contained clusters as it goes, starting a
     *  new one at each keyframe by format requirement, so an abruptly-killed temp file stays
     *  valid/playable up to its last complete cluster with no special flags — see
     *  remuxToFinalFile for why a second pass still matters for proper seeking. */
    private buildRecordingFfmpegArgs(sdpPath: string, tempOutputPath: string): string[] {
        return [
            '-n',
            '-protocol_whitelist',
            'file,udp,rtp',
            // Without this, ffmpeg trusts the RTP stream's raw clock timestamps as-is, which can
            // have jitter/discontinuities — wall-clock timestamps (when packets actually arrived)
            // give a correct container duration/playback timing instead. Unrelated to the
            // transcode-vs-copy decision, still needed either way.
            '-use_wallclock_as_timestamps',
            '1',
            '-i',
            sdpPath,
            '-c',
            'copy',
            // Minimizes how much data sits in ffmpeg's userspace I/O buffer rather than being
            // handed to the OS. Cheap now that there's no libx264 CPU cost competing for cycles.
            // NOTE: on its own this does far less than it looks like it does — see the cluster
            // limit below for what actually governs when bytes reach the file.
            '-flush_packets',
            '1',
            // THE thing that determines how often this file physically grows. matroskaenc
            // assembles each cluster in an in-memory dynamic buffer (it has to, to compute the
            // cluster's CRC32) and only hands it to the AVIO layer once the cluster closes — so
            // -flush_packets has nothing to flush until then, and the file sits at exactly its
            // 469-byte header until the first cluster completes. At matroska's default 5000ms
            // cluster_time_limit that's ~5s: measured 4.84s mean cluster spacing on a real 27kbps
            // mic capture, whose 15-21KB clusters never came near the 32KB size limit.
            //
            // That directly gated waitForRecordingToStart's growth check, which physically could
            // not resolve sooner and so put ~5s of latency on every single recording start.
            // Closing clusters every 500ms restores a sub-second start while leaving the growth
            // check's meaning untouched (real media, never just a header), and independently
            // shrinks how much trailing audio an abruptly-SIGKILLed capture loses with its final
            // unflushed cluster, from ~5s to ~0.5s.
            //
            // Costs nothing in the delivered artifact: remuxToFinalFile re-muxes into the final
            // file and matroskaenc re-clusters at its own defaults on that pass, so this is a
            // temp-file-only property. Overhead is ~10-20 bytes of cluster header at 2/sec.
            '-cluster_time_limit',
            '500',
            tempOutputPath,
        ];
    }

    /** Two-input variant for a combined mic+webcam session (see startCombinedCameraSession) —
     *  otherwise identical to buildRecordingFfmpegArgs above, same reasoning throughout for every
     *  flag shared between them. Two differences, both confirmed necessary by the validation spike
     *  documented in this file's class doc comment:
     *  - `-protocol_whitelist file,udp,rtp` must be repeated before EACH `-i`, not passed once —
     *    ffmpeg's CLI applies it to only the next input; a single shared copy left the second
     *    input rejected outright ("Protocol 'rtp' not on whitelist").
     *  - Explicit `-map 0:a -map 1:v`, since relying on ffmpeg's automatic stream-selection
     *    heuristics across two different-media-type inputs (safe for buildRecordingFfmpegArgs,
     *    which only ever has one) isn't something to lean on here. */
    private buildCombinedRecordingFfmpegArgs(audioSdpPath: string, videoSdpPath: string, tempOutputPath: string): string[] {
        return [
            '-n',
            '-protocol_whitelist',
            'file,udp,rtp',
            '-use_wallclock_as_timestamps',
            '1',
            '-i',
            audioSdpPath,
            '-protocol_whitelist',
            'file,udp,rtp',
            '-use_wallclock_as_timestamps',
            '1',
            '-i',
            videoSdpPath,
            '-map',
            '0:a',
            '-map',
            '1:v',
            '-c',
            'copy',
            '-flush_packets',
            '1',
            '-cluster_time_limit',
            '500',
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

    /** Combined-session counterpart to finalizeVideoSession above — same two-phase shape and
     *  reasoning, just closing two transports/consumers/ports/sdp files instead of one. A camera
     *  session always has video, so (unlike finalizeVideoSession) there's no `source !== 'mic'`
     *  check before generating a thumbnail. */
    private async finalizeCombinedCameraSession(state: IRoomRecordingState, session: ICombinedCameraSession): Promise<void> {
        await this.stopFfmpegGracefully(session.ffmpeg);
        session.audioConsumer.close();
        session.audioTransport.close();
        this.releasePort(session.destPortAudio);
        void fs.unlink(session.audioSdpPath).catch(() => undefined);
        session.videoConsumer?.close();
        session.videoTransport.close();
        this.releasePort(session.destPortVideo);
        void fs.unlink(session.videoSdpPath).catch(() => undefined);

        const hasContent = await this.remuxToFinalFile(this.tempRecordingPath(session.outputPath), session.outputPath);

        const stoppedAt = new Date();
        await this.prisma.recording
            .update({ where: { id: session.dbId }, data: { stoppedAt, hasContent } })
            .catch((error: unknown) => this.logger.error(`Failed to record stoppedAt for combined camera recording ${session.dbId}: ${error}`));
        this.events.emit('recording-ready', {
            sessionId: state.sessionDbId,
            recordingId: session.dbId,
            url: hasContent ? this.buildLocalFileUrl(path.basename(session.outputPath)) : null,
            stoppedAt: stoppedAt.toISOString(),
            hasContent,
        });

        if (hasContent) {
            void this.generateFinalThumbnail(state, session).catch((error: unknown) =>
                this.logger.warn(`Final thumbnail generation failed for combined camera recording ${session.dbId}: ${error}`),
            );
            void this.uploadAndNotify(state, session.outputPath, session.dbId).catch((error: unknown) =>
                this.logger.error(`Post-finalize GCS upload failed for combined camera recording ${session.dbId}: ${error}`),
            );
        }
    }

    private async teardownRoom(state: IRoomRecordingState): Promise<void> {
        // Finalizes whatever's still open, concurrently, AND waits for anything already
        // finalizing in the background from an earlier individual stream stop (see
        // pendingFinalizations) — each finalize is just a graceful ffmpeg quit plus a cheap
        // -c copy remux, so there's no CPU contention to stagger against.
        await Promise.all([
            ...[...state.videoSessions.values()].map((session) => this.finalizeVideoSession(state, session)),
            ...[...state.cameraSessions.values()].map((session) => this.finalizeCombinedCameraSession(state, session)),
            ...state.pendingFinalizations,
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
     * The live recording writes to a temp WebM file (see buildRecordingFfmpegArgs — clusters are
     * self-contained as they're written, but the Cues seek index and final Segment
     * duration/size only ever get written at trailer time, which only runs on a clean exit).
     * Once that process has exited, this does a fast `-c copy` remux into the real, final path —
     * on a clean stop this is close to a no-op (the temp file likely already has a reasonable
     * trailer), but on an abrupt SIGKILL (a retry, or stopFfmpegGracefully's 5s-timeout fallback)
     * the temp file's trailer never ran at all, and this is the only place a proper Cues
     * index/duration ever gets built for it. Best-effort: logs and keeps the temp file (rather
     * than throwing) if the remux itself fails, so a stop/close action never fails because of this.
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
            await this.runFfmpegToCompletion(['-y', '-i', tempPath, '-c', 'copy', finalPath], `remux ${path.basename(finalPath)}`);
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
     *  generateFinalThumbnail always covers it properly once the recording actually stops.
     *  Structurally typed on just the two fields it needs, rather than IRecordingVideoSession
     *  specifically, so ICombinedCameraSession (a combined mic+webcam session) can reuse this too. */
    private async generateLiveThumbnail(state: IRoomRecordingState, session: { outputPath: string; dbId: string }): Promise<void> {
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
     *  thumbnailUpdatedAt cache-busts it) with a full-color frame. Best-effort, same as above.
     *  Structurally typed for the same reason as generateLiveThumbnail above. */
    private async generateFinalThumbnail(state: IRoomRecordingState, session: { outputPath: string; dbId: string }): Promise<void> {
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
        return finalPath.replace(/\.webm$/, '.recording.webm');
    }

    /** Runs ffmpeg on a finite local-file input to completion (unlike spawnFfmpegAndWaitReady, which is for live RTP input and never awaits full completion).
     *  Always deprioritized (see deprioritize()) — remux/thumbnail generation operate on
     *  already-recorded files and can simply take a bit longer under CPU contention with zero
     *  data-loss risk, unlike a live recording process consuming real-time, unbufferable RTP. */
    private runFfmpegToCompletion(args: string[], logLabel: string): Promise<void> {
        return new Promise((resolve, reject) => {
            const ffmpeg = spawn(this.ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
            this.deprioritize(ffmpeg, logLabel);
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

    /** Lowers OS scheduling priority (nice) for a non-time-critical ffmpeg process, so it yields
     *  CPU to any concurrently-running LIVE recording process under contention — those consume
     *  real-time, unbufferable RTP and permanently lose data if starved even briefly (confirmed
     *  via a real incident: several video streams starting together starved each other badly
     *  enough that some never wrote a single frame). Raising niceness (unlike lowering it) needs
     *  no special privileges, but this is still best-effort/non-fatal — a container/OS that
     *  doesn't permit it shouldn't break recording over a scheduling nicety. */
    private deprioritize(proc: ChildProcess, logLabel: string): void {
        if (!proc.pid) {
            return;
        }
        try {
            os.setPriority(proc.pid, 19); // lowest niceness available without elevated privileges
        } catch (error) {
            this.logger.debug(`Could not lower priority for ffmpeg (${logLabel}): ${error instanceof Error ? error.message : error}`);
        }
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
        return `${this.sanitize(roomName)}-${this.sanitize(username)}${peerSegment}-${timestamp}-${streamType}-${streamNumber}.webm`;
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
