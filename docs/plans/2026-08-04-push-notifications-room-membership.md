# Browser push notifications + persistent room membership

## Context

The ask started as "add browser push notifications for new messages and people joining a live
session," with a granular Notifications section in settings and a mobile-friendly full-screen
settings view. While scoping notification eligibility, it became clear rooms currently have no
persistent identity beyond a free-form name (`Room.name` is the primary key, no ownership, no
membership — confirmed in `schema.prisma`) — so "who should be notified about room X" had no
answer. The user resolved this by asking for a lightweight persistent room-membership concept
(a user becomes a "member" of a room the first time they join it), scaffolded now, with full
permissions and a complete member-management UI explicitly deferred. That membership list is also
being used immediately for one small but real UI win: the existing avatar strip above the chat
panel (`room.html`'s `.presence-avatars`, currently only ever showing who's *currently online*)
becomes a full room-member roster, greyed out for members who aren't currently online — seeded for
existing rooms by backfilling from `ChatMessage` history.

Everything here is new infrastructure — there is no existing service worker, manifest, push
library, or per-browser device identity anywhere in either repo today.

## Backend — `spaces-nestjs-api-claude`

### Schema (`prisma/schema.prisma`)

```
model RoomMember {
  id            String   @id @default(uuid())
  userId        String
  user          User     @relation(fields: [userId], references: [id])
  roomName      String
  room          Room     @relation(fields: [roomName], references: [name])
  firstJoinedAt DateTime @default(now())
  lastJoinedAt  DateTime @updatedAt
  @@unique([userId, roomName])
  @@index([userId])
  @@index([roomName])
}

model PushSubscription {
  id        String   @id @default(uuid())
  userId    String
  user      User     @relation(fields: [userId], references: [id])
  deviceId  String   // client-minted, localStorage-persisted per browser install
  endpoint  String
  p256dh    String
  auth      String
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  @@unique([userId, deviceId])
  @@index([userId])
}
```

Add back-relations (`roomMembers`/`pushSubscriptions` on `User`, `members` on `Room`). Generate via
`prisma migrate dev --create-only`, then hand-edit the generated SQL to append a backfill insert
after `CREATE TABLE "RoomMember"`:

```sql
INSERT INTO "RoomMember" (id, "userId", "roomName", "firstJoinedAt", "lastJoinedAt")
SELECT gen_random_uuid(), "userId", "roomName", MIN("sentAt"), MAX("sentAt")
FROM "ChatMessage" GROUP BY "userId", "roomName"
ON CONFLICT ("userId", "roomName") DO NOTHING;
```

(`ChatMessage.userId` is non-nullable, so every historical message maps cleanly to a member.)

### Room membership (`src/room/room-membership.service.ts`, new)

- `recordVisit(userId, roomName): Promise<void>` — upsert on `[userId, roomName]`, `room:
  {connectOrCreate: ...}` matching `ChatService.saveMessage`'s existing convention.
- `listForUser(userId): Promise<{name, lastJoinedAt}[]>` — for the join-room typeahead, ordered by
  `lastJoinedAt desc`, capped at 20.
- `listMembersWithProfile(roomName): Promise<{userId, displayName, pictureUrl}[]>` — `findMany`
  with `include: {user: {select: {id, displayName, pictureUrl}}}`, for the member-roster UI. Live
  profile fields (not a snapshot) — this is a presence-style display, not chat history.

Hook both into `room.gateway.ts`'s `onJoinRoom` (~230): `void recordVisit(userId, roomName)`
fire-and-forget right after the existing `peer-joined` broadcast, and `await
listMembersWithProfile(roomName)` added to the join-room ack alongside `chatHistory`/`userSettings`
as a new `roomMembers` field.

New `src/room/rooms.controller.ts`: `GET /rooms/mine` (`SessionAuthGuard`) → `{rooms}` via
`listForUser(req.userId)`, for the name-entry typeahead (needed before any socket join exists, same
reasoning `UserSettingsController` already documents for why it's REST not socket).

### Push subscriptions (`src/room/push-subscription.service.ts` + `.controller.ts`, new)

Service: `register(userId, deviceId, endpoint, p256dh, auth)` (upsert on `[userId, deviceId]`),
`unregister(userId, deviceId)`, `listForUser(userId)`, `deleteByEndpoint(endpoint)` (for expiry
cleanup).

Controller (`SessionAuthGuard`): `POST /push/subscriptions`, `DELETE /push/subscriptions/:deviceId`,
`POST /push/active` (body `{deviceId}`, triggers cross-device dismiss — see below). Unauthenticated:
`GET /push/vapid-public-key` → `{publicKey}` (not secret; avoids a frontend rebuild to rotate keys).

Add `web-push` (+ `@types/web-push`) to `package.json`. Add `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`
/ `VAPID_SUBJECT` to `.env` and `deploy/.env.example`, generated via `npx web-push
generate-vapid-keys`, documented inline like every other secret there.

### Notification preferences — no new table

Three new `UserSetting` keys, account-wide (`deviceId: ''`), reached via the existing `/user/settings`
HTTP path exactly like `language`/`theme`: `notifications-master`, `notifications-new-message`,
`notifications-person-joined`, all booleans, absent = `false` (off by default, per the ask). Turning
the master toggle on for the first time implicitly writes both categories `true` too, so "on" reads
as "notify me about everything" out of the box; the user can then narrow.

### Dispatch (`src/room/push-notification.service.ts` + `push-payload.interface.ts`, new)

`onModuleInit` calls `webpush.setVapidDetails(...)`. Payload shapes:
```ts
interface IChatMessagePush { type: 'chat-message'; roomName: string; senderDisplayName: string; messageText: string; messageId: string; tag: string /* chat:${roomName} */ }
interface IPeerJoinedPush  { type: 'peer-joined'; roomName: string; joinerDisplayName: string; tag: string /* peer-joined:${roomName} */ }
interface IDismissAllPush { type: 'dismiss-all' }
```
- `notifyChatMessage(roomName, actorUserId, senderDisplayName, messageText, messageId)` — loads
  `RoomMember`s for the room excluding the actor, filters each by
  `notifications-master && notifications-new-message` (via `UserSettingsService.getAll`), sends to
  every `PushSubscription` for each eligible member via `webpush.sendNotification`. Truncate
  `messageText` (~300 chars) — web-push payloads have a ~4KB ceiling. On a `404`/`410` response,
  delete that subscription row (standard expiry idiom); swallow/log other errors.
- `notifyPeerJoined(roomName, actorUserId, joinerDisplayName)` — same shape, gated on
  `notifications-person-joined`.
- `dismissOtherDevices(userId, callerDeviceId)` — same fan-out, `{type:'dismiss-all'}`, excluding the
  caller's own device.

Hook into `room.gateway.ts`: `onChatMessage` (~454, right after the live broadcast) →
`void notifyChatMessage(...)`; `onJoinRoom` (~230, alongside `recordVisit`) →
`void notifyPeerJoined(...)`. Both fire-and-forget, matching the existing broadcast-before-persist
style.

`POST /push/active` → `dismissOtherDevices` covers cross-device dismiss; no separate mechanism
needed.

## Frontend — `spaces-angular-claude`

### Service worker (`public/push-sw.js`, new)

Plain JS, copied verbatim to `/push-sw.js` by the existing `public/` build convention. No caching,
no `fetch` handler — push-only.

- `push`: parse JSON payload.
  - `dismiss-all`: `getNotifications()` → close all. Chrome requires a `showNotification` call per
    `push` event or it shows its own generic "site updated" notification — call
    `showNotification('', {silent:true, tag:'noop'})` and immediately close it to satisfy this
    without anything visible.
  - `chat-message`/`peer-joined`: `getNotifications({tag: data.tag})` — if one is still showing
    (i.e. not yet dismissed), read its accumulated message list from `data`, append the new one,
    rebuild the body (last few lines + "+N more"); otherwise start fresh. `showNotification(...,
    {body, tag, renotify: true, data: {...merged, roomName, type}})` so the OS re-alerts on update.
- `notificationclick`: close it, `clients.matchAll()` to focus an existing tab already on
  `/rooms/<roomName>`, else `clients.openWindow('/rooms/' + roomName)`.

### Registration flow (`src/app/core/services/push-notifications.ts`, new)

`PushNotifications`, `providedIn: 'root'`:
- `deviceId()` — lazy `crypto.randomUUID()` persisted at `localStorage['spaces:push-device-id']`
  (a genuinely new identity — distinct from the existing hardware-`deviceId` used for mic/camera
  selection).
- `isSupported()` — `'serviceWorker' in navigator && 'PushManager' in window`. Gate this on the
  Electron desktop shell being excluded until verified (`file://`-loaded renderers typically can't
  register service workers) — check `desktop-bridge.ts` at implementation time.
- `enable()` — register `/push-sw.js`, `Notification.requestPermission()`, on grant fetch the VAPID
  public key, `pushManager.subscribe({userVisibleOnly:true, applicationServerKey})`, POST it +
  `deviceId()` to `/push/subscriptions`. Returns `false` (never throws) on denial so the settings
  dialog can revert its toggle and show the existing `saveError` pattern.
- `disable()` — `getSubscription()?.unsubscribe()`, `DELETE /push/subscriptions/:deviceId`.
- A `visibilitychange` listener (once per app load, only when `notifications-master` is on) POSTs
  `/push/active {deviceId}` — this is the "dismiss my other devices' notifications" trigger.

### Notifications settings section

`user-settings-dialog.ts`/`.html`: add `'notifications'` to `UserSettingsView` + `VIEW_TITLES`, a
menu row, and a `@case('notifications')` block with 3 `mat-slide-toggle`s, following the exact
optimistic-set/await/revert-on-failure pattern `linkPreviewsEnabled` already uses. Master toggle
calls `pushNotifications.enable()`/`disable()`; category toggles just write `Preferences` keys
(`Preferences.NOTIFICATIONS_MASTER/NEW_MESSAGE/PERSON_JOINED`, new static keys) and are disabled in
the template while the master is off. `Preferences.adopt(...)` in the constructor keeps the dialog
in sync if a value changes from another device while it's open.

### Mobile full-screen settings dialog

At the `dialog.open(UserSettingsDialog, ...)` call site in `room.ts`, branch on the existing
`isHandset()` signal: full-viewport `MatDialogConfig` (`100vw`/`100dvh`, a `fullscreen-dialog`
panel class) on handset vs. today's centered config on desktop. On handset only, wrap the open/close
with the same `history.pushState`/`popstate` idiom already used by `media-viewer.ts`'s
`openMediaViewer()` and `video-tile.ts`'s `enterImmersiveFallback()` — push a throwaway history
entry on open, close the dialog on `popstate`, and call `history.back()` on every other close path
so Back doesn't need a second press later. Since `MatDialog` overlays render outside the component's
view, the `fullscreen-dialog` panel-class rule needs to live wherever this codebase already puts
other global `panelClass` overrides (verify the existing convention, e.g. `styles.scss`, at
implementation time) rather than in `user-settings-dialog.scss`.

### Join-room typeahead

New `src/app/core/services/rooms-api.ts`: `myRooms()` → `GET /rooms/mine`, same auth-header pattern
as `Preferences`, returns `[]` on any failure (never throws). `name-entry.ts` gets a `myRooms`
signal populated once the user is signed in (mirroring the existing Google-button `effect`), and
`name-entry.html` attaches a `matAutocomplete` to the existing room-name input, filtered client-side.
Anonymous users see the plain field unchanged.

### Member roster above chat (greyscale when offline)

`room.html`'s existing `.presence-avatars` block (`room.html:661-673`, inside `.side-panel-content`,
above `<app-chat-panel>`) currently renders `roomPeople()` — online peers only. It becomes a full
member roster:

- Backend: `roomMembers` on the join-room ack (above) gives `{userId, displayName, pictureUrl}[]`
  for everyone who's ever been a member of the room.
- `Chat` service gains a `roomMembers` signal + `setInitialRoomMembers(members)`, seeded the same
  way `setInitialPresence` already is — call it from `Room` wherever `setInitialPresence(result.peers)`
  runs today (`room.ts:990`), passing `result.roomMembers`.
- `Room` gains a `memberRoster` computed: start from `roomMembers()` (each marked offline), then
  overlay every currently-online `roomPeople()` entry as online — this also makes a brand-new,
  never-before-seen joiner show up immediately without waiting for a fresh member-list fetch. Self
  is excluded the same way `roomPeople()` already excludes it.
- Template: iterate `memberRoster()` instead of `roomPeople()`, `[class.offline]="!member.online"`
  on `app-avatar-image`; `room.scss` gets `.presence-avatars .avatar.offline { filter: grayscale(1);
  opacity: .5; }` (exact opacity/treatment is a small visual call, not architecturally significant).

## Explicitly deferred (per the user's own scoping)

Full room permissions, and any dedicated "manage members" UI beyond the greyscale roster strip
above — `RoomMember` is scaffolded generically enough (own table, `userId`/`roomName`, timestamps)
that either can build on it later without a migration rework.

## Verification

1. Unit: `RoomMembershipService`/`PushSubscriptionService`/`PushNotificationService` — upsert
   idempotency, preference-gating (default-off), and 404/410 subscription cleanup.
2. Unit: `PushNotifications` frontend service — permission-denied path returns `false` without
   throwing; `deviceId()` is stable across calls.
3. Unit: `Room.memberRoster` — online overlay merges correctly; self excluded; a brand-new joiner
   with no prior `RoomMember` row still appears online.
4. Manual, two real browsers + a real push subscription (needs real HTTPS — LAN/dev-cert setups
   used elsewhere in this project should work, since Push API requires a secure context):
   register both, background one, send a chat message from the other — confirm the backgrounded
   device gets a notification with the message text, clicking it opens/focuses the right room;
   send a second message before dismissing — confirm the notification updates in place rather than
   stacking; open the app on the backgrounded device — confirm the other device's undismissed
   notification disappears.
5. Manual: settings dialog on a real mobile viewport — confirm full-screen presentation and that
   Android's back gesture closes it instead of leaving the room/navigating away.
6. Manual: join-room typeahead shows previously-visited rooms for a signed-in user; the member strip
   above chat shows a room's historical members (post-backfill) greyed out until they join live.
