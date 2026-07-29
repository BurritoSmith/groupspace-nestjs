-- AlterTable
ALTER TABLE "ChatMessage" ADD COLUMN     "pictureUrl" TEXT;

-- Backfill existing rows from the sender's current User.pictureUrl — the best information
-- available for messages sent before this column existed. Going forward, saveMessage() snapshots
-- pictureUrl at send-time instead, same as displayName already does.
UPDATE "ChatMessage" cm
SET "pictureUrl" = u."pictureUrl"
FROM "User" u
WHERE u.id = cm."userId" AND cm."pictureUrl" IS NULL;
