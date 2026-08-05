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
}

export interface IPeerJoinedPush {
    type: 'peer-joined';
    roomName: string;
    joinerDisplayName: string;
    tag: string;
}

/** Silent — asks every OTHER device to close whatever it's currently showing, because the user
 *  just paid attention to the app on THIS device. Carries no visible content of its own. */
export interface IDismissAllPush {
    type: 'dismiss-all';
}

export type PushPayload = IChatMessagePush | IPeerJoinedPush | IDismissAllPush;

export const chatMessageTag = (roomName: string): string => `chat:${roomName}`;
export const peerJoinedTag = (roomName: string): string => `peer-joined:${roomName}`;
