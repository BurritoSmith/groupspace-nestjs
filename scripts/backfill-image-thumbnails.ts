/**
 * One-off backfill: generate a thumbnail for every chat image stored before thumbnails existed.
 *
 * Images uploaded from now on carry one already — the browser scales a copy at send time and
 * uploads it alongside the original (see the frontend's image-thumbnail.ts). Everything sent before
 * that has `thumbnailUrl: null`, so the media viewer's filmstrip, the album tile and the chat list
 * all keep falling back to the full-size original for it. This closes that gap for history.
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
 * The decision logic it depends on lives in `src/room/chat-thumbnail-backfill.ts` instead, so it is
 * compiled and unit-tested with everything else. This file is only plumbing.
 *
 * ## Running it
 *
 *   npm run backfill:thumbnails              # dry run — reports what it WOULD do, changes nothing
 *   npm run backfill:thumbnails -- --apply   # actually writes
 *
 * Needs DATABASE_URL and CHAT_MEDIA_GCS_BUCKET in the environment, and credentials the Storage
 * client can find (`gcloud auth application-default login` locally). Run it from a dev machine; it
 * is not part of any deploy.
 *
 * **Idempotent.** An attachment that already has a thumbnailUrl is skipped, so a second run reports
 * zero work and an interrupted first run can simply be re-run.
 */
import { Storage } from '@google-cloud/storage';
import { Prisma, PrismaClient } from '@prisma/client';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import sharp from 'sharp';
import {
    attachmentObjectPath,
    backfillThumbnailBox,
    isStaleAlbumCover,
    needsImageThumbnail,
    storagePathFromMediaUrl,
    thumbnailStoragePath,
} from '../src/room/chat-thumbnail-backfill';
import { IChatAttachment } from '../src/room/interfaces/room.interfaces';

/** Matches what ChatUploads sends for a client-generated thumbnail. */
const THUMBNAIL_QUALITY = 80;

const apply = process.argv.includes('--apply');

/** Reading and writing objects, over whichever of the two stores this environment actually uses. */
interface MediaStore {
    describe: string;
    publicBase: string;
    read(objectPath: string): Promise<Buffer>;
    write(objectPath: string, body: Buffer): Promise<void>;
}

/**
 * Picks the same store ChatMediaService itself would, by the same signal — CHAT_MEDIA_GCS_BUCKET
 * being set or not — and builds the same publicBase.
 *
 * The local branch is not a convenience: it is what makes this script runnable against a dev machine's
 * own chat-media directory, which is the only way to watch it work end to end before pointing it at
 * real data. Getting publicBase wrong in either mode is silent — sanitizeAttachment drops a
 * thumbnailUrl that doesn't match the base, with nothing logged — so both are mirrored exactly rather
 * than approximated.
 */
function mediaStore(): MediaStore {
    const bucketName = process.env.CHAT_MEDIA_GCS_BUCKET;
    if (bucketName) {
        const bucket = new Storage().bucket(bucketName);
        return {
            describe: `gs://${bucketName}`,
            publicBase: `https://storage.googleapis.com/${bucketName}/`,
            read: async (objectPath) => (await bucket.file(objectPath).download())[0],
            // Same metadata ChatMediaService.uploadAttachment writes, so a backfilled object is
            // indistinguishable from an uploaded one to anything downstream.
            write: async (objectPath, body) => {
                await bucket.file(objectPath).save(body, {
                    contentType: 'image/jpeg',
                    resumable: false,
                    metadata: { cacheControl: 'public, max-age=31536000, immutable' },
                });
            },
        };
    }

    const localDir = process.env.CHAT_MEDIA_DIR ?? path.join(process.cwd(), 'chat-media');
    return {
        describe: localDir,
        publicBase: '/chat-media/',
        read: (objectPath) => fs.readFile(path.join(localDir, objectPath)),
        write: async (objectPath, body) => {
            const target = path.join(localDir, objectPath);
            await fs.mkdir(path.dirname(target), { recursive: true });
            await fs.writeFile(target, body);
        },
    };
}

async function main(): Promise<void> {
    const store = mediaStore();
    const publicBase = store.publicBase;
    console.log(`Media store: ${store.describe}`);

    const prisma = new PrismaClient();

    let scanned = 0;
    let converted = 0;
    let alreadySmall = 0;
    let failed = 0;
    let coversDropped = 0;

    /**
     * Cover URLs already judged, since every attachment of an album carries the SAME one — without
     * this, a 30-image album would download and measure its cover 30 times.
     */
    const coverVerdicts = new Map<string, boolean>();

    /** Whether an album cover was drawn to the old square geometry and should be dropped. */
    async function isCoverStale(coverUrl: string): Promise<boolean> {
        const cached = coverVerdicts.get(coverUrl);
        if (cached !== undefined) {
            return cached;
        }
        let stale = false;
        const objectPath = storagePathFromMediaUrl(coverUrl, publicBase);
        if (objectPath) {
            try {
                const { width, height } = await sharp(await store.read(objectPath)).metadata();
                stale = isStaleAlbumCover(width ?? 0, height ?? 0);
            } catch (error) {
                // Unreadable: leave it alone rather than dropping a cover that might be fine. The
                // next run will try again.
                console.warn(`  cover unreadable ${objectPath}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        coverVerdicts.set(coverUrl, stale);
        return stale;
    }

    try {
        // There is no attachment table — chat media lives in ChatMessage.attachments, an untyped
        // JSONB column — so the only way to reach it is to walk the messages that have any.
        const messages = await prisma.chatMessage.findMany({
            where: { attachments: { not: Prisma.DbNull } },
            select: { id: true, attachments: true },
        });

        console.log(`${messages.length} messages carry attachments.${apply ? '' : ' DRY RUN — nothing will be written.'}`);

        for (const message of messages) {
            const attachments = (message.attachments as unknown as IChatAttachment[] | null) ?? [];
            if (!Array.isArray(attachments)) {
                continue;
            }

            let changed = false;
            const updated: IChatAttachment[] = [];

            /*
             * Whether this message's album cover has to go.
             *
             * A square cover cannot be repaired: the fan does not fill a square, so its leftover
             * corners were transparent on the canvas and JPEG flattened them to solid black. Dropping
             * the reference makes the album render the CSS card stack instead — built from the
             * attachments themselves, correct 4:3 geometry, and genuinely transparent where the
             * cards step out. The cover OBJECT is left in the bucket untouched; only the pointer to
             * it is cleared, so this is reversible by hand if it ever needs to be.
             */
            const coverUrl = attachments.find((candidate) => candidate?.albumCoverUrl)?.albumCoverUrl;
            const dropCover = coverUrl ? await isCoverStale(coverUrl) : false;
            if (dropCover) {
                coversDropped += 1;
                console.log(`  ${apply ? 'dropped' : 'would drop'} square album cover on message ${message.id}`);
            }

            for (const rawAttachment of attachments) {
                const attachment = dropCover ? { ...rawAttachment, albumCoverUrl: null } : rawAttachment;
                if (dropCover) {
                    changed = true;
                }
                const sourcePath = needsImageThumbnail(attachment) ? attachmentObjectPath(attachment, publicBase) : null;
                if (!sourcePath) {
                    updated.push(attachment);
                    continue;
                }
                scanned += 1;

                try {
                    const image = sharp(await store.read(sourcePath));
                    const { width, height } = await image.metadata();
                    const box = backfillThumbnailBox(width ?? 0, height ?? 0);
                    if (!box) {
                        // Already its own thumbnail. Left with a null thumbnailUrl on purpose, which
                        // is what makes every consumer fall back to the original — correct here,
                        // since the original is already small.
                        alreadySmall += 1;
                        updated.push(attachment);
                        continue;
                    }

                    const objectPath = thumbnailStoragePath(sourcePath);
                    if (apply) {
                        await store.write(objectPath, await image.resize(box.width, box.height).jpeg({ quality: THUMBNAIL_QUALITY }).toBuffer());
                    }

                    updated.push({ ...attachment, thumbnailUrl: `${publicBase}${objectPath}` });
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
                // by the spread above — this adds thumbnailUrl and changes nothing else.
                await prisma.chatMessage.update({ where: { id: message.id }, data: { attachments: updated as unknown as object[] } });
            }
        }
    } finally {
        await prisma.$disconnect();
    }

    console.log(
        [
            '',
            `Candidates:       ${scanned}`,
            `${apply ? 'Thumbnailed:     ' : 'Would thumbnail: '} ${converted}`,
            `Already small:    ${alreadySmall}`,
            `${apply ? 'Covers dropped:  ' : 'Covers to drop:  '} ${coversDropped}`,
            `Failed:           ${failed}`,
            apply ? '' : '\nRe-run with --apply to write.',
        ].join('\n'),
    );
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
