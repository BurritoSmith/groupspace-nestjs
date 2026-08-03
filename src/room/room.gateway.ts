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
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { Server, Socket } from 'socket.io';
import { getAllowedOrigins } from '../config/cors-origins';
import { sanitizeAttachment } from './chat-attachment-url';
import { sanitizeReactionEmoji } from './chat-reaction-emoji';
import { ChatReactionService } from './chat-reaction.service';
import { ChatMediaService } from './chat-media.service';
import { ChatService, HISTORY_PAGE_SIZE } from './chat.service';
import { GoogleAuthService } from './google-auth.service';
import { LinkPreviewService, extractFirstUrl } from './link-preview.service';
import { RecordingService } from './recording.service';
import { RoomService } from './room.service';
import { SessionService } from './session.service';
import { TurnCredentialsService } from './turn-credentials.service';
import { UsersService } from './users.service';
import { UserSettingsService } from './user-settings.service';
import type {
    IChatMessage,
    IChatMessagePayload,
    IChatMessageUpdate,
    ICloseProducerPayload,
    IConnectTransportPayload,
    IConsumePayload,
    ICreateTransportPayload,
    IJoinRoomPayload,
    IProducePayload,
    IResumeConsumerPayload,
    ISaveUserSettingPayload,
    ISetConsumerQualityPayload,
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
        private readonly usersService: UsersService,
        private readonly userSettingsService: UserSettingsService,
        private readonly chatService: ChatService,
        private readonly sessionService: SessionService,
        private readonly chatMediaService: ChatMediaService,
        private readonly linkPreviewService: LinkPreviewService,
        private readonly chatReactionService: ChatReactionService,
    ) {
        this.roomService.events.on('active-speakers', ({ roomName, peerIds }: { roomName: string; peerIds: string[] }) => {
            this.server.to(roomName).emit('active-speakers', { peerIds });
        });
        this.recordingService.events.on(
            'recording-state',
            ({ roomName, isRecording, startedAt }: { roomName: string; isRecording: boolean; startedAt: string | null }) => {
                this.server.to(roomName).emit('recording-state', { isRecording, startedAt });
            },
        );
        // Fan-out for the playback page's progressive-availability UI — a bare broadcast room per
        // recording session, joined via subscribe-recording-session below. Unlike the video-call
        // room, there's no application-level state tied to membership here, so no disconnect
        // cleanup is needed on this side (see subscribe/unsubscribe handlers' comment).
        this.recordingService.events.on(
            'recording-ready',
            ({
                sessionId,
                recordingId,
                url,
                stoppedAt,
                hasContent,
            }: {
                sessionId: string;
                recordingId: string;
                url: string | null;
                stoppedAt: string;
                hasContent: boolean;
            }) => {
                this.server.to(`recording-session:${sessionId}`).emit('recording-ready', { recordingId, url, stoppedAt, hasContent });
            },
        );
        this.recordingService.events.on(
            'thumbnail-updated',
            ({
                sessionId,
                recordingId,
                thumbnailUrl,
                thumbnailStatus,
            }: {
                sessionId: string;
                recordingId: string;
                thumbnailUrl: string | null;
                thumbnailStatus: string;
            }) => {
                this.server.to(`recording-session:${sessionId}`).emit('thumbnail-updated', { recordingId, thumbnailUrl, thumbnailStatus });
            },
        );
        this.recordingService.events.on(
            'recording-uploaded',
            ({ sessionId, recordingId, url }: { sessionId: string; recordingId: string; url: string | null }) => {
                this.server.to(`recording-session:${sessionId}`).emit('recording-uploaded', { recordingId, url });
            },
        );
        // A brand-new stream (webcam/screen start, or a mic-set change creating a fresh
        // mixed-audio row) starting while someone is already viewing this session's playback
        // page — lets that viewer's tile grid grow live instead of only ever reflecting
        // whatever existed at page load.
        this.recordingService.events.on(
            'recording-added',
            ({
                sessionId,
                recordingId,
                filename,
                streamType,
                displayName,
                userId,
                pictureUrl,
                startedAt,
            }: {
                sessionId: string;
                recordingId: string;
                filename: string;
                streamType: string;
                displayName: string;
                userId: string | null;
                pictureUrl: string | null;
                startedAt: string;
            }) => {
                this.server
                    .to(`recording-session:${sessionId}`)
                    .emit('recording-added', { recordingId, filename, streamType, displayName, userId, pictureUrl, startedAt });
            },
        );
    }

    handleDisconnect(socket: Socket): void {
        this.cleanupPeer(socket);
    }

    /** Explicit "I'm done with this room" signal — distinct from a real socket disconnect
     *  because SocketConnection is a page-wide singleton that the playback route reuses
     *  (recordings dropdown -> playback navigates within the same SPA, same socket). Without
     *  this, navigating away only tore down state locally; the server never learned the peer
     *  left, so its producers/transports stayed open and other peers were left looking at a
     *  frozen last frame instead of getting a producer-closed/peer-left broadcast. */
    @SubscribeMessage('leave-room')
    onLeaveRoom(@ConnectedSocket() socket: Socket): { ok: true } {
        this.cleanupPeer(socket);
        return { ok: true };
    }

    private cleanupPeer(socket: Socket): void {
        const closed = this.roomService.closePeer(socket.id);
        if (!closed) {
            return;
        }
        for (const producerId of closed.removedProducerIds) {
            socket.to(closed.roomName).emit('producer-closed', { producerId });
        }
        socket.to(closed.roomName).emit('peer-left', { peerId: socket.id, displayName: closed.displayName });
        // No-op on a socket that's already disconnecting; matters for the still-connected
        // leave-room path so a later join-room on this same socket starts from a clean slate.
        void socket.leave(closed.roomName);
    }

    @SubscribeMessage('join-room')
    async onJoinRoom(@ConnectedSocket() socket: Socket, @MessageBody() payload: IJoinRoomPayload) {
        let userId: string;
        let displayName: string;
        let pictureUrl: string;

        if (payload.sessionToken) {
            // Returning session — resume without touching Google at all. The exact message
            // below is matched on by the frontend to distinguish "truly signed out, go back to
            // the login screen" from any other join failure.
            const session = this.sessionService.verify(payload.sessionToken);
            const user = session && (await this.usersService.findById(session.userId));
            if (!user) {
                throw new WsException('Session expired. Please sign in again.');
            }
            ({ id: userId, displayName, pictureUrl } = user);
        } else {
            // Fresh sign-in — the only path that ever talks to Google, and the only one that
            // creates/updates the User row.
            const profile = await this.googleAuthService.verify(payload.googleIdToken ?? '');
            if (!profile) {
                throw new WsException('Google sign-in could not be verified.');
            }
            const user = await this.usersService.upsertFromGoogleProfile(profile);
            userId = user.id;
            displayName = profile.displayName;
            pictureUrl = profile.pictureUrl;
        }

        // Reissued on every successful join regardless of which path was taken above — this is
        // what gives the session a sliding expiry rather than one fixed deadline from first
        // sign-in: as long as the app gets used at least once within the token's lifetime, the
        // user is never forced back to a Google sign-in.
        const sessionToken = this.sessionService.issue(userId);

        const roomName = this.normalizeRoomName(payload.roomName);
        const result = await this.roomService.joinRoom(socket.id, roomName, userId, displayName, pictureUrl);
        await socket.join(roomName);
        socket.data.roomName = roomName;
        socket.data.displayName = displayName;
        socket.data.userId = userId;
        socket.data.pictureUrl = pictureUrl;
        socket.to(roomName).emit('peer-joined', { peerId: socket.id, userId, displayName, pictureUrl, micSelfMuted: false });
        const turnCredentials = this.turnCredentialsService.generateFor(socket.id);
        const chatHistory = await this.chatService.getRecentHistory(roomName);
        const userSettings = await this.userSettingsService.getAll(userId);
        return {
            ...result,
            userId,
            sessionToken,
            chatHistory,
            hasMoreChatHistory: chatHistory.length === HISTORY_PAGE_SIZE,
            iceServers: turnCredentials ? [turnCredentials] : [],
            userSettings,
        };
    }

    /** Room names are case-insensitive — trimmed + lowercased once here, the single earliest
     *  point every downstream consumer (in-memory router/recording-state Maps, every Socket.IO
     *  room string, every Prisma Room/RecordingSession/ChatMessage row) derives from, so
     *  normalizing here alone is sufficient for the whole app. Pulled out as its own method so
     *  this is testable without exercising the rest of onJoinRoom's session/Google-auth logic. */
    private normalizeRoomName(raw: string | undefined): string {
        const normalized = raw?.trim().toLowerCase() ?? '';
        if (!normalized) {
            throw new WsException('A room name is required.');
        }
        return normalized;
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
        // Returns { ok: false, error } rather than throwing — see onStartRecording's comment
        // below. This one bit real: an uncaught throw here left the client's
        // consumeRemoteProducer() awaiting a promise that would never resolve, so the
        // stream's tile/track setup code after it never ran at all.
        try {
            await this.roomService.resumeConsumer(socket.id, payload.consumerId);
            return { ok: true };
        } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : 'Failed to resume consumer.' };
        }
    }

    @SubscribeMessage('set-consumer-quality')
    async onSetConsumerQuality(@ConnectedSocket() socket: Socket, @MessageBody() payload: ISetConsumerQualityPayload) {
        // Same ok/error-ack shape as onResumeConsumer above, for the same reason — an uncaught
        // throw here would leave the client's emitWithAck() promise hung forever.
        try {
            await this.roomService.setConsumerQuality(socket.id, payload.consumerId, payload.quality);
            return { ok: true };
        } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : 'Failed to change stream quality.' };
        }
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
        // Deliberately does NOT log a 'join' event for whoever's already in the room — join/leave
        // events are now derived from mic producer start/stop (see RecordingService
        // .notifyProducerCreated/.notifyProducerClosing), which naturally excludes anyone already
        // producing when recording starts (that goes through start()'s own snapshot path, never
        // notifyProducerCreated) and naturally covers every later join/leave, however many times.
        return { ok: true };
    }

    @SubscribeMessage('stop-recording')
    async onStopRecording(@ConnectedSocket() socket: Socket, @MessageBody() payload: { name?: string }) {
        const roomName = socket.data.roomName as string | undefined;
        if (!roomName) {
            return { ok: false, error: 'Not in a room.' };
        }
        await this.recordingService.stop(roomName, payload?.name?.trim() || undefined);
        return { ok: true };
    }

    @SubscribeMessage('list-recording-sessions')
    async onListRecordingSessions(@ConnectedSocket() socket: Socket) {
        const roomName = socket.data.roomName as string | undefined;
        if (!roomName) {
            return { sessions: [] };
        }
        try {
            const sessions = await this.recordingService.listRecentSessions(roomName);
            return { sessions };
        } catch (error) {
            this.logger.error(`Failed to list recording sessions for room ${roomName}: ${error}`);
            return { sessions: [] };
        }
    }

    @SubscribeMessage('get-recording-session')
    async onGetRecordingSession(@MessageBody() payload: { id: string }) {
        try {
            const session = await this.recordingService.getSessionDetail(payload.id);
            if (!session) {
                return { session: null };
            }
            const chatHistory = await this.chatService.getHistoryForSession(
                session.roomName,
                new Date(session.startedAt),
                session.stoppedAt ? new Date(session.stoppedAt) : null,
            );
            return { session: { ...session, chatHistory } };
        } catch (error) {
            this.logger.error(`Failed to load recording session ${payload.id}: ${error}`);
            return { session: null };
        }
    }

    /** No room-membership check — same rationale as get-recording-session above (the playback
     *  route can be visited directly). Unlike join-room/leave-room, there's no server-side
     *  bookkeeping beyond Socket.IO's own room membership here — it's a bare broadcast-fan-out
     *  channel, so a disconnect needs no explicit cleanup; Socket.IO already removes a
     *  disconnected socket from every room it was in. */
    @SubscribeMessage('subscribe-recording-session')
    onSubscribeRecordingSession(@ConnectedSocket() socket: Socket, @MessageBody() payload: { id: string }): { ok: true } {
        void socket.join(`recording-session:${payload.id}`);
        return { ok: true };
    }

    @SubscribeMessage('unsubscribe-recording-session')
    onUnsubscribeRecordingSession(@ConnectedSocket() socket: Socket, @MessageBody() payload: { id: string }): { ok: true } {
        void socket.leave(`recording-session:${payload.id}`);
        return { ok: true };
    }

    @SubscribeMessage('chat-message')
    onChatMessage(@ConnectedSocket() socket: Socket, @MessageBody() payload: IChatMessagePayload) {
        const roomName = socket.data.roomName as string;
        const userId = socket.data.userId as string;
        // Untrusted client input — only URLs that actually resolve to our own chat-media storage
        // (or, for a gif, the Giphy CDN) survive this; anything else is silently dropped rather
        // than rejecting the whole message, since a stripped attachment is still a usable text
        // message. See sanitizeAttachment's own comment for what else gets clamped here.
        const attachments = (payload.attachments ?? [])
            .map((attachment) => sanitizeAttachment(attachment, this.chatMediaService.publicBase))
            .filter((attachment) => attachment !== null);
        const text = payload.text?.trim() ?? '';
        if (!roomName || !userId || (!text && attachments.length === 0)) {
            return;
        }
        const message: IChatMessage = {
            id: randomUUID(), // generated here so the broadcast doesn't wait on the DB insert
            userId,
            displayName: socket.data.displayName ?? 'Anonymous',
            pictureUrl: (socket.data.pictureUrl as string | undefined) ?? '',
            text,
            at: new Date().toISOString(),
            ...(attachments.length > 0 ? { attachments } : {}),
        };
        this.server.to(roomName).emit('chat-message', message);
        this.chatService.saveMessage(
            message.id,
            roomName,
            userId,
            message.displayName,
            message.pictureUrl,
            message.text,
            new Date(message.at),
            attachments,
        );
        this.scrapeLinkPreview(message.id, roomName, text);
    }

    /**
     * Adds or removes this user's reaction on one message, then broadcasts the message's whole
     * reaction state.
     *
     * PERSIST FIRST, THEN BROADCAST — deliberately the opposite of onChatMessage above, which
     * generates its own id up front precisely so delivery never waits on the insert. A reaction has
     * no such latency pressure (it's one indexed write, and the sender's own UI has already updated
     * optimistically), and writing first buys two things: the broadcast is derived from real
     * database state, so concurrent taps converge instead of racing; and there is no way to show
     * everyone a reaction whose write then failed and which vanishes on the next refresh.
     *
     * It also disposes of the one ordering hazard here. ChatService.saveMessage is fire-and-forget,
     * so the ChatMessage row a reaction points at may not exist yet. Writing first turns that into
     * a failed insert and an { ok: false } ack the client reverts, rather than a phantom reaction.
     *
     * Auth is the file's usual idiom — read socket.data, bail if it isn't there. No handler in this
     * gateway uses a guard; socket.data is only ever populated by a successful join-room.
     */
    @SubscribeMessage('chat-reaction')
    async onChatReaction(
        @ConnectedSocket() socket: Socket,
        @MessageBody() payload: { messageId?: string; emoji?: string },
    ): Promise<{ ok: boolean }> {
        const roomName = socket.data.roomName as string | undefined;
        const userId = socket.data.userId as string | undefined;
        const messageId = payload?.messageId;
        const emoji = sanitizeReactionEmoji(payload?.emoji);
        if (!roomName || !userId || !emoji || typeof messageId !== 'string' || !messageId) {
            return { ok: false };
        }
        const displayName = (socket.data.displayName as string | undefined) ?? 'Anonymous';
        try {
            await this.chatReactionService.toggle(messageId, userId, displayName, emoji);
            const reactions = await this.chatReactionService.listGrouped(messageId);
            const update: IChatMessageUpdate = { id: messageId, reactions };
            this.server.to(roomName).emit('chat-message-updated', update);
            return { ok: true };
        } catch (error: unknown) {
            // Most likely a foreign-key violation against a message that doesn't exist (or hasn't
            // been inserted yet). Nothing was broadcast, so the client's revert leaves both sides
            // agreeing that the reaction never happened.
            this.logger.warn(`Failed to toggle reaction on message ${messageId}: ${error}`);
            return { ok: false };
        }
    }

    /**
     * Soft-deletes one of the sender's OWN messages, then broadcasts the flag.
     *
     * Same persist-first-then-broadcast shape as onChatReaction above, for the same reason: there's
     * no way to tell every client "this is deleted" and then have the delete itself fail to persist.
     * Ownership is enforced entirely inside ChatService.softDelete's `updateMany({ where: { id,
     * userId } })` — userId here comes from socket.data, never from the payload, so a forged
     * messageId against someone else's row simply matches zero rows and returns { ok: false }.
     */
    @SubscribeMessage('chat-message-delete')
    async onChatMessageDelete(@ConnectedSocket() socket: Socket, @MessageBody() payload: { messageId?: string }): Promise<{ ok: boolean }> {
        const roomName = socket.data.roomName as string | undefined;
        const userId = socket.data.userId as string | undefined;
        const messageId = payload?.messageId;
        if (!roomName || !userId || typeof messageId !== 'string' || !messageId) {
            return { ok: false };
        }
        const deleted = await this.chatService.softDelete(messageId, userId);
        if (!deleted) {
            return { ok: false };
        }
        const update: IChatMessageUpdate = { id: messageId, deleted: true };
        this.server.to(roomName).emit('chat-message-updated', update);
        return { ok: true };
    }

    /**
     * Kicks off link-preview scraping for a message that has already been delivered.
     *
     * Deliberately detached rather than awaited: a scrape is a network round trip to a third party
     * (plus, when there's an image, a second one and an upload), and no chat message should wait on
     * a stranger's server to appear. The card arrives via 'chat-message-updated' whenever it's
     * ready, or never — both are fine.
     *
     * A message with no URL costs nothing here; extractFirstUrl is a single regex over text we
     * already have in hand.
     */
    private scrapeLinkPreview(messageId: string, roomName: string, text: string): void {
        const url = extractFirstUrl(text);
        if (!url) {
            return;
        }
        void this.linkPreviewService
            .fetchPreview(url, roomName)
            .then(async (linkPreview) => {
                if (!linkPreview) {
                    return; // nothing worth showing — leave the message exactly as sent
                }
                await this.chatService.updateLinkPreview(messageId, linkPreview);
                const update: IChatMessageUpdate = { id: messageId, linkPreview };
                this.server.to(roomName).emit('chat-message-updated', update);
            })
            .catch((error: unknown) => this.logger.debug(`Link preview scrape failed for message ${messageId}: ${error}`));
    }

    /** Purely ephemeral — no persistence, no ack. socket.to() (not this.server.to()) so the
     *  typing user never receives their own broadcast back, matching peer-joined's convention. */
    @SubscribeMessage('user-typing')
    onUserTyping(@ConnectedSocket() socket: Socket) {
        const roomName = socket.data.roomName as string;
        if (!roomName) {
            return;
        }
        socket.to(roomName).emit('user-typing', { peerId: socket.id, displayName: socket.data.displayName ?? 'Anonymous' });
    }

    @SubscribeMessage('user-stopped-typing')
    onUserStoppedTyping(@ConnectedSocket() socket: Socket) {
        const roomName = socket.data.roomName as string;
        if (!roomName) {
            return;
        }
        socket.to(roomName).emit('user-stopped-typing', { peerId: socket.id });
    }

    /** Client-side "still producing, but silenced" mute — see IPeerState.micSelfMuted for why
     *  this needs real server-side state (a late joiner's join-room ack must reflect it),
     *  unlike the fully ephemeral typing-indicator broadcasts above. */
    @SubscribeMessage('mic-mute-changed')
    onMicMuteChanged(@ConnectedSocket() socket: Socket, @MessageBody() payload: { muted: boolean }) {
        const result = this.roomService.setMicSelfMuted(socket.id, payload.muted);
        if (!result) {
            return;
        }
        socket.to(result.roomName).emit('mic-mute-changed', { peerId: socket.id, muted: payload.muted });
    }

    /** Generic per-user setting save — one handler for every settings key (starting with the
     *  microphone threshold, `deviceId`-scoped), so a future setting needs no new gateway code.
     *  Never throws: an unauthenticated/expected failure comes back as {ok:false, error} — a
     *  thrown WsException never fills the caller's ack callback, only a real return value does. */
    @SubscribeMessage('save-user-setting')
    async onSaveUserSetting(@ConnectedSocket() socket: Socket, @MessageBody() payload: ISaveUserSettingPayload) {
        const userId = socket.data.userId as string | undefined;
        if (!userId) {
            return { ok: false, error: 'Not signed in.' };
        }
        try {
            await this.userSettingsService.save(userId, payload.key, payload.deviceId, payload.value as Prisma.InputJsonValue);
            return { ok: true };
        } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : 'Failed to save setting' };
        }
    }

    @SubscribeMessage('load-earlier-chat-messages')
    async onLoadEarlierChatMessages(@ConnectedSocket() socket: Socket, @MessageBody() payload: { before: string }) {
        const roomName = socket.data.roomName as string | undefined;
        if (!roomName) {
            return { messages: [], hasMore: false };
        }
        const messages = await this.chatService.getMessagesBefore(roomName, new Date(payload.before));
        return { messages, hasMore: messages.length === HISTORY_PAGE_SIZE };
    }
}
