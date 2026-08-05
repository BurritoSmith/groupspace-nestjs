# Firebase Cloud Messaging plumbing (Electron push + mobile-ready backend)

## Context

The Electron desktop app shows "Couldn't enable notifications. Check your connection and try
again." whenever a user turns on push. Root cause: Electron's Chromium build has no working
`PushManager` — `Notification.requestPermission()` and `serviceWorker.register()` both succeed,
but `pushManager.subscribe()` throws (`AbortError: Registration failed - push service not
available`) because Electron ships without the Google API key a real Chrome/Firefox/Safari tab
uses to talk to the browser push service invisibly. The comment in
`src/app/core/services/push-notifications.ts:19-23` assumed Electron behaves like a normal browser
tab for this; it doesn't, specifically for Push.

Decision: adopt Firebase Cloud Messaging (FCM) to fix this properly, since a native mobile app
(Capacitor) is coming soon and would need FCM/APNs plumbing anyway — building it now means the
backend send path is shared between Electron and the future mobile app instead of being rebuilt
twice.

**Important correction carried into this work**: even with FCM, a fully-quit Electron app cannot
be woken to receive a notification — Windows/macOS/Linux have no OS-level always-on push daemon
the way Android (Google Play Services) or iOS (the APNs daemon) do. So the real, honest ceiling for
this work is **notifications while the Electron app is running — foreground, minimized, or
tray-only** — not "after fully quitting." Getting real value out of that ceiling requires the app
to stay alive in the system tray instead of quitting on window-close. The FCM investment's payoff
for "receives even when fully quit" is real, but it lands on **mobile**, later, not on desktop now.

**Second correction, found mid-implementation**: `electron-push-receiver` (the library originally
planned for the Electron side) depends on `push-receiver`, a hand-rolled Node reimplementation of
Google's GCM/MCS binary protocol, last published in 2022. `npm audit` flagged **critical**,
unpatchable vulnerabilities in its dependency chain (`protobufjs` arbitrary code execution/prototype
pollution sitting directly in the code path parsing untrusted binary data off a live TLS socket,
plus a critical SSRF CVE in the abandoned `request`/`request-promise` libraries) — running in the
Electron **main process**, which has full Node/filesystem access. Combined with the fact that it
only ever delivers while the process is already running (same ceiling as the option below), it was
rejected. Electron instead gets notifications from its own already-live socket connection, not FCM.

## Backend (`spaces-nestjs-api-claude`) — shipped

- `prisma/schema.prisma`: new `FcmToken` model (`id`, `userId`, `deviceId`, `token`, `platform`,
  timestamps; `@@unique([userId, deviceId])`), migration `20260805034846_add_fcm_token`. Nothing
  writes to it yet — no client registers a token until a mobile app exists.
- `src/room/fcm.service.ts`: `FcmService`, using the modular `firebase-admin/app` /
  `firebase-admin/messaging` imports (the v14 namespace import doesn't expose `credential`/
  `messaging` the way older `firebase-admin` majors did). `onModuleInit` reads
  `FIREBASE_SERVICE_ACCOUNT_JSON`, silently no-ops if absent/invalid (mirrors
  `PushNotificationService`'s VAPID stance). `send(token, payload: PushPayload)` sends a
  `data`-only message (`{payload: JSON.stringify(payload)}`), maps
  `messaging/registration-token-not-registered` / `messaging/invalid-registration-token` to
  `'gone'`.
- `src/room/fcm-token.service.ts` / `fcm-token.controller.ts`: `FcmTokenService` (upsert on
  `[userId, deviceId]`, mirroring `PushSubscriptionService` exactly) and `FcmTokenController`
  exposing `POST /push/fcm-token` / `DELETE /push/fcm-token/:deviceId`, both `SessionAuthGuard`-
  protected, same shape as the existing `/push/subscriptions` endpoints.
- `src/room/push-notification.service.ts`: `notifyRoomMembers`/`dismissOtherDevices` now also load
  each member's `FcmToken[]` and fan out through `FcmService.send`, deleting the token row on
  `'gone'`. Gated on `!this.configured && !this.fcm.isConfigured()` so either transport alone is
  enough to proceed.
- `deploy/.env.example`: documented `FIREBASE_SERVICE_ACCOUNT_JSON` (paste the downloaded service
  account JSON as one line).
- Tests: `fcm.service.spec.ts`, `fcm-token.service.spec.ts`, `fcm-token.controller.spec.ts`, plus
  new cases in `push-notification.service.spec.ts` for the FCM fan-out/gone-deletion. Full suite:
  392 passing.

## Electron (`spaces-angular-claude/electron`) — shipped

- `main.ts`: added a `Tray` (reuses `build/icon.png`) with Open/Quit; the window's `close` event
  now hides instead of closing unless `isQuitting` (set only by the tray's Quit item or the OS
  itself via `before-quit`). `window-all-closed` is now a rarely-hit final-quit cleanup path rather
  than the primary quit trigger.
- No FCM registration happens in Electron at all — see the frontend section below.

## Frontend (`spaces-angular-claude/src/app`) — shipped

- `core/services/push-notifications.ts`: `isSupported()` branches on `desktopBridge.isDesktop` —
  desktop only needs `Notification` to exist; `enable()`/`disable()` short-circuit to just the
  permission prompt on desktop (no service worker, no VAPID subscribe, nothing sent to the
  backend).
- `room/services/chat.ts`: new `notifyDesktop()`, called from the existing `'chat-message'` and
  `'peer-joined'` socket listeners. Shows a native `Notification` when `desktopBridge.isDesktop`,
  permission is granted, the relevant preference (`notifications-master` + category) is on, and
  `document.visibilityState !== 'visible'` (mirrors the same signal `media-room.ts` already uses
  for the server-side focus check). Excludes the sender's own echoed `chat-message` (the backend
  broadcasts via `server.to(roomName)`, which includes the sender, unlike `peer-joined`'s
  `socket.to()`) by comparing against `MediaRoom.ownUserId()`.
- Tests: new "Chat — desktop notifications" describe block in `chat.spec.ts`, new desktop-path
  cases in `push-notifications.spec.ts`. Full suite: 1887 passing. Production build clean (only
  pre-existing bundle-size budget warnings).

## Prerequisites — still needed from you

Create a Firebase project in the Firebase console and generate a **service account key JSON**
(Project settings → Service accounts → Generate new private key) → set as
`FIREBASE_SERVICE_ACCOUNT_JSON` in the backend's `.env` (local) and the VM's `deploy/.env`
(production) to actually activate `FcmService`. Nothing currently registers a token against it —
this is prerequisite plumbing for the future Capacitor mobile app, not required for the Electron
fix (which needed none of this).

## Verification

1. Backend unit tests — done, 392 passing.
2. Manual, packaged Electron build: enable notifications, confirm a chat message from another
   account shows a native OS notification while the app is (a) foregrounded, (b) minimized,
   (c) closed-to-tray. Confirm closing to tray does not actually quit (check Task Manager/Activity
   Monitor), and that the tray's Quit item does. **Not yet performed — needs a packaged build.**
3. Manual: fully quit the Electron app, send a message, confirm nothing arrives (expected), and
   relaunching shows no stale/replayed notification either. **Not yet performed.**
