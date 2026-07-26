import { Logger } from '@nestjs/common';
import {
    ConnectedSocket,
    MessageBody,
    OnGatewayDisconnect,
    SubscribeMessage,
    WebSocketGateway,
    WebSocketServer,
    WsException,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { getAllowedOrigins } from '../config/cors-origins';
import { GoogleAuthService } from './google-auth.service';
import { RecordingService } from './recording.service';
import { RoomService } from './room.service';
import { TurnCredentialsService } from './turn-credentials.service';
import type {
    IChatMessage,
    IChatMessagePayload,
    ICloseProducerPayload,
    IConnectTransportPayload,
    IConsumePayload,
    ICreateTransportPayload,
    IJoinRoomPayload,
    IProducePayload,
    IResumeConsumerPayload,
} from './interfaces/room.interfaces';

@WebSocketGateway({
    namespace: 'room',
    cors: {
        origin: getAllowedOrigins(),
        credentials: true,
    },
    transports: ['websocket', 'polling'],
})
export class RoomGateway implements OnGatewayDisconnect {
    private readonly logger = new Logger(RoomGateway.name);

    @WebSocketServer()
    server!: Server;

    constructor(
        private readonly roomService: RoomService,
        private readonly turnCredentialsService: TurnCredentialsService,
        private readonly googleAuthService: GoogleAuthService,
        private readonly recordingService: RecordingService,
    ) {
        this.roomService.events.on('active-speakers', ({ roomName, peerIds }: { roomName: string; peerIds: string[] }) => {
            this.server.to(roomName).emit('active-speakers', { peerIds });
        });
        this.recordingService.events.on('recording-state', ({ roomName, isRecording }: { roomName: string; isRecording: boolean }) => {
            this.server.to(roomName).emit('recording-state', { isRecording });
        });
    }

    handleDisconnect(socket: Socket): void {
        const closed = this.roomService.closePeer(socket.id);
        if (!closed) {
            return;
        }
        for (const producerId of closed.removedProducerIds) {
            socket.to(closed.roomName).emit('producer-closed', { producerId });
        }
        socket.to(closed.roomName).emit('peer-left', { peerId: socket.id, displayName: closed.displayName });
    }

    @SubscribeMessage('join-room')
    async onJoinRoom(@ConnectedSocket() socket: Socket, @MessageBody() payload: IJoinRoomPayload) {
        const profile = await this.googleAuthService.verify(payload.googleIdToken);
        if (!profile) {
            throw new WsException('Google sign-in could not be verified.');
        }
        const roomName = payload.roomName?.trim() || 'lobby';
        const result = await this.roomService.joinRoom(socket.id, roomName, profile.displayName, profile.pictureUrl);
        await socket.join(roomName);
        socket.data.roomName = roomName;
        socket.data.displayName = profile.displayName;
        socket.to(roomName).emit('peer-joined', { peerId: socket.id, displayName: profile.displayName, pictureUrl: profile.pictureUrl });
        const turnCredentials = this.turnCredentialsService.generateFor(socket.id);
        return { ...result, iceServers: turnCredentials ? [turnCredentials] : [] };
    }

    @SubscribeMessage('create-transport')
    async onCreateTransport(@ConnectedSocket() socket: Socket, @MessageBody() payload: ICreateTransportPayload) {
        return this.roomService.createTransport(socket.id, payload.direction);
    }

    @SubscribeMessage('connect-transport')
    async onConnectTransport(@ConnectedSocket() socket: Socket, @MessageBody() payload: IConnectTransportPayload) {
        await this.roomService.connectTransport(socket.id, payload.direction, payload.dtlsParameters);
        return { ok: true };
    }

    @SubscribeMessage('produce')
    async onProduce(@ConnectedSocket() socket: Socket, @MessageBody() payload: IProducePayload) {
        const summary = await this.roomService.produce(socket.id, payload.kind, payload.rtpParameters, payload.source);
        const roomName = socket.data.roomName as string;
        socket.to(roomName).emit('new-producer', summary);
        return { id: summary.producerId };
    }

    @SubscribeMessage('close-producer')
    onCloseProducer(@ConnectedSocket() socket: Socket, @MessageBody() payload: ICloseProducerPayload) {
        const result = this.roomService.closeProducer(socket.id, payload.producerId);
        if (!result) {
            return { ok: false };
        }
        socket.to(result.roomName).emit('producer-closed', { producerId: payload.producerId });
        return { ok: true };
    }

    @SubscribeMessage('consume')
    async onConsume(@ConnectedSocket() socket: Socket, @MessageBody() payload: IConsumePayload) {
        return this.roomService.consume(socket.id, payload.producerId, payload.rtpCapabilities);
    }

    @SubscribeMessage('resume-consumer')
    async onResumeConsumer(@ConnectedSocket() socket: Socket, @MessageBody() payload: IResumeConsumerPayload) {
        await this.roomService.resumeConsumer(socket.id, payload.consumerId);
        return { ok: true };
    }

    @SubscribeMessage('start-recording')
    async onStartRecording(@ConnectedSocket() socket: Socket) {
        // Returns { ok: false, error } rather than throwing on failure — NestJS's
        // WS gateway only fills the client's ack callback when a handler RETURNS
        // a value; a thrown WsException is routed to a separate 'exception' event
        // instead, leaving the client's emitWithAck() promise unresolved forever.
        const roomName = socket.data.roomName as string | undefined;
        if (!roomName) {
            return { ok: false, error: 'Not in a room.' };
        }
        const snapshot = this.roomService.getRecordingSnapshot(roomName);
        if (!snapshot) {
            return { ok: false, error: 'Room not found.' };
        }
        try {
            await this.recordingService.start(roomName, snapshot);
        } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : 'Failed to start recording.' };
        }
        return { ok: true };
    }

    @SubscribeMessage('stop-recording')
    async onStopRecording(@ConnectedSocket() socket: Socket) {
        const roomName = socket.data.roomName as string | undefined;
        if (!roomName) {
            return { ok: false, error: 'Not in a room.' };
        }
        await this.recordingService.stop(roomName);
        return { ok: true };
    }

    @SubscribeMessage('chat-message')
    onChatMessage(@ConnectedSocket() socket: Socket, @MessageBody() payload: IChatMessagePayload) {
        const roomName = socket.data.roomName as string;
        if (!roomName || !payload.text?.trim()) {
            return;
        }
        const message: IChatMessage = {
            peerId: socket.id,
            displayName: socket.data.displayName ?? 'Anonymous',
            text: payload.text.trim(),
            at: new Date().toISOString(),
        };
        this.server.to(roomName).emit('chat-message', message);
    }
}
