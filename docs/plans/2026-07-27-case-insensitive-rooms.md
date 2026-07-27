# Remove "lobby" default room, make room names case-insensitive, carry `?room=` through sign-in

## Context

Today every fresh visit defaults to a room literally named "lobby" (`environment.defaultRoomName`, used in both `NameEntry` and `Room`, with a matching `|| 'lobby'` fallback server-side in `onJoinRoom`). The user wants that default gone entirely — no auto-filled room name, no server-side fallback — so a room name always has to come from somewhere real (a typed value, or a `?room=` link).

Room names are also completely case-sensitive today, both server-side (confirmed via research: every consumer — the in-memory router/recording-state Maps, every Socket.IO `room` string, every Prisma `Room`/`RecordingSession`/`ChatMessage` row — derives from one single normalization point, `room.gateway.ts`'s `onJoinRoom`, which currently does no case-folding at all) and client-side. Two people typing "Lobby" and "lobby" today land in two entirely separate rooms with separate mediasoup routers, separate chat history, and separate recordings — confusing and easy to trigger by accident.

Finally, when someone opens the app with `?room=xyz` in the URL, that value should pre-fill `NameEntry`'s room-name text box and survive through Google sign-in. Confirmed via research: sign-in here is a same-page Google Identity Services (FedCM) dialog, not a redirect or popup navigation — the `NameEntry` component instance is never destroyed/reloaded during sign-in, so a value read into `roomName` once at construction survives automatically. No round-trip/session-storage plumbing is needed for this specific ask; it just needs to actually be read from the query param in the first place (it isn't today).

## Backend (`spaces-nestjs-api-claude`)

`src/room/room.gateway.ts`'s `onJoinRoom` (the confirmed single earliest point every downstream Map key/Socket.IO room/Prisma row derives from) — replace:
```ts
const roomName = payload.roomName?.trim() || 'lobby';
```
with a small extracted, independently-testable helper (mirrors the existing `buildRecordingFfmpegArgs`-style extraction-for-testability pattern already used in this codebase):
```ts
private normalizeRoomName(raw: string | undefined): string {
    const normalized = raw?.trim().toLowerCase() ?? '';
    if (!normalized) {
        throw new WsException('A room name is required.');
    }
    return normalized;
}
```
called as `const roomName = this.normalizeRoomName(payload.roomName);` at the same call site. No other handler needs touching — every other read of a room name in the codebase goes through `socket.data.roomName` (set once here) or a value already persisted from a normalized write, so normalizing at this one spot is sufficient (confirmed by tracing both a read path — `list-recording-sessions` — and a write path — `start-recording` — back to this exact origin).

No Prisma/schema change needed — `Room.name` stays a plain `String @id`; case-folding happens in application code before any DB write, so every row is already stored lowercase and every lookup already queries lowercase.

### Tests
Extend `room.gateway.spec.ts` with a focused `normalizeRoomName` block (same private-cast-and-call pattern already used elsewhere in this file/repo): lowercases mixed-case input, trims whitespace, throws `WsException` for empty/whitespace-only/undefined input. (Existing tests using the literal `'lobby'` as an arbitrary fixture room name elsewhere in this file and in `recording.service.spec.ts` need no changes — that string is still a perfectly valid room name, it's just no longer a default.)

## Frontend (`spaces-angular-claude`)

### Remove the default entirely
- `src/environments/environment.ts` and `environment.development.ts`: delete the `defaultRoomName: 'lobby'` property from both.

### `src/app/name-entry/name-entry.ts` + `.html`
- Inject `ActivatedRoute` (constructor param, matching this file's existing style) and read `?room=` once, normalized (trim + lowercase — client-side mirror of the server's own normalization, so the URL/displayed value is already canonical before it's even submitted):
  ```ts
  constructor(
      protected readonly user: User,
      private readonly googleAuth: GoogleAuth,
      private readonly router: Router,
      private readonly route: ActivatedRoute,
      protected readonly theme: Theme,
  ) {
      this.roomName = this.route.snapshot.queryParamMap.get('room')?.trim().toLowerCase() ?? '';
      ...
  }
  ```
  `roomName` field declaration changes from `= environment.defaultRoomName;` to `= '';` (constructor fills it in immediately after). `canJoin`/`join()` already guard on a non-empty trimmed value — no changes needed there beyond also lowercasing in `join()`:
  ```ts
  this.router.navigate(['/room'], { queryParams: { room: this.roomName.trim().toLowerCase() } });
  ```
- No template change needed for the "survives sign-in" requirement itself — the room-name input already only renders in the signed-in branch, and since sign-in never destroys the component, `roomName` (now seeded from the query param) is already correct the moment that branch first renders.

### `src/app/room/room.ts`
- Field declaration `roomName = environment.defaultRoomName;` → `roomName = '';`.
- `ngOnInit()`: replace the `|| environment.defaultRoomName` fallback with a bounce back to the home page when no room name is present at all (a direct `/room` hit with no query param has nothing to join) — and normalize (lowercase) defensively, covering a shared link with mixed case that bypassed `NameEntry` entirely:
  ```ts
  async ngOnInit(): Promise<void> {
      const roomParam = this.route.snapshot.queryParamMap.get('room')?.trim().toLowerCase();
      if (!roomParam) {
          this.router.navigateByUrl('/');
          return;
      }
      this.roomName = roomParam;
      ...
  ```
  (`this.router` is already injected in this component.)

### Tests
- `name-entry.spec.ts` (check at implementation time whether one exists already; extend or create): `roomName` seeds from `?room=` (normalized to lowercase, trimmed) when present, empty string when absent; `join()` navigates with the lowercased/trimmed value.
- `room.spec.ts`: `ngOnInit()` redirects to `/` when no `room` query param is present (instead of falling back to a default); normalizes a mixed-case query param before joining.

## Verification
- `npm run build` + `npm test` in both repos.
- Manual: visit `/` with no query param — room-name box starts empty, Join disabled until something's typed. Visit `/?room=MyRoom` — box shows `myroom` pre-filled both before and after completing Google sign-in. Join, then in a second browser join `/?room=MYROOM` — confirm both land in the same room (same participants, same chat history). Visit `/room` directly with no query param (or after clearing it) — confirm it redirects to `/` instead of erroring or joining an empty-named room.

### Critical files
- `spaces-nestjs-api-claude/src/room/room.gateway.ts` (+ `.spec.ts`)
- `spaces-angular-claude/src/environments/environment.ts` + `environment.development.ts`
- `spaces-angular-claude/src/app/name-entry/name-entry.ts` (+ spec)
- `spaces-angular-claude/src/app/room/room.ts` (+ spec)

## Workflow
New branch `feature/case-insensitive-rooms` off `main` in both repos (both up to date post-merge from the self-mute round). Plan doc committed first to `docs/plans/2026-07-27-case-insensitive-rooms.md` in both repos, then backend, verify with tests, then frontend, verify with build+tests. Commit locally, then the same wait-for-explicit-go-ahead pattern: test locally first, push/PR/merge/deploy only when asked.
