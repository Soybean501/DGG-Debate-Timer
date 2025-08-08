FROM node:18-slim

# Install ffmpeg + yt-dlp + streamlink
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg python3-pip ca-certificates && \
    pip3 install --no-cache-dir yt-dlp streamlink && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["node", "src/index.js"]
