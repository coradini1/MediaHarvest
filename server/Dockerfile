FROM node:20-bookworm-slim

# nightly = mesmo canal da atualizacao automatica (YTDLP_CHANNEL no compose)
ARG YTDLP_CHANNEL=nightly

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip curl ca-certificates aria2 \
  && python3 -m pip install --break-system-packages --no-cache-dir $( [ "$YTDLP_CHANNEL" = "stable" ] || echo --pre ) "yt-dlp[default,curl-cffi]" \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY backend ./backend

ENV PORT=3000
ENV DOWNLOAD_DIR=/downloads

RUN mkdir -p /downloads

EXPOSE 3000

CMD ["npm", "start"]
