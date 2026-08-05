import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as webpush from 'web-push';
import { RoomMembershipService } from './room-membership.service';
import { PushSubscriptionService, IPushSubscriptionRow } from './push-subscription.service';
import { FcmTokenService, IFcmTokenRow } from './fcm-token.service';
import { FcmService } from './fcm.service';
import { UserSettingsService } from './user-settings.service';
import { PushPayload, chatMessageTag, peerJoinedTag } from './push-payload.interface';

/** web-push payloads have roughly a 4KB ceiling — this is nowhere near it, just a sane cap on how
 *  much of one message's text ever needs to show in a notification body. */
const MAX_MESSAGE_TEXT_LENGTH = 300;

const NOTIFICATIONS_MASTER_KEY = 'notifications-master';
const NOTIFICATIONS_NEW_MESSAGE_KEY = 'notifications-new-message';
const NOTIFICATIONS_PERSON_JOINED_KEY = 'notifications-person-joined';

/**
 * Sends Web Push notifications for room activity (new chat messages, someone joining), fanned out
 * to every device a room's OTHER members have registered — and handles the cross-device "I just
 * looked at the app, dismiss my other devices' notifications" signal.
 *
 * Eligibility: a `RoomMember` row (see RoomMembershipService) plus that user's own account-wide
 * notification preference, stored as plain `UserSetting` rows (no new preferences table — see
 * user-settings.service.ts) — so a fully offline member with no open tab anywhere still gets
 * notified. The one presence-aware exception is `focusedUserIds` (RoomService.getFocusedUserIds,
 * client-reported via 'set-focus'): a member already looking at the room live, on ANY device, is
 * skipped entirely for that event, since a push would just be telling them something they can
 * already see.
 */
@Injectable()
export class PushNotificationService implements OnModuleInit {
    private readonly logger = new Logger(PushNotificationService.name);
    private configured = false;

    constructor(
        private readonly roomMembership: RoomMembershipService,
        private readonly pushSubscriptions: PushSubscriptionService,
        private readonly fcmTokens: FcmTokenService,
        private readonly fcm: FcmService,
        private readonly userSettings: UserSettingsService,
    ) {}

    onModuleInit(): void {
        const publicKey = process.env.VAPID_PUBLIC_KEY;
        const privateKey = process.env.VAPID_PRIVATE_KEY;
        const subject = process.env.VAPID_SUBJECT;
        if (!publicKey || !privateKey || !subject) {
            // Missing in most local dev setups until someone opts in — push just silently no-ops
            // rather than blocking startup, unlike SESSION_JWT_SECRET which is load-bearing everywhere.
            this.logger.warn('VAPID keys not configured — push notifications are disabled.');
            return;
        }
        webpush.setVapidDetails(subject, publicKey, privateKey);
        this.configured = true;
    }

    async notifyChatMessage(
        roomName: string,
        actorUserId: string,
        senderDisplayName: string,
        messageText: string,
        messageId: string,
        focusedUserIds: ReadonlySet<string>,
        iconUrl?: string,
        imageUrl?: string,
        senderPictureUrl?: string,
    ): Promise<void> {
        const payload: PushPayload = {
            type: 'chat-message',
            roomName,
            senderDisplayName,
            messageText: messageText.slice(0, MAX_MESSAGE_TEXT_LENGTH),
            messageId,
            tag: chatMessageTag(roomName),
            ...(iconUrl ? { iconUrl } : {}),
            ...(imageUrl ? { imageUrl } : {}),
            // Guarded rather than always spread: pictureUrl is '' (not undefined) for an account
            // Google gave no picture for, and shipping an empty string would have the client set
            // an icon it can never load instead of falling back to the app's own.
            ...(senderPictureUrl ? { senderPictureUrl } : {}),
        };
        await this.notifyRoomMembers(roomName, actorUserId, NOTIFICATIONS_NEW_MESSAGE_KEY, payload, focusedUserIds);
    }

    async notifyPeerJoined(
        roomName: string,
        actorUserId: string,
        joinerDisplayName: string,
        focusedUserIds: ReadonlySet<string>,
        joinerPictureUrl?: string,
    ): Promise<void> {
        const payload: PushPayload = {
            type: 'peer-joined',
            roomName,
            joinerDisplayName,
            tag: peerJoinedTag(roomName),
            ...(joinerPictureUrl ? { joinerPictureUrl } : {}),
        };
        await this.notifyRoomMembers(roomName, actorUserId, NOTIFICATIONS_PERSON_JOINED_KEY, payload, focusedUserIds);
    }

    async dismissOtherDevices(userId: string, callerDeviceId: string): Promise<void> {
        if ((!this.configured && !this.fcm.isConfigured()) || !userId) {
            return;
        }
        const subscriptions = await this.pushSubscriptions.listForUser(userId, callerDeviceId);
        const tokens = await this.fcmTokens.listForUser(userId, callerDeviceId);
        await Promise.all([...subscriptions.map((sub) => this.send(sub, { type: 'dismiss-all' })), ...tokens.map((tok) => this.sendFcm(tok, { type: 'dismiss-all' }))]);
    }

    /** `focusedUserIds` — every user with at least one device currently looking at this room live
     *  (see RoomService.getFocusedUserIds) — is excluded outright, on every one of their devices,
     *  not just the focused one: they're already aware of the activity, so a push to their OTHER
     *  idle devices would just be a redundant ping about something they've already seen. */
    private async notifyRoomMembers(
        roomName: string,
        actorUserId: string,
        categoryKey: string,
        payload: PushPayload,
        focusedUserIds: ReadonlySet<string>,
    ): Promise<void> {
        if (!this.configured && !this.fcm.isConfigured()) {
            return;
        }
        const members = await this.roomMembership.listMembersWithProfile(roomName);
        this.logger.debug(
            `notify ${payload.type} in ${roomName}: actor=${actorUserId} members=[${members.map((m) => m.userId).join(',')}] focused=[${[...focusedUserIds].join(',')}]`,
        );
        const recipients = members.filter((member) => member.userId !== actorUserId && !focusedUserIds.has(member.userId));
        await Promise.all(
            recipients.map(async (member) => {
                const settings = await this.userSettings.getAll(member.userId);
                if (!this.isEnabled(settings, categoryKey)) {
                    this.logger.debug(`skip ${member.userId}: category "${categoryKey}" not enabled`);
                    return;
                }
                const subscriptions = await this.pushSubscriptions.listForUser(member.userId);
                const tokens = await this.fcmTokens.listForUser(member.userId);
                this.logger.debug(`sending to ${member.userId}: ${subscriptions.length} subscription(s), ${tokens.length} FCM token(s)`);
                await Promise.all([...subscriptions.map((sub) => this.send(sub, payload)), ...tokens.map((tok) => this.sendFcm(tok, payload))]);
            }),
        );
    }

    private isEnabled(settings: { key: string; deviceId: string; value: unknown }[], categoryKey: string): boolean {
        const isTrue = (key: string) => settings.some((s) => s.key === key && s.deviceId === '' && s.value === true);
        return isTrue(NOTIFICATIONS_MASTER_KEY) && isTrue(categoryKey);
    }

    private async send(subscription: IPushSubscriptionRow, payload: PushPayload): Promise<void> {
        try {
            const result = await webpush.sendNotification(
                { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
                JSON.stringify(payload),
            );
            this.logger.debug(`push accepted by vendor (status ${result?.statusCode}) for subscription ${subscription.id}`);
        } catch (error: unknown) {
            const statusCode = (error as { statusCode?: number }).statusCode;
            if (statusCode === 404 || statusCode === 410) {
                this.logger.debug(`subscription ${subscription.id} gone (${statusCode}) — deleting`);
                await this.pushSubscriptions.deleteById(subscription.id);
            } else {
                this.logger.warn(`Push send failed (${statusCode ?? 'unknown'}) for subscription ${subscription.id}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }

    private async sendFcm(token: IFcmTokenRow, payload: PushPayload): Promise<void> {
        const result = await this.fcm.send(token.token, payload);
        if (result === 'gone') {
            this.logger.debug(`FCM token ${token.id} gone — deleting`);
            await this.fcmTokens.deleteById(token.id);
        }
    }
}
