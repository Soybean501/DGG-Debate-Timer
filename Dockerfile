FROM node:18-slim

# Install ffmpeg + streamlink from apt, and fetch latest yt-dlp binary
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg streamlink ca-certificates curl && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Use upstream static yt-dlp to avoid outdated Debian package issues
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
      -o /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp && \
    /usr/local/bin/yt-dlp --version

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["node", "src/index.js"]
