import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { cert, initializeApp, ServiceAccount } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { fcmNotificationFor } from './fcm-notification';
import { PushPayload } from './push-payload.interface';

export type FcmSendResult = 'ok' | 'gone' | 'error';

/** Sends Firebase Cloud Messaging messages to a single registration token, for the Capacitor
 *  mobile app (Android push is FCM-only). */
@Injectable()
export class FcmService implements OnModuleInit {
    private readonly logger = new Logger(FcmService.name);
    private configured = false;

    onModuleInit(): void {
        const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
        if (!serviceAccountJson) {
            // Missing in most local dev setups until someone opts in — mirrors VAPID's own stance
            // in PushNotificationService: push just silently no-ops rather than blocking startup.
            this.logger.warn('FIREBASE_SERVICE_ACCOUNT_JSON not configured — FCM push notifications are disabled.');
            return;
        }
        let serviceAccount: ServiceAccount;
        try {
            serviceAccount = JSON.parse(serviceAccountJson) as ServiceAccount;
        } catch (error) {
            this.logger.error(`FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON — FCM push notifications are disabled. ${error instanceof Error ? error.message : String(error)}`);
            return;
        }
        initializeApp({ credential: cert(serviceAccount) });
        this.configured = true;
    }

    isConfigured(): boolean {
        return this.configured;
    }

    /**
     * `data.payload` always carries the raw PushPayload — the same JSON web push sends — so the
     * client has the full typed shape to route a tap on. A `notification` block is added on top for
     * every payload that should be visible, which is what lets the OS draw it while the app is
     * backgrounded or killed; see fcm-notification.ts for that split in full. `dismiss-all` gets no
     * such block and stays a silent data message.
     */
    async send(token: string, payload: PushPayload): Promise<FcmSendResult> {
        if (!this.configured) {
            return 'error';
        }
        const visible = fcmNotificationFor(payload);
        try {
            await getMessaging().send({
                token,
                data: { payload: JSON.stringify(payload) },
                ...(visible
                    ? {
                          notification: { title: visible.title, body: visible.body },
                          android: {
                              // Replaces rather than stacks, so a busy room is one notification
                              // showing the latest message instead of a column of them.
                              notification: { tag: visible.tag, ...(visible.imageUrl ? { imageUrl: visible.imageUrl } : {}) },
                          },
                          apns: {
                              // APNs' equivalent of the tag, and the only way to get replacement
                              // behaviour on iOS. `apns-collapse-id` has a 64-byte ceiling; the tags
                              // in play are `chat:<room>` / `peer-joined:<room>`, and a room name
                              // long enough to overflow that would have APNs reject the whole send.
                              headers: { 'apns-collapse-id': visible.tag.slice(0, 64) },
                          },
                      }
                    : {}),
            });
            return 'ok';
        } catch (error: unknown) {
            const code = (error as { code?: string }).code;
            if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') {
                return 'gone';
            }
            // NOT mapped to 'gone', despite being what FCM returns for a malformed token: the same
            // code also covers a malformed PAYLOAD, so treating it as a dead token would delete
            // every registration a payload bug touched. A malformed token can only come from a
            // client that made one up, so leaving the row is the cheaper failure.
            this.logger.warn(`FCM send failed (${code ?? 'unknown'}): ${error instanceof Error ? error.message : String(error)}`);
            return 'error';
        }
    }
}
