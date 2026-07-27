-- AlterTable
ALTER TABLE "Recording" ADD COLUMN     "gcsUploadedAt" TIMESTAMP(3),
ADD COLUMN     "thumbnailStatus" TEXT,
ADD COLUMN     "thumbnailUpdatedAt" TIMESTAMP(3);
