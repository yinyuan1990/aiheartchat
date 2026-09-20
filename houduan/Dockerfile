FROM node:20-slim AS build
RUN sed -i 's/deb.debian.org/mirrors.aliyun.com/g' /etc/apt/sources.list.d/debian.sources \
    && apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# Prisma 引擎从 npmmirror 下载（直连 binaries.prisma.sh 在国内/HK 机房经常卡死不超时）
ENV PRISMA_ENGINES_MIRROR=https://registry.npmmirror.com/-/binary/prisma
COPY package*.json ./
RUN npm ci --registry=https://registry.npmmirror.com
COPY prisma ./prisma
RUN npx prisma generate
COPY tsconfig.json nest-cli.json ./
COPY src ./src
RUN npm run build

FROM node:20-slim
# ffmpeg：表情包里的视频贴纸（WebM VP9+alpha）转成动态 WebP（sticker.service）
RUN sed -i 's/deb.debian.org/mirrors.aliyun.com/g' /etc/apt/sources.list.d/debian.sources \
    && apt-get update && apt-get install -y --no-install-recommends openssl ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
ENV PRISMA_ENGINES_MIRROR=https://registry.npmmirror.com/-/binary/prisma
COPY package*.json ./
RUN npm ci --omit=dev --registry=https://registry.npmmirror.com
COPY prisma ./prisma
RUN npx prisma generate
COPY --from=build /app/dist ./dist
EXPOSE 20800
CMD ["sh", "-c", "npx prisma db push --skip-generate --accept-data-loss && node dist/prisma/seed.js && node dist/src/main.js"]
