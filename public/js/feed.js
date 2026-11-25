'use strict';

const PATH_FEED_MAP = {
  '/feed1': 'all',
  '/feed2': 'ext',
  '/feed3': 'din',
  '/feed4': 'main'
};

const FEEDS = {
  all: {
    url: '/manifest/all.mpd',
    kid: 'b75e0a8315d0499b834c00a3d5b91935',
    key: '39876c3c4f32a11dee56078febbb67dd',
    kidAlt: '1044e7ece2d741bcafe80d8613da104f',
    keyAlt: 'f5e17f169ff05ea40c5d3f065f523942',
    token: ''
  },
  ext: {
    url: '/manifest/ext.mpd',
    kid: '1044e7ece2d741bcafe80d8613da104f',
    key: 'f5e17f169ff05ea40c5d3f065f523942',
    token: ''
  },
  din: {
    url: '/manifest/din.mpd',
    kid: '1044e7ece2d741bcafe80d8613da104f',
    key: 'f5e17f169ff05ea40c5d3f065f523942',
    token: ''
  },
  main: {
    url: '/manifest/main.mpd',
    kid: '1044e7ece2d741bcafe80d8613da104f',
    key: 'f5e17f169ff05ea40c5d3f065f523942',
    token: ''
  }
};

const video = document.getElementById('feed-video');
const messageEl = document.getElementById('feed-message');

let activeFeedId = null;

// Auto-reconnect on fatal playback errors: reload the page a few times
// (fresh manifest + fresh player) before showing the error to the user.
function clearErrorRetries() {
  try { sessionStorage.removeItem(`feed-retry-${activeFeedId}`); } catch (_) {}
}
function handleFatalError(msg) {
  let n = 0;
  try { n = Number(sessionStorage.getItem(`feed-retry-${activeFeedId}`) || 0); } catch (_) {}
  if (n < 3) {
    try { sessionStorage.setItem(`feed-retry-${activeFeedId}`, String(n + 1)); } catch (_) {}
    showMessage('Reconnecting…');
    setTimeout(() => location.reload(), 1500);
    return;
  }
  showMessage(msg || 'Stream unavailable. Please try again later.');
}
video.addEventListener('playing', clearErrorRetries);

// Web Audio loudness boost (same idea as the dashboard AudioBooster)
let audioBoost = null;
function ensureAudioBoost() {
  if (audioBoost) return audioBoost;
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return null;
  const ctx = new AudioContextClass();
  const source = ctx.createMediaElementSource(video);
  const gain = ctx.createGain();
  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.value = -14;
  compressor.knee.value = 8;
  compressor.ratio.value = 10;
  compressor.attack.value = 0.003;
  compressor.release.value = 0.25;
  source.connect(gain);
  gain.connect(compressor);
  compressor.connect(ctx.destination);
  gain.gain.value = video.muted ? 0 : 2.5;
  audioBoost = { ctx, gain };
  return audioBoost;
}

function applyBoostState() {
  if (!audioBoost) return;
  audioBoost.gain.gain.value = video.muted ? 0 : 2.5;
  if (audioBoost.ctx.state === 'suspended') {
    audioBoost.ctx.resume().catch(() => {});
  }
}

function showMessage(text) {
  messageEl.textContent = text;
  messageEl.style.display = 'flex';
}

function isIOSDevice() {
  return /iPad|iPhone|iPod/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function isAndroidDevice() {
  return /Android/i.test(navigator.userAgent);
}

async function supportsClearKey() {
  try {
    if (!navigator.requestMediaKeySystemAccess) return false;
    await navigator.requestMediaKeySystemAccess('org.w3.clearkey', [{ initDataTypes: ['cenc'] }]);
    return true;
  } catch {
    return false;
  }
}

function getFeedConfig() {
  const feedId = PATH_FEED_MAP[window.location.pathname.replace(/\/+$/, '')];
  return feedId ? { id: feedId, ...FEEDS[feedId] } : null;
}

async function start() {
  const feed = getFeedConfig();
  if (!feed) {
    showMessage('Unknown feed.');
    return;
  }
  activeFeedId = feed.id;

  // Native path: vendored ManagedMediaSource + WebCrypto AES-CTR engine —
  // decrypts segments in the browser, zero server load. Works on iOS
  // (ManagedMediaSource) and any MSE browser (Chrome/Android) as fallback
  // when ClearKey EME is unavailable.
  const clearKeyOkEarly = await supportsClearKey();
  const mmsOk = window.isMmsSupported ? window.isMmsSupported() :
    !!(window.isIosMmsSupported && window.isIosMmsSupported());
  const useMms = mmsOk && (isIOSDevice() || isAndroidDevice() || !clearKeyOkEarly);

  if (useMms) {
    try {
      const savedSrv = localStorage.getItem('pbb-server');
      const srv = /^s[1-4]$/.test(savedSrv || '') ? savedSrv : 's1';
      const dashUrl = `${window.location.origin}/manifest/${feed.id}.mpd?srv=${srv}${window.PBB_SITE_KEY ? '&k=' + window.PBB_SITE_KEY : ''}`;
      const mmsKey = feed.keyAlt || feed.key;
      const mmsPlayer = new window.IosDashPlayer(video);
      mmsPlayer.addEventListener('error', (e) => {
        handleFatalError(e?.detail?.message || 'Playback error');
      });
      await mmsPlayer.load(dashUrl, feed.kid, mmsKey, {
        targetHeight: 1080,
        autoQuality: false,
        enableAudio: true
      });
      video.muted = false;
      video.volume = 1;
      try { await video.play(); } catch (_) {
        video.muted = true;
        await video.play().catch(() => {});
      }
      return;
    } catch (err) {
      console.warn('[feed] MMS player failed, falling back:', err);
    }
  }

  if (!window.shaka || !shaka.Player.isBrowserSupported()) {
    showMessage('This browser does not support playback.');
    return;
  }

  // Candidate sources: on desktop, the calibrated ClearKey manifest plays
  // encrypted segments straight from the CDN (browser decrypts — no server
  // CPU). The decrypting same-origin proxy is the fallback and the primary
  // path on iOS/embedded browsers where ClearKey is unreliable.
  const savedSrv = localStorage.getItem('pbb-server');
  const srv = /^s[1-4]$/.test(savedSrv || '') ? savedSrv : 's1';
  const proxyFirst = isIOSDevice() || isAndroidDevice() || !clearKeyOkEarly;
  const siteK = window.PBB_SITE_KEY ? '&k=' + window.PBB_SITE_KEY : '';
  const clearKeyCandidate = { manifestUrl: `${window.location.origin}/manifest/${feed.id}.mpd?srv=${srv}${siteK}`, drm: { preferredKeySystems: ['org.w3.clearkey'], clearKeys: { [feed.kid]: feed.key, ...(feed.kidAlt ? { [feed.kidAlt]: feed.keyAlt || feed.key } : {}) } } };
  const proxyCandidate = { manifestUrl: `${window.location.origin}/stream/${feed.id}.mpd?srv=${srv}${siteK}`, drm: null };
  const candidates = proxyFirst ? [proxyCandidate, clearKeyCandidate] : [clearKeyCandidate, proxyCandidate];

  const player = new shaka.Player();
  await player.attach(video);

  player.configure({
    abr: {
      enabled: false // pin the highest rendition — no auto quality drops
    },
    dash: {
      ignoreSuggestedPresentationDelay: false
    },
    streaming: {
      lowLatencyMode: true,
      rebufferingGoal: 2,
      bufferingGoal: 10,
      bufferBehind: 20,
      stallEnabled: true,
      stallThreshold: 1,
      retryParameters: {
        maxAttempts: 5,
        baseDelay: 500,
        backoffFactor: 2,
        timeout: 10000
      }
    }
  });

  player.addEventListener('error', (event) => {
    const detail = event.detail;
    console.error('Playback error:', detail);
    // Ignore recoverable errors (single-segment failures Shaka retries itself)
    if (detail && typeof detail.severity === 'number' && detail.severity < 2) return;
    handleFatalError('Stream interrupted. Reconnecting…');
  });

  // Pin the highest-quality variant (1080p) as soon as tracks are known
  const pinTopVariant = () => {
    const tracks = player.getVariantTracks()
      .filter((t) => Number.isFinite(t.height) && t.height > 0)
      .sort((a, b) => (b.height - a.height) || ((b.bandwidth || 0) - (a.bandwidth || 0)));
    if (tracks.length > 0) {
      player.selectVariantTrack(tracks[0], true);
    }
  };
  player.addEventListener('trackschanged', pinTopVariant);

  let loaded = false;
  for (const candidate of candidates) {
    try {
      if (candidate.drm) {
        player.configure({ drm: candidate.drm });
      }
      await player.load(candidate.manifestUrl);
      loaded = true;
      break;
    } catch (error) {
      console.error(`Load failed for ${candidate.manifestUrl}:`, error);
      try { await player.unload(); } catch (_) { /* ignore */ }
    }
  }

  if (!loaded) {
    handleFatalError('Could not load this feed.');
    return;
  }

  pinTopVariant();
  // Try to start with sound immediately; browsers may block unmuted autoplay
  video.muted = false;
  video.volume = 1;
  try {
    await video.play();
  } catch (error) {
    if (error && error.name === 'NotAllowedError') {
      video.muted = true;
      await video.play().catch(() => {});
    }
  }
}

// Tap to unmute / replay — first tap also enables the loudness boost
video.addEventListener('click', () => {
  ensureAudioBoost();
  if (video.paused) {
    video.play().catch(() => {});
    return;
  }
  video.muted = !video.muted;
  video.volume = 1;
  applyBoostState();
});

// Server selector — shares the dashboard's saved choice via localStorage
const serverSelect = document.getElementById('feed-server');
const savedSrv = localStorage.getItem('pbb-server');
if (serverSelect) {
  if (/^s[1-4]$/.test(savedSrv || '')) serverSelect.value = savedSrv;
  serverSelect.addEventListener('change', () => {
    localStorage.setItem('pbb-server', serverSelect.value);
    location.reload();
  });
}

start();
