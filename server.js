'use strict';

const express = require('express');
const path = require('node:path');
const fs = require('node:fs');
const cenc = require('./cenc');

const app = express();
// Load .env if present (Node 20.6+ native loader — no dependency needed).
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch {}
const port = Number.parseInt(process.env.PORT || '3000', 10);
const publicDirectory = path.join(__dirname, 'public');

const streams = [
  { id: 'all', name: 'PBB Extra' },
  { id: 'ext', name: 'External Den' },
  { id: 'din', name: 'Dining Area' },
  { id: 'main', name: 'PBB Collab 3.0 Live' }
];
const activeViewers = new Map();
const viewerTimeoutMs = 30_000;
const chatMessages = [];
const chatClients = new Set();
const chatHistoryLimit = 100;
let nextChatMessageId = Date.now();

app.disable('x-powered-by');
app.use((request, response, next) => {
  response.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'X-Download-Options': 'noopen'
  });
  next();
});
app.set('trust proxy', 1);
app.use('/vendor/shaka-player', express.static(path.join(__dirname, 'node_modules', 'shaka-player', 'dist')));
app.use(express.static(publicDirectory));

// Access key for media endpoints. When PUBLIC_SITE_KEY is set, manifest
// and segment routes require ?k=<key>. The key ships in the frontend
// bundle — this deters casual scraping/leeching, it is not real auth.
const SITE_KEY = process.env.PUBLIC_SITE_KEY || 'pk7f3a9c2e81b4d6f0a5c8e2b1d4f7a9c3e6';
const rateBuckets = new Map();
const RATE_LIMIT = Number.parseInt(process.env.MEDIA_RATE_LIMIT || '600', 10);
// Decrypted-segment proxy burns server CPU — cap it tighter than media.
const SEGMENT_RATE_LIMIT = Number.parseInt(process.env.SEGMENT_RATE_LIMIT || '120', 10);
function rateLimited(ip, limit = RATE_LIMIT) {
  const now = Date.now();
  let arr = rateBuckets.get(ip);
  if (!arr) { arr = []; rateBuckets.set(ip, arr); }
  while (arr.length && now - arr[0] > 60000) arr.shift();
  if (arr.length >= limit) return true;
  arr.push(now);
  if (rateBuckets.size > 20000) rateBuckets.clear();
  return false;
}
function clientIp(request) {
  const cf = request.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf) return cf;
  return request.ip || request.socket.remoteAddress || '';
}
app.use((request, response, next) => {
  // Express routing is case-insensitive but startsWith is not — normalize
  // or /MANIFEST/... style paths would bypass the gate entirely.
  const p = request.path.toLowerCase();
  const guarded = p.startsWith('/manifest/') || p.startsWith('/stream/') ||
    p.startsWith('/px/') || p === '/api/segment';
  if (!guarded) return next();
  if (SITE_KEY && request.query.k !== SITE_KEY) {
    return response.status(403).json({ error: 'forbidden' });
  }
  const ip = clientIp(request);
  if (rateLimited(ip, p === '/api/segment' ? SEGMENT_RATE_LIMIT : RATE_LIMIT)) {
    return response.status(429).json({ error: 'rate limited' });
  }
  next();
});

app.post('/api/viewers/heartbeat', express.json({ limit: '1kb' }), (request, response) => {
  const viewerId = request.body && request.body.id;
  if (typeof viewerId !== 'string' || !/^[a-z0-9-]{16,64}$/i.test(viewerId)) {
    return response.status(400).json({ error: 'A valid viewer ID is required.' });
  }

  const now = Date.now();
  for (const [id, lastSeen] of activeViewers) {
    if (now - lastSeen >= viewerTimeoutMs) {
      activeViewers.delete(id);
    }
  }

  activeViewers.set(viewerId, now);
  response.set('Cache-Control', 'no-store');
  return response.json({ count: activeViewers.size });
});

app.get('/api/chat/messages', (_request, response) => {
  response.set('Cache-Control', 'no-store');
  return response.json({ messages: chatMessages.slice(-50) });
});

app.get('/api/chat/stream', (_request, response) => {
  if (chatClients.size >= 500) {
    return response.status(503).json({ error: 'chat capacity reached' });
  }
  response.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  response.flushHeaders();
  chatClients.add(response);
  response.write(`event: history\ndata: ${JSON.stringify(chatMessages.slice(-50))}\n\n`);

  const keepAlive = setInterval(() => {
    if (!response.destroyed && !response.writableEnded) {
      response.write(': keep-alive\n\n');
    }
  }, 15_000);

  response.on('close', () => {
    clearInterval(keepAlive);
    chatClients.delete(response);
  });
});

function broadcastChatMessage(message) {
  const event = `event: message\ndata: ${JSON.stringify(message)}\n\n`;
  for (const client of chatClients) {
    if (client.destroyed || client.writableEnded) {
      chatClients.delete(client);
    } else {
      client.write(event);
    }
  }
}

const chatPostBuckets = new Map();
function chatPostLimited(ip) {
  const now = Date.now();
  const arr = chatPostBuckets.get(ip) || [];
  while (arr.length && now - arr[0] > 60000) arr.shift();
  if (arr.length >= 10) return true;
  arr.push(now);
  chatPostBuckets.set(ip, arr);
  if (chatPostBuckets.size > 5000) chatPostBuckets.clear();
  return false;
}

app.post('/api/chat/messages', express.json({ limit: '2kb' }), (request, response) => {
  if (chatPostLimited(clientIp(request))) {
    return response.status(429).json({ error: 'rate limited' });
  }
  const name = typeof request.body?.name === 'string' ? request.body.name.trim() : '';
  const text = typeof request.body?.text === 'string' ? request.body.text.trim() : '';
  if (!name || name.length > 24 || !text || text.length > 280) {
    return response.status(400).json({ error: 'Enter a name (up to 24 characters) and a message (up to 280 characters).' });
  }

  const message = {
    id: ++nextChatMessageId,
    name,
    text,
    createdAt: new Date().toISOString()
  };
  chatMessages.push(message);
  if (chatMessages.length > chatHistoryLimit) {
    chatMessages.shift();
  }
  broadcastChatMessage(message);

  response.set('Cache-Control', 'no-store');
  return response.status(201).json({ message });
});

app.get('/api/streams', (_request, response) => {
  response.json(streams);
});

/* ========================================================
   CENC DECRYPTION PROXY (iOS / unencrypted segment serving)
   ======================================================== */
const UPSTREAM_ORIGIN = 'https://pbb-live.pages.dev';
const proxyStreams = {
  all: {
    // PBB Extra — TRUE ORIGIN: Akamai live packager, no token required,
    // CORS-open (ACAO:*). xyz is only an emergency fallback.
    segBase: 'https://abslive.akamaized.net/dash/live/2099522/pbbcollaballaccesslivestream/',
    key: '39876c3c4f32a11dee56078febbb67dd',
    keyAudio: '39876c3c4f32a11dee56078febbb67dd'
  },
  ext: {
    segBase: 'https://pbbcollab.xyz/api/seg/dash/live/2099522/pbbcollaballaccesslivestream-externalden/',
    key: 'f5e17f169ff05ea40c5d3f065f523942'
  },
  din: {
    segBase: 'https://pbbcollab.xyz/api/seg/dash/live/2099522/pbbcollaballaccesslivestream-diningarea/',
    key: 'f5e17f169ff05ea40c5d3f065f523942'
  },
  main: {
    segBase: 'https://pbbcollab.xyz/api/seg/dash/live/2099522/pinoybigbrothercollabedition30live/',
    key: 'f5e17f169ff05ea40c5d3f065f523942'
  }
};

const decryptedCache = new Map();
const CACHE_LIMIT = 800;
const CENC_OPTS = { ivMode: 'high', counterMode: 'continuous', coverRemainder: true, stripCryptoMeta: true };

// Per-feed timing info learned from manifests/init segments: the live DASH
// Period can start far after availabilityStartTime, and segment tfdt values
// are period-relative, so they must be rebased onto the MPD timeline.
const feedTiming = {};

function parsePeriodStartSec(periodTag) {
  const m = periodTag.match(/\bstart="PT([^"]*)"/);
  if (!m) return 0;
  const d = m[1].match(/(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?/);
  if (!d) return 0;
  return (+d[1] || 0) * 3600 + (+d[2] || 0) * 60 + (+d[3] || 0);
}

function cacheGet(ch, file) {
  return decryptedCache.get(`${ch}:${file}`);
}

function cacheSet(ch, file, buf) {
  const key = `${ch}:${file}`;
  decryptedCache.delete(key);
  decryptedCache.set(key, buf);
  if (decryptedCache.size > CACHE_LIMIT) {
    decryptedCache.delete(decryptedCache.keys().next().value);
  }
}

// Segment auth token (~24h validity, covers all feeds). Refreshed
// externally via POST /admin/token; hdntl-token.json persists it.
// The hardcoded value below is only a bootstrap fallback.
const HDNTL_BOOTSTRAP = 'hdntl=exp=1795262844~acl=%2f*~id=c819df7d-a208-44a3-bbbc-032f66f6c30b~data=hdntl~hmac=463d976f997a0e2e4e7902fed5d43e42a098f337ec42b3c1f604c12c4e86add0';
const HDNTL_FILE = path.join(__dirname, 'hdntl-token.json');
let hdntlParam = HDNTL_BOOTSTRAP;
try {
  const saved = JSON.parse(fs.readFileSync(HDNTL_FILE, 'utf8'));
  if (typeof saved.hdntl === 'string' && saved.hdntl.startsWith('hdntl=')) {
    hdntlParam = saved.hdntl;
  }
} catch {}

function withHdntl(u) {
  if (!(u.includes('absp-live.akamaized.net') || u.includes('abslive.akamaized.net')) || u.includes('hdntl=')) return u;
  return u + (u.includes('?') ? '&' : '?') + hdntlParam;
}

function adminKeyOk(request) {
  const key = process.env.PBB_ADMIN_KEY || '';
  return Boolean(key) && request.query.key === key;
}

// Token update endpoint — called by the external refresher job.
// Protected by PBB_ADMIN_KEY env var; disabled entirely if unset.
app.post('/admin/token', express.text({ limit: '8kb' }), (request, response) => {
  if (!adminKeyOk(request)) {
    return response.status(403).json({ error: 'forbidden' });
  }
  let body = String(request.body || '').trim();
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed.hdntl === 'string') body = parsed.hdntl.trim();
  } catch {}
  if (!body.startsWith('hdntl=')) {
    return response.status(400).json({ error: 'expected hdntl=...' });
  }
  hdntlParam = body;
  try {
    fs.writeFileSync(HDNTL_FILE, JSON.stringify({ hdntl: body, updatedAt: Date.now() }));
  } catch (err) {
    console.error('[admin] failed to persist token:', err.message);
  }
  console.log('[admin] hdntl token updated');
  return response.json({ ok: true });
});

// Manifest source switch. 'remote' (default): upstream live manifest
// endpoint first, own anchored/probing chain as fallback. 'own': never
// contact the remote endpoint — bundled snapshot + edge probing only.
// Persisted across restarts; MANIFEST_MODE env sets the initial value.
const MANIFEST_MODE_FILE = path.join(__dirname, 'manifest-mode.json');
let manifestMode = process.env.MANIFEST_MODE === 'own' ? 'own' : 'remote';
try {
  const saved = JSON.parse(fs.readFileSync(MANIFEST_MODE_FILE, 'utf8'));
  if (saved.mode === 'own' || saved.mode === 'remote') manifestMode = saved.mode;
} catch {}

const mpdSourceMap = new Map(); // `${ch}:${srv}` -> 'remote' | 'own'

app.get('/admin/manifest-mode', (request, response) => {
  if (!adminKeyOk(request)) {
    return response.status(403).json({ error: 'forbidden' });
  }
  return response.json({ mode: manifestMode });
});

app.post('/admin/manifest-mode', express.json({ limit: '4kb' }), (request, response) => {
  if (!adminKeyOk(request)) {
    return response.status(403).json({ error: 'forbidden' });
  }
  const mode = request.body && request.body.mode;
  if (mode !== 'own' && mode !== 'remote') {
    return response.status(400).json({ error: "mode must be 'own' or 'remote'" });
  }
  manifestMode = mode;
  try {
    fs.writeFileSync(MANIFEST_MODE_FILE, JSON.stringify({ mode, updatedAt: Date.now() }));
  } catch (err) {
    console.error('[admin] failed to persist manifest mode:', err.message);
  }
  liveMpdCache.clear();
  anchorCache.clear();
  calibCache.clear();
  console.log(`[admin] manifest mode -> ${mode}`);
  return response.json({ ok: true, mode });
});

async function fetchRemote(fileUrl) {
  const response = await fetch(withHdntl(fileUrl), {
    headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X)' }
  });
  if (!response.ok) {
    throw new Error(`Upstream HTTP ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function sendMedia(response, buf) {
  response.set({
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'video/mp4',
    'Cache-Control': 'no-store'
  });
  response.send(buf);
}

/* ========================================================
   UPSTREAM MANIFEST ANCHORING
   The manifests hosted at UPSTREAM_ORIGIN are static snapshots whose
   segment numbering does not line up with wall-clock time, so a player
   following them requests segment numbers that 404 at the live edge.
   This mirrors the client-side anchoring: pin every startNumber
   to a per-channel anchor, then measure the real period start by
   reading the sidx box of a live segment.
   ======================================================== */
const UPSTREAM_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X)';
const SEGMENT_DURATION_SEC = 360360 / 90000; // 4.004s (audio: 192192/48000 — identical)
const MPD_ANCHORS = { main: 1794872925, all: 1794943247, din: 1794875802, ext: 1794875872 };
const ANCHOR_TTL_MS = 15 * 60 * 1000;
const MPD_CACHE_TTL_MS = 10 * 1000;
const anchorCache = new Map(); // ch -> { mpd, at }
const calibCache = new Map();  // ch -> { mpd, at }
const tfdtAnchorCache = new Map(); // ch -> media-seconds at startNumber

function applyMpdAnchor(mpd, anchor, periodStartSec) {
  const ast = new Date(periodStartSec * 1000).toISOString();
  const now = new Date().toISOString();
  let out = mpd;
  const firstPeriodEnd = out.indexOf('</Period>');
  const secondPeriodStart = firstPeriodEnd >= 0 ? out.indexOf('<Period', firstPeriodEnd) : -1;
  const mpdEnd = out.indexOf('</MPD>');
  if (secondPeriodStart > 0 && mpdEnd > secondPeriodStart) {
    out = out.slice(0, secondPeriodStart) + out.slice(mpdEnd);
  }
  out = out.replace(/(<Period\b[^>]*?)\s+duration="[^"]*"/, '$1');
  out = out.replace(/startNumber="\d+"/g, `startNumber="${anchor}"`);
  out = out.replace(/availabilityStartTime="[^"]+"/, `availabilityStartTime="${ast}"`);
  out = out.replace(/publishTime="[^"]+"/, `publishTime="${now}"`);
  out = out.replace(/timeShiftBufferDepth="[^"]+"/, 'timeShiftBufferDepth="PT300S"');
  out = out.replace(/suggestedPresentationDelay="[^"]+"/, 'suggestedPresentationDelay="PT10S"');
  if (!/UTCTiming/.test(out)) {
    out = out.replace(/<\/MPD>/, `<UTCTiming schemeIdUri="urn:mpeg:dash:utc:direct:2014" value="${now}"/></MPD>`);
  }
  return out;
}

function extractProbeTemplate(mpd) {
  const medias = [...mpd.matchAll(/media="(https:\/\/[^"]*\$Number\$[^"]*)"/g)].map((m) => m[1]);
  return medias.find((u) => u.includes('360p')) || medias.find((u) => u.includes('1080')) || medias[0] || null;
}

// Fetch the head of a segment and try to read its sidx box to derive the
// media-time anchor. Returns { ok, periodStartSec }.
async function probeSegment(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(withHdntl(url), {
        headers: { Range: 'bytes=0-1023', 'User-Agent': UPSTREAM_UA },
        signal: AbortSignal.timeout(8000)
      });
      if (r.status !== 200 && r.status !== 206) {
        try { await r.body?.cancel(); } catch {}
        return { ok: false, periodStartSec: null, periodStartNum: null };
      }
      const segNum = Number(/(\d+)\.mp4(?:\?|$)/.exec(url)?.[1] ?? 0);
      return await parseSegmentHead(r, segNum);
    } catch {
      await new Promise((res) => setTimeout(res, 400 * (attempt + 1)));
    }
  }
  return { ok: false, periodStartSec: null, periodStartNum: null };
}

async function parseSegmentHead(r, segNum) {
    const lastMod = Date.parse(r.headers.get('last-modified') || '') || 0;
    const buf = Buffer.from(await r.arrayBuffer());
    let periodStartSec = null;
    let periodStartNum = null;
    let tfdtSec = null;
    if (lastMod > 0) {
      let off = 0;
      while (off + 24 <= buf.length) {
        const size = buf.readUInt32BE(off);
        const type = buf.toString('latin1', off + 4, off + 8);
        if (type === 'sidx') {
          const version = buf[off + 8];
          const ept = version === 1
            ? buf.readUInt32BE(off + 20) * 4294967296 + buf.readUInt32BE(off + 24)
            : buf.readUInt32BE(off + 20);
          const t = Math.max(0, Math.round((ept - 3003) / 360360));
          periodStartSec = Math.round(lastMod / 1000 - (t + 1) * SEGMENT_DURATION_SEC);
          if (segNum > 0) periodStartNum = segNum - t;
          break;
        }
        if (size < 8) break;
        off += size;
      }
    }
    // tfdt lives at moof/traf/tfdt — scan the buffered head for it.
    // Probe template is always a video track (90kHz timescale).
    let moofOff = -1;
    for (let p = 0; p + 16 <= buf.length; p += 4) {
      if (buf.toString('latin1', p + 4, p + 8) === 'moof') { moofOff = p; break; }
    }
    if (moofOff >= 0) {
      const moofSize = buf.readUInt32BE(moofOff);
      const moofEnd = Math.min(moofOff + moofSize, buf.length);
      for (let p = moofOff + 8; p + 16 <= moofEnd; p += 4) {
        const bt = buf.toString('latin1', p + 4, p + 8);
        if (bt === 'traf') {
          const trafSize = buf.readUInt32BE(p);
          const trafEnd = Math.min(p + trafSize, moofEnd);
          for (let q = p + 8; q + 16 <= trafEnd; q += 4) {
            if (buf.toString('latin1', q + 4, q + 8) === 'tfdt') {
              const c = q + 8;
              const version = buf[c];
              const v = version === 1
                ? Number(buf.readBigUInt64BE(c + 4))
                : buf.readUInt32BE(c + 4);
              tfdtSec = v / 90000;
              break;
            }
          }
          break;
        }
      }
    }
    return { ok: true, periodStartSec, periodStartNum, tfdtSec };
}

// Live-edge tracker — segment numbers do NOT track wall-clock time on
// these feeds, so we persist the last segment number that probed OK and
// advance it by elapsed wall time (~4s per segment) on each run.
const LIVE_EDGE_FILE = path.join(__dirname, 'live-edge.json');
let liveEdgeStore = {};
try {
  liveEdgeStore = JSON.parse(fs.readFileSync(LIVE_EDGE_FILE, 'utf8'));
} catch {}
function saveLiveEdgeStore() {
  try { fs.writeFileSync(LIVE_EDGE_FILE, JSON.stringify(liveEdgeStore)); } catch {}
}

// Find ANY currently-published segment number. Any OK hit is enough —
// its sidx yields the period mapping; we don't need the exact live edge.
async function findLiveSegment(template, ch) {
  const urlFor = (n) => template.replace('$Number$', String(n));
  const probeOk = async (n) => n > 0 && (await probeSegment(urlFor(n))).ok;
  const anchor = MPD_ANCHORS[ch] || 0;
  // Seed from this channel's last hit; failing that, ANY channel's — all
  // feeds share the same encoder clock so their windows overlap.
  let saved = liveEdgeStore[ch];
  if (!(saved && saved.num > 0)) {
    for (const k of Object.keys(liveEdgeStore)) {
      const e = liveEdgeStore[k];
      if (e && e.num > 0 && (!saved || e.num > saved.num)) saved = e;
    }
  }
  const guess = saved && saved.num > 0
    ? saved.num + Math.floor((Date.now() - (saved.at || 0)) / 4000)
    : anchor;

  if (await probeOk(guess)) return guess;

  // Bidirectional exponential search around the guess — covers stale
  // anchors (window is above) and stream restarts (window is below).
  let step = 4000;
  for (let i = 0; i < 10; i++) {
    for (const n of [guess + step, guess - step]) {
      if (await probeOk(n)) return n;
    }
    step *= 2;
    if (step > 400000) break;
  }

  // Last resort: climb from the static anchor. Step capped at 8k so we
  // can't jump over a narrow retention window.
  let n = anchor;
  step = 4000;
  for (let i = 0; i < 90; i++) {
    n += step;
    step = Math.min(step * 2, 8000);
    if (await probeOk(n)) return n;
  }
  return null;
}

async function measurePeriodStart(ch, mpd, anchor) {
  const template = extractProbeTemplate(mpd);
  if (!template) return null;
  const segNum = await findLiveSegment(template, ch);
  if (segNum == null) return null;
  const probe = await probeSegment(template.replace('$Number$', String(segNum)));
  const s = probe.periodStartSec;
  const startNum = probe.periodStartNum || anchor;
  liveEdgeStore[ch] = { num: segNum, at: Date.now() };
  saveLiveEdgeStore();
  // tfdt at the first served segment = probed tfdt minus segments-between*dur.
  // Encoders may keep tfdt continuous across periods ('all' does), in which
  // case this is a large offset we must subtract during decrypt.
  let tfdtAnchorSec = null;
  if (probe.tfdtSec != null) {
    tfdtAnchorSec = probe.tfdtSec - (segNum - startNum) * SEGMENT_DURATION_SEC;
  }
  // sidx-derived epoch anchor should be a sane unix timestamp
  if (s && s > 1.7e9 && s < 2.1e9) {
    return { periodStartSec: s, startNum, tfdtAnchorSec };
  }
  return tfdtAnchorSec != null ? { periodStartSec: anchor + 1, startNum, tfdtAnchorSec } : null;
}

/* ========================================================
   LIVE MANIFEST SOURCE
   Remote manifest endpoint returns fresh manifests with the
   correct current-period timing. Media URLs are normalized
   to canonical segment URLs below.
   ======================================================== */
const LIVE_MPD_API = 'https://pbbcollab.xyz/api/mpd';
// xyz cam ids differ from ours: our 'all' feed is their 'extra' cam.
const XYZ_CAM = { all: 'extra', ext: 'ext', din: 'din', main: 'main' };
const LIVE_MPD_TTL_MS = 10 * 1000;
const liveMpdCache = new Map(); // ch -> { mpd, at }

async function fetchLiveMpd(ch, srv = 's1') {
  const cacheKey = `${ch}:${srv}`;
  const cached = liveMpdCache.get(cacheKey);
  if (cached && Date.now() - cached.at < LIVE_MPD_TTL_MS) {
    return cached.mpd;
  }
  const AKAMAI_EXTRA_MPD = 'https://abslive.akamaized.net/dash/live/2099522/pbbcollaballaccesslivestream/manifest.mpd';
  try {
    // 'all'/PBB Extra: TRUE ORIGIN first — Akamai serves manifest.mpd
    // with no token and CORS-open. xyz is only an emergency fallback.
    if (ch === 'all') {
      try {
        const ar = await fetch(AKAMAI_EXTRA_MPD, {
          headers: { 'User-Agent': UPSTREAM_UA },
          signal: AbortSignal.timeout(8000)
        });
        if (ar.ok) {
          const ampd = await ar.text();
          liveMpdCache.set(cacheKey, { mpd: ampd, at: Date.now() });
          return ampd;
        }
        try { await ar.body?.cancel(); } catch {}
      } catch {}
    }
    const r = await fetch(`${LIVE_MPD_API}/${XYZ_CAM[ch] || ch}`, {
      headers: { 'User-Agent': UPSTREAM_UA },
      signal: AbortSignal.timeout(8000)
    });
    if (!r.ok) {
      try { await r.body?.cancel(); } catch {}
      if (ch === 'all') {
        try {
          const ar = await fetch(withHdntl(AKAMAI_EXTRA_MPD), { headers: { 'User-Agent': UPSTREAM_UA }, signal: AbortSignal.timeout(8000) });
          if (ar.ok) {
            let ampd = await ar.text();
            ampd = ampd.replace(/<BaseURL>[\s\S]*?<\/BaseURL>/g,
              '<BaseURL>https://pbbcollab.xyz/api/seg/dash/live/2099522/pbbcollaballaccesslivestream/</BaseURL>');
            liveMpdCache.set(cacheKey, { mpd: ampd, at: Date.now() });
            return ampd;
          }
          try { await ar.body?.cancel(); } catch {}
        } catch {}
      }
      return cached?.mpd || null;
    }
    let mpd = await r.text();
    // xyz manifests carry <BaseURL>/api/seg/dash/live/.../</BaseURL> —
    // make it absolute; routes below collapse segment URLs to opaque /px.
    mpd = mpd.replace(/<BaseURL>\/api\/seg\//g,
      '<BaseURL>https://pbbcollab.xyz/api/seg/');
    mpd = mpd.replace(/<BaseURL>\/dash\/live\//g,
      '<BaseURL>https://absp-live.akamaized.net/dash/live/');
    liveMpdCache.set(cacheKey, { mpd, at: Date.now() });
    return mpd;
  } catch {
    return cached?.mpd || null;
  }
}

async function buildAnchoredMpd(ch, srv = 's1') {
  const cacheKey = `${ch}:${srv}`;
  // 'own' mode skips the remote manifest endpoint entirely — anchored
  // snapshot + edge probing only.
  if (manifestMode !== 'own') {
    // Prefer the live manifest endpoint — always current-period correct.
    const live = await fetchLiveMpd(ch, srv);
    if (live) {
      mpdSourceMap.set(cacheKey, 'remote');
      return live;
    }
  }
  mpdSourceMap.set(cacheKey, 'own');
  const cached = anchorCache.get(ch);
  if (cached && Date.now() - cached.at < ANCHOR_TTL_MS) {
    return cached.mpd;
  }

  const anchor = MPD_ANCHORS[ch];
  let mpd = null;
  try {
    const upstream = await fetch(`${UPSTREAM_ORIGIN}/live/${ch}.mpd`, {
      headers: { 'User-Agent': UPSTREAM_UA },
      signal: AbortSignal.timeout(8000)
    });
    if (upstream.ok) mpd = await upstream.text();
  } catch {}
  if (mpd == null) {
    // Fall back to the bundled snapshot so we keep working if the
    // upstream Pages site goes away.
    mpd = await fs.promises.readFile(path.join(__dirname, 'live-manifests', `${ch}.mpd`), 'utf8');
  }
  if (!anchor) return mpd;

  let periodStartSec = anchor + 1;
  let startNum = anchor;
  try {
    const measured = await measurePeriodStart(ch, mpd, anchor);
    if (measured) {
      periodStartSec = measured.periodStartSec;
      if (measured.startNum) startNum = measured.startNum;
      if (measured.tfdtAnchorSec != null) tfdtAnchorCache.set(ch, measured.tfdtAnchorSec);
    }
  } catch (err) {
    console.error(`[anchor] ${ch} measurement failed:`, err.message);
  }

  const anchored = applyMpdAnchor(mpd, startNum, periodStartSec);
  anchorCache.set(ch, { mpd: anchored, at: Date.now() });
  console.log(`[anchor] ${ch}: startNumber=${startNum} periodStart=${periodStartSec}`);
  return anchored;
}

async function getCalibratedMpd(ch, srv = 's1') {
  const cacheKey = `${ch}:${srv}`;
  const cached = calibCache.get(cacheKey);
  if (cached && Date.now() - cached.at < MPD_CACHE_TTL_MS) {
    return cached.mpd;
  }
  let mpd = await buildAnchoredMpd(ch, srv);
  // The iOS client-side player fetches segment URLs itself — make sure
  // every manifest we serve has absolute URLs, never site-relative.
  mpd = mpd.replace(/(media|initialization)="\/stream\//g,
    '$1="https://pbbcollab.com/stream/');
  mpd = mpd.replace(/(media|initialization)="\/dash\/live\//g,
    '$1="https://absp-live.akamaized.net/dash/live/');
  mpd = mpd.replace(/<BaseURL>\/stream\//g,
    '<BaseURL>https://pbbcollab.com/stream/');
  mpd = mpd.replace(/<BaseURL>\/api\/seg\//g,
    '<BaseURL>https://pbbcollab.xyz/api/seg/');
  mpd = mpd.replace(/<BaseURL>\/dash\/live\//g,
    '<BaseURL>https://absp-live.akamaized.net/dash/live/');
  // Normalize any remaining absolute proxy URL to the canonical
  // segment URL — query strings (foreign tokens) are dropped so
  // downstream basename extraction stays clean.
  mpd = mpd.replace(
    /(media|initialization)="https?:\/\/[^/"']+(\/dash\/live\/[^"?]+)[^"]*"/g,
    (m, attr, p) => `${attr}="https://absp-live.akamaized.net${p}"`
  );
  // Never rewrite abslive (PBB Extra origin) URLs to absp-live — different
  // host, different access rules.
  mpd = mpd.replace(
    /(media|initialization)="https:\/\/absp-live\.akamaized\.net(\/dash\/live\/2099522\/pbbcollaballaccesslivestream\/[^"]*)"/g,
    (m, attr, p) => `${attr}="https://abslive.akamaized.net${p}"`
  );
  calibCache.set(cacheKey, { mpd, at: Date.now() });
  return mpd;
}

function sanitizeSrv(value) {
  return /^s[1-4]$/.test(value || '') ? value : 's1';
}

// Same-origin encrypted segment proxy. The upstream CDN rejects
// cross-origin browser fetches from hosting domains with 403, so
// clients pull segments through us. Server-side fetch carries no
// Origin header. Zero decryption — pure byte pipe.
// Opaque per-feed prefixes for /px — keeps upstream CDN paths and
// channel names out of client-visible manifest URLs.
const PX_KEYS = { all: 'xK9f2mQ7w', ext: 'wR4tY8p2n', din: 'nB6vC1z5d', main: 'jH5sD3g8k' };
const PX_KEY_TO_CH = Object.fromEntries(Object.entries(PX_KEYS).map(([c, k]) => [k, c]));

const AKAMAI_ORIGIN = 'https://absp-live.akamaized.net';
app.get('/px/*splat', async (request, response) => {
  try {
    const rel = Array.isArray(request.params.splat)
      ? request.params.splat.join('/')
      : (request.params.splat || '');
    const pxParts = rel.split('/');
    const pxCh = PX_KEY_TO_CH[pxParts.shift()];
    const sub = pxParts.join('/');
    if (!pxCh || !sub || sub.includes('..') || sub.includes('/')) {
      return response.status(404).send('Not found');
    }
    let query = '';
    const qIndex = request.originalUrl.indexOf('?');
    if (qIndex >= 0) {
      const qs = new URLSearchParams(request.originalUrl.slice(qIndex + 1));
      qs.delete('k');
      const s = qs.toString();
      query = s ? '?' + s : '';
    }
    const headers = { 'User-Agent': UPSTREAM_UA };
    if (request.headers.range) headers.Range = request.headers.range;
    // Upstream segment prefix per feed (xyz /api/seg proxy). The opaque
    // /px key maps to the feed; upstream host/path never reaches clients.
    const segBase = proxyStreams[pxCh] && proxyStreams[pxCh].segBase;
    const targetUrl = segBase
      ? `${segBase}${sub}${query}`
      : withHdntl(`${AKAMAI_ORIGIN}/dash/live/2099522/dead/${sub}${query}`);
    const upstream = await fetch(targetUrl, {
      headers,
      signal: AbortSignal.timeout(15000)
    });
    if (upstream.status >= 400) console.log('[px] upstream', upstream.status, targetUrl.slice(0, 160));
    response.status(upstream.status);
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control', 'etag', 'last-modified']) {
      const v = upstream.headers.get(h);
      if (v) response.setHeader(h, v);
    }
    response.setHeader('Access-Control-Allow-Origin', '*');
    if (!upstream.ok || !upstream.body) {
      return response.end();
    }
    const { Readable } = await import('node:stream');
    Readable.fromWeb(upstream.body).pipe(response);
  } catch (error) {
    console.error('[px] segment proxy error:', error.message);
    if (!response.headersSent) response.status(502).send('Segment proxy error');
    else response.end();
  }
});

app.get('/api/segment', async (request, response) => {
  const { ch, file } = request.query;
  const streamConfig = proxyStreams[ch];

  if (!streamConfig || typeof file !== 'string' || file.includes('..') || file.includes('/')) {
    return response.status(404).send('Segment not found');
  }

  try {
    const isInit = /_init\.mp4$/i.test(file);
    let buf = cacheGet(ch, file);
    if (!buf) {
      const isAudioCls = /audio/i.test(file);
      // segBase = the feed's upstream segment prefix (xyz /api/seg proxy).
      const upstreamUrl = streamConfig.segBase
        ? `${streamConfig.segBase}${file}`
        : `${streamConfig.url || ''}${file}`;
      const remote = await fetchRemote(upstreamUrl);
      buf = isInit
        ? cenc.decryptInit(remote)
        : (() => {
            const t = feedTiming[ch] || {};
            const clsMap = t.trackTimescales && t.trackTimescales[isAudioCls ? 'audio' : 'video'];
            return cenc.decryptSegment(remote, isAudioCls && streamConfig.keyAudio ? streamConfig.keyAudio : streamConfig.key, {
              ...CENC_OPTS,
              periodOffsetSec: (t.periodStartSec || 0) - (tfdtAnchorCache.get(ch) || 0),
              trackTimescales: clsMap || { '*': isAudioCls ? 48000 : 90000 }
            });
          })();
      cacheSet(ch, file, buf);
    }
    if (isInit) {
      const t = feedTiming[ch] = feedTiming[ch] || {};
      t.trackTimescales = t.trackTimescales || {};
      t.trackTimescales[/audio/i.test(file) ? 'audio' : 'video'] = cenc.extractTrackTimescales(buf);
    }
    return sendMedia(response, buf);
  } catch (error) {
    console.error(`Error proxying segment (${file}):`, error.message);
    return response.status(500).send('Failed to fetch/decrypt segment');
  }
});

app.get('/stream/:feedId.mpd', async (request, response) => {
  const feedId = request.params.feedId;
  const streamConfig = proxyStreams[feedId];

  if (!streamConfig) {
    return response.status(404).send('Feed not found');
  }

  try {
    const srv = sanitizeSrv(request.query.srv);
    let mpdContent = await getCalibratedMpd(feedId, srv);
    const mpdSource = mpdSourceMap.get(`${feedId}:${srv}`) || 'unknown';

    const rewriteSegmentUrl = (match, segmentUrl) => {
      const file = segmentUrl.split('/').pop();
      if (!file || file.includes('..')) return match;
      return match.replace(segmentUrl, `/api/segment?ch=${feedId}&file=${file}${SITE_KEY ? '&k=' + SITE_KEY : ''}`);
    };
    mpdContent = mpdContent.replace(/media="([^"]+)"/g, rewriteSegmentUrl);
    mpdContent = mpdContent.replace(/initialization="([^"]+)"/g, rewriteSegmentUrl);
    // Strip <BaseURL> — it leaks the upstream host and is unneeded once
    // every media/init URL is absolute.
    mpdContent = mpdContent.replace(/<BaseURL>[\s\S]*?<\/BaseURL>/g, '');
    mpdContent = mpdContent.replace(/<ContentProtection\b[^>]*?\/>|<ContentProtection\b[^>]*>[\s\S]*?<\/ContentProtection>/g, '');

    const periodStarts = [...mpdContent.matchAll(/<Period\b[^>]*>/g)]
      .map((x) => parsePeriodStartSec(x[0]));
    if (periodStarts.length) {
      const t = feedTiming[feedId] = feedTiming[feedId] || {};
      t.periodStartSec = Math.max(...periodStarts);
    }

    response.set({
      'Access-Control-Allow-Origin': '*',
      'Content-Type': 'application/dash+xml',
      'Cache-Control': 'no-store',
      'X-Mpd-Source': mpdSource
    });
    response.send(mpdContent);
  } catch (error) {
    console.error('Manifest proxy error:', error.message);
    return response.status(500).send('Failed to fetch manifest');
  }
});

// Encrypted (ClearKey) variant of the calibrated manifest. Segment URLs
// are rewritten to the same-origin /px/ proxy so every client path
// (Shaka ClearKey, MMS engine, direct pages) works everywhere. The proxy
// only pipes encrypted bytes; decryption still happens in the browser.
app.get('/manifest/:feedId.mpd', async (request, response) => {
  const feedId = request.params.feedId;

  if (!proxyStreams[feedId]) {
    return response.status(404).send('Feed not found');
  }

  try {
    const srv = sanitizeSrv(request.query.srv);
    let mpdContent = await getCalibratedMpd(feedId, srv);
    const mpdSource = mpdSourceMap.get(`${feedId}:${srv}`) || 'unknown';
    // Emit DIRECT absolute upstream URLs — both origins are CORS-open
    // (Akamai ACAO:*, xyz /api/seg), so browsers fetch segments straight
    // from the CDN. Zero bandwidth through this server = free-tier safe.
    const segBase = proxyStreams[feedId].segBase || '';
    mpdContent = mpdContent.replace(
      /(media|initialization)="([^"]+)"/g,
      (m, attr, url) => {
        if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('/px/') || url.startsWith('/api/segment')) {
          // Already absolute upstream URL — keep, but repoint any
          // pbbcollab.xyz/api/seg or Akamai variant to this feed's segBase
          // so 'all' always resolves to the token-free Akamai origin.
          const file = url.split('/').pop();
          if (file && segBase) return `${attr}="${segBase}${file}"`;
          return m;
        }
        const file = url.split('/').pop();
        if (!file || file.includes('..')) return m;
        return `${attr}="${segBase}${file}"`;
      }
    );
    // <BaseURL> leaks the upstream host/token — remove it; all segment
    // URLs are now absolute /px paths.
    mpdContent = mpdContent.replace(/<BaseURL>[\s\S]*?<\/BaseURL>/g, '');
    if (SITE_KEY) {
      mpdContent = mpdContent.replace(
        /(media|initialization)="(\/px\/[^"?]+)"/g,
        `$1="$2?k=${SITE_KEY}"`
      );
    }
    // Collapse /px/dash/live/.../dir/file → /px/<opaque-key>/file so
    // upstream CDN paths never appear in client-visible URLs.
    mpdContent = mpdContent.replace(
      /(media|initialization)="(\/px\/[^"]+)"/g,
      (m, attr, u) => {
        const qi = u.indexOf('?');
        const path = qi >= 0 ? u.slice(0, qi) : u;
        const query = qi >= 0 ? u.slice(qi) : '';
        const file = path.split('/').pop();
        return `${attr}="/px/${PX_KEYS[feedId]}/${file}${query}"`;
      }
    );
    response.set({
      'Access-Control-Allow-Origin': '*',
      'Content-Type': 'application/dash+xml',
      'Cache-Control': 'no-store',
      'X-Mpd-Source': mpdSource
    });
    response.send(mpdContent);
  } catch (error) {
    console.error('Manifest proxy error:', error.message);
    return response.status(500).send('Failed to fetch manifest');
  }
});

const feedPaths = {
  '/feed1': 'all',
  '/feed2': 'ext',
  '/feed3': 'din',
  '/feed4': 'main'
};

app.get(/^\/feed[1-4]\/?$/, (request, response) => {
  response.set('Cache-Control', 'no-store');
  return response.sendFile(path.join(publicDirectory, 'feed.html'));
});

app.listen(port, () => {
  console.log(`PBB Live dashboard listening on port ${port}`);
  // Pre-warm edge calibration for all channels so the first page load
  // doesn't block on ~30 upstream probes per feed.
  for (const ch of Object.keys(proxyStreams)) {
    getCalibratedMpd(ch).catch((err) => console.error(`[calib] ${ch} warmup failed:`, err.message));
  }
});
