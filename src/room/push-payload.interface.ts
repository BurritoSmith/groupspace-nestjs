/** Shapes sent as the JSON body of a Web Push message — mirrored on the frontend's push-sw.js,
 *  which has no way to import this file, so keep the two in sync by hand on any change. */

export interface IChatMessagePush {
    type: 'chat-message';
    roomName: string;
    /**
     * What the notification is titled, when the room's own name must not be shown.
     *
     * A private room may exist precisely because its subject is confidential — an IEP room's
     * identifier is generated for that reason, and its readable title lives in `Room.displayName`.
     * Sending EITHER of those here would defeat the point: the generated identifier is meaningless
     * on a lock screen, and the display name is the child's name, which is the thing being kept out
     * of URLs in the first place. Moving it from the address bar to a lock screen, in front of
     * whoever is stood next to the parent, is not an improvement.
     *
     * So the server decides the whole title and the clients render it verbatim. Neither
     * fcm-notification.ts nor push-sw.js knows what a private room is, and neither should.
     *
     * Optional: absent means "use roomName", which is right for an ordinary public room and is
     * also what every payload built before this field existed will do.
     */
    title?: string;
    senderDisplayName: string;
    messageText: string;
    messageId: string;
    /** Notification coalescing key — the service worker updates an existing not-yet-dismissed
     *  notification with this tag instead of stacking a new one. */
    tag: string;
    /** Small notification icon — the message's first image/gif attachment's thumbnail, when it has
     *  one. Only ever set for a kind the sender already has an immediate thumbnail for at send
     *  time (image/gif) — a video's poster is generated asynchronously afterward, so it's never
     *  ready in time for this. Root-relative URLs (local dev) resolve fine from push-sw.js, which
     *  is registered at the same origin. */
    iconUrl?: string;
    /** Large image shown in the expanded notification — the same attachment's full/display
     *  rendition, or an album's cover. */
    imageUrl?: string;
    /** The sender's account picture, used as the notification icon whenever `iconUrl` above isn't
     *  set (i.e. every message without an image/gif attachment). Without it Chrome for Android
     *  draws its own letter placeholder from the origin, which reads as a stray "D" rather than as
     *  anything to do with who sent the message. Absent for an account with no Google picture. */
    senderPictureUrl?: string;
}

export interface IPeerJoinedPush {
    type: 'peer-joined';
    roomName: string;
    /**
     * What the notification is titled, when the room's own name must not be shown.
     *
     * A private room may exist precisely because its subject is confidential — an IEP room's
     * identifier is generated for that reason, and its readable title lives in `Room.displayName`.
     * Sending EITHER of those here would defeat the point: the generated identifier is meaningless
     * on a lock screen, and the display name is the child's name, which is the thing being kept out
     * of URLs in the first place. Moving it from the address bar to a lock screen, in front of
     * whoever is stood next to the parent, is not an improvement.
     *
     * So the server decides the whole title and the clients render it verbatim. Neither
     * fcm-notification.ts nor push-sw.js knows what a private room is, and neither should.
     *
     * Optional: absent means "use roomName", which is right for an ordinary public room and is
     * also what every payload built before this field existed will do.
     */
    title?: string;
    joinerDisplayName: string;
    tag: string;
    /** Same role as IChatMessagePush.senderPictureUrl — this notification never has an attachment
     *  to show, so the avatar is the only icon it will ever carry. */
    joinerPictureUrl?: string;
}

/** Silent — asks every OTHER device to close whatever it's currently showing, because the user
 *  just paid attention to the app on THIS device. Carries no visible content of its own. */
export interface IDismissAllPush {
    type: 'dismiss-all';
}

/**
 * "A newer build of the native app is out." Unlike every other member of this union this is about
 * the app itself rather than a room, so it is fanned out by AppUpdateController to every FcmToken on
 * one platform rather than to a room's members — see that file for why it respects the master
 * notification preference but none of the per-room categories.
 *
 * FCM-only in practice: the Android app is distributed as a sideloaded APK, so it is the only client
 * that can act on this. push-sw.js ignores the type outright rather than showing a browser
 * notification about an APK the browser cannot install.
 */
export interface IAppUpdatePush {
    type: 'app-update';
    platform: 'android' | 'ios';
    versionName: string;
    versionCode: number;
    apkUrl: string;
}

export type PushPayload = IChatMessagePush | IPeerJoinedPush | IDismissAllPush | IAppUpdatePush;

export const chatMessageTag = (roomName: string): string => `chat:${roomName}`;
export const peerJoinedTag = (roomName: string): string => `peer-joined:${roomName}`;
