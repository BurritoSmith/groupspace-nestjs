import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as webpush from 'web-push';
import { RoomMembershipService } from './room-membership.service';
import { PushSubscriptionService, IPushSubscriptionRow } from './push-subscription.service';
import { FcmTokenService, IFcmTokenRow } from './fcm-token.service';
import { FcmService } from './fcm.service';
import { UserSettingsService } from './user-settings.service';
import { PushPayload, chatMessageTag, peerJoinedTag } from './push-payload.interface';
import { dropSilentPushIntolerant, suppressNativeDuplicates } from './push-platform';

/** web-push payloads have roughly a 4KB ceiling — this is nowhere near it, just a sane cap on how
 *  much of one message's text ever needs to show in a notification body. */
const MAX_MESSAGE_TEXT_LENGTH = 300;

/** A preference is opt-IN: only an explicit `true` at the account-wide scope (deviceId '') counts,
 *  so a missing row reads as off rather than as a default-on. */
function isSettingTrue(settings: { key: string; deviceId: string; value: unknown }[], key: string): boolean {
    return settings.some((setting) => setting.key === key && setting.deviceId === '' && setting.value === true);
}

const NOTIFICATIONS_MASTER_KEY = 'notifications-master';
const NOTIFICATIONS_NEW_MESSAGE_KEY = 'notifications-new-message';
const NOTIFICATIONS_PERSON_JOINED_KEY = 'notifications-person-joined';

/**
 * How long a room stays "already told that this person joined".
 *
 * Exists because a peer is keyed by socket.id, so a client that loses its socket cannot get its
 * identity back — MediaRoom.rejoinAfterReconnect() re-emits `join-room` as a brand-new peer, which
 * re-runs onJoinRoom and lands here a second time. The frontend documents that reconnect as the
 * ordinary consequence of a phone briefly losing its radio (screen lock, Wi-Fi/LTE handoff, ~45s of
 * missed pings) and accepts that the OTHER people in the room watch that peer leave and come back;
 * that is a fair price for a live roster, but not for a push notification, which buzzes a handset
 * that is nowhere near the room. On FCM it is worse than on web push: push-sw.js coalesces on `tag`
 * into the notification already sitting there, whereas Android's collapse key REPLACES and
 * re-notifies, so a flapping radio rings every device in the room every time it flaps.
 *
 * Two minutes covers a radio drop plus socket.io's reconnect backoff, and is short enough that
 * someone who deliberately leaves a call and comes back later is still announced — which is a
 * genuine join and should ring.
 *
 * The window is the honest limit of what can be decided HERE. What would settle it exactly is
 * whether this user was already a peer in the room a moment ago, and that lives in RoomService's
 * peer map: onJoinRoom's own result already carries the pre-join roster. Passing that in is the
 * better fix for the case where the old socket has not been reaped yet, but it cannot replace this
 * one — after a real disconnect the old peer is already gone, so the roster says "not present" and
 * a rejoin looks exactly like a first join. Something has to remember that we just announced them,
 * and this service is what knows what it has told a room.
 */
const PEER_JOINED_RENOTIFY_WINDOW_MS = 2 * 60 * 1000;

/**
 * What a notification calls a room whose real name must not be shown.
 *
 * Says nothing at all about which room, on purpose. The body still names the sender and their
 * message, which is what makes the notification useful — it is the room's IDENTITY that has to stay
 * off the lock screen, because for an IEP room that identity is a child and their disability
 * records. "Converge" alone is enough for the reader to know which app wants them.
 */
const GENERIC_NOTIFICATION_TITLE = 'Converge';


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
    /** One room-and-user pair -> when that room was last told this person joined. See
     *  PEER_JOINED_RENOTIFY_WINDOW_MS. */
    private readonly peerJoinedAnnouncedAt = new Map<string, number>();
    /** Room name -> whether its notifications must not name it. See notificationTitleFor. */
    private readonly roomNeedsGenericTitle = new Map<string, boolean>();

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

    /**
     * What a notification may call this room.
     *
     * `undefined` means "use the room name", which is right for an ordinary public room. A room
     * whose name was GENERATED so its subject would not appear in a URL gets a title that names
     * nothing instead — sending either half of that room's identity here would undo the point:
     * the identifier is meaningless on a lock screen, and the display name is the child's name,
     * which is the thing being kept out of URLs in the first place. A lock screen is read by
     * whoever is stood next to the parent, so it is not a safer place for it than the address bar.
     *
     * Keyed on displayName rather than on visibility: an ordinary private room is private for
     * convenience and its name is still just a name, while a generated name is the signal that
     * somebody decided this room's subject must not be written down.
     */
    private async notificationTitleFor(roomName: string): Promise<string | undefined> {
        const cached = this.roomNeedsGenericTitle.get(roomName);
        if (cached !== undefined) {
            return cached ? GENERIC_NOTIFICATION_TITLE : undefined;
        }
        // Cached rather than queried per notification: this runs on every chat message, and
        // displayName is written once when the room is created and never updated afterwards —
        // there is no endpoint that changes it, so a stale entry is not reachable. Bounded by the
        // number of rooms a single process sees traffic for, and lost on restart, which is fine.
        const displayName = await this.roomMembership.findDisplayName(roomName);
        const needsGeneric = displayName !== null;
        this.roomNeedsGenericTitle.set(roomName, needsGeneric);
        return needsGeneric ? GENERIC_NOTIFICATION_TITLE : undefined;
    }

    /** `{ title }` or `{}`, so an ordinary room's payload is byte-identical to what it was before
     *  this existed. */
    private async roomTitleField(roomName: string): Promise<{ title?: string }> {
        const title = await this.notificationTitleFor(roomName);
        return title ? { title } : {};
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
            ...(await this.roomTitleField(roomName)),
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
        if (this.wasJustAnnouncedAsJoined(roomName, actorUserId)) {
            this.logger.debug(`skip peer-joined for ${actorUserId} in ${roomName}: announced within the last ${PEER_JOINED_RENOTIFY_WINDOW_MS}ms — treating it as a rejoin`);
            return;
        }
        const payload: PushPayload = {
            type: 'peer-joined',
            roomName,
            ...(await this.roomTitleField(roomName)),
            joinerDisplayName,
            tag: peerJoinedTag(roomName),
            ...(joinerPictureUrl ? { joinerPictureUrl } : {}),
        };
        await this.notifyRoomMembers(roomName, actorUserId, NOTIFICATIONS_PERSON_JOINED_KEY, payload, focusedUserIds);
    }

    /**
     * Whether this room has already been told about this person joining recently — and records that
     * we are telling it now, either way.
     *
     * Recorded on a SUPPRESSED join too, which makes the window sliding rather than fixed: a radio
     * that flaps every ninety seconds would otherwise slip an announcement through on every third
     * flap, which is exactly the noise this exists to stop. The cost is that a genuine join after a
     * long stretch of flapping stays quiet until the flapping does.
     *
     * Swept on the way past rather than on a timer. The map holds one small entry per person per
     * room they have joined lately, and a process that has stopped seeing joins has no notifications
     * to send either — a setInterval would keep an otherwise idle event loop alive to reclaim a few
     * hundred bytes.
     */
    private wasJustAnnouncedAsJoined(roomName: string, userId: string): boolean {
        const now = Date.now();
        for (const [seen, at] of this.peerJoinedAnnouncedAt) {
            if (now - at >= PEER_JOINED_RENOTIFY_WINDOW_MS) {
                this.peerJoinedAnnouncedAt.delete(seen);
            }
        }
        // JSON rather than a joined string: a room name and a userId are both free-form enough
        // that any separator picked by hand could turn up inside one of them, and a collision here
        // silences a real notification for someone who genuinely just joined.
        const key = JSON.stringify([roomName, userId]);
        const previous = this.peerJoinedAnnouncedAt.get(key);
        this.peerJoinedAnnouncedAt.set(key, now);
        return previous !== undefined && now - previous < PEER_JOINED_RENOTIFY_WINDOW_MS;
    }

    /**
     * Tells every install of the native app on one platform that a newer build exists.
     *
     * Deliberately unlike every other method here: it fans out across ALL users rather than a
     * room's members, and it is FCM-only — the announcement is about a sideloaded APK, which a
     * browser can do nothing with. It honours the master notification preference (someone who
     * turned notifications off should not be pinged about a release either) but none of the
     * per-room categories, since this is not room activity and there is no category that would
     * describe it. Anyone it skips still gets the in-app update banner on next launch, which is the
     * path that actually guarantees delivery — see the frontend's AppUpdate service.
     */
    async announceAppUpdate(platform: 'android' | 'ios', versionName: string, versionCode: number, apkUrl: string): Promise<{ sent: number; skipped: number }> {
        if (!this.fcm.isConfigured()) {
            this.logger.warn('Ignoring an app-update announcement — FCM is not configured.');
            return { sent: 0, skipped: 0 };
        }
        const tokens = await this.fcmTokens.listAllForPlatform(platform);
        // One settings read per distinct USER, not per token — a user with a phone and a tablet
        // would otherwise be looked up twice for the same answer.
        const userIds = [...new Set(tokens.map((token) => token.userId))];
        const optedIn = new Set<string>();
        await Promise.all(
            userIds.map(async (userId) => {
                const settings = await this.userSettings.getAll(userId);
                if (this.isMasterEnabled(settings)) {
                    optedIn.add(userId);
                }
            }),
        );
        const targets = tokens.filter((token) => optedIn.has(token.userId));
        const payload: PushPayload = { type: 'app-update', platform, versionName, versionCode, apkUrl };
        this.logger.debug(`app-update ${versionName} (${platform}): ${targets.length} of ${tokens.length} token(s) opted in`);
        await Promise.all(targets.map((token) => this.sendFcm(token, payload)));
        return { sent: targets.length, skipped: tokens.length - targets.length };
    }

    async dismissOtherDevices(userId: string, callerDeviceId: string): Promise<void> {
        if ((!this.configured && !this.fcm.isConfigured()) || !userId) {
            return;
        }
        const subscriptions = await this.pushSubscriptions.listForUser(userId, callerDeviceId);
        const tokens = await this.fcmTokens.listForUser(userId, callerDeviceId);
        // Same suppression as the notify path, for the same reason turned around: a subscription a
        // native app has taken over never had a notification shown on it, so there is nothing there
        // to dismiss.
        //
        // Then, and only on this path, iOS is dropped as well: `dismiss-all` is the one payload that
        // shows the user nothing, and a content-less push costs an iOS subscription its life (which
        // send() below then finishes off by deleting the row on the resulting 410). See
        // dropSilentPushIntolerant for the full reasoning. The notify paths are untouched — they
        // always show something, so they are safe on iOS as they are.
        const webTargets = dropSilentPushIntolerant(suppressNativeDuplicates(subscriptions, tokens));
        await Promise.all([...webTargets.map((sub) => this.send(sub, { type: 'dismiss-all' })), ...tokens.map((tok) => this.sendFcm(tok, { type: 'dismiss-all' }))]);
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
                const webTargets = suppressNativeDuplicates(subscriptions, tokens);
                const suppressed = subscriptions.length - webTargets.length;
                this.logger.debug(
                    `sending to ${member.userId}: ${webTargets.length} subscription(s)${suppressed ? ` (${suppressed} suppressed by a native app)` : ''}, ${tokens.length} FCM token(s)`,
                );
                await Promise.all([...webTargets.map((sub) => this.send(sub, payload)), ...tokens.map((tok) => this.sendFcm(tok, payload))]);
            }),
        );
    }

    private isEnabled(settings: { key: string; deviceId: string; value: unknown }[], categoryKey: string): boolean {
        return this.isMasterEnabled(settings) && isSettingTrue(settings, categoryKey);
    }

    private isMasterEnabled(settings: { key: string; deviceId: string; value: unknown }[]): boolean {
        return isSettingTrue(settings, NOTIFICATIONS_MASTER_KEY);
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
