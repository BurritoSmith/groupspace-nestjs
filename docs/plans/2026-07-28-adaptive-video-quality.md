# Adaptive video quality (simulcast) for webcam/screen streams

## Context

Every webcam/screen-share stream was single-quality, fixed-bitrate — every viewer got the same encode regardless of whether it was a tiny dashboard tile or the full main stage, and a publisher's bandwidth had no way to prioritize across multiple streams. This adds mediasoup simulcast: publishers encode 2 independently-bitrated layers per video track, and viewers request whichever layer suits their current display context.

Publish-side bandwidth adaptation (degrading gracefully as more streams are added) needs no custom code — Chrome's built-in congestion control already throttles/drops higher simulcast layers under uplink pressure once simulcast exists with sane per-layer bitrate caps. This branch only adds the plumbing simulcast itself needs: a way for a viewer to request a layer, and (on the frontend, companion branch) the UI-context logic deciding when to ask for which.

## Backend (`spaces-nestjs-api-claude`) — this repo's half of the feature

### `src/room/interfaces/room.interfaces.ts`
- New `ConsumerQuality = 'low' | 'high'` and `ISetConsumerQualityPayload { consumerId, quality }`.

### `src/room/room.service.ts`
- `consume()`: every new *video* consumer now explicitly defaults to `spatialLayer: 0` (low) — previously relied on mediasoup's implicit default. Necessary because most tiles just sit in the grid and never get an explicit request at all.
- New `setConsumerQuality(peerId, consumerId, quality)`: resolves `'high'` against the *producer's own* currently-negotiated `encodings.length - 1` (via a new `findProducer()` lookup, sibling to the existing `findProducerOwner()`) rather than a static per-source layer-count table — stays correct automatically if the frontend's layer scheme ever changes. `'low'` always resolves to `0`. No-ops for audio.

### `src/room/room.gateway.ts`
- New `set-consumer-quality` handler, same ok/error-ack shape as `resume-consumer`.

**Recording is untouched** — it consumes through its own independent `PlainTransport`, unrelated to any live viewer's consumer, and mediasoup's default (no preference set) already requests the best layer.

## Tests
- `room.service.spec.ts`: new `consume` describe block (defaults video to layer 0, leaves audio alone) and `setConsumerQuality` describe block (resolves 'high'/'low' correctly, no-ops for audio, falls back safely if the producer is gone, throws for an unknown consumerId).
- `room.gateway.spec.ts`: new `onSetConsumerQuality` describe block (ok-ack on success, error-ack instead of throwing on rejection).

## Verification
`npm run build` && `npm test`. Actual bandwidth-adaptation behavior isn't unit-testable — verify manually via `chrome://webrtc-internals` or DevTools network throttling once the frontend half is deployed alongside this.

## Workflow
Branch `feature/adaptive-video-quality` off `main`. Companion frontend branch (same name) in `spaces-angular-claude` does the simulcast encodings + UI-context quality-demand tracking. Implement, test, commit locally — do not push/PR/merge/deploy until explicitly asked.
