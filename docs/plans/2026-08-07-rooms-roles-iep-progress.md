# Rooms, roles and the IEP module — progress log

Snapshot as of **2026-08-07**. The design lives in
[`2026-08-06-rooms-roles-iep-module.md`](./2026-08-06-rooms-roles-iep-module.md); this file records
what is actually built, what was decided while building it, and what is left.

---

## Shipped to production

**v0.61.0**, web and Android, 2026-08-07. `main` at `0df5479`, tag `v0.61.0`.

- Web: <https://groupspace-tv.web.app/> — `version.json` reports `0.61.0`
- Android: `converge-0.61.0.apk`, versionCode `610000`,
  sha256 `b579598cae18df032c961f15c731759f1152f4a153e6b0557b4c5fb1c5914d54`

It carries everything merged during a ~9½-hour GitHub Actions outage: Android screen share and
recent rooms (#113), the iOS Google sign-in fix and two `isSupported` corrections (#115), the
cold-start notification tap and composer zoom fix (#117), and the toolbar roster, overflow menu and
iOS foreground-notification sound (#118).

None of Part 0 is in it. All of it sits on branches, unmerged, behind draft PRs.

---

## Part 0 — what is built

### API — `feature/rooms-roles-modules`, draft PR groupspace-nestjs#61

Seven commits, **678 tests**, build clean.

| Commit | What |
| --- | --- |
| `81556ec` | Schema: room ownership, visibility, passcode, modules, roles, invitations, guest identity. Backfill migration. |
| `550f2ef` | Capability resolver, plus the IEP module's own capability contribution. |
| `34901ac` | One canonicalisation for room names (shared with the gateway); scrypt passcode hashing. |
| `20c1317` | `RoomProvisioningService` — creation in a transaction, module enablement, `requiresPrivate` enforcement. |
| `1d81803` | Invitations, the capability guard and decorator, passcode rate limiting, the REST controller. |
| `f7acb41` | Plan amendment: URL structure and room identity. |
| `9a2576c` | DI fix, plus a smoke test that stands up a real Nest injector. |

Verified end-to-end against the running server (HTTPS, port 3001):

- `  IEP Smoke Test  ` created as `iep smoke test`
- asked for public with the IEP module on → **got private**
- making it public again refused, naming the module
- a non-member sees only name/visibility/hasPasscode — no module list
- wrong passcode 403, right one joins, module list then appears

### Frontend — `feature/rooms-roles-modules`, draft PR groupspace-angular#116

Four commits, **2175 tests**, build clean, `iep-workspace` emits as a 1.84 kB lazy chunk with the
initial bundle unchanged.

| Commit | What |
| --- | --- |
| `cf27775` | The plan doc. |
| `fae1d53` | Plan amendment: URLs, room identity, QR. |
| `3b0e324` | The module seam — registry, `ConvergeModule`, module-scoped i18n merging in `Translate`. |
| `286ea8f` | Module nav button and the stage outlet; `RoomModules` (server × registry intersection). |

**This branch is 12 commits behind `main`** and needs another rebase before it can merge.

---

## Decisions made while building

Recorded because none of them are recoverable from the diff alone.

- **Two role axes.** `RoomMember.role` is governance; `RoomMemberModuleRole` is domain, with a
  vocabulary the module owns. Adding a module adds rows, never columns.
- **`contextFor` drops roles for disabled modules.** Load-bearing, not tidiness: `capabilitiesFor`
  takes `moduleRoles` at face value, so reporting them unfiltered would leave every `iep:`
  capability granted after the module was switched off.
- **Disabling a module does not restore public visibility**, even the module that forced it private.
  Privacy is easy to loosen by accident and hard to notice afterwards.
- **Ownership cannot be invited**, and accepting an invitation never lowers a role already held.
- **A guest who signed the document may read it.** The plan said guests are refused
  `iep:view-executed` outright; that is wrong in the domain, because a parent authenticated by the
  e-signature provider has a right to a copy of what they signed. The resolver takes the signer fact
  as context.
- **Two endpoints deliberately say less than they know.** A wrong invitation address and a missing
  one give the same message; the capability guard refuses non-members and unauthorised members
  identically. Both are membership oracles about a child's education otherwise. Tests assert the
  messages match.
- **`/rooms/` prefix stays**, module segments hang under `:roomName`. The root already holds routes
  (`share`, `update`, `playback`) *and* static files (`i18n/`, `push-sw.js`, `version.json`), and
  room names are user-chosen — so `update` and `version.json` are both creatable names, failing
  differently and silently. Retroactive, too: any new top-level route would steal an existing room.
- **IEP rooms get a generated Crockford base32 identifier**, human title in a separate
  `Room.displayName`. Lowercase alphabet specifically, because `canonicalRoomName` lowercases and
  base64url or base58 would fold into collisions and dead links with nothing appearing to go wrong.
- **QR is per person and encodes an invitation, never a passcode.** A code held up on screen during
  a call goes into the stream and the recording; it is only survivable because `accept()` demands
  the token AND a matching verified Google email. Never add a token-alone shortcut.
- **The module nav sits outside the `isSessionJoined()` gate.** Every other control in that bar acts
  on a live call; a module does not. "Join the call first" is exactly the precondition that ends the
  attempt for the person this feature exists to help.
- **Passcode rate limiting is per (room, user)**, in memory. One person mistyping must not lock a
  meeting out. Per-process, so it resets on deploy and does not span instances — honest for one
  instance, a real limitation at two.

### Two bugs worth remembering

- **`Translate` must stay `new`-able.** Putting `inject()` in a field initializer broke 144 tests in
  `media-room.spec.ts`, which constructs one directly. `{ optional: true }` covers a missing
  *provider*, not a missing *injector*.
- **A defaulted constructor parameter killed the app at boot.** `PasscodeAttempts` took a clock as
  `now: () => number = () => Date.now()`. It compiled, `nest build` was clean, its own 29 tests
  passed — and Nest died on `can't resolve dependencies of the PasscodeAttempts (?)`, because it
  reads constructor parameters as dependencies. Every spec in that directory constructs with `new`,
  so every provider had the same blind spot. `room-di.spec.ts` now closes it.

---

## What is left

### Part 0, to finish

1. **Create-room UI** — the step reached explicitly, by invitation link, or by typing an unknown
   room name (pre-filled, public + chat/live/playback by default). Module toggles, visibility,
   passcode. WCAG 2.2 AA from the first commit.
2. **`Room.displayName` migration** — falls out of the opaque-identifier decision. Fold into the
   above rather than leaving it dangling.
3. **Private-room notification text** — `fcm-notification.ts` and `push-sw.js` both use
   `title: payload.roomName`. Pointing them at a display name would deliver a child's name to a lock
   screen instead. Must be one commit across all three files, as agreed with the macOS checkout.
4. Rebase the frontend branch (12 behind), take both PRs out of draft.

### Then

Part 1 (IEP session skeleton + audit log), Part 2 (DocuSign and Adobe, both), Part 3 (the wizard),
Part 4 (accessibility — 4a with the module, 4b app-wide once the parallel iOS work lands).

**Sandbox credentials for DocuSign and Adobe are lead time, not engineering time.** Part 2 cannot
start without them.

---

## Coordination with the macOS checkout

Ownership split agreed on groupspace-angular#116:

| Owner | Files |
| --- | --- |
| iOS | `core/services/native-*.ts`, `src/main.ts`, `ios/**`, `chat-panel/services/**`, `chat-panel.scss` |
| This epic | `src/app/modules/**`, `app.routes.ts`, `app.config.ts`, `room.html`, `core/i18n/translate.ts`, `prisma/schema.prisma` |
| Sequenced | `chat-panel.html`, `name-entry.html`, `room.html` — 4b after their Wave 1 |

- Room addressing does **not** change in Part 0 — `Room.name` is still the identifier, so the
  three-file push deep-link contract holds. Answered on #116.
- The i18n hold ("stay out of `en.json` and the eight locale files until Wave 1.1 lands") may now be
  spent — #118 edited all nine. **Confirm before touching them.**

---

## Open items

- **`Billie`** — a Room row predating case-insensitive names, unreachable because the gateway
  lowercases what you type. 1 message, 1 member. Task chip pending; renaming touches every table
  storing `roomName` as a string.
- **The nav rail has six buttons with no accessible name** — they announce as their icon ligatures
  (`more_vert`, `dashboard`). `matTooltip` sets `aria-describedby`, not a name. Pre-existing, and
  Part 4b's territory. The macOS checkout's *new* controls are labelled correctly.
- Roster names truncate ("Clay Crosla…") in the expanded filmstrip — cosmetic, seen with a single
  participant, may not reproduce with several.
