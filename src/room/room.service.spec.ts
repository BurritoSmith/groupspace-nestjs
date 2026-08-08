import { RoomService, planWorkerPorts } from './room.service';
import { IPeerState } from './interfaces/room.interfaces';

function seedRouter(target: RoomService, roomName: string): void {
    // getOrCreateRouter() returns whatever's already in routersByRoom before touching the
    // mediasoup worker, so pre-seeding it here lets joinRoom() be tested without a real worker.
    const routersByRoom = (target as unknown as { routersByRoom: Map<string, unknown> }).routersByRoom;
    routersByRoom.set(roomName, { rtpCapabilities: {} });
}

describe('RoomService', () => {
    let service: RoomService;

    beforeEach(() => {
        // isRecording()/getRecordingStartedAt() are the only RecordingService methods joinRoom()
        // itself calls; every other test in this file exercises methods that never touch
        // RecordingService at all.
        service = new RoomService({ isRecording: jest.fn().mockReturnValue(false), getRecordingStartedAt: jest.fn().mockReturnValue(null) } as never);
    });

    describe('setMicSelfMuted', () => {
        function seedPeer(peerId: string, roomName: string): void {
            const peers = (service as unknown as { peers: Map<string, IPeerState> }).peers;
            peers.set(peerId, {
                peerId,
                userId: 'user-1',
                displayName: 'Clay',
                pictureUrl: '',
                micSelfMuted: false,
                focused: true,
                roomName,
                router: {} as never,
                sendTransport: null,
                recvTransport: null,
                producers: new Map(),
                consumers: new Map(),
            });
        }

        it('sets the flag and returns the peer\'s roomName when the peer exists', () => {
            seedPeer('peer-1', 'lobby');

            const result = service.setMicSelfMuted('peer-1', true);

            expect(result).toEqual({ roomName: 'lobby' });
            const peers = (service as unknown as { peers: Map<string, IPeerState> }).peers;
            expect(peers.get('peer-1')?.micSelfMuted).toBe(true);
        });

        it('can flip the flag back to false', () => {
            seedPeer('peer-1', 'lobby');
            service.setMicSelfMuted('peer-1', true);

            service.setMicSelfMuted('peer-1', false);

            const peers = (service as unknown as { peers: Map<string, IPeerState> }).peers;
            expect(peers.get('peer-1')?.micSelfMuted).toBe(false);
        });

        it('returns null and touches nothing when the peer is unknown', () => {
            const result = service.setMicSelfMuted('nonexistent-peer', true);

            expect(result).toBeNull();
        });
    });

    describe('setPeerFocus / getFocusedUserIds', () => {
        function seedPeer(peerId: string, userId: string, roomName: string, focused = true): void {
            const peers = (service as unknown as { peers: Map<string, IPeerState> }).peers;
            peers.set(peerId, {
                peerId,
                userId,
                displayName: 'Clay',
                pictureUrl: '',
                micSelfMuted: false,
                focused,
                roomName,
                router: {} as never,
                sendTransport: null,
                recvTransport: null,
                producers: new Map(),
                consumers: new Map(),
            });
        }

        it('flips a peer\'s focused flag', () => {
            seedPeer('peer-1', 'user-1', 'lobby', true);

            service.setPeerFocus('peer-1', false);

            const peers = (service as unknown as { peers: Map<string, IPeerState> }).peers;
            expect(peers.get('peer-1')?.focused).toBe(false);
        });

        it('does nothing when the peer is unknown, rather than throwing', () => {
            expect(() => service.setPeerFocus('nonexistent-peer', true)).not.toThrow();
        });

        it('returns the userIds of every focused peer in the room', () => {
            seedPeer('peer-1', 'user-1', 'lobby', true);
            seedPeer('peer-2', 'user-2', 'lobby', false);

            expect(service.getFocusedUserIds('lobby')).toEqual(new Set(['user-1']));
        });

        it('counts a user as focused if ANY of their devices/peers in the room is', () => {
            seedPeer('peer-1', 'user-1', 'lobby', false);
            seedPeer('peer-2', 'user-1', 'lobby', true);

            expect(service.getFocusedUserIds('lobby')).toEqual(new Set(['user-1']));
        });

        it('ignores peers in a different room', () => {
            seedPeer('peer-1', 'user-1', 'other-room', true);

            expect(service.getFocusedUserIds('lobby')).toEqual(new Set());
        });
    });

    describe('consume', () => {
        function seedConsumingPeer(consumeMock: jest.Mock): void {
            const peers = (service as unknown as { peers: Map<string, IPeerState> }).peers;
            peers.set('viewer-1', {
                peerId: 'viewer-1',
                userId: 'user-1',
                displayName: 'Viewer',
                pictureUrl: '',
                micSelfMuted: false,
                focused: true,
                roomName: 'lobby',
                router: { canConsume: () => true } as never,
                sendTransport: null,
                recvTransport: { consume: consumeMock } as never,
                producers: new Map(),
                consumers: new Map(),
            });
        }

        it('defaults a freshly-created video consumer to the lowest simulcast layer', async () => {
            const setPreferredLayers = jest.fn().mockResolvedValue(undefined);
            // `on` stub — RoomService.consume() registers a 'producerresume' keyframe-request
            // listener on every video consumer (see its own comment on why).
            const consumeMock = jest.fn().mockResolvedValue({ id: 'consumer-1', kind: 'video', rtpParameters: {}, setPreferredLayers, on: jest.fn() });
            seedConsumingPeer(consumeMock);

            await service.consume('viewer-1', 'producer-1', {} as never);

            expect(setPreferredLayers).toHaveBeenCalledWith({ spatialLayer: 0 });
        });

        it('does not touch layers for an audio consumer', async () => {
            const setPreferredLayers = jest.fn().mockResolvedValue(undefined);
            const consumeMock = jest.fn().mockResolvedValue({ id: 'consumer-1', kind: 'audio', rtpParameters: {}, setPreferredLayers });
            seedConsumingPeer(consumeMock);

            await service.consume('viewer-1', 'producer-1', {} as never);

            expect(setPreferredLayers).not.toHaveBeenCalled();
        });
    });

    describe('setConsumerQuality', () => {
        function seedPeerWithConsumer(consumer: { kind: 'video' | 'audio'; producerId: string; setPreferredLayers: jest.Mock }): void {
            const peers = (service as unknown as { peers: Map<string, IPeerState> }).peers;
            const consumers = new Map([['consumer-1', consumer as never]]);
            peers.set('viewer-1', {
                peerId: 'viewer-1',
                userId: 'user-1',
                displayName: 'Viewer',
                pictureUrl: '',
                micSelfMuted: false,
                focused: true,
                roomName: 'lobby',
                router: {} as never,
                sendTransport: null,
                recvTransport: null,
                producers: new Map(),
                consumers,
            });
        }

        /** Seeds the producer-owning peer (a *different* peer than the one consuming it — mirrors
         *  the real topology) so findProducer() inside setConsumerQuality() can resolve its
         *  negotiated encodings. */
        function seedOwningPeer(producerId: string, encodingsLength: number): void {
            const peers = (service as unknown as { peers: Map<string, IPeerState> }).peers;
            peers.set('publisher-1', {
                peerId: 'publisher-1',
                userId: 'user-2',
                displayName: 'Publisher',
                pictureUrl: '',
                micSelfMuted: false,
                focused: true,
                roomName: 'lobby',
                router: {} as never,
                sendTransport: null,
                recvTransport: null,
                producers: new Map([
                    [
                        producerId,
                        {
                            source: 'screen',
                            producer: { rtpParameters: { encodings: Array.from({ length: encodingsLength }) } } as never,
                        },
                    ],
                ]),
                consumers: new Map(),
            });
        }

        it("resolves 'high' to the producer's own highest negotiated layer index", async () => {
            const setPreferredLayers = jest.fn().mockResolvedValue(undefined);
            seedPeerWithConsumer({ kind: 'video', producerId: 'producer-1', setPreferredLayers });
            seedOwningPeer('producer-1', 2); // 2-layer simulcast — highest index is 1

            await service.setConsumerQuality('viewer-1', 'consumer-1', 'high');

            expect(setPreferredLayers).toHaveBeenCalledWith({ spatialLayer: 1 });
        });

        it("resolves 'low' to spatial layer 0 regardless of the producer's layer count", async () => {
            const setPreferredLayers = jest.fn().mockResolvedValue(undefined);
            seedPeerWithConsumer({ kind: 'video', producerId: 'producer-1', setPreferredLayers });
            seedOwningPeer('producer-1', 2);

            await service.setConsumerQuality('viewer-1', 'consumer-1', 'low');

            expect(setPreferredLayers).toHaveBeenCalledWith({ spatialLayer: 0 });
        });

        it('is a no-op for an audio consumer', async () => {
            const setPreferredLayers = jest.fn().mockResolvedValue(undefined);
            seedPeerWithConsumer({ kind: 'audio', producerId: 'producer-1', setPreferredLayers });

            await service.setConsumerQuality('viewer-1', 'consumer-1', 'high');

            expect(setPreferredLayers).not.toHaveBeenCalled();
        });

        it('falls back to spatial layer 0 for \'high\' if the owning producer can no longer be found', async () => {
            const setPreferredLayers = jest.fn().mockResolvedValue(undefined);
            seedPeerWithConsumer({ kind: 'video', producerId: 'producer-1', setPreferredLayers });
            // No seedOwningPeer() call — producer genuinely gone (e.g. closed moments earlier).

            await service.setConsumerQuality('viewer-1', 'consumer-1', 'high');

            expect(setPreferredLayers).toHaveBeenCalledWith({ spatialLayer: 0 });
        });

        it('throws for an unknown consumerId', async () => {
            seedPeerWithConsumer({ kind: 'video', producerId: 'producer-1', setPreferredLayers: jest.fn() });

            await expect(service.setConsumerQuality('viewer-1', 'nonexistent-consumer', 'high')).rejects.toThrow(
                'No consumer nonexistent-consumer for peer viewer-1',
            );
        });
    });

    describe('joinRoom', () => {
        // Regression coverage: chat messages carry userId but not peerId/pictureUrl, and the
        // roster (peers) carried peerId/pictureUrl but not userId — no join key between them for
        // the frontend to look up a message sender's avatar. userId closes that gap.
        it("includes each existing peer's userId in the returned roster", async () => {
            seedRouter(service, 'lobby');
            await service.joinRoom('peer-1', 'lobby', 'user-1', 'Clay', 'https://pic-1');

            const result = await service.joinRoom('peer-2', 'lobby', 'user-2', 'Burr', 'https://pic-2');

            expect(result.peers).toEqual([{ peerId: 'peer-1', userId: 'user-1', displayName: 'Clay', pictureUrl: 'https://pic-1', micSelfMuted: false }]);
        });

        // Regression coverage: a client joining after recording has already started must see
        // isRecording: true immediately in the join result, not just via a 'recording-state'
        // broadcast it could never have received — see IJoinRoomResult.isRecording's comment.
        it('reports isRecording: true when RecordingService says the room is currently recording', async () => {
            const fakeRecordingService = { isRecording: jest.fn().mockReturnValue(true), getRecordingStartedAt: jest.fn().mockReturnValue(null) };
            const target = new RoomService(fakeRecordingService as never);
            seedRouter(target, 'lobby');

            const result = await target.joinRoom('peer-1', 'lobby', 'user-1', 'Clay', 'https://pic');

            expect(result.isRecording).toBe(true);
            expect(fakeRecordingService.isRecording).toHaveBeenCalledWith('lobby');
        });

        it('reports isRecording: false when the room is not being recorded', async () => {
            const fakeRecordingService = { isRecording: jest.fn().mockReturnValue(false), getRecordingStartedAt: jest.fn().mockReturnValue(null) };
            const target = new RoomService(fakeRecordingService as never);
            seedRouter(target, 'lobby');

            const result = await target.joinRoom('peer-1', 'lobby', 'user-1', 'Clay', 'https://pic');

            expect(result.isRecording).toBe(false);
        });

        // Regression coverage: a late joiner's recording timer must reflect the true elapsed
        // time, not restart from 00:00 — this is what lets the frontend compute that instead of
        // just knowing recording is active. See IJoinRoomResult.recordingStartedAt's comment.
        it("reports the recording's actual start time as an ISO string when currently recording", async () => {
            const startedAt = new Date('2026-07-28T12:00:00.000Z');
            const fakeRecordingService = { isRecording: jest.fn().mockReturnValue(true), getRecordingStartedAt: jest.fn().mockReturnValue(startedAt) };
            const target = new RoomService(fakeRecordingService as never);
            seedRouter(target, 'lobby');

            const result = await target.joinRoom('peer-1', 'lobby', 'user-1', 'Clay', 'https://pic');

            expect(result.recordingStartedAt).toBe('2026-07-28T12:00:00.000Z');
            expect(fakeRecordingService.getRecordingStartedAt).toHaveBeenCalledWith('lobby');
        });

        it('reports recordingStartedAt: null when not recording', async () => {
            const fakeRecordingService = { isRecording: jest.fn().mockReturnValue(false), getRecordingStartedAt: jest.fn().mockReturnValue(null) };
            const target = new RoomService(fakeRecordingService as never);
            seedRouter(target, 'lobby');

            const result = await target.joinRoom('peer-1', 'lobby', 'user-1', 'Clay', 'https://pic');

            expect(result.recordingStartedAt).toBeNull();
        });
    });
});

/**
 * The pool's whole safety property is that no two workers can be handed the same port. mediasoup
 * tracks port usage per Worker, so an overlap is not caught anywhere at runtime — it surfaces as an
 * intermittent bind failure under load, which is the worst possible way to find out.
 */
describe('planWorkerPorts', () => {
    /** Production today: 40000-40199 from deploy/.env.example. */
    const PROD_MIN = 40000;
    const PROD_MAX = 40199;

    it('never overlaps two workers, whatever the inputs', () => {
        for (const cpus of [1, 2, 4, 8, 16]) {
            for (const [min, max] of [
                [PROD_MIN, PROD_MAX],
                [10000, 10199],
                [40000, 41999],
                [1000, 1099],
            ]) {
                const ranges = planWorkerPorts(cpus, min, max);
                for (let i = 1; i < ranges.length; i += 1) {
                    expect(ranges[i].minPort).toBeGreaterThan(ranges[i - 1].maxPort);
                }
                expect(ranges[0].minPort).toBe(min);
                // The last slice absorbs the remainder, so the configured range — which has to match
                // the firewall rule — is fully used and never exceeded.
                expect(ranges[ranges.length - 1].maxPort).toBe(max);
            }
        }
    });

    it('gives production two workers on its 200-port range', () => {
        expect(planWorkerPorts(8, PROD_MIN, PROD_MAX)).toEqual([
            { minPort: 40000, maxPort: 40099 },
            { minPort: 40100, maxPort: 40199 },
        ]);
    });

    // Ports are a hard external limit — the firewall rule has to match — so they cap the pool even
    // on a machine with cores to spare. Running out of ports fails a join; running out of
    // parallelism only makes things slower.
    it('is capped by the port range rather than the CPU count', () => {
        expect(planWorkerPorts(32, PROD_MIN, PROD_MAX)).toHaveLength(2);
    });

    it('never returns fewer than one worker, even for a range too small to slice', () => {
        expect(planWorkerPorts(8, 40000, 40009)).toEqual([{ minPort: 40000, maxPort: 40009 }]);
    });

    it('uses no more workers than there are CPUs, since a worker is single-threaded', () => {
        expect(planWorkerPorts(1, 40000, 41999)).toHaveLength(1);
        expect(planWorkerPorts(3, 40000, 41999)).toHaveLength(3);
    });

    it('honours an explicit override, but still not past what the ports afford', () => {
        expect(planWorkerPorts(1, 40000, 41999, 4)).toHaveLength(4);
        expect(planWorkerPorts(1, PROD_MIN, PROD_MAX, 16)).toHaveLength(2);
    });

    it('ignores a nonsensical override rather than producing zero workers', () => {
        expect(planWorkerPorts(4, PROD_MIN, PROD_MAX, 0)).toHaveLength(2);
        expect(planWorkerPorts(4, PROD_MIN, PROD_MAX, -1)).toHaveLength(2);
    });
});

/**
 * Routers used to live until the process restarted — created on first join, never closed. A server
 * that had seen a thousand rooms held a thousand Routers and their observers, and the worker pool's
 * least-loaded placement decayed into meaninglessness because every count only ever rose.
 */
describe('RoomService — releasing an empty room', () => {
    let service: RoomService;
    let stop: jest.Mock;
    let router: { close: jest.Mock };
    let slot: { routers: number };

    function internals() {
        return service as unknown as {
            peers: Map<string, IPeerState>;
            routersByRoom: Map<string, unknown>;
            slotByRoom: Map<string, unknown>;
            audioLevelObserversByRoom: Map<string, unknown>;
        };
    }

    function seedPeer(peerId: string, roomName: string): void {
        internals().peers.set(peerId, {
            peerId,
            userId: `user-${peerId}`,
            displayName: 'Clay',
            pictureUrl: '',
            micSelfMuted: false,
            focused: true,
            roomName,
            router: {} as never,
            sendTransport: null,
            recvTransport: null,
            producers: new Map(),
            consumers: new Map(),
        });
    }

    beforeEach(() => {
        stop = jest.fn().mockResolvedValue(undefined);
        router = { close: jest.fn() };
        slot = { routers: 1 };
        service = new RoomService({
            isRecording: jest.fn().mockReturnValue(false),
            getRecordingStartedAt: jest.fn().mockReturnValue(null),
            notifyProducerClosing: jest.fn(),
            stop,
        } as never);
        internals().routersByRoom.set('honey', router);
        internals().slotByRoom.set('honey', slot);
        internals().audioLevelObserversByRoom.set('honey', {});
    });

    it('closes the router once the last peer leaves, and hands the load back', async () => {
        seedPeer('peer-1', 'honey');

        service.closePeer('peer-1');
        await Promise.resolve();
        await Promise.resolve();

        expect(router.close).toHaveBeenCalledTimes(1);
        expect(internals().routersByRoom.has('honey')).toBe(false);
        expect(internals().audioLevelObserversByRoom.has('honey')).toBe(false);
        // Without this the pool keeps placing new rooms as though this one were still here.
        expect(slot.routers).toBe(0);
    });

    it('keeps the router while anyone is still in the room', async () => {
        seedPeer('peer-1', 'honey');
        seedPeer('peer-2', 'honey');

        service.closePeer('peer-1');
        await Promise.resolve();
        await Promise.resolve();

        expect(router.close).not.toHaveBeenCalled();
        expect(internals().routersByRoom.has('honey')).toBe(true);
    });

    /** The close runs AFTER an awaited recording stop, so there is a real window in which someone
     *  can rejoin. Closing then would pull the router out from under them. */
    it('does not close the router when someone rejoins while the recording is being finalized', async () => {
        seedPeer('peer-1', 'honey');
        let finishStop: () => void = () => undefined;
        stop.mockReturnValue(new Promise<void>((resolve) => { finishStop = resolve; }));

        service.closePeer('peer-1');
        seedPeer('peer-2', 'honey'); // rejoined mid-finalization
        finishStop();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(router.close).not.toHaveBeenCalled();
        expect(internals().routersByRoom.has('honey')).toBe(true);
    });

    /** stop() is best-effort; a failure there must not strand the router forever. */
    it('still releases the router when stopping the recording rejects', async () => {
        seedPeer('peer-1', 'honey');
        stop.mockRejectedValue(new Error('ffmpeg went away'));
        jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined);

        service.closePeer('peer-1');
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(router.close).toHaveBeenCalledTimes(1);
    });
});

/**
 * Creating a Router is real I/O, so "get or create" has an await in the middle of it — and anything
 * with an await in the middle of a check-then-act can run twice.
 */
describe('RoomService: two people joining one empty room at once', () => {
    interface IProbeSlot {
        worker: { createRouter: jest.Mock };
        listenInfos: unknown[];
        routers: number;
    }

    function serviceWithPool(slots: number): { service: RoomService; pool: IProbeSlot[]; built: { closed: boolean }[] } {
        const built: { closed: boolean }[] = [];
        const service = new RoomService({
            isRecording: () => false,
            getRecordingStartedAt: () => null,
            stop: async () => undefined,
            notifyProducerClosing: () => undefined,
        } as never);
        const pool: IProbeSlot[] = Array.from({ length: slots }, () => ({
            worker: {
                createRouter: jest.fn(async () => {
                    // The delay is the point: without it there is no window to race in.
                    await new Promise((resolve) => setTimeout(resolve, 5));
                    const router = {
                        closed: false,
                        close: jest.fn(function (this: { closed: boolean }) {
                            this.closed = true;
                        }),
                        createAudioLevelObserver: jest.fn(async () => ({ on: jest.fn() })),
                        rtpCapabilities: {},
                    };
                    built.push(router);
                    return router;
                }),
            },
            listenInfos: [],
            routers: 0,
        }));
        (service as unknown as { workers: IProbeSlot[] }).workers.push(...pool);
        return { service, pool, built };
    }

    function peerRouters(service: RoomService): unknown[] {
        const peers = (service as unknown as { peers: Map<string, IPeerState> }).peers;
        return [...peers.values()].map((peer) => peer.router);
    }

    /* Both joiners used to get past the routersByRoom check, build a Router each, and end up on
     * DIFFERENT ones — in the same room, unable to see or hear each other. */
    it('puts both peers on one router', async () => {
        const { service, built } = serviceWithPool(2);

        await Promise.all([
            service.joinRoom('peer-a', 'lobby', 'user-a', 'A', ''),
            service.joinRoom('peer-b', 'lobby', 'user-b', 'B', ''),
        ]);

        expect(built).toHaveLength(1);
        const [routerA, routerB] = peerRouters(service);
        expect(routerA).toBe(routerB);
    });

    /* The second Router had nothing pointing at it, so the close-when-empty path could never find
     * it — the very leak this pool was built to stop, surviving in the one case that creates two. */
    it('leaves nothing open once the room empties', async () => {
        const { service, pool, built } = serviceWithPool(2);
        await Promise.all([
            service.joinRoom('peer-a', 'lobby', 'user-a', 'A', ''),
            service.joinRoom('peer-b', 'lobby', 'user-b', 'B', ''),
        ]);

        service.closePeer('peer-a');
        service.closePeer('peer-b');
        await new Promise((resolve) => setTimeout(resolve, 5));

        expect(built.filter((router) => !router.closed)).toHaveLength(0);
        // Back to zero, so least-loaded placement still means something on the next room.
        expect(pool.map((slot) => slot.routers)).toEqual([0, 0]);
    });

    /* Claiming the slot only after createRouter resolves makes every simultaneous room see the same
     * all-zero counts and pile onto worker 0 — round-robin with extra steps, and on one core. */
    it('spreads simultaneous rooms across the pool', async () => {
        const { service, pool } = serviceWithPool(2);

        await Promise.all([
            service.joinRoom('peer-a', 'lobby', 'user-a', 'A', ''),
            service.joinRoom('peer-b', 'attic', 'user-b', 'B', ''),
        ]);

        expect(pool.map((slot) => slot.routers)).toEqual([1, 1]);
    });
});
