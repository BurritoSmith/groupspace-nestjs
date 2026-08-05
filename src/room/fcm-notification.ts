import { PushPayload } from './push-payload.interface';

export interface IFcmNotificationContent {
    title: string;
    body: string;
    /** Android collapse key — a new notification with the same tag REPLACES the previous one rather
     *  than stacking beneath it. Same string the web service worker coalesces on. */
    tag: string;
    /** Big-picture attachment, when the message had one. */
    imageUrl?: string;
}

/**
 * Renders a payload into the `notification` block of an FCM message, or `null` for the payloads
 * that must stay silent.
 *
 * Why this exists at all — FCM treats a message with a `notification` block very differently from a
 * data-only one, and the difference is exactly what a native app needs:
 *
 *   - app BACKGROUNDED or killed -> the OS draws the tray notification itself, with no app code
 *     running. A data-only message shows nothing at all here, which was the old behaviour and would
 *     have made native push look broken for the case it matters most.
 *   - app FOREGROUNDED -> the OS draws nothing and the app's own listener fires instead, so the
 *     client can render something better (or nothing, if the user is already looking at that room).
 *
 * `data.payload` rides along either way, so the tap handler always has the full typed payload
 * regardless of which of the two paths drew the notification.
 *
 * Two deliberate limitations of the OS-rendered path, neither worth fixing here:
 *
 *   - No coalescing. push-sw.js stacks "+2 more" across messages because it can read back its own
 *     live notifications; the OS has no such state, so `tag` gets us replacement (one notification
 *     per room, showing the latest) rather than accumulation.
 *   - No sender avatar. Android's `notification.icon` names a drawable compiled into the APK, not a
 *     URL, so a per-sender picture cannot go there. The foreground path can still render one.
 */
export function fcmNotificationFor(payload: PushPayload): IFcmNotificationContent | null {
    switch (payload.type) {
        case 'chat-message':
            // Same shape push-sw.js composes for a single entry, so a message reads identically
            // whether it arrived over web push or FCM.
            return {
                title: payload.roomName,
                body: `${payload.senderDisplayName}: ${payload.messageText}`,
                tag: payload.tag,
                ...(payload.imageUrl ? { imageUrl: payload.imageUrl } : {}),
            };
        case 'peer-joined':
            return { title: payload.roomName, body: `${payload.joinerDisplayName} joined`, tag: payload.tag };
        case 'app-update':
            // English only, unlike everything the app itself renders. The other two bodies dodge
            // localization by being pure user content (a name and their own message text); this one
            // is genuinely app prose, and the backend has no i18n. Localizing it properly means
            // FCM's titleLocKey/bodyLocKey pointing at Android string resources, which would mean
            // duplicating public/i18n/*.json into res/values-*/strings.xml and keeping them in
            // sync. Not worth it for a string the in-app update banner already says correctly in
            // the user's own language.
            return {
                title: 'Converge update available',
                body: `Version ${payload.versionName} is ready to install.`,
                tag: 'app-update',
            };
        case 'dismiss-all':
            // Silent by definition — it asks other devices to CLOSE notifications, so giving it a
            // notification block would have it draw the very thing it exists to clean up.
            return null;
    }
}
