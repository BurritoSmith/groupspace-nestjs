# Sender avatar as the push notification icon (+ findings on the desktop dropout)

## Context

Web push to browser clients is working in the GCP dev environment, but two things came out of
this morning's testing:

1. **The "D" placeholder icon on Android.** A plain-text chat notification shows a generated
   letter-avatar in the icon slot. It is *not* hard-coded — `push-sw.js` only sets `icon` when the
   message has an image/gif attachment thumbnail, and when `icon` is absent Chrome for Android
   draws its own placeholder from the origin (`dev.burritostand.com` → "D"). The fix is to fill
   that slot with the sender's avatar, which the backend already has on hand.
   (The `Chrome • dev.burritostand.com` attribution line above it genuinely cannot be changed —
   that is the browser identifying itself as the delivering app, and only a native/Capacitor app
   would replace it.)

2. **Desktop Chrome stopped showing notifications.** Investigated against 12h of backend logs on
   `spaces-vm` — see the findings section below. It is **not** throttling, and it is **not** a
   dead subscription. The remaining candidates need one more piece of evidence before any code
   changes, so this plan reports rather than guesses.

## Part 1 — Sender avatar in the icon slot (the actual change)

Final behaviour: **the sender's avatar always wins the icon slot; the attachment thumbnail stays
only as a fallback for an account with no picture.** No change to the `image` (large expanded
picture) slot.

This was first shipped the other way round — thumbnail first, avatar only as a fallback — and
revised immediately on seeing it live: for a message with an attachment, the icon showed the same
picture already rendered full width by `image` directly beneath it, shrunk into a corner. The two
slots answer different questions (`icon` = who sent it, `image` = what they sent), and duplicating
the attachment across both told the reader nothing while dropping the only cue about who it was
from.

`User.pictureUrl` is a Google account picture (absolute `https://lh3.googleusercontent.com/...`),
already loaded everywhere it is needed — no new query, no new table.

### Backend (`spaces-nestjs-api-claude`)

- **`src/room/push-payload.interface.ts`** — add optional `senderPictureUrl` to `IChatMessagePush`
  and `joinerPictureUrl` to `IPeerJoinedPush`. Keep the existing hand-sync comment accurate, since
  `push-sw.js` mirrors this file and cannot import it.
- **`src/room/push-notification.service.ts`** — `notifyChatMessage` / `notifyPeerJoined` take the
  picture URL and spread it into the payload using the same `...(x ? {x} : {})` guard already used
  for `iconUrl`/`imageUrl`, so an empty string never ships a useless key.
- **`src/room/room.gateway.ts`** — pass `message.pictureUrl` (line ~467 call site, already built
  from `socket.data.pictureUrl`) and the `pictureUrl` local at the `peer-joined` call site
  (line ~237). Both values are already in scope; nothing new to fetch.

### Frontend (`spaces-angular-claude`)

- **`public/push-sw.js`** — carry `avatarUrl` on each coalesced entry in `showOrUpdate`, then:
  - `icon` = latest entry *with media*'s `iconUrl` (existing `latestWithMedia` lookup), falling
    back to the **latest entry's** `avatarUrl`. That second lookup is deliberately a different
    one — sender identity should come from the most recent message even when an older one in the
    same coalesced stack was the one carrying the picture.
  - `image` unchanged.
  - Route the avatar through the existing `resolveMediaUrl()` helper for consistency; an absolute
    Google URL passes through untouched, and it future-proofs a self-hosted avatar.
  - Also set it for the `peer-joined` branch, which today passes no icon at all.
- **`src/app/room/services/chat.ts`** — `notifyDesktop()` gains an `avatarUrl` parameter and
  resolves `avatarUrl → iconUrl → Chat.DEFAULT_NOTIFICATION_ICON`. Use `||`-style falsiness, not
  `??`: `pictureUrl` is `''` (not `undefined`) for an account with no Google picture, and `??`
  would let the empty string win. Both call sites already have the value in hand —
  `message.pictureUrl` on `'chat-message'`, and `pictureUrl` from the destructured `PeerSummary`
  on `'peer-joined'`.

### Tests

- `push-notification.service.spec.ts` — payload carries `senderPictureUrl`/`joinerPictureUrl` when
  present and omits the key entirely when the user has no picture.
- `chat.spec.ts` — extend the existing "Chat — desktop notifications" block: avatar used when
  there is no attachment thumbnail; avatar still wins when there is one; thumbnail as the fallback
  for a sender with no picture; app icon when neither.
- `push-sw.js` has **no test harness** (it is plain JS served from `public/`, deliberately outside
  the Angular build) — it stays manually verified, as today.

## Part 2 — Findings on the desktop dropout (report, no code change yet)

From `docker compose logs app --since=12h` on `spaces-vm`, room `hunch`, 4 members:

- **Not throttled, and not a dead subscription.** 33 pushes sent, 33 accepted with HTTP 201, and
  **zero** `410`/`404`/`gone`/`failed` entries in the whole window. Nothing server-side is
  dropping, deferring, or rate-limiting anything.
- **Nothing is remotely dismissing them.** Accepted pushes (33) exactly equals the sends implied
  by the `sending to …: N subscription(s)` lines (33), so no `dismiss-all` push was sent at all —
  the "another device became active, close this one" path never fired.
- **That path is in fact dead code.** `PushNotifications.signalActive()`
  (`src/app/core/services/push-notifications.ts:174`) has **no callers anywhere in the app** — the
  only consumer of that service is the settings dialog, which calls `enable()`/`disable()` only.
  So `POST /push/active`, `PushNotificationService.dismissOtherDevices()`, and the service
  worker's whole `dismiss-all` branch are currently unreachable.
  **Recommendation: do not wire this up as part of this work.** Switching it on would start
  closing every notification on a user's other devices the moment one device loads the app —
  which is precisely the "notifications disappear" symptom being debugged. Worth its own change,
  after the desktop issue is understood.
- **RESOLVED — the browser was closed. There is no bug here, and no code change is needed.**
  Chrome on the desktop holds the connection to the push service *itself*; Windows has no
  always-on push daemon equivalent to Android's Google Play Services, so a fully-quit Chrome has
  nothing listening. The push service queues undelivered messages against their TTL and flushes
  the backlog on reconnect — confirmed in testing, where reopening Chrome immediately delivered
  the whole stack of missed notifications at once.

  This is the same ceiling the Electron app has (and the reason for the tray work in
  `2026-08-05-fcm-electron-push-fix.md`). Chrome's "Continue running background apps when Google
  Chrome is closed" setting keeps a background process alive and does restore delivery, but that
  is a user-side browser setting, not something this app can influence.

  Worth remembering when testing: desktop web push can only be exercised with the browser
  actually running.

## Verification

1. `npx jest` in the backend and `npx ng test` in the frontend, plus a clean `nest build` /
   `ng build`.
2. Deploy to GCP dev, then on the Android device confirm: a plain-text message now shows the
   sender's Google avatar where the "D" placeholder was; a message with an image attachment still
   still shows the sender's avatar as the icon, with the attachment full width below; a "joined the room"
   notification now shows the joiner's avatar.
3. On the Electron desktop app, confirm the same precedence, and specifically that the attachment
   is still visible via the `image` slot now that it no longer occupies `icon` — Windows toasts
   render a hero image, but that path had only ever been exercised through `icon` before this.
4. Confirm an account with no Google picture still gets the Converge icon rather than a broken
   image.
