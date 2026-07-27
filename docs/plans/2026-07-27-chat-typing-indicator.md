# Chat "is typing…" indicator

## Context

The room's chat panel (`spaces-angular-claude/src/app/room/room.html`) has a message list and an input row, but no feedback that another participant is composing a reply. The user wants a lightweight indicator below the chat input, showing first name(s) only plus an animated ellipsis, that appears while someone is actively typing, disappears after they pause, and disappears immediately once they submit.

This is purely ephemeral UI state — nothing needs to be persisted (no DB writes, no chat history impact). It follows the exact broadcast style the room gateway already uses for `peer-joined`/`peer-left`: no ack, `socket.to(roomName).emit(...)` so the sender never echoes their own event back to themselves.

Confirmed from the code: `Chat` (`src/app/room/services/chat.ts`) already owns all chat-related socket wiring and signals (`messages`, `presence`), constructed with three `socketConnection.on(...)` listeners and a `reset()` cleared on room leave — the new typing state fits the same shape. The backend has no `firstName`/`givenName` field anywhere (`User.displayName` is Google's full `name` claim, not split) — first name will be derived client-side by taking the first whitespace-separated token of `displayName`. Per your answer, 3+ simultaneous typers collapse to "and N others."

## Backend (`spaces-nestjs-api-claude`)

In `src/room/room.gateway.ts`, add two handlers right next to `onChatMessage` (around line 345), matching `onJoinRoom`'s existing `peer-joined` broadcast style (line 209) — no persistence, no ack, excludes the sender via `socket.to()`:

```ts
@SubscribeMessage('user-typing')
onUserTyping(@ConnectedSocket() socket: Socket) {
    const roomName = socket.data.roomName as string;
    if (!roomName) return;
    socket.to(roomName).emit('user-typing', { peerId: socket.id, displayName: socket.data.displayName ?? 'Anonymous' });
}

@SubscribeMessage('user-stopped-typing')
onUserStoppedTyping(@ConnectedSocket() socket: Socket) {
    const roomName = socket.data.roomName as string;
    if (!roomName) return;
    socket.to(roomName).emit('user-stopped-typing', { peerId: socket.id });
}
```

No changes needed for the "someone disconnects mid-typing" case — the existing `peer-left` broadcast (already emitted on disconnect/leave) is reused client-side to clear that peer's typing state; no new backend cleanup path required.

### Tests
Extend `room.gateway.spec.ts` (or wherever `onChatMessage`/`onJoinRoom` are currently tested) with two small cases: `onUserTyping`/`onUserStoppedTyping` broadcast via `socket.to(roomName).emit` with the right payload, and no-op (no emit) when `socket.data.roomName` is unset.

## Frontend (`spaces-angular-claude`)

### `src/app/room/services/chat.ts` — own the typing state

- New signal: `private readonly typingPeersSignal = signal<Map<string, string>>(new Map())` (peerId → first name), exposed as `readonly typingPeerNames = computed(() => [...this.typingPeersSignal().values()])`.
- Constructor gains two more `socketConnection.on(...)` listeners, same style as the existing three:
  - `'user-typing'` → extract first name via `displayName.trim().split(/\s+/)[0] || displayName`, set into the map by peerId.
  - `'user-stopped-typing'` → delete that peerId from the map.
- Extend the existing `'peer-left'` handler to also delete the peerId from `typingPeersSignal` (covers disconnect-while-typing).
- `reset()` gains `this.typingPeersSignal.set(new Map())`.
- New local-typing lifecycle methods (debounce lives here, not in `room.ts`, keeping the component thin — mirrors `PlaybackSync`'s existing clear-then-reschedule `setTimeout` idiom):
  ```ts
  private isLocallyTyping = false;
  private stopTypingTimeout: ReturnType<typeof setTimeout> | null = null;
  private static readonly STOP_TYPING_DELAY_MS = 3000;

  notifyTyping(): void {
      if (!this.isLocallyTyping) {
          this.isLocallyTyping = true;
          this.socketConnection.emitWithAck('user-typing', {}).catch(() => {});
      }
      if (this.stopTypingTimeout) clearTimeout(this.stopTypingTimeout);
      this.stopTypingTimeout = setTimeout(() => this.notifyStoppedTyping(), Chat.STOP_TYPING_DELAY_MS);
  }

  notifyStoppedTyping(): void {
      if (this.stopTypingTimeout) { clearTimeout(this.stopTypingTimeout); this.stopTypingTimeout = null; }
      if (this.isLocallyTyping) {
          this.isLocallyTyping = false;
          this.socketConnection.emitWithAck('user-stopped-typing', {}).catch(() => {});
      }
  }
  ```
  `sendMessage()` calls `this.notifyStoppedTyping()` first (so submitting clears the sender's own broadcast typing state immediately, per your "remove completely on submit" requirement — the sender never sees their own indicator anyway since `socket.to()` excludes them, but this stops *other* participants from continuing to see it).
- Reuses `emitWithAck` (no new `SocketConnection` API needed) — the backend handlers take no ack callback param, so NestJS's gateway auto-resolves the promise with `undefined`, same as `chat-message` already does.

### `src/app/room/room.ts` / `room.html` / `room.scss`

- `room.html`: input row's `<input>` gains `(input)="onChatInput()"` alongside its existing `[(ngModel)]="chatDraft"`. New element between `.chat-messages` and the `.chat-input-row` form:
  ```html
  @if (typingIndicatorText(); as text) {
    <div class="chat-typing-indicator">{{ text }}<span class="typing-dots"><span></span><span></span><span></span></span></div>
  }
  ```
- `room.ts`:
  - `onChatInput(): void` — if `chatDraft.trim()` is non-empty, call `chat.notifyTyping()`; if it just became empty (user deleted everything), call `chat.notifyStoppedTyping()` immediately rather than waiting out the debounce.
  - `sendChatMessage()`: no change needed beyond what's already there — `chat.sendMessage()` now internally calls `notifyStoppedTyping()` first.
  - `ngOnDestroy()`: add `this.chat.notifyStoppedTyping()` before `this.chat.reset()` so leaving mid-typing doesn't leave a stale indicator for others.
  - New computed, formatting the natural-list copy per your answer (1/2/3+ cases), mirroring the existing `formatMessageTime` small-helper convention:
    ```ts
    readonly typingIndicatorText = computed(() => {
        const names = this.chat.typingPeerNames();
        if (names.length === 0) return null;
        if (names.length === 1) return `${names[0]} is typing`;
        if (names.length === 2) return `${names[0]} and ${names[1]} are typing`;
        return `${names[0]}, ${names[1]}, and ${names.length - 2} other${names.length - 2 === 1 ? '' : 's'} are typing`;
    });
    ```
- `room.scss`: new rules near `.chat-input-row` (line ~246):
  ```scss
  .chat-typing-indicator {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    opacity: 0.7;
    padding: 2px 0;
    min-height: 14px; // reserves space so the input row doesn't jump when the indicator toggles
  }
  .typing-dots span {
    display: inline-block;
    width: 3px;
    height: 3px;
    margin-left: 1px;
    border-radius: 50%;
    background: currentColor;
    animation: chat-typing-blink 1.4s infinite both;
  }
  .typing-dots span:nth-child(2) { animation-delay: 0.2s; }
  .typing-dots span:nth-child(3) { animation-delay: 0.4s; }
  @keyframes chat-typing-blink {
    0%, 80%, 100% { opacity: 0.2; }
    40% { opacity: 1; }
  }
  ```

### Tests
- Extend `chat.spec.ts` (if none exists yet, new file mirroring `media-room.spec.ts`'s fake-`SocketConnection` convention): `'user-typing'` populates `typingPeerNames` with the first-name-only extraction; `'user-stopped-typing'` and `'peer-left'` both remove it; `notifyTyping()` emits once per typing session (not per call) and reschedules the stop timer (use `vi.useFakeTimers()` to assert the 3s auto-stop fires `user-stopped-typing`); `sendMessage()` triggers `notifyStoppedTyping()`.
- Extend `room.spec.ts`: `typingIndicatorText()` renders the three copy variants (1/2/3+ names) correctly.

## Verification
- `npm run build` + `npm test` in both repos.
- Manual: two browser sessions in the same room — type in one (don't submit), confirm the other sees "X is typing…" within a keystroke, and it disappears ~3s after the first stops typing. Have both type simultaneously — confirm "X and Y are typing…". Add a third — confirm "X, Y, and 1 other are typing…". Submit a message mid-typing — confirm the indicator disappears immediately for the other participant. Close/refresh a tab while mid-typing — confirm the indicator clears for everyone else (via the existing `peer-left` cleanup).

## Workflow
New branch `feature/chat-typing-indicator` off `main` in both repos (both already up to date post-merge from the previous round). Implement backend first, verify with `npm test`, then frontend, running `npm run build` + `npm test` after. Commit locally, then the same wait-for-explicit-go-ahead pattern: test locally first, push/PR/merge/deploy only when asked.

**Plan history (new, per your request):** this plan itself gets committed into both repos as `docs/plans/2026-07-27-chat-typing-indicator.md` (same content in each, so either repo's history has full context even though the feature spans both) — the first commit on each feature branch, before the implementation commits, so `git log` gives a permanent, version-controlled record instead of relying on the ephemeral local plan-mode file.
