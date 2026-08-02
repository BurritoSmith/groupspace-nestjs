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
import sharp from 'sharp';
import { backfillThumbnailBox, needsImageThumbnail, thumbnailStoragePath } from '../src/room/chat-thumbnail-backfill';
import { IChatAttachment } from '../src/room/interfaces/room.interfaces';

/** Matches what ChatUploads sends for a client-generated thumbnail. */
const THUMBNAIL_QUALITY = 80;

const apply = process.argv.includes('--apply');

async function main(): Promise<void> {
    const bucketName = process.env.CHAT_MEDIA_GCS_BUCKET;
    if (!bucketName) {
        throw new Error('CHAT_MEDIA_GCS_BUCKET is not set — there is no bucket to read the images from or write the thumbnails to.');
    }
    // Mirrors ChatMediaService.publicBase exactly. A thumbnail URL that does not start with this is
    // dropped on the floor by sanitizeAttachment the next time the message is broadcast, silently
    // and with nothing logged — so it has to be built the same way, not approximated.
    const publicBase = `https://storage.googleapis.com/${bucketName}/`;

    const prisma = new PrismaClient();
    const bucket = new Storage().bucket(bucketName);

    let scanned = 0;
    let converted = 0;
    let alreadySmall = 0;
    let failed = 0;

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

            for (const attachment of attachments) {
                if (!needsImageThumbnail(attachment)) {
                    updated.push(attachment);
                    continue;
                }
                scanned += 1;

                try {
                    const source = await bucket.file(attachment.storagePath!).download();
                    const image = sharp(source[0]);
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

                    const objectPath = thumbnailStoragePath(attachment.storagePath!);
                    if (apply) {
                        const thumbnail = await image.resize(box.width, box.height).jpeg({ quality: THUMBNAIL_QUALITY }).toBuffer();
                        // Same metadata ChatMediaService.uploadAttachment writes, so a backfilled
                        // object is indistinguishable from an uploaded one to anything downstream.
                        await bucket.file(objectPath).save(thumbnail, {
                            contentType: 'image/jpeg',
                            resumable: false,
                            metadata: { cacheControl: 'public, max-age=31536000, immutable' },
                        });
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
                    console.warn(`  FAILED ${attachment.storagePath}: ${error instanceof Error ? error.message : String(error)}`);
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
            `Candidates:      ${scanned}`,
            `${apply ? 'Thumbnailed' : 'Would thumbnail'}: ${converted}`,
            `Already small:   ${alreadySmall}`,
            `Failed:          ${failed}`,
            apply ? '' : '\nRe-run with --apply to write.',
        ].join('\n'),
    );
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
