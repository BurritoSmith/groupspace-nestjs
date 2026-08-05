/** Shapes sent as the JSON body of a Web Push message — mirrored on the frontend's push-sw.js,
 *  which has no way to import this file, so keep the two in sync by hand on any change. */

export interface IChatMessagePush {
    type: 'chat-message';
    roomName: string;
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

export type PushPayload = IChatMessagePush | IPeerJoinedPush | IDismissAllPush;

export const chatMessageTag = (roomName: string): string => `chat:${roomName}`;
export const peerJoinedTag = (roomName: string): string => `peer-joined:${roomName}`;
