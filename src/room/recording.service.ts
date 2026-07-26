import { Injectable, Logger } from '@nestjs/common';
import { ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { types as mediasoupTypes } from 'mediasoup';
import {
    IRecordingAudioInput,
    IRecordingAudioMixSession,
    IRecordingProducerInfo,
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

    isRecording(roomName: string): boolean {
        return this.rooms.has(roomName);
    }

    /** Starts recording every currently active producer in the room. Throws if already recording. */
    async start(roomName: string, snapshot: IRecordingSnapshot): Promise<void> {
        if (this.rooms.has(roomName)) {
            throw new Error('Recording is already active for this room.');
        }
        await fs.mkdir(this.recordingsDir, { recursive: true });
        await fs.mkdir(this.sdpScratchDir, { recursive: true });

        const state: IRoomRecordingState = {
            roomName,
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

    /** Stops recording and finalizes every open file for the room. Idempotent — a no-op if not recording. */
    async stop(roomName: string): Promise<void> {
        const state = this.rooms.get(roomName);
        if (!state) {
            return;
        }
        this.rooms.delete(roomName);
        await this.teardownRoom(state);
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
        void this.finalizeVideoSession(session).catch((error: unknown) =>
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
        const transport = await router.createPlainTransport({
            listenInfo: { protocol: 'udp', ip: '127.0.0.1' },
            rtcpMux: true,
            comedia: false,
        });
        const destPort = this.allocatePort();
        try {
            await transport.connect({ ip: '127.0.0.1', port: destPort });
            const consumer = await transport.consume({
                producerId: info.producerId,
                rtpCapabilities: router.rtpCapabilities,
                paused: true,
            });
            const codec = consumer.rtpParameters.codecs[0];
            const sdpPath = path.join(this.sdpScratchDir, `${info.producerId}-${Date.now()}.sdp`);
            await fs.writeFile(sdpPath, this.buildSdp(destPort, codec, 'video'));

            const timestamp = this.formatTimestampUtc(new Date());
            const streamNumber = this.nextStreamNumber(state, `${info.peerId}:${info.source}`);
            const outputPath = path.join(
                this.recordingsDir,
                this.buildFilename(state.roomName, info.displayName, info.source, streamNumber, timestamp),
            );

            const ffmpeg = spawn(
                'ffmpeg',
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
                    '-movflags',
                    '+frag_keyframe+empty_moov+faststart',
                    outputPath,
                ],
                { stdio: ['pipe', 'ignore', 'pipe'] },
            );
            ffmpeg.stderr?.on('data', (chunk: Buffer) => this.logger.debug(`[ffmpeg ${info.producerId}] ${chunk}`));

            // Let ffmpeg's UDP listener bind before mediasoup starts sending, so the first packets aren't dropped.
            await new Promise((resolve) => setTimeout(resolve, 300));
            await consumer.resume();
            await consumer.requestKeyFrame();

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
            });
        } catch (error) {
            this.releasePort(destPort);
            transport.close();
            throw error;
        }
    }

    private async finalizeVideoSession(session: IRecordingVideoSession): Promise<void> {
        await this.stopFfmpegGracefully(session.ffmpeg);
        session.consumer.close();
        session.transport.close();
        this.releasePort(session.destPort);
        void fs.unlink(session.sdpPath).catch(() => undefined);
    }

    private async startAudioMix(
        state: IRoomRecordingState,
        router: mediasoupTypes.Router,
        mics: IRecordingProducerInfo[],
    ): Promise<void> {
        if (mics.length === 0) {
            return; // nothing to record yet — wait for the first mic
        }
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
                const sdpPath = path.join(this.sdpScratchDir, `${mic.producerId}-${Date.now()}.sdp`);
                await fs.writeFile(sdpPath, this.buildSdp(destPort, codec, 'audio'));
                inputs.push({ producerId: mic.producerId, peerId: mic.peerId, transport, consumer, destPort, sdpPath });
            }

            const timestamp = this.formatTimestampUtc(new Date());
            const streamNumber = this.nextStreamNumber(state, 'mixed-audio:audio');
            const outputPath = path.join(
                this.recordingsDir,
                this.buildFilename(state.roomName, 'mixed-audio', 'audio', streamNumber, timestamp),
            );

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
                '-movflags',
                '+frag_keyframe+empty_moov+faststart',
                outputPath,
            );
            const ffmpeg = spawn('ffmpeg', args, { stdio: ['pipe', 'ignore', 'pipe'] });
            ffmpeg.stderr?.on('data', (chunk: Buffer) => this.logger.debug(`[ffmpeg audio-mix ${state.roomName}] ${chunk}`));

            await new Promise((resolve) => setTimeout(resolve, 300));
            for (const input of inputs) {
                await input.consumer.resume();
            }

            state.audioMix = { inputs, outputPath, ffmpeg };
        } catch (error) {
            for (const input of inputs) {
                input.consumer.close();
                input.transport.close();
                this.releasePort(input.destPort);
                void fs.unlink(input.sdpPath).catch(() => undefined);
            }
            throw error;
        }
    }

    private async restartAudioMix(
        state: IRoomRecordingState,
        router: mediasoupTypes.Router,
        mics: IRecordingProducerInfo[],
    ): Promise<void> {
        const old = state.audioMix;
        state.audioMix = null;
        if (old) {
            await this.finalizeAudioMix(old);
        }
        await this.startAudioMix(state, router, mics);
    }

    private async finalizeAudioMix(mix: IRecordingAudioMixSession): Promise<void> {
        await this.stopFfmpegGracefully(mix.ffmpeg);
        for (const input of mix.inputs) {
            input.consumer.close();
            input.transport.close();
            this.releasePort(input.destPort);
            void fs.unlink(input.sdpPath).catch(() => undefined);
        }
    }

    private async teardownRoom(state: IRoomRecordingState): Promise<void> {
        await Promise.all([
            ...[...state.videoSessions.values()].map((session) => this.finalizeVideoSession(session)),
            this.withAudioMixLock(state, () => (state.audioMix ? this.finalizeAudioMix(state.audioMix) : Promise.resolve())),
        ]);
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
}
