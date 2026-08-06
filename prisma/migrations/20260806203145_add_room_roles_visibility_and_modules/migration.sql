-- AlterTable
ALTER TABLE "Room" ADD COLUMN     "createdByUserId" TEXT,
ADD COLUMN     "passcodeHash" TEXT,
ADD COLUMN     "visibility" TEXT NOT NULL DEFAULT 'public';

-- AlterTable
ALTER TABLE "RoomMember" ADD COLUMN     "role" TEXT NOT NULL DEFAULT 'member';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "authKind" TEXT NOT NULL DEFAULT 'google',
ALTER COLUMN "googleSub" DROP NOT NULL,
ALTER COLUMN "email" DROP NOT NULL;

-- CreateTable
CREATE TABLE "RoomModule" (
    "id" TEXT NOT NULL,
    "roomName" TEXT NOT NULL,
    "moduleId" TEXT NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "enabledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RoomModule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoomMemberModuleRole" (
    "id" TEXT NOT NULL,
    "roomName" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "moduleId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RoomMemberModuleRole_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoomInvitation" (
    "id" TEXT NOT NULL,
    "roomName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "roomRole" TEXT NOT NULL DEFAULT 'member',
    "moduleRoles" JSONB NOT NULL DEFAULT '{}',
    "token" TEXT NOT NULL,
    "invitedByUserId" TEXT NOT NULL,
    "acceptedByUserId" TEXT,
    "acceptedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RoomInvitation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RoomModule_moduleId_idx" ON "RoomModule"("moduleId");

-- CreateIndex
CREATE UNIQUE INDEX "RoomModule_roomName_moduleId_key" ON "RoomModule"("roomName", "moduleId");

-- CreateIndex
CREATE INDEX "RoomMemberModuleRole_roomName_moduleId_idx" ON "RoomMemberModuleRole"("roomName", "moduleId");

-- CreateIndex
CREATE INDEX "RoomMemberModuleRole_userId_idx" ON "RoomMemberModuleRole"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "RoomMemberModuleRole_roomName_userId_moduleId_key" ON "RoomMemberModuleRole"("roomName", "userId", "moduleId");

-- CreateIndex
CREATE UNIQUE INDEX "RoomInvitation_token_key" ON "RoomInvitation"("token");

-- CreateIndex
CREATE INDEX "RoomInvitation_roomName_idx" ON "RoomInvitation"("roomName");

-- CreateIndex
CREATE INDEX "RoomInvitation_email_idx" ON "RoomInvitation"("email");

-- AddForeignKey
ALTER TABLE "Room" ADD CONSTRAINT "Room_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoomModule" ADD CONSTRAINT "RoomModule_roomName_fkey" FOREIGN KEY ("roomName") REFERENCES "Room"("name") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoomMemberModuleRole" ADD CONSTRAINT "RoomMemberModuleRole_roomName_fkey" FOREIGN KEY ("roomName") REFERENCES "Room"("name") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoomMemberModuleRole" ADD CONSTRAINT "RoomMemberModuleRole_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoomInvitation" ADD CONSTRAINT "RoomInvitation_roomName_fkey" FOREIGN KEY ("roomName") REFERENCES "Room"("name") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoomInvitation" ADD CONSTRAINT "RoomInvitation_invitedByUserId_fkey" FOREIGN KEY ("invitedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoomInvitation" ADD CONSTRAINT "RoomInvitation_acceptedByUserId_fkey" FOREIGN KEY ("acceptedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill 1 of 3: ownership.
--
-- Every room predating this migration was created implicitly, by whoever happened to join first —
-- RoomMembershipService.recordVisit's connectOrCreate, which was the only thing that ever made a
-- Room row. That first joiner is the closest thing to a creator these rooms have, and is very often
-- literally the person who invented the name and told everyone else it.
--
-- DISTINCT ON needs its leading ORDER BY columns to match, hence roomName first. The id tiebreak is
-- what makes this deterministic: firstJoinedAt defaults to CURRENT_TIMESTAMP, and the backfill that
-- created these rows in the first place inserted a whole room's members inside one statement, so
-- ties are not hypothetical here — they are the common case for any room seeded from chat history.
WITH earliest AS (
    SELECT DISTINCT ON ("roomName") "roomName", "userId"
    FROM "RoomMember"
    ORDER BY "roomName", "firstJoinedAt" ASC, "id" ASC
)
UPDATE "Room" r
SET "createdByUserId" = e."userId"
FROM earliest e
WHERE r."name" = e."roomName";

-- Backfill 2 of 3: that same person becomes the room's owner. Everyone else keeps the column
-- default of 'member'. Joined back through Room rather than repeating the DISTINCT ON, so the two
-- can never disagree about who the owner is.
UPDATE "RoomMember" m
SET "role" = 'owner'
FROM "Room" r
WHERE r."name" = m."roomName"
  AND r."createdByUserId" = m."userId";

-- Backfill 3 of 3: the modules every existing room implicitly already had.
--
-- Chat, live and playback were never optional — they were simply what a room was. Recording them as
-- enabled is what keeps existing rooms behaving identically once the UI starts asking the room which
-- modules it has, instead of assuming all of them. enabledAt is the room's own createdAt rather than
-- now(), because that is when these actually became available to it.
--
-- The IEP module is deliberately absent: no existing room opted into it, and enabling it would flip
-- the room private.
INSERT INTO "RoomModule" ("id", "roomName", "moduleId", "config", "enabledAt")
SELECT gen_random_uuid(), r."name", m."moduleId", '{}'::jsonb, r."createdAt"
FROM "Room" r
CROSS JOIN (VALUES ('chat'), ('live'), ('playback')) AS m("moduleId")
ON CONFLICT ("roomName", "moduleId") DO NOTHING;

-- Visibility needs no backfill: the column default is 'public', which is exactly what every one of
-- these rooms already was — anyone with the name could walk in.
