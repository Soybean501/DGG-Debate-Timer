#!/usr/bin/env node
'use strict';

require('dotenv').config();
const { spawn } = require('child_process');
const readline = require('readline');
const os = require('os');
const express = require('express');
const path = require('path');
const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');

function exitWith(message, code = 1) {
  console.error(message);
  process.exit(code);
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    exitWith(`Missing environment variable ${name}. Set it in your shell or create a .env with ${name}=...`);
  }
  return value;
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));

    child.on('error', (err) => reject(err));

    child.on('close', (code) => {
      if (code === 0 || options.allowNonZeroExit) {
        resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code });
      } else {
        reject(new Error(`${command} exited with code ${code}: ${stderr || stdout}`));
      }
    });
  });
}

async function resolveMediaUrl(pageUrl) {
  // Try yt-dlp (covers YouTube, Twitch, Kick for many cases)
  try {
    const { stdout } = await runCommand('yt-dlp', ['-g', '-f', 'bestaudio', pageUrl]);
    const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length > 0) {
      return lines[0];
    }
  } catch (err) {
    // fall through
  }
  // Fallback: streamlink (widely supports live platforms)
  try {
    const { stdout } = await runCommand('streamlink', ['--stream-url', pageUrl, 'best']);
    const url = stdout.trim();
    if (url) return url;
  } catch (err) {
    // fall through
  }

  throw new Error('Failed to resolve a direct media URL. Ensure yt-dlp or streamlink is installed and the URL is a valid livestream.');
}

function startFfmpegPcmStream(mediaUrl) {
  const ffArgs = [
    '-hide_banner',
    '-loglevel', 'error',
    '-i', mediaUrl,
    '-vn',
    '-ac', '1',
    '-ar', '16000',
    '-f', 's16le',
    '-acodec', 'pcm_s16le',
    'pipe:1',
  ];
  const ff = spawn('ffmpeg', ffArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
  return ff;
}

function startFfmpegMicStream(deviceArg) {
  const platform = process.platform;
  let ffArgs;

  if (platform === 'darwin') {
    // macOS: avfoundation input. Device format ":<audio_index>". Default to :0
    const input = deviceArg ? deviceArg : ':0';
    ffArgs = [
      '-hide_banner',
      '-loglevel', 'error',
      '-f', 'avfoundation',
      '-i', input,
      '-ac', '1',
      '-ar', '16000',
      '-f', 's16le',
      '-acodec', 'pcm_s16le',
      'pipe:1',
    ];
  } else if (platform === 'win32') {
    // Windows: dshow input. Device format "audio=<DEVICE_NAME>"
    const input = deviceArg ? `audio=${deviceArg}` : 'audio=default';
    ffArgs = [
      '-hide_banner',
      '-loglevel', 'error',
      '-f', 'dshow',
      '-i', input,
      '-ac', '1',
      '-ar', '16000',
      '-f', 's16le',
      '-acodec', 'pcm_s16le',
      'pipe:1',
    ];
  } else {
    // Linux: prefer PulseAudio if available; fallback to ALSA default
    const input = deviceArg || 'default';
    ffArgs = [
      '-hide_banner',
      '-loglevel', 'error',
      '-f', 'pulse',
      '-i', input,
      '-ac', '1',
      '-ar', '16000',
      '-f', 's16le',
      '-acodec', 'pcm_s16le',
      'pipe:1',
    ];
  }

  const ff = spawn('ffmpeg', ffArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
  return ff;
}

async function listMicDevices() {
  const platform = process.platform;
  try {
    if (platform === 'darwin') {
      // avfoundation lists devices via this special input
      const { stderr } = await runCommand('ffmpeg', ['-f', 'avfoundation', '-list_devices', 'true', '-i', '""'], { allowNonZeroExit: true });
      console.log('Available avfoundation devices (use the audio index as ":<index>"):\n');
      console.log(stderr);
      return;
    }
    if (platform === 'win32') {
      const { stderr } = await runCommand('ffmpeg', ['-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], { allowNonZeroExit: true });
      console.log('Available dshow devices (use device name after "audio="):\n');
      console.log(stderr);
      return;
    }
    // Linux: try PulseAudio sources
    try {
      const { stdout } = await runCommand('pactl', ['list', 'short', 'sources']);
      if (stdout.trim()) {
        console.log('PulseAudio sources (use with --device <name>):\n');
        console.log(stdout);
        return;
      }
    } catch (_) { /* ignore */ }
    // Fallback to ffmpeg listing via ALSA
    const { stderr } = await runCommand('ffmpeg', ['-f', 'alsa', '-list_devices', 'true', '-i', 'dummy'], { allowNonZeroExit: true });
    console.log('Available ALSA devices (use with --device hw:*,* or name):\n');
    console.log(stderr);
  } catch (err) {
    console.error('Failed to list devices:', err.message);
  }
}

// Return normalized list of microphone input choices for the UI
async function getMicDevices() {
  const platform = process.platform;
  try {
    if (platform === 'darwin') {
      const { stderr } = await runCommand('ffmpeg', ['-f', 'avfoundation', '-list_devices', 'true', '-i', '""'], { allowNonZeroExit: true });
      const lines = stderr.split(/\r?\n/);
      const devices = [];
      let inAudio = false;
      for (const line of lines) {
        if (line.includes('AVFoundation audio devices')) { inAudio = true; continue; }
        if (line.includes('AVFoundation video devices')) { inAudio = false; continue; }
        if (!inAudio) continue;
        const m = line.match(/\[(\d+)\]\s+(.+)/);
        if (m) {
          devices.push({ id: `:${m[1]}`, label: m[2].trim() });
        }
      }
      if (devices.length === 0) devices.push({ id: ':0', label: 'Default (:0)' });
      return devices;
    }
    if (platform === 'win32') {
      const { stderr } = await runCommand('ffmpeg', ['-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], { allowNonZeroExit: true });
      const lines = stderr.split(/\r?\n/);
      const devices = [];
      let inAudio = false;
      for (const line of lines) {
        if (/DirectShow audio devices/.test(line)) { inAudio = true; continue; }
        if (/DirectShow video devices/.test(line)) { inAudio = false; continue; }
        if (!inAudio) continue;
        const m = line.match(/"([^"]+)"/);
        if (m) devices.push({ id: m[1], label: m[1] });
      }
      if (devices.length === 0) devices.push({ id: 'default', label: 'Default' });
      return devices;
    }
    // Linux
    try {
      const { stdout } = await runCommand('pactl', ['list', 'short', 'sources']);
      const devices = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
        const parts = l.split(/\t/);
        const name = parts[1];
        const desc = parts[1];
        return { id: name, label: desc };
      });
      if (devices.length === 0) devices.push({ id: 'default', label: 'Default' });
      return devices;
    } catch (_) {
      // ALSA fallback unknown — return default
      return [{ id: 'default', label: 'Default' }];
    }
  } catch (err) {
    return [{ id: process.platform === 'win32' ? 'default' : (process.platform === 'darwin' ? ':0' : 'default'), label: 'Default' }];
  }
}

function parseArgs(argv) {
  const args = { flags: new Set(), values: {}, positionals: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--mic') {
      args.flags.add('mic');
    } else if (token === '--list-devices') {
      args.flags.add('listDevices');
    } else if (token === '--device') {
      args.values.device = argv[i + 1];
      i += 1;
    } else if (token === '--help' || token === '-h') {
      args.flags.add('help');
    } else if (token.startsWith('--device=')) {
      args.values.device = token.slice('--device='.length);
    } else {
      args.positionals.push(token);
    }
  }
  return args;
}

function printUsage() {
  console.log('Usage:');
  console.log('  Transcribe a livestream URL:');
  console.log('    npm start -- <kick|youtube|twitch URL>');
  console.log('');
  console.log('  Transcribe from system microphone:');
  console.log('    npm start -- --mic [--device <device>]');
  console.log('');
  console.log('  List available input devices:');
  console.log('    npm start -- --list-devices');
  console.log('');
  console.log('Notes:');
  console.log('  - macOS: use avfoundation index like ":0" for default mic');
  console.log('  - Windows: pass device name as shown by --list-devices (without quotes), e.g. "Microphone (Realtek...)"');
  console.log('  - Linux: default PulseAudio source is "default"; pass pactl source name for others');
}

function formatTimestamp(seconds) {
  const date = new Date(seconds * 1000);
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mm = String(date.getUTCMinutes()).padStart(2, '0');
  const ss = String(date.getUTCSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function detectPlatformFromUrl(url) {
  try {
    const { hostname } = new URL(url);
    if (/youtube\.com$|youtu\.be$/.test(hostname)) return 'YouTube';
    if (/twitch\.tv$/.test(hostname)) return 'Twitch';
    if (/kick\.com$/.test(hostname)) return 'Kick';
    return hostname;
  } catch (_) {
    return 'unknown';
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);

  if (args.flags.has('help')) {
    printUsage();
    process.exit(0);
  }

  if (args.flags.has('listDevices')) {
    await listMicDevices();
    process.exit(0);
  }

  const apiKey = requireEnv('DEEPGRAM_API_KEY');
  const deepgram = createClient(apiKey);

  // Minimal Express server and SSE for frontend
  const app = express();
  const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
  const sseClients = new Set();
  app.use(express.json());

  app.get('/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    sseClients.add(res);
    // Send initial analytics snapshot to the new client
    try {
      const initial = JSON.stringify(analyticsSnapshot());
      res.write(`data: ${initial}\n\n`);
    } catch {}
    req.on('close', () => sseClients.delete(res));
  });

  app.use(express.static(path.join(__dirname, 'public')));
  app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

  const server = app.listen(PORT, () => {
    console.log(`Web UI: http://localhost:${PORT}`);
  });

  // Streaming state & helpers
  let current = {
    connection: null,
    ff: null,
    opened: false,
    closed: false,
    mode: null, // 'mic' | 'url'
    url: null,
    device: null,
    platform: null,
    speakerDurations: new Map(),
    lastPartialSpeaker: null,
    lastPartialStart: null,
    startTimeMs: null,
    bytesSent: 0,
    wordsCount: 0,
  };

  function broadcast(obj) {
    const payload = JSON.stringify(obj);
    for (const client of sseClients) client.write(`data: ${payload}\n\n`);
  }

  function analyticsSnapshot() {
    const durations = Object.fromEntries(current.speakerDurations);
    const uptimeMs = current.startTimeMs ? Date.now() - current.startTimeMs : 0;
    const ingestedSeconds = current.bytesSent / 32000; // 16kHz * 2 bytes
    return {
      type: 'analytics',
      mode: current.mode,
      platform: current.platform,
      url: current.url,
      status: current.connection ? (current.opened ? 'streaming' : 'connecting') : 'idle',
      wordsCount: current.wordsCount,
      speakerDurations: durations,
      uptimeMs,
      ingestedSeconds,
      speakers: Object.keys(durations).map((id) => ({ id, seconds: durations[id] })),
    };
  }

  async function stopStreaming() {
    if (current.closed) return;
    current.closed = true;
    try { current.connection && current.connection.finish(); } catch {}
    // Try graceful, then escalate
    if (current.ff) {
      try { current.ff.kill('SIGINT'); } catch {}
      setTimeout(() => {
        if (current.ff && !current.ff.killed) {
          try { current.ff.kill('SIGTERM'); } catch {}
        }
      }, 500);
      setTimeout(() => {
        if (current.ff && !current.ff.killed) {
          try { current.ff.kill('SIGKILL'); } catch {}
        }
      }, 1500);
    }
    current.connection = null;
    current.ff = null;
    broadcast(analyticsSnapshot());
  }

  async function startStreaming({ mic, url, device }) {
    if (current.connection) await stopStreaming();
    current = {
      connection: null,
      ff: null,
      opened: false,
      closed: false,
      mode: mic ? 'mic' : 'url',
      url: url || null,
      device: device || null,
      platform: url ? detectPlatformFromUrl(url) : (mic ? os.platform() : null),
      speakerDurations: new Map(),
      lastPartialSpeaker: null,
      lastPartialStart: null,
      startTimeMs: null,
      bytesSent: 0,
      wordsCount: 0,
    };

    let mediaUrl = null;
    if (!mic && url) {
      console.log('Resolving stream URL...');
      mediaUrl = await resolveMediaUrl(url);
      console.log('Resolved media URL');
    }

    console.log('Connecting to Deepgram Live...');
    const connection = deepgram.listen.live({
      model: 'nova-2',
      language: 'en',
      punctuate: true,
      interim_results: true,
      smart_format: true,
      diarize: true,
      encoding: 'linear16',
      sample_rate: 16000,
    });
    current.connection = connection;
    broadcast(analyticsSnapshot());

    connection.on(LiveTranscriptionEvents.Open, () => {
      current.opened = true;
      current.startTimeMs = Date.now();
      console.log('Deepgram connection opened. Starting ffmpeg...');
      const ff = mic ? startFfmpegMicStream(device) : startFfmpegPcmStream(mediaUrl);
      current.ff = ff;

      ff.stdout.on('data', (chunk) => {
        current.bytesSent += chunk.length;
        try {
          connection.send(chunk);
        } catch (err) {
          console.error('Error sending audio to Deepgram:', err.message);
        }
      });

      if (ff.stderr) {
        ff.stderr.on('data', () => {});
      }

      ff.on('close', (code) => {
        console.log(`ffmpeg exited with code ${code}. Ending Deepgram stream...`);
        try { connection.finish(); } catch {}
      });

      broadcast(analyticsSnapshot());
    });

    connection.on(LiveTranscriptionEvents.Transcript, (data) => {
      try {
        const alt = data?.channel?.alternatives?.[0];
        const text = alt?.transcript || '';
        if (!text) return;
        const words = alt?.words || [];
        if (!Array.isArray(words) || words.length === 0) return;
        current.wordsCount += (text.match(/\S+/g) || []).length;
        const segmentSpeaker = words[0]?.speaker ?? 'unknown';

        if (data.is_final) {
          const start = words[0]?.start || 0;
          const end = words[words.length - 1]?.end || start;
          const duration = Math.max(0, end - start);
          const prev = current.speakerDurations.get(segmentSpeaker) || 0;
          current.speakerDurations.set(segmentSpeaker, prev + duration);

          // Send final and instruct UI to replace partial
          broadcast({ type: 'final', replace: true, speaker: segmentSpeaker, text, start, end, speakerDurations: Object.fromEntries(current.speakerDurations) });
          broadcast(analyticsSnapshot());

          console.log(`[${formatTimestamp(start)}] [Speaker ${segmentSpeaker}] ${text}`);
          current.lastPartialSpeaker = null;
          current.lastPartialStart = null;
        } else {
          readline.clearLine(process.stdout, 0);
          readline.cursorTo(process.stdout, 0);
          process.stdout.write(`[Speaker ${segmentSpeaker}] ${text}`);

          if (current.lastPartialSpeaker !== segmentSpeaker) {
            current.lastPartialSpeaker = segmentSpeaker;
            current.lastPartialStart = words[0]?.start ?? null;
          }
          const estStart = current.lastPartialStart ?? words[0]?.start ?? 0;
          const estEnd = words[words.length - 1]?.end ?? estStart;
          broadcast({ type: 'partial', speaker: segmentSpeaker, text, start: estStart, end: estEnd, speakerDurations: Object.fromEntries(current.speakerDurations) });
        }
      } catch (err) {
        // ignore formatting issues
      }
    });

    connection.on(LiveTranscriptionEvents.Error, (err) => {
      console.error('Deepgram error:', err);
    });

    connection.on(LiveTranscriptionEvents.Close, () => {
      if (current.closed) return;
      current.closed = true;
      console.log('\nDeepgram connection closed.');
      try { current.ff && current.ff.kill('SIGINT'); } catch {}
      current.connection = null;
      current.ff = null;
      broadcast(analyticsSnapshot());
    });

    // fail-fast timeout
    setTimeout(() => {
      if (!current.opened && current.connection) {
        console.error('Timed out waiting for Deepgram connection.');
        try { current.connection.finish(); } catch {}
      }
    }, 15000);
  }

  // REST control endpoints
  app.get('/status', (_req, res) => {
    res.json(analyticsSnapshot());
  });

  app.post('/start', async (req, res) => {
    try {
      const { url, mic, device } = req.body || {};
      if (!mic && !url) return res.status(400).json({ error: 'Provide url or mic=true' });
      await startStreaming({ mic: !!mic, url, device });
      res.json({ ok: true, platform: current.platform });
    } catch (e) {
      console.error(e?.message || e);
      res.status(500).json({ error: e?.message || 'failed to start' });
    }
  });

  app.post('/stop', async (_req, res) => {
    await stopStreaming();
    res.json({ ok: true });
  });

  app.get('/devices', async (_req, res) => {
    try {
      const devices = await getMicDevices();
      res.json({ devices });
    } catch {
      res.json({ devices: [] });
    }
  });

  // CLI auto-start remains supported
  if (args.flags.has('mic') || args.positionals[0]) {
    const url = args.flags.has('mic') ? null : args.positionals[0];
    const device = args.values.device;
    await startStreaming({ mic: args.flags.has('mic'), url, device });
  }

  // Graceful shutdown on Ctrl-C / termination
  const handleSignal = () => {
    console.log('\nShutting down...');
    stopStreaming().finally(() => {
      try { server && server.close(); } catch {}
      setTimeout(() => process.exit(0), 300);
    });
  };

  process.on('SIGINT', handleSignal);
  process.on('SIGTERM', handleSignal);
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
