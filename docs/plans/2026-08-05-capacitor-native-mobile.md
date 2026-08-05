# Native mobile app with Capacitor — first pass (+ update delivery on all three shells)

## Context

Converge runs today as a web app (App Engine) and an Electron desktop app, both built from one
Angular bundle. We want a real native mobile app for **Android and iOS**, using native device APIs
where they exist rather than the web equivalents.

Four constraints shape everything below:

1. **iOS cannot be tested during development.** It must still stay in sync, so every platform
   decision goes through cross-platform Capacitor APIs (one code path, not two), and CI compiles the
   iOS project on a GitHub-hosted `macos-latest` runner on every PR. That runner is GitHub's machine
   — developing on Windows is not a blocker; the only step needing macOS is `pod install`, and CI
   owns it.
2. **No duplicate notifications.** Once a native client registers an FCM token, the same phone must
   not also get the web push it was already getting from mobile Chrome — while the user's *desktop*
   browser keeps working normally.
3. **Android ships as a sideloaded APK**, not through Play. The app has to discover a new version,
   tell the user, download it, and install over itself.
4. **Stale web tabs need the same courtesy.** A long-lived browser tab running an old bundle should
   surface a Google-Messages-style "a new version is available" prompt — but only for releases
   explicitly designated as significant, not every patch.

The codebase is unusually well set up for a third shell: `DesktopBridge`
(`src/app/core/services/desktop-bridge.ts`) is already the single answer to "which shell am I in",
with an explicit *never sniff the UA, never use a build flag* policy, and `app.config.ts:32` already
swaps a service implementation per shell via `useFactory`. The backend already has `FcmService`,
`FcmToken`, and `POST /push/fcm-token` built and tested — with **no client that has ever called
them**. Much of this plan fills in seams that already exist.

Scope: shell, parity, and update delivery. Native camera / share-target / file-save / haptics land in
a **second pass** on top of the seam this one builds.

---

## Part 1 — Capacitor scaffolding

**`capacitor.config.ts`** (frontend root): `appId: 'tv.groupspace.converge'` (same reverse-DNS as
the Electron `appId`), `appName: 'Converge'`, `webDir: 'dist/spaces-angular-claude/browser'`,
`server.androidScheme: 'https'`.

**Dependencies.** `@capacitor/core` and each plugin are **runtime** dependencies — they compile into
the Angular bundle and their web implementations are inert stubs. `@capacitor/cli`,
`@capacitor/android`, `@capacitor/ios` are devDependencies. This is deliberately *unlike* the
Electron split documented in `package.json`'s `//electron` comment: that separation exists because
Electron is ~200MB and App Engine's buildpack installs root devDeps; the Capacitor CLI is a few MB
and not worth a second package tree.

**`android/` and `ios/` are committed**, with build outputs ignored — `android/app/build/`,
`android/.gradle/`, `android/local.properties`, `ios/App/Pods/`, `ios/App/build/`, and both copied
web roots (`android/app/src/main/assets/public/`, `ios/App/App/public/`). Add `android/` and `ios/`
to `.gcloudignore`, which already excludes `electron/` and `release/`.

`npx cap add ios` runs fine on Windows — it only copies a template, and its `pod install` step fails
gracefully.

**Excluding ffmpeg.wasm from the native bundle.** `angular.json` copies ~30MB of `@ffmpeg/core` wasm
into `assets/ffmpeg`, which `cap sync` would otherwise bake into the APK. Both native WebViews
support WebCodecs (Android WebView is Chromium; iOS 16.4+), which is `video-compression.ts`'s
preferred tier anyway, so ffmpeg is a fallback that will almost never fire. Add
`"cap:sync": "npx cap sync && node scripts/strip-native-assets.mjs"`. **Verify** that
`video-compression.ts` fails *fast* on a missing loader rather than hanging — it is documented as
"never throws, falls back to the original", and that promise has to hold when the asset is simply
absent.

---

## Part 2 — The platform seam

New **`src/app/core/services/platform-shell.ts`** — the one place answering the now three-way shell
question, wrapping `Capacitor.isNativePlatform()` and the existing `DesktopBridge`:

```ts
readonly kind: 'electron' | 'native' | 'web';
readonly isElectron / isNative / isWeb: boolean;
readonly nativePlatform: 'android' | 'ios' | null;
```

`DesktopBridge` keeps its current job — it is the *Electron API bridge*, not the platform detector —
and is otherwise untouched. Its three `isDesktop` consumers (`app.config.ts:32`,
`push-notifications.ts`, `chat.ts`) move to `PlatformShell`, and the `ScreenCapture` factory becomes
three-way.

**Backend origin.** `environment.development.ts` derives `nestApiUrl` from `location`, which under a
WebView resolves to the *device's own* localhost. Native builds therefore use the **default
(production) configuration**, pointing at the GCP dev backend (`https://35-238-110-160.sslip.io`) —
a real Let's Encrypt cert, which also sidesteps the unresolved self-signed-CA-on-Android problem
entirely. Pointing a native build at the LAN backend still needs that cert work; out of scope here.

**CORS.** `spaces-nestjs-api-claude/src/config/cors-origins.ts` (used by both `main.ts`'s
`enableCors` and the `@WebSocketGateway` cors) gains `capacitor://localhost` (iOS) and
`https://localhost` (Android under `androidScheme: 'https'`).

**Screen share** gets a native `ScreenCapture` reporting unsupported, and the control hides on
native. Not a regression — Android Chrome has no `getDisplayMedia` either, so screen share is
already desktop-only in practice.

---

## Part 3 — Native sign-in

`GoogleAuth` (`src/app/core/services/google-auth.ts`) uses Google Identity Services `renderButton` +
FedCM, which has no working path in a WebView (no FedCM, no `window.opener` for the popup fallback).
It gains a native branch: our own button calling a native Google Sign-In plugin.

**The requirement that keeps the backend unchanged:** the plugin must return a raw **Google** ID
token whose `aud` is the existing *web* client ID (passed as `serverClientId`). Then
`google-auth.service.ts`'s `verifyIdToken({ audience: GOOGLE_CLIENT_ID })` passes as-is, and the
whole flow — ID token used once at `join-room`, backend mints a 30-day session token — works
untouched. Candidates: `@codetrix-studio/capacitor-google-auth` or
`@capacitor-firebase/authentication`; pick at implementation time against that requirement, not by
name.

Console work: an **Android** OAuth client (package `tv.groupspace.converge` + SHA-1 of *both* the
debug and the release keystore) and an **iOS** OAuth client (+ reversed-client-id URL scheme in
Info.plist). Forgetting the release keystore's SHA-1 is the classic trap — sign-in works in debug
and fails only in the shipped APK.

**Durable credentials.** `user.ts` reads `localStorage['spaces:google-profile']` *synchronously* at
construction, and WebView localStorage can be evicted by the OS. Rather than restructure `User` to
be async, add a `provideAppInitializer` registered **first** (before `Language.init()`) that on
native hydrates `localStorage` from `@capacitor/preferences`, and mirror writes back on save. Mirror
only what cannot be recovered: `spaces:google-profile`, `spaces:invitation-verified`,
`spaces:push-device-id` — everything else in `preferences.ts` is a boot cache the server re-supplies.
**Verify** no service reading localStorage is injected before initializers complete.

---

## Part 4 — Push notifications, and the dedup rule

### Backend

**Migration**: `PushSubscription` gains `platform String @default("web")`, matching `FcmToken`'s
existing column. `'web'` means *unknown* and is never suppressed.

**The routing rule**, in `PushNotificationService.notifyRoomMembers`
(`push-notification.service.ts:138-141`, which today sends to both transports with no arbitration):

```ts
const nativePlatforms = new Set(tokens.map((t) => t.platform));
const webTargets = subscriptions.filter((sub) => !nativePlatforms.has(sub.platform));
```

An `android` FCM token suppresses that user's `android` web-push rows only; their `desktop` and
`ios` subscriptions are untouched. Log the suppression count alongside the existing
`sending to ${userId}: N subscription(s), M FCM token(s)` debug line, so this stays diagnosable from
production logs the way the last push bug was.

**Self-healing existing rows.** Rows written before the migration are `'web'` and would never be
suppressed. `PushNotifications` will re-POST its subscription on every boot when it already has one
and a session token — one idempotent upsert that backfills `platform` and, as a bonus, repairs
endpoint rotation.

**FCM message shape.** `FcmService.send()` is currently data-only, which renders *nothing* when the
app is backgrounded or killed — the exact failure mode to avoid. For the two user-visible types it
gains a `notification` block (title = room name, body = the text `push-sw.js` composes) plus
`android.notification.tag = payload.tag` so same-room notifications replace rather than stack, while
keeping `data.payload` for foreground rendering and the tap handler. `dismiss-all` stays data-only —
it is a silent control message. This gives the right split for free: **backgrounded → the OS renders
from `notification`; foregrounded → `pushNotificationReceived` fires and we render.**

**One known gap, deliberately not "fixed":** `FcmService.send()` maps `messaging/invalid-argument` to
`'error'`, so a malformed token row is never pruned. Leave the mapping alone and document it —
`invalid-argument` also covers *payload* errors, so blanket-mapping it to `'gone'` would delete good
tokens on a payload bug. Revisit once a real client is minting tokens and the code is observed in
production.

### Frontend

`PushNotifications` (`src/app/core/services/push-notifications.ts`) gains a native branch mirroring
the existing Electron short-circuit:

- `isSupported()` → `true` on native.
- `enable()` → Capacitor `requestPermissions()` → `register()` → `registration` listener yields the
  FCM token → `POST /push/fcm-token { deviceId, token, platform }`.
- `disable()` → `DELETE /push/fcm-token/:deviceId`.
- Import the plugin aliased (`import { PushNotifications as CapacitorPush }`) — the names collide.
- Listeners: `pushNotificationReceived` → render via `@capacitor/local-notifications` (foreground
  only); `pushNotificationActionPerformed` → route to `/rooms/<roomName>` from `data.payload`.
- Android needs a **notification channel** and a monochrome small-icon asset, or Android draws its
  own silhouette — the same class of problem as the "D" placeholder just fixed.

**Web platform tagging.** A pure `detectWebPushPlatform(userAgent): 'android' | 'ios' | 'desktop'`
in its own file with its own spec, following the `window-policy.ts` / `menu-policy.ts`
pure-function-plus-spec pattern. This is a legitimate UA use (precedent: `device-tier.ts`) — it
describes the *browser's* host OS, it does not choose a shell.

**Why no other dedup is needed:** `Chat.notifyDesktop()` is gated on the Electron shell so it never
fires natively; the native shell never registers a web-push subscription; and the existing
`focusedUserIds` skip already suppresses a push to a user actively looking at that room on any
device.

---

## Part 5 — Versioning and the Android release pipeline

### The release keystore — do this first, get it right

Generate one release keystore, stored at
`C:\Users\burra\.secrets\groupspace-tv\converge-release.keystore` — same treatment as the Firebase
key (outside both repos, user-only ACL). Base64 it into GitHub secrets `ANDROID_KEYSTORE_BASE64` /
`_PASSWORD` / `_KEY_ALIAS` / `_KEY_PASSWORD`.

**If this keystore is lost, no installed user can ever update in place again** — Android refuses an
update signed by a different key, so every user would have to uninstall (losing local data) and
reinstall. Its SHA-1 also has to be registered on the Android OAuth client (Part 3).

### versionCode

`versionCode = major * 1_000_000 + minor * 10_000 + patch` (0.55.25 → 550025). Monotonic while
minor < 100 and patch < 10000, comfortable given the every-deploy versioning cadence.

`scripts/bump-version.mjs` gains a native step alongside the `electron/package.json` one it already
does — writing `android/version.properties` (read by `build.gradle`) and the iOS
`CFBundleShortVersionString` / `CFBundleVersion`. **The Android workflow does not bump**; it builds
whatever version `main` is already on, so an APK's version always corresponds to a deployed web
version and the two workflows never race over `package.json`.

### Distribution

A new public-read GCS bucket `converge-app-releases` — separate from the chat-media bucket, since
release artifacts and user content should not share a namespace:

- `android/converge-<version>.apk` — immutable, long cache.
- `android/latest.json` — `no-cache`:

```json
{ "platform": "android", "versionName": "0.56.0", "versionCode": 560000,
  "apkUrl": "https://storage.googleapis.com/converge-app-releases/android/converge-0.56.0.apk",
  "sizeBytes": 0, "sha256": "…", "releasedAt": "2026-08-05",
  "minSupportedVersionCode": 0, "notes": ["…"] }
```

`sha256` lets the installer verify the download before firing the intent. `minSupportedVersionCode`
is a forced-update lever that needs no code change to use later.

### `.github/workflows/android.yml` (new, `workflow_dispatch`)

Modelled on the existing `desktop.yml`. Input: `announce` (boolean). Steps: `npm ci` → `npm run
build` → `npm run cap:sync` → decode keystore → `./gradlew assembleRelease` (APK, not AAB — Play
bundles are not sideloadable) → upload APK + `latest.json` to GCS via the existing WIF auth → if
`announce`, call the announce endpoint below.

### `.github/workflows/ios-build.yml` (new, `pull_request`)

`macos-latest`: `npm ci` → `npm run build` → `npx cap sync ios` →
`xcodebuild -workspace ios/App/App.xcworkspace -scheme App -sdk iphonesimulator CODE_SIGNING_ALLOWED=NO build`.
Catches the realistic drift — a plugin added without its iOS half, a broken Podfile, a Swift error —
at the PR that causes it.

### Announcing a native update

New `IAppUpdatePush` member of the `PushPayload` union (`push-payload.interface.ts` — its header
warns it is hand-mirrored in `push-sw.js`; the web SW should ignore this type).

New `POST /app/announce-update`, guarded by a shared secret (`X-Admin-Token` vs an `APP_ADMIN_TOKEN`
env var) — matching the codebase's hand-rolled-guard, no-DTO-class style. Body
`{ platform, versionName, versionCode, apkUrl }`. Fans out to every `FcmToken` on that platform,
respecting `notifications-master` but **not** the room categories: it is an app-level announcement,
not room activity.

### In-app update check — the path that reaches everyone

New `AppUpdate` service, native-only: on boot and on `appStateChange → active` (throttled to a few
hours), fetch `latest.json`, compare against the compiled-in `APP_VERSION`, expose a signal. The app
shell shows a banner; tapping it — or tapping the push — opens an Update screen. **The push is the
proactive nudge; this check is what actually guarantees delivery**, including to users who have
notifications switched off.

### The installer

A small **custom Capacitor plugin** (`AppInstaller`), because no first-party plugin covers
sideloaded self-update:

- **Android** (Java, ~100 lines): download via `DownloadManager` (free progress, retry, and its own
  notification), verify sha256, then a `FileProvider` URI + `ACTION_VIEW` with
  `application/vnd.android.package-archive`. Needs `REQUEST_INSTALL_PACKAGES` in the manifest, a
  `FileProvider` entry + `res/xml/file_paths.xml`, and a `canRequestPackageInstalls()` check routing
  to `Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES` on first use.
- **iOS**: `unimplemented` — iOS updates go through TestFlight/App Store and are never sideloaded.
  Keeping the seam honest rather than pretending otherwise.

Downloading inside the WebView instead was rejected: a ~50MB APK through `@capacitor/filesystem`
means a ~67MB base64 string, a real OOM risk on low-end devices.

---

## Part 6 — Stale-tab update prompt on the web

The web analogue of Part 5, for a browser tab left open across a deploy. Same idea, different
mechanism: the web app can just reload itself.

**Designating a release.** Not every patch should nag. `src/app/core/app-version.ts` — which
`bump-version.mjs` already owns — gains a third constant, `RELOAD_PROMPT_SINCE`, updated **only**
when `deploy.yml` is dispatched with a new `notify_reload` boolean input; otherwise it carries
forward untouched. That keeps the designation explicit, committed, and auditable in git rather than
inferred from the semver level.

**The manifest.** `bump-version.mjs` also writes `public/version.json`
(`{ version, buildDate, reloadPromptSince }`), which `angular.json`'s existing `public/**` copy puts
at the web root. `public/serve.json` currently sets immutable caching only for `assets/ffmpeg/**`;
it gains a `no-cache` entry for `/version.json`, without which a stale tab would poll a stale
manifest and never learn anything.

**The check.** A new `WebAppUpdate` service, web-shell only, fetches `/version.json` on an interval
(~30 min) and on `visibilitychange → visible`, throttled. It prompts when
`APP_VERSION < manifest.reloadPromptSince` — i.e. the running bundle predates the last release
designated significant. Comparing the *stale tab's own compiled-in constant* against the *server's*
threshold is what makes this work with no server-side session state at all.

Reusing the same semver-compare pure function as the native check, in its own file with its own spec.

**The UI.** A small banner pinned bottom-left in the app shell (`app.html`, alongside the existing
language and invitation veils, so it appears on every route): a reload icon plus
*"A new version of Converge is available"*, tapping it calls `location.reload()`. Dismissible, and
dismissal lasts for that page load. Needs a new i18n key in **all nine locale files** —
`locales.spec.ts` enforces key parity and will fail the build otherwise. **Check** it does not
collide with existing bottom-left room chrome on a handset layout.

**Why the other two shells need no guard beyond the shell check:** Electron serves the bundle from
its own packaged `static-server.ts`, so `/version.json` is always the bundled one and the comparison
can never trip; native has its own APK flow from Part 5.

---

## Tests

Following the established patterns — backend Jest with hand-rolled `jest.fn()` fakes constructed
directly (no `Test.createTestingModule`), frontend Vitest with `TestBed` + `vi.stubGlobal`.

- `push-notification.service.spec.ts` — platform-matched suppression: an `android` token suppresses
  `android` subscriptions, leaves `desktop` and `ios` alone, and `'web'` (unknown) is never
  suppressed.
- `fcm.service.spec.ts` — the `notification` block is present for the two visible types, absent for
  `dismiss-all`.
- New pure-function specs, table-driven: `detect-web-push-platform.spec.ts`, the `versionCode`
  derivation, and the shared semver comparison.
- `push-notifications.spec.ts` — a native `describe` block alongside the existing desktop one,
  stubbing `Capacitor.isNativePlatform()`.
- New `app-update.spec.ts` (native version comparison, throttling), `web-app-update.spec.ts`
  (prompts only past the threshold, no prompt on an equal or newer version, dismissal sticks), and
  `app-update.controller.spec.ts` (admin-token guard, platform filtering, master-preference respect).
- `push-sw.js` still has no harness and stays manually verified, as today.

## Verification

1. `npx jest` (backend), `npx ng test` (frontend), clean `nest build` / `ng build`.
2. `npx cap sync android` + `./gradlew assembleDebug` locally — needs JDK 17 and the Android SDK
   (Android Studio) on the Windows machine.
3. On the device: sign in, join a room, camera + mic, send an image, background the app, receive
   **exactly one** notification, tap it and land in the right room.
4. **Dedup, the load-bearing check**: enable web push in mobile Chrome on the *same phone* as the
   native app → only the native notification arrives. Confirm desktop Chrome still receives its own.
5. Build 0.56.0, upload, trigger the announce, then from an installed 0.55.x: receive the push → tap
   → download → install **over the top without uninstalling**. This is what proves the keystore is
   right.
6. Web banner: open a tab, deploy with `notify_reload` set, leave the tab open past a poll interval
   (or background/foreground it), confirm the banner appears bottom-left and reloads onto the new
   version. Then deploy *without* the flag and confirm a second tab stays quiet.
7. Confirm the iOS CI job compiles green, and that the App Engine web deploy is unaffected.
8. Per standing practice, write this plan to `docs/plans/2026-08-05-capacitor-native-mobile.md` in
   both repos once approved.

## Explicitly out of scope (second pass)

Native camera capture for chat attachments — there is no camera entry point at all today, the file
input is gallery-only, and note HEIC sits in its `accept` list but is **rejected by the server's MIME
sniffer**, so native picks must emit JPEG. Also: Web/native Share Target; native file save & share
(`save-file.ts`'s File System Access API works on neither platform); haptics; native clipboard;
`@capacitor-community/keep-awake` replacing `wake-lock.ts`; replacing the WebCodecs/ffmpeg
compression stack with native transcode; and Android `MediaProjection` screen share.
