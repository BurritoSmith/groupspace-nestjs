# Add userId to the peer roster (IPeerSummary)

## Context

The Angular frontend is redesigning its chat UI to show each message's sender avatar. Chat messages carry `userId` but not `peerId`/`pictureUrl`; the presence roster (`IPeerSummary`/`peers`, `peer-joined`) carries `peerId`/`pictureUrl` but not `userId` — there's no existing key to join a chat message to a roster entry for its avatar. This adds `userId` to the roster, mirroring the existing `micSelfMuted`-in-roster precedent (mutable per-peer state exposed directly in the join ack + join event, rather than requiring a second round-trip).

## Backend (`spaces-nestjs-api-claude`) — the only repo touched by this branch

- `src/room/interfaces/room.interfaces.ts`: `IPeerSummary` gains `userId: string;`.
- `src/room/room.service.ts`'s `joinRoom()`: `peers.push({ peerId: peer.peerId, displayName: peer.displayName, pictureUrl: peer.pictureUrl, micSelfMuted: peer.micSelfMuted, userId: peer.userId })` — `userId` is already on `IPeerState`, no new lookup needed.
- `src/room/room.gateway.ts`'s `onJoinRoom`: the `peer-joined` emit (`socket.to(roomName).emit('peer-joined', { peerId: socket.id, displayName, pictureUrl, micSelfMuted: false })`) gains `userId`.

## Tests

`room.service.spec.ts`: `joinRoom()`'s existing-peers list includes each peer's `userId`.

## Verification

`npm run build` && `npm test`.

## Workflow

Branch `feature/peer-roster-userid` off `main`. Implement, test, commit locally. Do not push/PR/merge/deploy until explicitly asked.
