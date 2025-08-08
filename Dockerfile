FROM node:18-slim

# Install ffmpeg + streamlink from apt, Python runtime for plugins, and fetch latest yt-dlp binary
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg streamlink ca-certificates curl python3 python3-venv python3-distutils && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Use upstream static yt-dlp to avoid outdated Debian package issues
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
      -o /usr/local/bin/yt-dlp && \
    chmod +x /usr/local/bin/yt-dlp && \
    ln -sf /usr/local/bin/yt-dlp /usr/bin/yt-dlp && \
    /usr/local/bin/yt-dlp --version

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

ENV NODE_ENV=production
ENV PORT=3000
ENV PATH=/usr/local/bin:$PATH
EXPOSE 3000

CMD ["node", "src/index.js"]
