const transcriptEl = document.getElementById('transcript');
const toggleBtn = document.getElementById('toggle-transcript');
const timeAEl = document.getElementById('time-a');
const timeBEl = document.getElementById('time-b');
const barAEl = document.getElementById('bar-a');
const barBEl = document.getElementById('bar-b');
const nameAInput = document.getElementById('name-a');
const nameBInput = document.getElementById('name-b');
const pctAEl = document.getElementById('pct-a');
const pctBEl = document.getElementById('pct-b');

const urlInput = document.getElementById('url-input');
const micSelect = document.getElementById('mic-select');
const startBtn = document.getElementById('start-btn');
const stopBtn = document.getElementById('stop-btn');

const statusEl = document.getElementById('status');
const platformEl = document.getElementById('platform');
const uptimeEl = document.getElementById('uptime');
const wordsEl = document.getElementById('words');
const ingestedEl = document.getElementById('ingested');

let statusState = { uptimeMs: 0 };
let uptimeTimer = null;

function labelSeconds(sec) {
  const s = Math.round(sec);
  const m = Math.floor(s/60);
  const r = s % 60;
  return m > 0 ? `${m}m ${r}s` : `${r}s`;
}

const speakerMap = new Map(); // speakerId -> label
const nextLabel = (() => { let idx = 0; const labels = ['A','B','C','D','E']; return () => labels[idx++] || `S${idx}`; })();
function labelFor(speaker) {
  if (!speakerMap.has(speaker)) speakerMap.set(speaker, nextLabel());
  return speakerMap.get(speaker);
}

function updateBars(durations) {
  const entries = Object.entries(durations || {});
  const sorted = entries.sort((a,b) => b[1]-a[1]);
  const topA = sorted[0]?.[0];
  const topB = sorted[1]?.[0];

  const a = topA ? durations[topA] : 0;
  const b = topB ? durations[topB] : 0;
  const sum = a + b;
  const pA = sum ? (a/sum)*100 : 50;
  const pB = sum ? (b/sum)*100 : 50;

  timeAEl.textContent = labelSeconds(a);
  timeBEl.textContent = labelSeconds(b);
  barAEl.style.width = `${pA}%`;
  barBEl.style.width = `${pB}%`;
  pctAEl.textContent = `(${pA.toFixed(0)}%)`;
  pctBEl.textContent = `(${pB.toFixed(0)}%)`;
}

function setStatus(status) {
  statusEl.textContent = status || '-';
}

function setPlatform(p) {
  platformEl.textContent = p || '-';
}

function setWords(n) { wordsEl.textContent = String(n ?? 0); }
function setIngested(sec) { ingestedEl.textContent = labelSeconds(sec || 0); }

function startUptime(ms) {
  if (uptimeTimer) clearInterval(uptimeTimer);
  function tick() {
    const s = Math.max(0, Math.round(((statusState.startEpoch ?? Date.now()) + statusState.uptimeMs - Date.now()) / 1000));
    // The above is weird; simply use uptimeMs snapshot + delta
  }
  const start = Date.now();
  uptimeTimer = setInterval(() => {
    const elapsed = (Date.now() - start) + (statusState.uptimeMs || 0);
    uptimeEl.textContent = labelSeconds(elapsed / 1000);
  }, 1000);
}

async function fetchJSON(url, opts) {
  const res = await fetch(url, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts&&opts.headers) } });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

startBtn.addEventListener('click', async () => {
  try {
    startBtn.disabled = true;
    const url = urlInput.value.trim();
    if (!url) throw new Error('Please paste a livestream or YouTube video URL');
    await fetchJSON('/start', { method: 'POST', body: JSON.stringify({ url, mic: false }) });
  } catch (e) {
    alert('Failed to start: ' + (e.message || e));
  } finally {
    startBtn.disabled = false;
  }
});

const startMicBtn = document.getElementById('start-mic-btn');
startMicBtn.addEventListener('click', async () => {
  try {
    startMicBtn.disabled = true;
    const device = micSelect.value || undefined;
    await fetchJSON('/start', { method: 'POST', body: JSON.stringify({ mic: true, device }) });
  } catch (e) {
    alert('Failed to start mic: ' + (e.message || e));
  } finally {
    startMicBtn.disabled = false;
  }
});

stopBtn.addEventListener('click', async () => {
  try {
    stopBtn.disabled = true;
    await fetchJSON('/stop', { method: 'POST' });
  } catch (e) {
    alert('Failed to stop: ' + (e.message || e));
  } finally {
    stopBtn.disabled = false;
  }
});

// Populate mic devices
(async () => {
  try {
    const { devices } = await fetchJSON('/devices');
    micSelect.innerHTML = '';
    for (const d of devices) {
      const opt = document.createElement('option');
      opt.value = d.id;
      opt.textContent = d.label;
      micSelect.appendChild(opt);
    }
  } catch {}
})();

const es = new EventSource('/events');
es.onmessage = (ev) => {
  try {
    const msg = JSON.parse(ev.data);
    if (!msg) return;

    if (msg.type === 'analytics') {
      statusState = { uptimeMs: msg.uptimeMs || 0 };
      setStatus(msg.status);
      setPlatform(msg.platform);
      setWords(msg.wordsCount);
      setIngested(msg.ingestedSeconds);
      updateBars(msg.speakerDurations);
      if (msg.status === 'streaming') startUptime(msg.uptimeMs);
      return;
    }

    if (!msg.text) return;
    const label = labelFor(msg.speaker);
    const name = label === 'A' ? (nameAInput.value || 'Speaker A') : (label === 'B' ? (nameBInput.value || 'Speaker B') : `Speaker ${label}`);
    const speakerLabel = `${name}`;
    const p = document.createElement('div');
    p.className = msg.type === 'partial' ? 'partial' : '';
    p.textContent = `[${new Date(msg.start*1000).toISOString().substring(11,19)}] [${speakerLabel}] ${msg.text}`;
    if (msg.type === 'partial') {
      const last = transcriptEl.lastElementChild;
      if (last && last.classList.contains('partial')) transcriptEl.removeChild(last);
      transcriptEl.appendChild(p);
    } else {
      // Final: replace last partial if present, otherwise append
      const last = transcriptEl.lastElementChild;
      if (last && last.classList.contains('partial')) transcriptEl.removeChild(last);
      transcriptEl.appendChild(p);
    }
    transcriptEl.scrollTop = transcriptEl.scrollHeight;

    updateBars(msg.speakerDurations);
  } catch {}
};

// Toggle transcript visibility
toggleBtn.addEventListener('click', () => {
  const hidden = transcriptEl.style.display === 'none';
  transcriptEl.style.display = hidden ? 'block' : 'none';
  toggleBtn.textContent = hidden ? 'Hide transcript' : 'Show transcript';
});
