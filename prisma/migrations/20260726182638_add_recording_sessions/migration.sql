/*
  Warnings:

  - Added the required column `sessionId` to the `Recording` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Recording" ADD COLUMN     "sessionId" TEXT NOT NULL;

-- CreateTable
CREATE TABLE "RecordingSession" (
    "id" TEXT NOT NULL,
    "roomName" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stoppedAt" TIMESTAMP(3),

    CONSTRAINT "RecordingSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RecordingSession_roomName_startedAt_idx" ON "RecordingSession"("roomName", "startedAt");

-- CreateIndex
CREATE INDEX "Recording_sessionId_idx" ON "Recording"("sessionId");

-- AddForeignKey
ALTER TABLE "RecordingSession" ADD CONSTRAINT "RecordingSession_roomName_fkey" FOREIGN KEY ("roomName") REFERENCES "Room"("name") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Recording" ADD CONSTRAINT "Recording_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "RecordingSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
