/**
 * One-off backfill: generate a ~1600px display rendition for every chat image stored without one.
 *
 * Images uploaded from now on carry one already — the browser scales a copy at send time and uploads
 * it alongside the original and the thumbnail (see the frontend's image-thumbnail.ts). Everything
 * sent before that has no displayUrl, so the media viewer's stage keeps painting the full-size
 * original for it: up to 8000px, and roughly 48MB of bitmap once decoded, which is the decode that
 * made swiping an album stutter and hitch on a phone. This closes that gap for history.
 *
 * ## Why this lives outside src/
 *
 * It uses `sharp`, which is a NATIVE module, and the API deliberately has no image library — see
 * ChatMediaService and the album-cover work for the same decision made twice already. Keeping the
 * script out of `src/` and excluded in tsconfig.build.json means:
 *
 *  - `nest build` never compiles it, so `sharp` need not even resolve when the image is built;
 *  - nothing reaches `dist/`, so the runtime container (which installs `npm ci --omit=dev`) has no
 *    dead code in it that would throw on require;
 *  - `sharp` is a devDependency and is never installed in production at all.
 *
 * The decision logic it depends on lives in `src/room/chat-display-backfill.ts` instead, so it is
 * compiled and unit-tested with everything else. This file is only plumbing.
 *
 * ## Running it
 *
 *   npm run backfill:display              # dry run — reports what it WOULD do, changes nothing
 *   npm run backfill:display -- --apply   # actually writes
 *
 * Needs DATABASE_URL and CHAT_MEDIA_GCS_BUCKET in the environment, and credentials the Storage
 * client can find. Run it against production from the VM itself, in a container with
 * `--env-file deploy/.env`, so the database password never leaves the machine it already lives on.
 *
 * **Idempotent.** An attachment that already has a displayUrl is skipped, so a second run reports
 * zero work and an interrupted first run can simply be re-run.
 */
import { Storage } from '@google-cloud/storage';
import { Prisma, PrismaClient } from '@prisma/client';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import sharp from 'sharp';
import { attachmentObjectPath, backfillDisplayBox, displayStoragePath, needsDisplayRendition } from '../src/room/chat-display-backfill';
import { IChatAttachment } from '../src/room/interfaces/room.interfaces';

/** Matches DISPLAY_QUALITY in the frontend's image-thumbnail.ts — higher than the thumbnail's,
 *  because this is the image the user is actually looking at, full-screen. */
const DISPLAY_QUALITY = 85;

const apply = process.argv.includes('--apply');

/**
 * Where the images live, and what their URLs are prefixed with.
 *
 * Two backends because ChatMediaService itself has two, and they must agree exactly: `publicBase`
 * here has to match ChatMediaService.publicBase, or the displayUrl this writes gets dropped on the
 * floor by sanitizeAttachment the next time the message is broadcast — silently, with nothing
 * logged.
 */
interface RenditionStore {
    readonly publicBase: string;
    readonly describe: string;
    read(objectPath: string): Promise<Buffer>;
    write(objectPath: string, bytes: Buffer): Promise<void>;
}

function gcsStore(bucketName: string): RenditionStore {
    const bucket = new Storage().bucket(bucketName);
    return {
        publicBase: `https://storage.googleapis.com/${bucketName}/`,
        describe: `GCS bucket ${bucketName}`,
        read: async (objectPath) => (await bucket.file(objectPath).download())[0],
        write: async (objectPath, bytes) => {
            // Same metadata ChatMediaService.uploadAttachment writes, so a backfilled object is
            // indistinguishable from an uploaded one to anything downstream.
            await bucket.file(objectPath).save(bytes, {
                contentType: 'image/jpeg',
                resumable: false,
                metadata: { cacheControl: 'public, max-age=31536000, immutable' },
            });
        },
    };
}

/**
 * Local dev, where there is no bucket at all — matching ChatMediaService's own fallback and
 * main.ts's /chat-media/ static mount.
 *
 * Worth having rather than only supporting GCS: it is the only way to exercise this end to end
 * (sharp, the message walk, the URL-derived paths, the row patching) against real rows before
 * pointing it at anything that matters.
 */
function localStore(directory: string): RenditionStore {
    return {
        publicBase: '/chat-media/',
        describe: `local directory ${directory}`,
        read: (objectPath) => fs.readFile(path.join(directory, objectPath)),
        write: async (objectPath, bytes) => {
            const destination = path.join(directory, objectPath);
            await fs.mkdir(path.dirname(destination), { recursive: true });
            await fs.writeFile(destination, bytes);
        },
    };
}

async function main(): Promise<void> {
    // The same branch ChatMediaService makes: a bucket when one is configured, the local directory
    // otherwise. Choosing it the same way is what keeps publicBase in agreement with it.
    const bucketName = process.env.CHAT_MEDIA_GCS_BUCKET;
    const store = bucketName ? gcsStore(bucketName) : localStore(process.env.CHAT_MEDIA_DIR ?? path.join(process.cwd(), 'chat-media'));
    const publicBase = store.publicBase;

    const prisma = new PrismaClient();

    let scanned = 0;
    let converted = 0;
    let alreadySmall = 0;
    let notOurs = 0;
    let failed = 0;

    try {
        // There is no attachment table — chat media lives in ChatMessage.attachments, an untyped
        // JSONB column — so the only way to reach it is to walk the messages that have any.
        const messages = await prisma.chatMessage.findMany({
            where: { attachments: { not: Prisma.DbNull } },
            select: { id: true, attachments: true },
        });

        console.log(`Reading from ${store.describe}, URLs under "${publicBase}".`);
        console.log(`${messages.length} messages carry attachments.${apply ? '' : ' DRY RUN — nothing will be written.'}`);

        for (const message of messages) {
            const attachments = (message.attachments as unknown as IChatAttachment[] | null) ?? [];
            if (!Array.isArray(attachments)) {
                continue;
            }

            let changed = false;
            const updated: IChatAttachment[] = [];

            for (const attachment of attachments) {
                if (!needsDisplayRendition(attachment)) {
                    updated.push(attachment);
                    continue;
                }
                scanned += 1;

                const sourcePath = attachmentObjectPath(attachment, publicBase);
                if (!sourcePath) {
                    // A hotlinked Giphy URL, or anything else not in our bucket. Nothing to read.
                    notOurs += 1;
                    updated.push(attachment);
                    continue;
                }

                try {
                    const image = sharp(await store.read(sourcePath));
                    const { width, height } = await image.metadata();
                    const box = backfillDisplayBox(width ?? 0, height ?? 0);
                    if (!box) {
                        // Already display-sized. Left with no displayUrl on purpose, which is what
                        // makes the viewer fall back to the original — correct here, since the
                        // original is already small enough.
                        alreadySmall += 1;
                        updated.push(attachment);
                        continue;
                    }

                    const objectPath = displayStoragePath(sourcePath);
                    if (apply) {
                        const rendition = await image.resize(box.width, box.height).jpeg({ quality: DISPLAY_QUALITY }).toBuffer();
                        await store.write(objectPath, rendition);
                    }

                    updated.push({ ...attachment, displayUrl: `${publicBase}${objectPath}` });
                    changed = true;
                    converted += 1;
                    console.log(`  ${apply ? 'wrote' : 'would write'} ${objectPath} (${width}x${height} -> ${box.width}x${box.height})`);
                } catch (error) {
                    // One unreadable object must not abandon the rest of the run. Keeping the
                    // attachment untouched also leaves it eligible for the next run.
                    failed += 1;
                    updated.push(attachment);
                    console.warn(`  FAILED ${sourcePath}: ${error instanceof Error ? error.message : String(error)}`);
                }
            }

            if (changed && apply) {
                // The whole array is rewritten, but every field of every attachment is carried over
                // by the spread above — this adds displayUrl and changes nothing else.
                await prisma.chatMessage.update({ where: { id: message.id }, data: { attachments: updated as unknown as object[] } });
            }
        }
    } finally {
        await prisma.$disconnect();
    }

    console.log(
        [
            '',
            `Candidates:      ${scanned}`,
            `${apply ? 'Rendered' : 'Would render'}:   ${converted}`,
            `Already small:   ${alreadySmall}`,
            `Not our object:  ${notOurs}`,
            `Failed:          ${failed}`,
            apply ? '' : '\nRe-run with --apply to write.',
        ].join('\n'),
    );
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
