# Changelog

Every entry here is a release that was actually deployed. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) — see `docs/versioning.md`.

Versions before the scheme existed were reconstructed from the first-parent history: one
release per merged pull request, minor for `feature/` branches and patch for everything else.

## [Unreleased]

_Nothing yet._

## [0.27.4] - 2026-08-04

### Added

- Accept PDF chat attachments; bump image cap to 50MB ([#47](https://github.com/BurritoSmith/groupspace-nestjs/pull/47))

## [0.27.3] - 2026-08-04

### Added

- Add an invitation-code gate ahead of the app, and record which code let each user in ([#46](https://github.com/BurritoSmith/groupspace-nestjs/pull/46))

## [0.27.2] - 2026-08-03

### Added

- Let a user soft-delete their own chat messages ([#45](https://github.com/BurritoSmith/groupspace-nestjs/pull/45))

### Changed

- Version every deploy, and backfill the 56 releases already shipped ([#44](https://github.com/BurritoSmith/groupspace-nestjs/pull/44))
- Point the PR checklist at this repo's own commands ([#44](https://github.com/BurritoSmith/groupspace-nestjs/pull/44))
- Match the changelog heading literally when cutting release notes ([#44](https://github.com/BurritoSmith/groupspace-nestjs/pull/44))

## [0.27.1] - 2026-08-02

### Changed

- Remove the display-rendition backfill now that it has run ([#43](https://github.com/BurritoSmith/groupspace-nestjs/pull/43))

## [0.27.0] - 2026-08-02

### Added

- Backfill display renditions for images stored before they existed ([#42](https://github.com/BurritoSmith/groupspace-nestjs/pull/42))
- Let the backfill run against local storage, not only GCS ([#42](https://github.com/BurritoSmith/groupspace-nestjs/pull/42))

## [0.26.0] - 2026-08-02

### Added

- Accept a display rendition URL on chat attachments ([#41](https://github.com/BurritoSmith/groupspace-nestjs/pull/41))

## [0.25.2] - 2026-08-02

### Fixed

- Package the commit, and prune what git dropped, when deploying ([#40](https://github.com/BurritoSmith/groupspace-nestjs/pull/40))

## [0.25.1] - 2026-08-02

### Changed

- Remove the thumbnail backfill now that it has run ([#39](https://github.com/BurritoSmith/groupspace-nestjs/pull/39))

## [0.25.0] - 2026-08-02

### Added

- Backfill thumbnails for images stored before thumbnails existed ([#38](https://github.com/BurritoSmith/groupspace-nestjs/pull/38))
- Drop square album covers, and run against local dev too ([#38](https://github.com/BurritoSmith/groupspace-nestjs/pull/38))

## [0.24.0] - 2026-08-02

### Added

- Allow the Electron desktop app's loopback origin ([#37](https://github.com/BurritoSmith/groupspace-nestjs/pull/37))

## [0.23.0] - 2026-08-02

### Added

- Read and write user preferences over REST ([#36](https://github.com/BurritoSmith/groupspace-nestjs/pull/36))

## [0.22.0] - 2026-08-01

### Added

- Carry an album cover URL through the chat attachment allowlist ([#35](https://github.com/BurritoSmith/groupspace-nestjs/pull/35))

## [0.21.0] - 2026-08-01

### Added

- Carry an albumId through the chat attachment allowlist ([#34](https://github.com/BurritoSmith/groupspace-nestjs/pull/34))

## [0.20.0] - 2026-08-01

### Added

- Add emoji reactions to chat messages ([#33](https://github.com/BurritoSmith/groupspace-nestjs/pull/33))

## [0.19.0] - 2026-08-01

### Added

- Proxy Giphy search server-side, and fix hotlinks being rejected in local dev ([#32](https://github.com/BurritoSmith/groupspace-nestjs/pull/32))

## [0.18.0] - 2026-08-01

### Added

- Carry userId on producer summaries, so clients can count people not sockets ([#31](https://github.com/BurritoSmith/groupspace-nestjs/pull/31))

## [0.17.0] - 2026-08-01

### Added

- Scrape link previews for chat messages, behind an SSRF guard ([#30](https://github.com/BurritoSmith/groupspace-nestjs/pull/30))

## [0.16.4] - 2026-07-31

### Fixed

- Give the startVideoSession spec its own scratch dir instead of the shared one ([#29](https://github.com/BurritoSmith/groupspace-nestjs/pull/29))

## [0.16.3] - 2026-07-31

### Fixed

- Stamp a recording's startedAt from when media began, not when detection finished ([#28](https://github.com/BurritoSmith/groupspace-nestjs/pull/28))

## [0.16.2] - 2026-07-31

### Fixed

- Cap the muxer cluster interval so recording start isn't gated on a 5s flush ([#27](https://github.com/BurritoSmith/groupspace-nestjs/pull/27))

## [0.16.1] - 2026-07-31

### Fixed

- Detect a recording actually starting by file growth, not by it being non-empty ([#26](https://github.com/BurritoSmith/groupspace-nestjs/pull/26))

## [0.16.0] - 2026-07-31

### Added

- Add opt-in HTTPS and a LAN dev origin, for testing the frontend from a phone ([#25](https://github.com/BurritoSmith/groupspace-nestjs/pull/25))

## [0.15.0] - 2026-07-30

### Added

- Add chat media upload spine: REST endpoint, GCS storage, attachment validation ([#24](https://github.com/BurritoSmith/groupspace-nestjs/pull/24))
- Point CHAT_MEDIA_GCS_BUCKET at the actual reused bucket, not a placeholder ([#24](https://github.com/BurritoSmith/groupspace-nestjs/pull/24))

## [0.14.1] - 2026-07-30

### Fixed

- Verify a recording actually receives data before treating it as started, with retry ([#23](https://github.com/BurritoSmith/groupspace-nestjs/pull/23))

## [0.14.0] - 2026-07-29

### Added

- Stop transcoding recordings; stream-copy VP8/Opus straight into WebM ([#22](https://github.com/BurritoSmith/groupspace-nestjs/pull/22))

## [0.13.2] - 2026-07-29

### Fixed

- Detect and retry a CPU-starved video recording instead of silently corrupting it ([#21](https://github.com/BurritoSmith/groupspace-nestjs/pull/21))

## [0.13.1] - 2026-07-29

### Fixed

- Stagger recording starts against stops, not just against each other ([#20](https://github.com/BurritoSmith/groupspace-nestjs/pull/20))

## [0.13.0] - 2026-07-29

### Added

- Add recording-session timeline events + session-scoped chat history ([#19](https://github.com/BurritoSmith/groupspace-nestjs/pull/19))
- Log a join event for everyone already in the room when recording starts ([#19](https://github.com/BurritoSmith/groupspace-nestjs/pull/19))
- Base join/leave timeline events on mic producer lifecycle, not room socket ([#19](https://github.com/BurritoSmith/groupspace-nestjs/pull/19))

## [0.12.0] - 2026-07-29

### Added

- Add generic per-user settings storage, starting with mic threshold ([#18](https://github.com/BurritoSmith/groupspace-nestjs/pull/18))

## [0.11.2] - 2026-07-28

### Fixed

- Snapshot pictureUrl onto chat messages at send-time ([#17](https://github.com/BurritoSmith/groupspace-nestjs/pull/17))

## [0.11.1] - 2026-07-28

### Fixed

- Include recording status in the join-room ack ([#16](https://github.com/BurritoSmith/groupspace-nestjs/pull/16))
- Include the recording's actual start time in the join ack and broadcast ([#16](https://github.com/BurritoSmith/groupspace-nestjs/pull/16))

## [0.11.0] - 2026-07-28

### Added

- Add server-side plumbing for adaptive video quality (simulcast) ([#15](https://github.com/BurritoSmith/groupspace-nestjs/pull/15))

## [0.10.4] - 2026-07-28

### Fixed

- Stagger recording stops, not just starts; trim the stagger delay ([#14](https://github.com/BurritoSmith/groupspace-nestjs/pull/14))

## [0.10.3] - 2026-07-28

### Fixed

- Retry the deploy workflow's health check instead of checking once immediately ([#13](https://github.com/BurritoSmith/groupspace-nestjs/pull/13))

## [0.10.2] - 2026-07-28

### Fixed

- Fix the deploy workflow SSHing into the wrong VM account ([#12](https://github.com/BurritoSmith/groupspace-nestjs/pull/12))

## [0.10.1] - 2026-07-28

### Fixed

- Add plan doc for recording CPU-starvation fix ([#11](https://github.com/BurritoSmith/groupspace-nestjs/pull/11))
- Fix empty recordings caused by CPU starvation on session start ([#11](https://github.com/BurritoSmith/groupspace-nestjs/pull/11))

## [0.10.0] - 2026-07-28

### Added

- Add a manually-triggered deploy workflow for the backend VM ([#10](https://github.com/BurritoSmith/groupspace-nestjs/pull/10))

## [0.9.0] - 2026-07-28

### Added

- Add plan doc for peer-roster userId addition ([#9](https://github.com/BurritoSmith/groupspace-nestjs/pull/9))
- Include userId in the peer roster ([#9](https://github.com/BurritoSmith/groupspace-nestjs/pull/9))

## [0.8.1] - 2026-07-27

### Fixed

- Fix race where stopping the recording could drop a just-closed stream's file ([#8](https://github.com/BurritoSmith/groupspace-nestjs/pull/8))

## [0.8.0] - 2026-07-27

### Added

- Add plan doc for case-insensitive room names feature ([#7](https://github.com/BurritoSmith/groupspace-nestjs/pull/7))
- Make room names case-insensitive; drop the "lobby" default fallback ([#7](https://github.com/BurritoSmith/groupspace-nestjs/pull/7))

## [0.7.0] - 2026-07-27

### Added

- Add plan doc for self-mute feature ([#6](https://github.com/BurritoSmith/groupspace-nestjs/pull/6))
- Track and broadcast per-peer self-mute state (mic stays on, track silenced) ([#6](https://github.com/BurritoSmith/groupspace-nestjs/pull/6))

## [0.6.0] - 2026-07-27

### Added

- Add plan doc for chat typing indicator feature ([#5](https://github.com/BurritoSmith/groupspace-nestjs/pull/5))
- Broadcast user-typing/user-stopped-typing over the room gateway ([#5](https://github.com/BurritoSmith/groupspace-nestjs/pull/5))

## [0.5.0] - 2026-07-27

### Added

- Record each participant's mic separately instead of mixing into one track ([#4](https://github.com/BurritoSmith/groupspace-nestjs/pull/4))

## [0.4.0] - 2026-07-27

### Added

- Add app-owned session tokens so users stay logged in past Google's ~1hr expiry ([#3](https://github.com/BurritoSmith/groupspace-nestjs/pull/3))

## [0.3.1] - 2026-07-27

### Fixed

- Fix recording filename collision when two peers share a display name ([#2](https://github.com/BurritoSmith/groupspace-nestjs/pull/2))

## [0.3.0] - 2026-07-27

### Added

- Add progressive recording availability, thumbnails, and live playback events ([#1](https://github.com/BurritoSmith/groupspace-nestjs/pull/1))
- Send each recording's startedAt so playback can align streams by real offset ([#1](https://github.com/BurritoSmith/groupspace-nestjs/pull/1))
- Send stoppedAt so playback can derive duration from our own bookkeeping ([#1](https://github.com/BurritoSmith/groupspace-nestjs/pull/1))
- Harden playback against zero-content recordings and mid-session stream changes ([#1](https://github.com/BurritoSmith/groupspace-nestjs/pull/1))

## [0.2.3] - 2026-07-26

### Fixed

- Fix regression: resume-consumer could hang the client's ack forever

## [0.2.2] - 2026-07-26

### Changed

- Request a keyframe when resuming a video consumer to fix intermittent black tiles

## [0.2.1] - 2026-07-26

### Fixed

- Fix recorded video duration: ffmpeg was inferring a bogus ~90000fps output

## [0.2.0] - 2026-07-26

### Added

- Add explicit leave-room cleanup for in-app navigation away from the room

## [0.1.6] - 2026-07-26

### Fixed

- Fix recording port collision between concurrent streams, add local playback links

## [0.1.5] - 2026-07-26

### Changed

- Always link recordings to their deterministic GCS path, even on upload failure

## [0.1.4] - 2026-07-26

### Changed

- Retry recording startup with a fresh port on ffmpeg bind failure

## [0.1.3] - 2026-07-26

### Fixed

- Fix ffmpeg port bind collision with mediasoup's own port range

## [0.1.2] - 2026-07-26

### Changed

- Upload finished recordings to Cloud Storage instead of local disk on GCP

## [0.1.1] - 2026-07-26

### Fixed

- Fix ffmpeg path resolution ignoring blank FFMPEG_PATH env var

## [0.1.0] - 2026-07-26

### Added

- added recording session saving

## [0.0.1] - 2026-07-26

### Fixed

- Fix recording reliability: crash on missing ffmpeg, hung acks, empty files

## [0.0.0] - 2026-07-26

### Added

- Initial commit: mediasoup SFU backend with Google auth and recording

[Unreleased]: https://github.com/BurritoSmith/groupspace-nestjs/compare/v0.27.4...HEAD
[0.27.4]: https://github.com/BurritoSmith/groupspace-nestjs/compare/v0.27.3...v0.27.4
[0.27.3]: https://github.com/BurritoSmith/groupspace-nestjs/compare/v0.27.2...v0.27.3
[0.27.2]: https://github.com/BurritoSmith/groupspace-nestjs/compare/v0.27.1...v0.27.2
[0.27.1]: https://github.com/BurritoSmith/groupspace-nestjs/compare/v0.27.0...v0.27.1
[0.27.0]: https://github.com/BurritoSmith/groupspace-nestjs/compare/v0.26.0...v0.27.0
[0.26.0]: https://github.com/BurritoSmith/groupspace-nestjs/compare/v0.25.2...v0.26.0
[0.25.2]: https://github.com/BurritoSmith/groupspace-nestjs/compare/v0.25.1...v0.25.2
[0.25.1]: https://github.com/BurritoSmith/groupspace-nestjs/compare/v0.25.0...v0.25.1
[0.25.0]: https://github.com/BurritoSmith/groupspace-nestjs/compare/v0.24.0...v0.25.0
[0.24.0]: https://github.com/BurritoSmith/groupspace-nestjs/compare/v0.23.0...v0.24.0
[0.23.0]: https://github.com/BurritoSmith/groupspace-nestjs/compare/v0.22.0...v0.23.0
[0.22.0]: https://github.com/BurritoSmith/groupspace-nestjs/compare/v0.21.0...v0.22.0
[0.21.0]: https://github.com/BurritoSmith/groupspace-nestjs/compare/v0.20.0...v0.21.0
[0.20.0]: https://github.com/BurritoSmith/groupspace-nestjs/compare/v0.19.0...v0.20.0
[0.19.0]: https://github.com/BurritoSmith/groupspace-nestjs/compare/v0.18.0...v0.19.0
[0.18.0]: https://github.com/BurritoSmith/groupspace-nestjs/compare/v0.17.0...v0.18.0
[0.17.0]: https://github.com/BurritoSmith/groupspace-nestjs/compare/v0.16.4...v0.17.0
[0.16.4]: https://github.com/BurritoSmith/groupspace-nestjs/compare/v0.16.3...v0.16.4
[0.16.3]: https://github.com/BurritoSmith/groupspace-nestjs/compare/v0.16.2...v0.16.3
[0.16.2]: https://github.com/BurritoSmith/groupspace-nestjs/compare/v0.16.1...v0.16.2
[0.16.1]: https://github.com/BurritoSmith/groupspace-nestjs/compare/v0.16.0...v0.16.1
[0.16.0]: https://github.com/BurritoSmith/groupspace-nestjs/compare/v0.15.0...v0.16.0
[0.15.0]: https://github.com/BurritoSmith/groupspace-nestjs/compare/v0.14.1...v0.15.0
[0.14.1]: https://github.com/BurritoSmith/groupspace-nestjs/compare/v0.14.0...v0.14.1
[0.14.0]: https://github.com/BurritoSmith/groupspace-nestjs/compare/v0.13.2...v0.14.0
[0.13.2]: https://github.com/BurritoSmith/groupspace-nestjs/compare/v0.13.1...v0.13.2
[0.13.1]: https://github.com/BurritoSmith/groupspace-nestjs/compare/v0.13.0...v0.13.1
[0.13.0]: https://github.com/BurritoSmith/groupspace-nestjs/compare/v0.12.0...v0.13.0
[0.12.0]: https://github.com/BurritoSmith/groupspace-nestjs/compare/v0.11.2...v0.12.0
[0.11.2]: https://github.com/BurritoSmith/groupspace-nestjs/compare/v0.11.1...v0.11.2
[0.11.1]: https://github.com/BurritoSmith/groupspace-nestjs/compare/v0.11.0...v0.11.1
[0.11.0]: https://github.com/BurritoSmith/groupspace-nestjs/compare/v0.10.4...v0.11.0
[0.10.4]: https://github.com/BurritoSmith/groupspace-nestjs/compare/v0.10.3...v0.10.4
[0.10.3]: https://github.com/BurritoSmith/groupspace-nestjs/compare/v0.10.2...v0.10.3
[0.10.2]: https://github.com/BurritoSmith/groupspace-nestjs/compare/v0.10.1...v0.10.2
[0.10.1]: https://github.com/BurritoSmith/groupspace-nestjs/compare/v0.10.0...v0.10.1
[0.10.0]: https://github.com/BurritoSmith/groupspace-nestjs/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/BurritoSmith/groupspace-nestjs/compare/v0.8.1...v0.9.0
[0.8.1]: https://github.com/BurritoSmith/groupspace-nestjs/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/BurritoSmith/groupspace-nestjs/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/BurritoSmith/groupspace-nestjs/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/BurritoSmith/groupspace-nestjs/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/BurritoSmith/groupspace-nestjs/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/BurritoSmith/groupspace-nestjs/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/BurritoSmith/groupspace-nestjs/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/BurritoSmith/groupspace-nestjs/compare/v0.2.3...v0.3.0
[0.2.3]: https://github.com/BurritoSmith/groupspace-nestjs/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/BurritoSmith/groupspace-nestjs/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/BurritoSmith/groupspace-nestjs/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/BurritoSmith/groupspace-nestjs/compare/v0.1.6...v0.2.0
[0.1.6]: https://github.com/BurritoSmith/groupspace-nestjs/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/BurritoSmith/groupspace-nestjs/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/BurritoSmith/groupspace-nestjs/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/BurritoSmith/groupspace-nestjs/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/BurritoSmith/groupspace-nestjs/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/BurritoSmith/groupspace-nestjs/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/BurritoSmith/groupspace-nestjs/compare/v0.0.1...v0.1.0
[0.0.1]: https://github.com/BurritoSmith/groupspace-nestjs/compare/v0.0.0...v0.0.1
[0.0.0]: https://github.com/BurritoSmith/groupspace-nestjs/releases/tag/v0.0.0
