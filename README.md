# Converge — backend

The NestJS server behind Converge: a [mediasoup](https://mediasoup.org) SFU for the live video and
audio, plus Google sign-in, chat with attachments, link previews, and server-side recording via
ffmpeg into Cloud Storage. The [web client](https://github.com/BurritoSmith/groupspace-angular)
talks to it over one socket.io connection on the `/room` namespace.

## Running it

```bash
npm ci
npx prisma migrate deploy     # apply migrations locally too, not just at deploy time
npm run start:dev             # :3001
```

Needs a `.env` with at least `DATABASE_URL`. Secrets live only in `.env` files and on the VM — never
in the frontend, and never in a commit.

```bash
npm test                      # Jest
npm run build
```

## Deployment

A Docker Compose stack on a GCE VM, deployed manually: Actions → **Deploy (development)** → Run
workflow. The runner packages `git archive HEAD`, ships it over `gcloud compute scp`, and rebuilds
the stack in place. Nothing is auto-triggered by merging to `main`.

Migrations run on container start (`npx prisma migrate deploy` in the Dockerfile's `CMD`), so a
migration added in a PR applies itself on the next deploy — but apply it locally when you add it, or
your development database silently diverges from the schema the code expects.

## Versioning and releases

Semantic Versioning, currently `0.x`, and **every deploy moves the version**. The scheme, and why
this repo versions separately from the frontend, is in [`docs/versioning.md`](docs/versioning.md).
What has shipped, and when, is in [`CHANGELOG.md`](CHANGELOG.md).

`GET /version` reports what is actually running — the deploy asks it that question itself, and
refuses to push a tag if the container that came up is not the build it just shipped.

## Layout

| Path | What's in it |
|---|---|
| `src/room/` | the gateway, mediasoup workers and routers, chat, recording |
| `src/room/interfaces/` | the socket contract, shared in shape with the client |
| `prisma/` | schema and migrations |
| `deploy/` | the compose file and the VM-side environment |
| `docs/plans/` | dated design notes, one per non-trivial change |
