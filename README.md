# DGG Debate Timer

Live debate transcription and speaker timing overlay inspired by destiny.gg. Streams audio from a microphone or any YouTube/Twitch/Kick URL (including prerecorded videos) to Deepgram for diarized transcripts. A modern web UI shows who’s speaking with prominent timers and percentages; you can rename speakers, and optionally reveal the live transcript.

## Features
- Deepgram live transcription with diarization (speaker separation)
- Input sources
  - Microphone (choose device)
  - URL: YouTube, Twitch, Kick (works for livestreams and prerecorded videos)
- Web UI
  - Prominent speaking-time bars and per‑speaker timers
  - Editable speaker names ("Speaker A", "Speaker B", …)
  - Live analytics: status, platform, uptime, word count, audio seconds
  - Transcript panel (hidden by default) with partials and finals
- Robust process control: clean shutdown; ffmpeg logging suppressed

## Prerequisites
- Node.js 18+
- ffmpeg
- yt-dlp (recommended) and/or streamlink (fallback)
- Deepgram API key

macOS (Homebrew):
```bash
brew install ffmpeg yt-dlp streamlink
```
Windows (Chocolatey):
```powershell
choco install ffmpeg yt-dlp streamlink
```
Ubuntu/Debian:
```bash
sudo apt-get update && sudo apt-get install -y ffmpeg
pipx install yt-dlp  # or pipx/pip install --user yt-dlp
sudo apt-get install -y streamlink  # optional fallback
```

## Setup
1. Clone the repo
```bash
git clone https://github.com/Soybean501/DGG-Debate-Timer.git
cd DGG-Debate-Timer
```
2. Install dependencies
```bash
npm install
```
3. Configure Deepgram
Create a `.env` in the project root:
```bash
DEEPGRAM_API_KEY=your_deepgram_key_here
PORT=3000  # optional, defaults to 3000
```

## Running locally
```bash
npm start
```
Then open http://localhost:3000

In the UI you can:
- Start from URL: paste a YouTube/Twitch/Kick URL (works for prerecorded videos and livestreams)
- Start mic: choose a microphone device and start
- Stop: end the current session
- Edit names: change "Speaker A/B" inline; percentages and timers update live
- Show/Hide transcript: toggle the transcript panel to save screen space

Notes:
- macOS default mic is `:0`. The device list is auto-populated.
- If yt-dlp is missing, the app tries `streamlink` as a fallback for URLs.

## CLI usage (optional)
You can still run via the CLI:
```bash
# From microphone (default device)
npm start -- --mic

# From microphone (specific device on macOS)
npm start -- --mic --device :0

# From a URL (YouTube/Twitch/Kick; livestream or prerecorded)
npm start -- https://www.youtube.com/watch?v=...
```

## Deployment
Any Node hosting works (Render, Railway, Fly.io, Heroku, a VPS):
- Ensure Node 18+
- Install `ffmpeg` and `yt-dlp` (and optionally `streamlink`) on the host image
- Set `DEEPGRAM_API_KEY` and (optionally) `PORT`
- Run `npm ci && npm start`

Example with pm2 on a VPS:
```bash
npm ci
pm2 start src/index.js --name dgg-debate-timer --time
pm2 save
```
Make sure the firewall/reverse-proxy exposes the configured `PORT`.

## Troubleshooting
- "Failed to resolve a direct media URL"
  - Install `yt-dlp`; optionally install `streamlink`
  - Ensure the URL is accessible and not DRM-protected
- No mic devices listed
  - macOS: grant microphone permission to your terminal/Node
  - Linux: ensure PulseAudio is available (or install/restart it)
- Stop doesn’t end the stream
  - The app escalates termination signals to ffmpeg; if it still persists, ensure no system audio capture dialogs are blocking

## Security
- `.env` is ignored by git. Do not commit your API keys.
- Consider using a scoped Deepgram key with limited permissions.

## License
MIT