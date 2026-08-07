# Rooms, roles, and the IEP module — Converge's first module boundary

## Context

Administrators running virtual IEP meetings lose documents at the last mile. They get a whole team —
parent, student, instructors, administrators — to agree in a call, and then have to shepherd everyone
off to an external signing service, where signatures stall and documents go unexecuted. Separately,
producing the IEP itself is expert work that a non-specialist team fumbles.

This epic answers both, and uses them as the forcing function for two structural changes Converge
needs regardless:

1. **Rooms become real objects** — with an owner, a visibility, and a set of enabled modules. Today a
   room springs into existence silently the first time anyone joins one, via `connectOrCreate` inside
   `RoomMembershipService.recordVisit` (`src/room/room-membership.service.ts:27` in the API). There
   is no ownership, no privacy, and no roles anywhere in the system — `RoomMember` says so in its own
   comment: *"Deliberately no permissions/roles here yet."*
2. **The app gets a module boundary.** The frontend is one flat app; the API is one `RoomModule` with
   ~34 providers. The IEP work is big enough to justify inventing a module concept and self-contained
   enough to be a safe first tenant.

A third constraint shapes the layout: iOS work is happening in parallel in another checkout, so the
conflict surface with existing files has to be near zero.

### Decisions taken

Real data protections from day one. The facilitator drives the wizard while everyone watches.
DocuSign and Adobe Acrobat Sign both in the first pass. Per-room module enablement. Private rooms
admit a passcode guest as well as a Google invitation. Typing an unknown room name opens a pre-filled
create step. IEP roles are attached at invitation time.

### What the research changed

- **IEP records are FERPA-protected**, with IDEA Part B confidentiality duties on top. Chat media
  today is public-read with unguessable UUID object names, and rooms have no access code —
  deliberately, and reasonably, for casual video chat (`ChatMediaService`'s class comment argues the
  case). **That pattern cannot be reused here.** IEP artifacts get a private bucket and short-lived
  signed URLs, closer to how `RecordingService` already works.
- **E-signatures are acceptable for IEP consent.** OSEP has indicated that states may use electronic
  or digital signatures provided the integrity of the process is protected; consent must still be
  signed, dated, and in writing. State rules vary, so the executed artifact and its audit trail
  matter more than the signing widget does.
- **Predetermination is the live legal risk in the wizard.** Preparing before a meeting — reviewing
  data, drafting goals, identifying placement options — is lawful. Arriving at a fixed outcome not
  open to parent input is a procedural violation, and districts have lost on it: invalidated IEPs and
  compensatory education. A checkbox-driven generator that emits canned goals is that risk's exact
  shape.

  Three non-negotiable consequences, which should not be dropped later for tidiness:
  - Suggestions are presented as options with alternatives, **never preselected**.
  - Output is watermarked `DRAFT — not a completed IEP`.
  - Every section records that it was discussed, and what changed during the meeting.

---

## Part 0 — Rooms, roles, capabilities

### Two role axes, kept separate

The usual mistake is one role enum that every feature extends until `parent` is a concept the video
grid has to know about. Two axes instead:

**Governance — `RoomMember.role`:** `owner | moderator | member | guest`. Fixed, app-wide, module
agnostic. Answers *what may you do to the room*: invite, configure, enable modules, remove people.

**Domain — `RoomMemberModuleRole(roomName, userId, moduleId, role)`:** `role` is a plain string whose
vocabulary the **module** owns and validates. IEP defines `administrator | parent | student |
instructor | observer`. Answers *who are you in this process*.

This is what lets roles persist on room members in the database while keeping the shared schema
module-agnostic: adding a module adds rows, never columns or enum values. It also lets the person who
created the room not be the IEP administrator — the normal case, and inexpressible with one enum.

### Guard on capabilities, not roles

One resolver maps `(roomRole, moduleRoles, authKind)` to a capability set:

```
room:configure   room:invite   room:remove-member   room:enable-module
iep:facilitate   iep:sign      iep:view-executed
```

Everything downstream checks capabilities. Adding a role later is one line in the resolver rather
than hunting `if (role === 'owner')` across two codebases.

### Schema

Append-only. No existing model changes except `Room`, `RoomMember` and `User` gaining columns.

```
Room                  + createdByUserId, visibility (public|private), passcodeHash?
RoomMember            + role
User                  + authKind (google|guest); googleSub and email become nullable
RoomModule              (roomName, moduleId, config Json, enabledAt)
RoomInvitation          (roomName, email, roomRole, moduleRoles Json, token,
                         invitedByUserId, acceptedByUserId?, acceptedAt?, expiresAt)
RoomMemberModuleRole    (roomName, userId, moduleId, role)
```

`RoomModule` is a table rather than a JSON column on `Room`, so "every room with IEP enabled" is a
query and each module owns its own config blob.

**Name it `RoomInvitation`, not `Invitation`.** The existing `Invitation` model is the global
app-signup gate. Reusing the word will cause a bug.

### Modules declare their own requirements

The module manifest carries `requiresPrivate: true`. Enabling IEP **forces** the room private and
refuses to let it be flipped back while the module is enabled. Privacy for IEP is enforced by the
module's declaration, not by an administrator remembering.

### Guest identity

Private rooms admit either a Google invitation or a passcode plus a display name. Guests exist so
that parents without Google accounts are not excluded — which, for the population this feature
serves, is the difference between the feature working and not.

Implement guests as `User` rows with `googleSub` and `email` nullable, plus `authKind`.
`UsersService.upsertFromGoogleProfile` keys on `googleSub` and is unaffected. The alternative — a
separate guest identity type — would have to be threaded through `RoomMember`, `ChatMessage`,
reactions and every audit row as a polymorphic foreign key. One nullable column beats that
comfortably.

Guests are second-class on purpose:

- Visibly marked as unverified in the roster and in every audit entry.
- The session JWT carries `authKind`, so guards can refuse guest access to sensitive capabilities —
  notably `iep:view-executed`, which must not be reachable by "whoever had the passcode".
- Passcodes are hashed (argon2 or bcrypt), never returned to a client, rate-limited with lockout, and
  rotatable by the owner.

Identity for **signing** is not weakened by any of this: the e-signature provider performs its own
recipient authentication, and that is what the executed document's legal weight rests on.

### Room creation

One new step, reached three ways: an explicit "create room" action, an invitation link, or typing a
name that does not exist yet — which opens the create step **pre-filled** with that name and sensible
defaults (public; chat, live and playback enabled). Nothing is ever created silently again, and the
one-tap recent-rooms path is untouched.

The creator becomes `owner`, and `administrator` for every module they enable.

**Chat, live and playback become modules in the data model only.** The room records which are
enabled and the create step toggles them, but their code stays where it is and reads a flag.
Refactoring them into the module system is a separate epic and would swamp this one.

### Backfill

Every existing room predates ownership. The migration sets `createdByUserId` and the `owner` role
from the earliest member by `firstJoinedAt`, everyone else to `member`, visibility to `public`, and
enables chat + live + playback. Existing behaviour is preserved exactly.

### The module seam

```
src/app/modules/module.ts             ConvergeModule: id, navIcon, navLabelKey, routes,
                                      providers, i18nBundle, requiresPrivate, roles[]
src/app/modules/module-registry.ts    the one array new modules are added to
src/app/modules/iep/…                 everything IEP, frontend
```

```
API: src/modules/iep/…                its own NestJS module, controllers, services
```

**The entire conflict surface with existing files**, one line each:

| File | Change |
| --- | --- |
| `src/app/app.routes.ts` | spread the registry's routes |
| `src/app/app.config.ts` | spread the registry's providers |
| `src/app/room/room.html` | one `@for` over enabled modules rendering nav buttons |
| `src/app/core/i18n/translate.ts` | merge module bundles after the base locale |
| API `src/app.module.ts` | one import |
| `prisma/schema.prisma` | append-only |

**i18n without touching nine locale files.** `Translate.use(locale)` currently loads one bundle.
Extend it to merge registered module bundles from `public/i18n/modules/<id>/<locale>.json` under the
module's own namespace. One change to `translate.ts`, after which no module ever edits `en.json` or
the eight files in `public/i18n/` — which is otherwise a guaranteed conflict every time two people
add a feature at once.

---

## Part 0b — URLs, room identity, and joining by QR

### The room is a namespace; everything after it is app-owned

```
/rooms/:roomName                       the room itself
/rooms/:roomName/:moduleSegment        a module's landing view      e.g. /rooms/x/files
/rooms/:roomName/:moduleSegment/:id    one thing within it          e.g. /rooms/x/people/:userId
```

**The `/rooms/` prefix stays.** Hanging room names off the root was considered and rejected: the root
is already occupied twice over — by routes (`share`, `update`, `playback`) and by static files served
at `/` (`i18n/`, `push-sw.js`, `version.json`, `playback-popup-sync.js`). Room names are user-chosen
and validation permits anything short and non-control, so `update` and `version.json` are both
creatable names. The two layers even fail differently: the router would shadow the first, while
Firebase serves the real file before its SPA rewrite reaches the second. Worst of all it is
retroactive — adding any top-level route later silently steals an existing room, and the collision is
with data, so no build-time check can catch it.

Keeping one known prefix segment means everything after `:roomName` is app-owned and can never
collide with user input. That is the property the whole hierarchy rests on.

**Module segments are claimed through the registry**, which asserts uniqueness at boot, so two
modules cannot both take `files` and find out at runtime. A segment 404s when its module is not
enabled for that room — per-room enablement expressed directly in the URL.

**`/rooms/:roomName` does not move.** It is a live contract across `fcm-notification.ts`,
`native-push.ts` and `push-sw.js`, and cold-start notification taps now depend on it. Chat stays at
`?openChat=1` rather than becoming a path segment; if that changes later it is an added alias plus
all three files in one commit.

### IEP rooms get an unreadable identifier and a separate display name

A room called `iep-jimmy-smith` puts a child's name into browser history, access logs, referrer
headers and screen shares. So an IEP room's *identifier* is generated, and its human-readable title
lives beside it:

- `Room.name` — generated, ~16–20 characters, **Crockford base32**. Lowercase because
  `canonicalRoomName` lowercases everything, which would silently mangle base64url or base58 into
  collisions and dead links; and no `0/O`/`1/l/I`, for the times somebody reads one aloud.
- `Room.displayName` — new nullable column, what the UI shows. Never in a URL, never in a log.

**Moving the name out of the URL is only half of it.** Push titles use `payload.roomName` in both
`fcm-notification.ts` and `push-sw.js`; if that became `displayName`, the child's name would simply
arrive on a lock screen instead. Private rooms need deliberately vague notification text — "Converge
— new message" — rather than naming the room at all.

### Joining by QR

One QR **per person**, encoding that person's invitation link. Not a room-wide code: roles are
per-person and invitations are single-use, so a shared code would admit only whoever scanned first
and would grant them somebody else's role.

**A QR shown on screen during a call is broadcast to everyone in it**, including into the recording —
this app has screen sharing. The design survives that only because `accept()` requires the token AND
a matching verified Google email, which makes a photographed code useless to anyone but its intended
recipient. That is load-bearing, not incidental: **never add a "token alone admits you" shortcut.**

For the same reason a QR encodes an invitation and never a passcode — the passcode path has no
per-person binding to fall back on.

The encoder is a new dependency, and the initial bundle is already over its warning budget. It loads
inside the lazily-routed IEP module, so it never reaches the initial bundle at all.

## Part 1 — IEP session skeleton

- `IepSession` scoped to a room: student identifiers, status (`draft → in_review → signing →
  executed`), timestamps.
- Invitations carrying module roles; facilitator designation.
- The stage view: a nav button opens the workflow on the existing room stage, alongside the video
  rather than replacing the call.
- **An audit log from the first commit** — who viewed, edited, advanced, signed and downloaded, with
  timestamps and `authKind`. This is what makes the e-signature defensible, and it does not retrofit.

## Part 2 — Signing, both providers

A `SignatureProvider` abstract class with `DocuSignProvider` and `AdobeSignProvider`, copying the
seam shape already used for `ScreenCapture` / `CameraCapture` / `AttachmentPicker` — including
`screen-capture.ts`'s habit of documenting the cancel semantics on the abstract class so both
implementations are held to them.

1. The administrator creates an envelope/agreement from the draft, one recipient per participant.
2. Each participant signs **in-app**, through a short-lived embedded session generated server-side.
   Nobody is emailed off to an external site — that is the entire point of the feature.
3. Provider webhooks (DocuSign Connect, Acrobat Sign webhooks) notify on completion, **HMAC
   verified**.
4. The backend then pulls the executed PDF via the provider's API — Adobe's own guidance, rather than
   trusting the webhook payload — and writes it to the private session store.

One asymmetry to design around: DocuSign supports embedded *sending*, with field placement in-app;
Adobe does not, so Adobe documents need their fields prepared outside Converge. Do not build a UI
that only genuinely works for one provider.

Provider credentials are per-district and must never reach the client bundle.

## Part 3 — The wizard

Facilitator-driven, mirrored live to every participant over the existing `RoomGateway` socket. One
authoritative state and one driver: no conflict resolution, and it matches how these meetings are
actually run.

1. **Eligibility** — the 13 IDEA categories, plus the explicit adverse-effect determination. The
   two-part test is modelled, not implied by a checkbox.
2. **Category drill-down** — characteristics and functional impacts.
3. **PLAAFP** — present levels, the foundation every later decision cites.
4. **Needs → supports** — the mapping the feature exists for: screen reader and braille for
   blindness; interpreter, FM system and captioning for deafness; AAC for communication needs.
   Options with alternatives, never preselected.
5. **Annual goals** — measurable scaffolds tied to those needs, requiring edit before acceptance.
6. **LRE and service minutes**, with the justification field required.
7. **Transition** — surfaced for students at 16+.
8. **Review** — every section shown with its discussed/changed marker before export.

The output is a draft in the private session store, which becomes Part 2's input.

## Part 4 — Accessibility

Two distinct needs, kept separate because zoom does not help a blind user and a screen reader does
not help a low-vision one:

- **Blind → screen reader.** Semantic structure, accessible names and roles on all controls, live
  regions for anything that changes without a click.
- **Low vision → magnification.** WCAG 1.4.4 (200% text) and 1.4.10 (reflow at 400% with no
  horizontal scrollbar), plus an in-app zoom control — kiosk and native-app users may have no browser
  zoom to reach for.

Measured baseline across `src/`, so progress is against a number rather than a feeling:

| Signal | Count |
| --- | --- |
| `<button>` elements | 147 |
| `aria-label` | 41 |
| `aria-live` | 0 |
| `tabindex` | 0 |
| `aria-expanded` / `aria-describedby` | 0 |

`prefers-reduced-motion` is already honoured in several places and `A11yModule` appears once in
`recording-name-dialog.ts` — the instinct exists, it just is not systematic. Angular CDK 22 is
already a dependency, so `LiveAnnouncer`, `FocusMonitor` and `cdkTrapFocus` are available today.

**Sequencing matters, because this is the one part of the epic that is not isolated.** An app-wide
sweep edits `room.html`, `chat-panel.html` and `name-entry.html` — exactly the files another
checkout may be working in.

- **4a (with this epic):** the IEP module and the new room-creation flow ship at WCAG 2.2 AA from
  their first commit, and the zoom control lands as a new core service. No existing template touched.
- **4b (once the parallel work lands):** the app-wide sweep — the ~106 unlabelled buttons, live
  regions for chat and participant join/leave, focus management across panel and dialog transitions,
  focus order, visible focus, and 24px minimum target sizes.

Add `axe-core` to the test suite, so a regression fails a build instead of reaching a user.

---

## Risks

- **Part 0 is a breaking change to how rooms work**, touching auth, membership and the gateway. It
  deserves to land and be lived with on its own before anything is built on top of it.
- **Legal exposure is real.** If the draft is ever presented as producing a compliant IEP, a
  procedural challenge lands on whoever ran the meeting. The watermark and the discussed/changed
  markers are the mitigation.
- **Guest access is a deliberate identity tradeoff.** The mitigation is capability limits and visible
  marking — not pretending the identity is strong.
- **Provider credentials gate Part 2 entirely.** Sandbox accounts for both DocuSign and Adobe are
  lead time, not engineering time; start that early.
- **State variation.** IEP form requirements differ by state. Model the federal floor and treat state
  specifics as configuration rather than hardcoding one state's form.

## Verification

1. `npm test -- --watch=false` in both repos, with a `.spec.ts` beside each new service per the
   existing convention.
2. **Boundary proven by deletion.** Removing the registry entry removes the routes, providers, nav
   button and i18n namespace with no other edit and no test failure.
3. **Backfill.** Against a copy of production data, every existing room ends with exactly one owner,
   all other members `member`, visibility `public`, and the three default modules enabled — and
   joining behaves exactly as it did before.
4. **Access control.** A public room joins as today. A private room refuses without a passcode or
   invitation. A wrong passcode rate-limits and then locks out. A guest is refused
   `iep:view-executed`. Enabling IEP forces visibility private and refuses to un-private while
   enabled.
5. **Signing end-to-end in both sandboxes.** Create → embedded sign as two different participants →
   webhook received and HMAC-verified → executed PDF lands in the private bucket → audit rows exist
   for every step.
6. **Storage posture.** The object is not publicly readable; a signed URL works and a stale one 403s.
7. **Accessibility.** Keyboard-only through the whole IEP flow with no mouse; an NVDA or VoiceOver
   read-through; 400% zoom with no horizontal scroll; `axe-core` clean on the module's routes.
