FROM node:22-bookworm AS build
WORKDIR /app
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# libheif-examples provides heif-convert, which turns iPhone HEIC uploads into JPEG — see
# HeicTranscodeService for why this rather than ffmpeg (bookworm's ffmpeg is 5.1; the HEIF demuxer
# landed in 7.1). It pulls in libheif1 and libde265-0, the HEVC decoder those photos actually need,
# for about 1.3MB all told.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg openssl libheif-examples && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
EXPOSE 3001
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main"]
