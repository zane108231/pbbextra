'use strict';

const feeds = [
  { id: 'all', name: 'PBB Extra' }
];

const builtInStreams = {
  all: {
    url: '/manifest/all.mpd',
    // PBB Extra true origin — Akamai live packager, CORS-open, no token.
    // Browser fetches manifest + segments directly: zero server bandwidth.
    directMpd: 'https://abslive.akamaized.net/dash/live/2099522/pbbcollaballaccesslivestream/manifest.mpd',
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

function isIOSDevice() {
  return /iPad|iPhone|iPod/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function isAndroidDevice() {
  return /Android/i.test(navigator.userAgent);
}

let clearKeyProbe = null;
function supportsClearKey() {
  if (!clearKeyProbe) {
    clearKeyProbe = (async () => {
      try {
        if (!navigator.requestMediaKeySystemAccess) return false;
        await navigator.requestMediaKeySystemAccess('org.w3.clearkey', [{ initDataTypes: ['cenc'] }]);
        return true;
      } catch {
        return false;
      }
    })();
  }
  return clearKeyProbe;
}

function getIosHlsProxyBaseUrl() {
  const configuredBase = document.querySelector('meta[name="ios-hls-proxy-base-url"]')?.content.trim();
  if (!configuredBase || configuredBase === 'auto') {
    return new URL(window.location.origin);
  }

  const baseUrl = new URL(configuredBase);
  const isLocalhost = ['localhost', '127.0.0.1', '[::1]'].includes(baseUrl.hostname);
  const isSameHostHttp = baseUrl.protocol === 'http:' &&
    window.location.protocol === 'http:' &&
    baseUrl.hostname === window.location.hostname;
  if (baseUrl.protocol !== 'https:' && !(baseUrl.protocol === 'http:' && (isLocalhost || isSameHostHttp))) {
    throw new Error('The iOS HLS proxy URL must use HTTPS.');
  }
  if (baseUrl.username || baseUrl.password) {
    throw new Error('Do not put credentials in the iOS HLS proxy URL.');
  }

  return baseUrl;
}

function buildIosProxyManifestUrl(feedId, baseUrl) {
  const url = new URL(baseUrl.href);
  const basePath = url.pathname.replace(/\/+$/, '');
  url.pathname = `${basePath}/stream/${encodeURIComponent(feedId)}.mpd`;
  if (window.PBB_SITE_KEY) url.searchParams.set('k', window.PBB_SITE_KEY);
  return url;
}

/* ========================================================
   AUDIO BOOSTER & CROSS-FEED SOUND ENGINE
   ======================================================== */
class AudioBooster {
  constructor() {
    this.audioCtx = null;
    this.nodes = new Map(); // video -> { source, gainNode, compressor }
    this.globalVolume = 1.0;
    this.isMuted = true; // Starts true for browser autoplay compliance
    this.boostFactor = Number(localStorage.getItem('pbb-boost')) || 2.5; // +8dB preamp boost for TV broadcast loudness
  }

  setBoost(factor) {
    this.boostFactor = Math.max(1, Math.min(4, Number(factor) || 1));
    localStorage.setItem('pbb-boost', String(this.boostFactor));
    this.syncAllFeeds();
  }

  initContext() {
    if (!this.audioCtx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) {
        this.audioCtx = new AudioCtx();
      }
    }
    if (this.audioCtx && this.audioCtx.state === 'suspended') {
      this.audioCtx.resume().catch(() => {});
    }
  }

  ensureContextRunning() {
    this.initContext();
  }

  attachVideo(video) {
    if (!video || this.nodes.has(video)) return;
    this.initContext();
    if (!this.audioCtx) return;

    try {
      const source = this.audioCtx.createMediaElementSource(video);
      const gainNode = this.audioCtx.createGain();
      const compressor = this.audioCtx.createDynamicsCompressor();

      // Transparent peak limiting to prevent clipping distortion
      compressor.threshold.setValueAtTime(-12, this.audioCtx.currentTime);
      compressor.knee.setValueAtTime(24, this.audioCtx.currentTime);
      compressor.ratio.setValueAtTime(6, this.audioCtx.currentTime);
      compressor.attack.setValueAtTime(0.003, this.audioCtx.currentTime);
      compressor.release.setValueAtTime(0.25, this.audioCtx.currentTime);

      source.connect(gainNode);
      gainNode.connect(compressor);
      compressor.connect(this.audioCtx.destination);

      this.nodes.set(video, { source, gainNode, compressor });
    } catch (err) {
      console.warn('Web Audio attach error (falling back to native audio):', err);
    }
  }

  setVolume(vol) {
    this.globalVolume = Math.max(0, Math.min(1, vol));
    this.initContext();
    if (this.globalVolume > 0 && this.isMuted) {
      this.isMuted = false;
    } else if (this.globalVolume === 0) {
      this.isMuted = true;
    }
    this.syncAllFeeds();
  }

  setMuted(muted) {
    this.isMuted = Boolean(muted);
    this.initContext();
    this.syncAllFeeds();
  }

  toggleMute() {
    this.setMuted(!this.isMuted);
    return this.isMuted;
  }

  syncAllFeeds() {
    feeds.forEach((feed) => {
      const state = feedState.get(feed.id);
      if (!state || !state.video) return;

      const isSelected = (feed.id === selectedFeedId);
      const shouldHear = isSelected && !this.isMuted && this.globalVolume > 0;

      // HTML5 video native properties
      state.video.muted = !shouldHear;
      state.video.volume = this.globalVolume;

      // Web Audio gain node update
      const node = this.nodes.get(state.video);
      if (node && this.audioCtx) {
        const gainVal = shouldHear ? (this.globalVolume * this.boostFactor) : 0;
        node.gainNode.gain.setValueAtTime(gainVal, this.audioCtx.currentTime);
      }
    });

    updateAudioUI();
  }
}

const audioBooster = new AudioBooster();

/* ========================================================
   STATE & DOM ELEMENTS
   ======================================================== */
const feedState = new Map();
const playerContainer = document.querySelector('#player-container');
const stage = document.querySelector('#stage');
const dialog = document.querySelector('#source-dialog');
const sourceForm = document.querySelector('#source-form');
const manifestInput = document.querySelector('#manifest-url');
const sourceError = document.querySelector('#source-error');
const appMessage = document.querySelector('#app-message');
const siteLoader = document.querySelector('#site-loader');
const loaderProgress = document.querySelector('#loader-progress');
const loaderProgressBar = document.querySelector('#loader-progress-bar');
const loaderProgressText = document.querySelector('#loader-progress-text');
const loaderEnterButton = document.querySelector('#loader-enter-button');

// Floating Controls DOM Elements
const topPipButton = document.querySelector('#player-top-pip');
const unmuteOverlay = document.querySelector('#player-unmute-overlay');
const btnPlayPause = document.querySelector('#btn-play-pause');
const btnVolume = document.querySelector('#btn-volume');
const volSlider = document.querySelector('#pill-vol-slider');
const btnMultiView = document.querySelector('#btn-multiview');
const btnTheater = document.querySelector('#btn-theater');
const btnQuality = document.querySelector('#btn-quality');
const qualityBadgeText = document.querySelector('#quality-badge-text');
const qualityDropdown = document.querySelector('#quality-dropdown-menu');
const btnFullscreen = document.querySelector('#btn-fullscreen');
const btnServer = document.querySelector('#btn-server');
const serverBadgeText = document.querySelector('#server-badge-text');
const serverDropdown = document.querySelector('#server-dropdown-menu');
const btnBoost = document.querySelector('#btn-boost');
const boostBadgeText = document.querySelector('#boost-badge-text');
const boostDropdown = document.querySelector('#boost-dropdown-menu');

const PATH_FEED_MAP = {
  '/feed1': 'all',
  '/feed2': 'ext',
  '/feed3': 'din',
  '/feed4': 'main'
};
const pathFeedId = PATH_FEED_MAP[window.location.pathname.replace(/\/+$/, '')];

let selectedFeedId = pathFeedId || 'all';
let pendingFeedId = null;
let currentQuality = 'auto'; // 'auto' or number height (1080, 720, etc.)
let currentServer = (() => {
  const saved = localStorage.getItem('pbb-server');
  return /^s[1-4]$/.test(saved || '') ? saved : 's1';
})();
let controlsIdleTimer = null;
let wasFullscreen = false;

// Initialize Feed State
for (const feed of feeds) {
  feedState.set(feed.id, {
    player: null,
    video: document.querySelector(`#video-${feed.id}`),
    tile: document.querySelector(`[data-feed-id="${feed.id}"]`),
    active: false,
    appliedQuality: null,
    userPaused: false,
    lastCt: -1,
    stallCount: 0,
    lastLoad: null,
    errorRetries: 0
  });
}

// Debug/testing handle (used by CDP verification scripts)
window.__feedState = feedState;

// Polyfill Shaka if present
if (window.shaka) {
  shaka.polyfill.installAll();
}

/* ========================================================
   EVENT LISTENERS & BINDINGS
   ======================================================== */
// Sidebar feed choices
document.querySelectorAll('[data-select-id]').forEach((button) => {
  button.addEventListener('click', () => {
    audioBooster.ensureContextRunning();
    selectFeed(button.dataset.selectId);
  });
});

// Grid feed tiles: clicking a tile in Multi-View selects it
document.querySelectorAll('.feed-tile').forEach((tile) => {
  tile.addEventListener('click', () => {
    const feedId = tile.dataset.feedId;
    const isGrid = stage.classList.contains('stage--grid');
    if (feedId && (feedId !== selectedFeedId || isGrid)) {
      audioBooster.ensureContextRunning();
      selectFeed(feedId);
      if (isGrid) {
        setLayout('single');
      }
    }
  });
});

// Floating Top PiP Button
if (topPipButton) {
  topPipButton.addEventListener('click', (e) => {
    e.stopPropagation();
    togglePictureInPicture();
  });
}

// Center "Tap to unmute" Overlay
if (unmuteOverlay) {
  unmuteOverlay.addEventListener('click', (e) => {
    e.stopPropagation();
    audioBooster.ensureContextRunning();
    audioBooster.setMuted(false);
    unmuteOverlay.hidden = true;
    const activeVideo = feedState.get(selectedFeedId)?.video;
    if (activeVideo && activeVideo.paused) {
      activeVideo.play().catch(() => {});
    }
  });
}

// Play / Pause Button
if (btnPlayPause) {
  btnPlayPause.addEventListener('click', (e) => {
    e.stopPropagation();
    audioBooster.ensureContextRunning();
    togglePlayPause();
  });
}

// Mute / Volume Button
if (btnVolume) {
  btnVolume.addEventListener('click', (e) => {
    e.stopPropagation();
    audioBooster.ensureContextRunning();
    const isMutedNow = audioBooster.toggleMute();
    if (!isMutedNow && unmuteOverlay) {
      unmuteOverlay.hidden = true;
    }
  });
}

// Volume Slider
if (volSlider) {
  volSlider.addEventListener('input', (e) => {
    const val = Number.parseFloat(e.target.value);
    audioBooster.ensureContextRunning();
    audioBooster.setVolume(val);
    if (val > 0 && unmuteOverlay) {
      unmuteOverlay.hidden = true;
    }
  });
}

// Theater / Miniplayer Button
if (btnTheater) {
  btnTheater.addEventListener('click', (e) => {
    e.stopPropagation();
    togglePictureInPicture();
  });
}

// Quality Selector Button & Dropdown Menu
if (btnQuality && qualityDropdown) {
  btnQuality.addEventListener('click', (e) => {
    e.stopPropagation();
    const isHidden = qualityDropdown.hidden;
    qualityDropdown.hidden = !isHidden;
    btnQuality.setAttribute('aria-expanded', String(!isHidden));
  });

  document.addEventListener('click', (e) => {
    if (!qualityDropdown.contains(e.target) && e.target !== btnQuality) {
      qualityDropdown.hidden = true;
      btnQuality.setAttribute('aria-expanded', 'false');
    }
  });

  qualityDropdown.querySelectorAll('.quality-menu-item').forEach((item) => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      const targetQuality = item.dataset.quality;
      setQuality(targetQuality);
      qualityDropdown.hidden = true;
      btnQuality.setAttribute('aria-expanded', 'false');
    });
  });
}

// Audio boost selector (1x – 3x)
if (btnBoost && boostDropdown) {
  const fmtBoost = (v) => `${v}x`;
  if (boostBadgeText) boostBadgeText.textContent = fmtBoost(audioBooster.boostFactor);
  boostDropdown.querySelectorAll('.quality-menu-item').forEach((item) => {
    item.classList.toggle('is-active', Number(item.dataset.boost) === audioBooster.boostFactor);
  });

  btnBoost.addEventListener('click', (e) => {
    e.stopPropagation();
    const isHidden = boostDropdown.hidden;
    boostDropdown.hidden = !isHidden;
    btnBoost.setAttribute('aria-expanded', String(!isHidden));
  });

  document.addEventListener('click', (e) => {
    if (!boostDropdown.contains(e.target) && e.target !== btnBoost) {
      boostDropdown.hidden = true;
      btnBoost.setAttribute('aria-expanded', 'false');
    }
  });

  boostDropdown.querySelectorAll('.quality-menu-item').forEach((item) => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      const val = Number(item.dataset.boost);
      boostDropdown.hidden = true;
      btnBoost.setAttribute('aria-expanded', 'false');
      if (!val) return;
      audioBooster.setBoost(val);
      if (boostBadgeText) boostBadgeText.textContent = fmtBoost(val);
      boostDropdown.querySelectorAll('.quality-menu-item').forEach((el) => {
        el.classList.toggle('is-active', Number(el.dataset.boost) === val);
      });
    });
  });
}

// Fullscreen Button
if (btnFullscreen) {
  btnFullscreen.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleFullscreen();
  });
}

document.addEventListener('fullscreenchange', updateFullscreenState);
document.addEventListener('webkitfullscreenchange', updateFullscreenState);

// Inactivity Auto-Hide for Controls
if (playerContainer) {
  const resetIdleTimer = () => {
    playerContainer.classList.remove('is-idle');
    clearTimeout(controlsIdleTimer);
    controlsIdleTimer = setTimeout(() => {
      if (qualityDropdown && !qualityDropdown.hidden) return; // keep visible if dropdown is open
      playerContainer.classList.add('is-idle');
      if (isMobilePlayerFullscreen()) {
        playerContainer.classList.remove('controls-visible');
      }
    }, 2000);
  };

  playerContainer.addEventListener('mousemove', resetIdleTimer);
  playerContainer.addEventListener('touchstart', resetIdleTimer, { passive: true });
  playerContainer.addEventListener('pointerdown', resetIdleTimer);
  stage?.addEventListener('click', () => {
    if (isMobilePlayerFullscreen()) {
      if (playerContainer.classList.toggle('controls-visible')) {
        resetIdleTimer();
      } else {
        clearTimeout(controlsIdleTimer);
      }
      return;
    }
    if (window.matchMedia('(pointer: coarse)').matches) {
      playerContainer.classList.remove('is-idle');
      resetIdleTimer();
    }
  });
  resetIdleTimer();
  playerContainer.addEventListener('mouseleave', () => {
    if (qualityDropdown && !qualityDropdown.hidden) return;
    playerContainer.classList.add('is-idle');
  });
}

// Header Clean View & Dialogs
document.querySelector('#clean-view-button')?.addEventListener('click', toggleCleanView);
document.querySelector('#close-dialog-button')?.addEventListener('click', closeSourceDialog);
document.querySelector('#cancel-dialog-button')?.addEventListener('click', closeSourceDialog);
sourceForm?.addEventListener('submit', connectFeed);

// Window dot fullscreen toggle
document.querySelector('#dot-fullscreen')?.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleFullscreen();
});

// Support button
document.querySelector('#btn-support')?.addEventListener('click', (e) => {
  e.stopPropagation();
  showMessage('Thank you for supporting PBB Live!');
});

// Initial Setup
selectFeed(selectedFeedId);
initializeLoader();
document.addEventListener('DOMContentLoaded', initializeBuiltInStreams, { once: true });

/* ========================================================
   INITIALIZE & LOAD STREAMS
   ======================================================== */
function initializeBuiltInStreams() {
  if (!window.shaka || !shaka.Player.isBrowserSupported()) {
    feeds.forEach(({ id }) => {
      const state = feedState.get(id);
      const status = state.tile.querySelector('.tile-state');
      if (status) {
        status.textContent = 'ERROR';
        status.classList.remove('is-live');
      }
      state.tile.querySelector('.video-empty').hidden = false;
      updateFeedSidebar();
    });
    showMessage('Shaka Player is unavailable or this browser does not support media playback.');
    return;
  }

  // Attach audio booster to all 4 video elements
  feeds.forEach((feed) => {
    const state = feedState.get(feed.id);
    if (state.video) {
      audioBooster.attachVideo(state.video);
    }
  });

  loadAllFeeds();
}

// Minimal Shaka-shaped wrapper around the vendored IosDashPlayer engine
// (ManagedMediaSource + WebCrypto AES-CTR client-side decrypt). Used on
// iOS/iPadOS where EME ClearKey is unavailable — segments are fetched
// straight from the CDN and decrypted in the browser, so the server does
// zero decrypt work.
class MmsFeedPlayer {
  constructor(video, cfg) {
    this.video = video;
    this.cfg = cfg;
    this.ios = new window.IosDashPlayer(video);
  }
  attach() { return Promise.resolve(); }
  configure() {}
  addEventListener(type, cb) {
    if (type === 'error') {
      this.ios.addEventListener('error', (e) => cb(e));
    }
    // 'trackschanged' intentionally unused — the engine manages its own ABR
  }
  getVariantTracks() { return []; }
  getVariantTracksSimple() { return []; }
  selectVariantTrack() {}
  async load(url) {
    await this.ios.load(url, this.cfg.kid, this.cfg.key, {
      targetHeight: this.cfg.targetHeight || 1080,
      autoQuality: this.cfg.autoQuality !== false,
      enableAudio: true
    });
  }
  async unload() { await this.ios.unload(); }
}

async function loadAllFeeds() {
  feedState.forEach((s) => { s.errorRetries = 0; });
  const useIosProxy = isIOSDevice();
  let iosProxyBaseUrl = null;

  if (useIosProxy) {
    playerContainer?.classList.add('is-ios-hls');
    try {
      iosProxyBaseUrl = getIosHlsProxyBaseUrl();
    } catch (error) {
      feeds.forEach(({ id }) => showIosHlsError(id, error));
      return;
    }
  }

  // Playback mode per device capability:
  //  - 'mms'      : client-side decrypt engine (iOS, Android, anything
  //                 without ClearKey but with MSE) — zero server load
  //  - 'clearkey' : browser EME decrypt straight from CDN (desktop)
  //  - 'proxy'    : last resort — server-side decrypt via /stream/
  const clearKeyOk = await supportsClearKey();
  const mmsOk = window.isMmsSupported ? window.isMmsSupported() :
    !!(window.isIosMmsSupported && window.isIosMmsSupported());
  const useIosMms = useIosProxy && window.isIosMmsSupported && window.isIosMmsSupported();

  const forcedMode = new URLSearchParams(window.location.search).get('mode') || window.__forceMode;
  let mode;
  if (forcedMode === 'proxy' || forcedMode === 'clearkey' || forcedMode === 'mms') {
    mode = forcedMode;
  } else if (useIosProxy) {
    // iOS has no ClearKey and the custom MMS decrypt engine produces
    // undecodable segments on the current Akamai encode — use the Worker's
    // server-side decrypt proxy (/stream/*.mpd serves clear DASH, played via
    // Shaka + ManagedMediaSource on iOS 17.1+).
    mode = 'proxy';
  } else if (isAndroidDevice()) {
    // Android Chrome/Firefox support ClearKey — prefer it over the custom
    // MMS engine, which emits corrupt segments on this encode.
    mode = clearKeyOk ? 'clearkey' : (mmsOk ? 'mms' : 'proxy');
  } else {
    // Desktop: always try ClearKey first — the support probe is unreliable
    // (false negatives on Edge), and the mode-fallback chain covers a real
    // failure by cycling to mms then proxy.
    mode = 'clearkey';
  }
  const prevMode = window.__pbMode;
  window.__pbMode = mode;
  // Mode switched (e.g. ClearKey/MMS → proxy fallback): the per-feed player
  // objects are typed by mode — tear them down so loadFeed rebuilds the
  // right engine instead of reusing a stale MMS wrapper on a proxy manifest.
  if (prevMode && prevMode !== mode) {
    for (const s of feedState.values()) {
      try { s.player && s.player.unload && s.player.unload(); } catch {}
      s.player = null;
      s.mms = null;
    }
  }

  Promise.all(feeds.map((feed) => {
    if (mode === 'mms' || mode === 'proxy') {
      const stream0 = builtInStreams[feed.id];
      // 'all' has a token-free CORS-open origin — let the MMS engine pull
      // the manifest + encrypted segments straight from Akamai.
      const u = (mode === 'mms' && stream0.directMpd)
        ? new URL(stream0.directMpd)
        : new URL(`${window.location.origin}/${mode === 'mms' ? 'manifest' : 'stream'}/${feed.id}.mpd`);
      if (!stream0.directMpd || mode !== 'mms') {
        if (window.PBB_SITE_KEY) u.searchParams.set('k', window.PBB_SITE_KEY);
      }
      if (mode === 'mms') {
        const stream = builtInStreams[feed.id];
        feedState.get(feed.id).mms = { kid: stream.kid, key: stream.keyAlt || stream.key };
      } else {
        feedState.get(feed.id).mms = null;
      }
      return loadFeed(feed.id, u, null, false);
    }

    const stream = builtInStreams[feed.id];
    const manifestUrl = stream.directMpd
      ? new URL(stream.directMpd)
      : new URL(`${window.location.origin}/manifest/${feed.id}.mpd`);
    if (!stream.directMpd) {
      if (window.PBB_SITE_KEY) manifestUrl.searchParams.set('k', window.PBB_SITE_KEY);
    }
    return loadFeed(feed.id, manifestUrl, {
      preferredKeySystems: ['org.w3.clearkey'],
      clearKeys: {
        [stream.kid]: stream.key,
        ...(stream.kidAlt ? { [stream.kidAlt]: stream.keyAlt || stream.key } : {})
      }
    }, false);
  }));
}

function buildTokenizedManifestUrl(stream) {
  const url = new URL(stream.url);
  if (stream.token) {
    url.searchParams.set('token', stream.token);
  }
  return url;
}

async function loadFeed(feedId, manifestUrl, drm = null, activateFeed = true) {
  if (isIOSDevice()) {
    playerContainer?.classList.add('is-ios-hls');
    if (manifestUrl.pathname.toLowerCase().endsWith('.m3u8')) {
      return loadIosHlsFeed(feedId, manifestUrl, activateFeed);
    }
  }

  const state = feedState.get(feedId);
  const status = state.tile.querySelector('.tile-state');
  const emptyState = state.tile.querySelector('.video-empty');

  if (status) {
    status.textContent = 'LOADING';
    status.classList.remove('is-live');
  }
  state.video.controls = false;
  state.active = false;
  state.appliedQuality = null;
  emptyState.hidden = false;
  updateFeedSidebar();

  try {
    if (!state.player) {
      if (state.mms && window.IosDashPlayer) {
        state.player = new MmsFeedPlayer(state.video, state.mms);
      } else {
      state.player = new shaka.Player();
      await state.player.attach(state.video);

      // Shaka ABR & Streaming Configuration
      state.player.configure({
        abr: {
          enabled: (currentQuality === 'auto'),
          defaultBandwidthEstimate: 25000000, // 25 Mbps — start at 1080p
          switchInterval: 2,
          bandwidthUpgradeTarget: 0.8,
          bandwidthDowngradeTarget: 0.6
        },
        dash: {
          ignoreSuggestedPresentationDelay: false // respect manifest-driven live delay — prevents edge stalls/freezes
        },
        streaming: {
          lowLatencyMode: true,
          rebufferingGoal: 2,
          bufferingGoal: 10,
          bufferBehind: 20,
          stallEnabled: true,
          stallThreshold: 1,
          stallSkip: 0.2,
          retryParameters: {
            maxAttempts: 5,
            baseDelay: 500,
            backoffFactor: 2,
            timeout: 10000
          }
        }
      });

      state.player.addEventListener('error', (event) => {
        showPlaybackError(feedId, event.detail);
      });

      state.player.addEventListener('trackschanged', () => {
        applyQualityToPlayer(state.player);
        if (feedId === selectedFeedId) {
          updateQualityMenu();
        }
      });
      }
      if (!state.videoErrorBound) {
        state.videoErrorBound = true;
        state.video.addEventListener('error', () => {
          const code = state.video.error?.code;
          showPlaybackError(feedId, { message: `Media error ${code}`, severity: 2, skipRetries: true });
        });
      }
    } else {
      await state.player.unload();
    }

    if (drm) {
      state.player.configure({ drm });
    }

    // Attach to AudioBooster
    audioBooster.attachVideo(state.video);

    // Initial state: muted for autoplay
    state.video.muted = true;
    await state.player.load(manifestUrl.href);

    state.active = true;
    state.lastLoad = { manifestUrl, drm };
    state.errorRetries = 0;
    state.video.controls = false;
    emptyState.hidden = true;
    if (status) {
      status.textContent = 'CONNECTED';
      status.classList.add('is-live');
    }
    updateFeedSidebar();

    if (activateFeed || feedId === selectedFeedId) {
      selectFeed(feedId);
    }

    // Apply current quality rule (e.g. locked 1080p or auto)
    applyQualityToPlayer(state.player);
    syncGridQualityCap();

    await state.video.play().catch(() => {
      // Autoplay blocked: user will tap "Tap to unmute" or play
    });

    syncPlaybackWithLayout();
    audioBooster.syncAllFeeds();
  } catch (error) {
    showPlaybackError(feedId, error);
  }
}

async function loadIosHlsFeed(feedId, manifestUrl, activateFeed) {
  const state = feedState.get(feedId);
  const status = state.tile.querySelector('.tile-state');
  const emptyState = state.tile.querySelector('.video-empty');
  const emptyMessage = emptyState.querySelector('span:last-child');
  const video = state.video;

  state.active = false;
  state.appliedQuality = null;
  video.controls = false;
  video.autoplay = true;
  video.defaultMuted = true;
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.setAttribute('playsinline', '');
  video.setAttribute('webkit-playsinline', '');
  video.setAttribute('muted', '');
  video.setAttribute('autoplay', '');
  emptyState.hidden = false;
  if (emptyMessage) {
    emptyMessage.textContent = 'Connecting feed...';
  }

  video.onloadedmetadata = () => {
    state.active = true;
    if (status) {
      status.textContent = 'CONNECTED';
      status.classList.add('is-live');
    }
    updateFeedSidebar();
    syncPlaybackWithLayout();
  };

  video.onplaying = () => {
    state.active = true;
    emptyState.hidden = true;
    if (status) {
      status.textContent = 'CONNECTED';
      status.classList.add('is-live');
    }
    updateFeedSidebar();
    updatePlayPauseUI();
  };

  video.onerror = () => {
    const code = video.error?.code;
    const message = code
      ? `HLS playback failed (media error ${code}). Check the proxy playlist and segments.`
      : 'HLS playback failed. Check the proxy playlist and segments.';
    showIosHlsError(feedId, new Error(message));
  };

  video.src = manifestUrl.href;
  video.load();

  if (activateFeed || feedId === selectedFeedId) {
    selectFeed(feedId);
  } else {
    syncPlaybackWithLayout();
  }

  if (activateFeed || feedId === selectedFeedId || stage.classList.contains('stage--grid')) {
    try {
      await video.play();
    } catch (error) {
      if (error.name === 'NotAllowedError') {
        if (emptyMessage) {
          emptyMessage.textContent = 'Tap Play to start this stream.';
        }
        showMessage('Autoplay was blocked. Tap Play to start the stream.');
      } else if (error.name !== 'AbortError') {
        showIosHlsError(feedId, error);
      }
    }
  }
}

function showIosHlsError(feedId, error) {
  const state = feedState.get(feedId);
  if (!state) return;

  const message = error?.message || 'iOS HLS playback is unavailable.';
  const emptyState = state.tile.querySelector('.video-empty');
  const emptyMessage = emptyState.querySelector('span:last-child');
  if (emptyMessage) {
    emptyMessage.textContent = message;
  }
  showPlaybackError(feedId, new Error(message));
}

function showPlaybackError(feedId, error) {
  const state = feedState.get(feedId);
  const status = state.tile.querySelector('.tile-state');
  const detail = error?.message || error?.code || 'Playback error';

  // Recoverable Shaka errors (single-segment 404s etc.) shouldn't nuke the feed
  if (error && typeof error.severity === 'number' && error.severity < 2) {
    console.warn(`[${feedId}] recoverable playback error:`, detail);
    return;
  }

  // Auto-reconnect: reload the same manifest/source a few times before
  // declaring the feed dead — transient CDN/manifest hiccups self-heal.
  state.errorRetries = error && error.skipRetries ? 99 : (state.errorRetries || 0) + 1;
  if (state.lastLoad && state.errorRetries <= 4) {
    if (status) {
      status.textContent = 'RECONNECTING';
      status.classList.remove('is-live');
    }
    setTimeout(() => {
      loadFeed(feedId, state.lastLoad.manifestUrl, state.lastLoad.drm, feedId === selectedFeedId)
        .catch(() => {});
    }, 1500 * state.errorRetries);
    return;
  }

  // Client modes flake differently per browser — cycle through every
  // playback engine (mms → clearkey → proxy) before declaring the feed dead.
  // On static hosts proxy 404s harmlessly; on Render it still works.
  const MODES = ['mms', 'clearkey', 'proxy'];
  window.__modeFallbacks = window.__modeFallbacks || 0;
  const curIdx = MODES.indexOf(window.__pbMode);
  if (curIdx >= 0 && window.__modeFallbacks < 2) {
    window.__modeFallbacks++;
    window.__forceMode = MODES[(curIdx + 1) % MODES.length];
    if (status) {
      status.textContent = 'SWITCHING';
      status.classList.remove('is-live');
    }
    loadAllFeeds().catch(() => {});
    return;
  }

  if (status) {
    status.textContent = 'ERROR';
    status.classList.remove('is-live');
  }
  state.active = false;
  state.video.controls = false;
  state.tile.querySelector('.video-empty').hidden = false;
  updateFeedSidebar();
  showMessage(`Could not load ${feeds.find((f) => f.id === feedId).name}: ${detail}`);
}

/* ========================================================
   FEED SELECTION & AUDIO ROUTING
   ======================================================== */
function selectFeed(feedId) {
  if (!feedState.has(feedId)) return;
  selectedFeedId = feedId;
  const feed = feeds.find((item) => item.id === feedId);

  // Update window title
  const isGrid = stage.classList.contains('stage--grid');
  const windowTitleText = document.querySelector('#window-title-text');
  if (windowTitleText) {
    windowTitleText.textContent = isGrid ? 'PBB Studio Multi-View' : `${feed.name} — Live`;
  }

  // Update tiles
  feedState.forEach((state, id) => {
    const selected = (id === feedId);
    state.tile.classList.toggle('is-selected', selected);
  });

  // Keep the user-selected quality locked on the newly selected feed
  const selectedState = feedState.get(feedId);
  if (selectedState) {
    selectedState.userPaused = false;
  }
  if (selectedState && selectedState.player) {
    applyQualityToPlayer(selectedState.player);
  }
  syncGridQualityCap();

  updateFeedSidebar();
  updatePlayPauseUI();
  updateQualityMenu();

  // Route boosted audio to selected feed & mute others
  audioBooster.syncAllFeeds();
  syncPlaybackWithLayout();
}

function updateFeedSidebar() {
  const isGrid = stage.classList.contains('stage--grid');
  feeds.forEach((feed) => {
    const isSelected = (feed.id === selectedFeedId);
    const card = document.querySelector(`[data-select-id="${feed.id}"]`);
    const badge = document.querySelector(`[data-feed-badge="${feed.id}"]`);
    if (card) {
      card.classList.toggle('is-active', !isGrid && isSelected);
    }
    if (badge) {
      if (!isGrid && isSelected) {
        badge.textContent = 'ON AIR';
        badge.className = 'feed-status-badge badge--on-air';
      } else {
        badge.textContent = 'HD';
        badge.className = 'feed-status-badge badge--hd';
      }
    }
  });
}

/* ========================================================
   QUALITY LOCK & FULLSCREEN LOSS PREVENTION
   ======================================================== */
function setQuality(quality) {
  currentQuality = quality;
  feedState.forEach((state) => {
    if (state.player) {
      applyQualityToPlayer(state.player);
    }
  });
  syncGridQualityCap();
  updateQualityMenu();
}

// Floor for AUTO quality: on a healthy link never drop below 1080p single-view
// or 720p multi-view; on a genuinely slow link (reported downlink < 15 Mbps)
// leave the floor at 0 so ABR can fall back to 360p/180p.
function autoQualityFloor() {
  const downlink = navigator.connection?.downlink;
  if (Number.isFinite(downlink) && downlink > 0 && downlink < 15) return 0;
  return stage.classList.contains('stage--grid') ? 720 : 1080;
}

function applyQualityToPlayer(player) {
  if (!player) return;

  const videoTracks = player.getVariantTracks()
    .filter((t) => Number.isFinite(t.height) && t.height > 0);

  if (currentQuality === 'auto') {
    // Adaptive with a high floor on good connections — ABR still protects
    // against real congestion, but won't settle on blurry low renditions.
    player.configure({
      abr: {
        enabled: true,
        defaultBandwidthEstimate: 40000000, // 40 Mbps — start at 1080p
        bandwidthUpgradeTarget: 0.9,        // upgrade eagerly toward top variant
        bandwidthDowngradeTarget: 0.5,      // downgrade only under real pressure
        switchInterval: 2,
        restrictions: { minHeight: autoQualityFloor(), maxHeight: Infinity }
      }
    });
    return;
  }

  {
    const height = Number.parseInt(currentQuality, 10);
    player.configure({
      abr: {
        enabled: false,
        restrictions: {
          minHeight: 0,
          maxHeight: height
        }
      }
    });

    const tracks = videoTracks
      .filter((t) => t.height <= height)
      .sort((a, b) => (b.height - a.height) || ((b.bandwidth || 0) - (a.bandwidth || 0)));

    if (tracks.length > 0) {
      player.selectVariantTrack(tracks[0], false);
    }
  }
}

function updateQualityMenu() {
  const badgeText = (currentQuality === 'auto') ? 'AUTO' : `${currentQuality}P`;
  if (qualityBadgeText) qualityBadgeText.textContent = badgeText;

  if (!qualityDropdown) return;
  qualityDropdown.querySelectorAll('.quality-menu-item').forEach((item) => {
    const isSelected = (item.dataset.quality === String(currentQuality));
    item.classList.toggle('is-active', isSelected);
  });
}

/* ========================================================
   PLAYBACK, MULTI-VIEW & LAYOUT
   ======================================================== */
function togglePlayPause() {
  const state = feedState.get(selectedFeedId);
  if (!state || !state.video) return;

  if (state.video.paused) {
    state.video.play().catch(() => {});
  } else {
    state.video.pause();
  }
  state.userPaused = state.video.paused;
  updatePlayPauseUI();
}

function updatePlayPauseUI() {
  const state = feedState.get(selectedFeedId);
  if (!state || !state.video || !btnPlayPause) return;

  const isPaused = state.video.paused;
  const iconPause = btnPlayPause.querySelector('.icon-pause');
  const iconPlay = btnPlayPause.querySelector('.icon-play');

  if (iconPause && iconPlay) {
    iconPause.hidden = isPaused;
    iconPlay.hidden = !isPaused;
  }
  btnPlayPause.setAttribute('aria-label', isPaused ? 'Play' : 'Pause');
  btnPlayPause.title = isPaused ? 'Play' : 'Pause';
}

function isTvDevice() {
  const ua = navigator.userAgent || '';
  return /SmartTV|Smart-TV|Tizen|Web0S|webOS|Android TV|GoogleTV|BRAVIA|HbbTV|NetCast|VIDAA|AFTS|AFTSS|Fire TV|TV Safari|Devant|Coocaa|Konka|Skyworth|HiSense|TCL|Philips|Sharp|JVC|Telefunken|Strong|Tesla|Blaupunkt|Metz|LOEWE|Technisat|iFFALCON|JOIN|NetTV/i.test(ua);
}

function isLowPowerPlaybackDevice() {
  return isTvDevice() ||
    (Number.isFinite(navigator.hardwareConcurrency) && navigator.hardwareConcurrency <= 4);
}

const GRID_QUALITY_CAP = 720;

function syncGridQualityCap() {
  const inGrid = stage.classList.contains('stage--grid');
  // Only auto-quality gets capped on weak devices; an explicit user choice is always honored.
  const cap = (inGrid && currentQuality === 'auto' && isLowPowerPlaybackDevice()) ? GRID_QUALITY_CAP : null;

  feedState.forEach((state) => {
    const player = state.player;
    if (!player) return;

    if (!cap) {
      if (state.gridCapped) {
        state.gridCapped = false;
        applyQualityToPlayer(player);
      } else if (currentQuality !== 'auto') {
        applyQualityToPlayer(player);
      }
      return;
    }

    state.gridCapped = true;
    player.configure({
      abr: {
        enabled: false,
        restrictions: { minHeight: 0, maxHeight: cap }
      }
    });

    const tracks = player.getVariantTracks()
      .filter((t) => Number.isFinite(t.height) && t.height > 0 && t.height <= cap)
      .sort((a, b) => (b.height - a.height) || ((b.bandwidth || 0) - (a.bandwidth || 0)));
    if (tracks.length > 0) {
      player.selectVariantTrack(tracks[0], false);
    }
  });
}

function setLayout(layout) {
  const singleView = (layout === 'single');
  stage.classList.toggle('stage--single', singleView);
  stage.classList.toggle('stage--grid', !singleView);

  const windowTitleText = document.querySelector('#window-title-text');
  const feed = feeds.find((item) => item.id === selectedFeedId);
  if (windowTitleText) {
    windowTitleText.textContent = singleView ? `${feed.name} — Live` : 'PBB Studio Multi-View';
  }

  if (btnMultiView) {
    btnMultiView.classList.toggle('is-active', !singleView);
  }

  syncGridQualityCap();
  syncPlaybackWithLayout();
  audioBooster.syncAllFeeds();
}

function syncPlaybackWithLayout() {
  const singleView = stage.classList.contains('stage--single');
  const lowPower = isLowPowerPlaybackDevice();
  // Some TV browsers can't resume MSE playback after pause() — on those devices
  // keep every feed decoding (muted) so Multi-View never has to resume them.
  const keepAlive = isTvDevice();
  let resumeIndex = 0;

  feedState.forEach((state, id) => {
    if (!state.active || !state.video) return;

    if (singleView && id !== selectedFeedId) {
      if (!keepAlive && !state.video.paused) {
        state.video.pause();
      }
      return;
    }

    if (state.video.paused && !state.userPaused) {
      // On weak devices (smart TVs), stagger resumes so decoders aren't hit all at once
      const delay = (lowPower && !singleView) ? resumeIndex * 400 : 0;
      resumeIndex += 1;
      setTimeout(() => {
        if (!state.video || !state.video.paused || state.userPaused) return;
        state.video.play().catch((err) => {
          console.warn(`[${id}] play() rejected:`, err?.name, err?.message);
          // Retry once — decoder/bandwidth may still be busy
          setTimeout(() => {
            if (state.video && state.video.paused && !state.userPaused) {
              state.video.play().catch(() => {});
            }
          }, 1200);
        });
      }, delay);
    }
  });

  setTimeout(updatePlayPauseUI, 100);
}

/* ========================================================
   STALL WATCHDOG — auto-recover frozen/paused feeds
   ======================================================== */
setInterval(() => {
  if (document.hidden) return;
  const singleView = stage.classList.contains('stage--single');

  feedState.forEach((state, id) => {
    if (!state.active || !state.video) return;

    const shouldPlay = !state.userPaused &&
      (!singleView || id === selectedFeedId || isTvDevice());

    // Case 1: feed should be playing but video element got paused
    // (missed resume, rejected play(), decoder hiccup). Just nudge it.
    if (shouldPlay && state.video.paused) {
      state.video.play().catch(() => {});
      return;
    }

    // Case 2: playing but currentTime frozen — stalled on dead segments
    // (period rollover, CDN gap). Reload the manifest to recover.
    if (id === selectedFeedId && shouldPlay && !state.video.paused) {
      const ct = state.video.currentTime;
      if (Math.abs(ct - state.lastCt) < 0.05) {
        state.stallCount += 1;
      } else {
        state.stallCount = 0;
      }
      state.lastCt = ct;

      if (state.stallCount >= 3 && state.lastLoad) {
        state.stallCount = 0;
        console.warn(`[${id}] playback frozen for ~12s — reloading manifest`);
        loadFeed(id, state.lastLoad.manifestUrl, state.lastLoad.drm, id === selectedFeedId)
          .catch(() => {});
      }
    }
  });
}, 4000);

/* ========================================================
   AUDIO UI UPDATES
   ======================================================== */
function updateAudioUI() {
  if (!btnVolume) return;
  const isMuted = audioBooster.isMuted || audioBooster.globalVolume === 0;

  const iconHigh = btnVolume.querySelector('.icon-vol-high');
  const iconMute = btnVolume.querySelector('.icon-vol-mute');

  if (iconHigh && iconMute) {
    iconHigh.hidden = isMuted;
    iconMute.hidden = !isMuted;
  }
  btnVolume.setAttribute('aria-label', isMuted ? 'Unmute' : 'Mute');
  btnVolume.title = isMuted ? 'Unmute' : 'Mute';

  if (volSlider) {
    volSlider.value = isMuted ? 0 : audioBooster.globalVolume;
    const pct = Math.round(volSlider.value * 100);
    volSlider.style.background = `linear-gradient(to right, #ffffff 0%, #ffffff ${pct}%, rgba(255,255,255,0.28) ${pct}%, rgba(255,255,255,0.28) 100%)`;
  }

  if (unmuteOverlay) {
    unmuteOverlay.hidden = !isMuted;
  }
}

/* ========================================================
   FULLSCREEN & PICTURE-IN-PICTURE
   ======================================================== */
async function toggleFullscreen() {
  try {
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      if (document.exitFullscreen) {
        await document.exitFullscreen();
      } else if (document.webkitExitFullscreen) {
        await document.webkitExitFullscreen();
      }
      return;
    }

    // iPhone/iPad Safari has no element fullscreen API — use the video's
    // native fullscreen instead (auto-rotates to landscape, native controls).
    if (isIOSDevice()) {
      const v = feedState.get(selectedFeedId)?.video;
      if (v && v.webkitEnterFullscreen) {
        v.webkitEnterFullscreen();
        return;
      }
    }

    // Go fullscreen on the unified playerContainer so controls & unmute overlay remain accessible!
    if (playerContainer.requestFullscreen) {
      await playerContainer.requestFullscreen();
    } else if (playerContainer.webkitRequestFullscreen) {
      await playerContainer.webkitRequestFullscreen();
    } else {
      showMessage('Fullscreen is not supported by this browser.');
    }
  } catch (error) {
    showMessage(`Could not toggle fullscreen: ${error.message}`);
  }
}

function updateFullscreenState() {
  const isFs = Boolean(document.fullscreenElement || document.webkitFullscreenElement);
  if (isFs !== wasFullscreen) {
    wasFullscreen = isFs;
    if (playerContainer) {
      playerContainer.classList.remove('controls-visible', 'is-idle');
      clearTimeout(controlsIdleTimer);
    }
    const orientation = window.screen && window.screen.orientation;
    if (isFs && orientation && typeof orientation.lock === 'function') {
      try {
        const lockRequest = orientation.lock('landscape');
        if (lockRequest && typeof lockRequest.catch === 'function') {
          lockRequest.catch(handleOrientationLockError);
        }
      } catch (error) {
        handleOrientationLockError(error);
      }
    } else if (isFs && window.matchMedia('(max-width: 960px), (max-height: 520px)').matches) {
      showMessage('Automatic rotation is unavailable in this browser. Rotate your device for landscape fullscreen.');
    } else if (!isFs && orientation && typeof orientation.unlock === 'function') {
      orientation.unlock();
    }
  }

  if (!btnFullscreen) return;

  const iconEnter = btnFullscreen.querySelector('.icon-fs-enter');
  const iconExit = btnFullscreen.querySelector('.icon-fs-exit');

  if (iconEnter && iconExit) {
    iconEnter.hidden = isFs;
    iconExit.hidden = !isFs;
  }
  btnFullscreen.setAttribute('aria-label', isFs ? 'Exit Fullscreen' : 'Fullscreen');
  btnFullscreen.title = isFs ? 'Exit Fullscreen' : 'Fullscreen';

  // Ensure locked quality is re-verified upon entering/exiting fullscreen
  const activeState = feedState.get(selectedFeedId);
  if (activeState && activeState.player) {
    applyQualityToPlayer(activeState.player);
  }
}

function isMobilePlayerFullscreen() {
  const fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement;
  return fullscreenElement === playerContainer &&
    window.matchMedia('(max-width: 960px), (max-height: 520px)').matches;
}

function handleOrientationLockError(error) {
  console.warn('Unable to lock landscape orientation:', error);
  if (window.matchMedia('(max-width: 960px), (max-height: 520px)').matches) {
    showMessage('Automatic rotation was blocked. Rotate your device for landscape fullscreen.');
  }
}

async function togglePictureInPicture() {
  const state = feedState.get(selectedFeedId);
  if (!state || !state.active || !state.video) {
    showMessage('Wait for the feed to load before using Picture-in-Picture.');
    return;
  }

  try {
    if (document.pictureInPictureElement) {
      await document.exitPictureInPicture();
    } else if (document.pictureInPictureEnabled && state.video.requestPictureInPicture) {
      await state.video.requestPictureInPicture();
    } else {
      showMessage('Picture-in-picture is not supported on this device/browser.');
    }
  } catch (error) {
    showMessage(`Could not open Picture-in-Picture: ${error.message}`);
  }
}

/* ========================================================
   CUSTOM STREAM DIALOG & CLEAN VIEW
   ======================================================== */
function openSourceDialog(feedId) {
  pendingFeedId = feedId;
  const feed = feeds.find((item) => item.id === feedId);
  document.querySelector('#dialog-title').textContent = `Connect ${feed.name}`;
  sourceError.hidden = true;
  manifestInput.value = '';
  dialog.showModal();
  manifestInput.focus();
}

function closeSourceDialog() {
  dialog.close();
  pendingFeedId = null;
  sourceError.hidden = true;
}

async function connectFeed(event) {
  event.preventDefault();
  sourceError.hidden = true;

  const manifestUrl = parsePublicManifestUrl(manifestInput.value);
  if (!manifestUrl) {
    sourceError.textContent = 'Use a valid HTTPS manifest URL without query strings, fragments, or embedded credentials.';
    sourceError.hidden = false;
    return;
  }

  const feedId = pendingFeedId;
  closeSourceDialog();
  await loadFeed(feedId, manifestUrl);
}

function parsePublicManifestUrl(value) {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

function toggleCleanView() {
  const cleanView = document.body.classList.toggle('clean-view');
  document.querySelector('#clean-view-button')?.setAttribute('aria-pressed', String(cleanView));
}

/* ========================================================
   LOADER & MESSAGING
   ======================================================== */
function initializeLoader() {
  if (!siteLoader || !loaderProgress || !loaderProgressBar || !loaderProgressText || !loaderEnterButton) {
    return;
  }

  const loaderCustomImage = document.querySelector('#loader-custom-image');
  const loaderDefaultMark = document.querySelector('#loader-default-mark');
  if (loaderCustomImage && loaderDefaultMark) {
    const showCustomImage = () => {
      loaderCustomImage.hidden = false;
      loaderDefaultMark.hidden = true;
    };
    const showDefaultMark = () => {
      loaderCustomImage.hidden = true;
      loaderDefaultMark.hidden = false;
    };

    if (loaderCustomImage.complete) {
      if (loaderCustomImage.naturalWidth > 0) {
        showCustomImage();
      } else {
        showDefaultMark();
      }
    } else {
      loaderCustomImage.addEventListener('load', showCustomImage, { once: true });
      loaderCustomImage.addEventListener('error', showDefaultMark, { once: true });
    }
  }

  const startedAt = performance.now();
  const minimumDuration = 2400;
  const maximumDuration = 10000;
  let displayedProgress = 0;

  const tick = () => {
    const elapsed = performance.now() - startedAt;
    const settledCount = feeds.filter((feed) => {
      const state = feedState.get(feed.id);
      return state.active || state.tile.querySelector('.tile-state')?.textContent === 'ERROR';
    }).length;
    const settledFraction = settledCount / feeds.length;
    const timeFraction = Math.min(1, elapsed / minimumDuration);
    const targetProgress = Math.min(0.95, Math.max(timeFraction * 0.95, settledFraction * 0.95));
    displayedProgress += (targetProgress - displayedProgress) * 0.1;
    if (Math.abs(targetProgress - displayedProgress) < 0.002) {
      displayedProgress = targetProgress;
    }
    setLoaderProgress(displayedProgress);

    if ((elapsed >= minimumDuration && settledCount === feeds.length) || elapsed >= maximumDuration) {
      completeLoader();
      return;
    }
    requestAnimationFrame(tick);
  };

  requestAnimationFrame(tick);
  loaderEnterButton.addEventListener('click', () => {
    audioBooster.ensureContextRunning();
    setLayout('single');
    siteLoader.classList.add('is-leaving');
    window.setTimeout(() => {
      siteLoader.hidden = true;
    }, 460);
  }, { once: true });
}

function setLoaderProgress(value) {
  const percent = Math.max(0, Math.min(100, Math.round(value * 100)));
  loaderProgressBar.style.width = `${percent}%`;
  loaderProgressText.textContent = `${percent}%`;
  loaderProgress.setAttribute('aria-valuenow', String(percent));
}

function completeLoader() {
  setLoaderProgress(100);
  siteLoader.classList.add('is-complete');
  loaderEnterButton.hidden = false;
}

function showMessage(message) {
  if (appMessage) appMessage.textContent = message;
}
