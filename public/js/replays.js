/* PBB Collab 3.0 Extra On-Demand — replay browser + DRM player.
   Talks to the Worker's /api/replay/* proxy which handles iWantTFC
   sessions, token refresh and license forwarding. */
(function () {
  'use strict';

  const state = {
    episodes: [],
    player: null,
    currentEp: null,
  };

  const listEl = document.getElementById('replay-list');
  const modalEl = document.getElementById('replay-modal');
  const videoEl = document.getElementById('replay-video');
  const statusEl = document.getElementById('replay-status');
  const titleEl = document.getElementById('replay-title-text');

  if (!listEl || !modalEl || !videoEl) return;

  function fmtDuration(sec) {
    sec = Math.max(0, Math.round(sec || 0));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const mm = String(m).padStart(2, '0');
    const ss = String(s).padStart(2, '0');
    return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
  }

  function render() {
    if (!state.episodes.length) {
      listEl.innerHTML = '<p class="replay-empty">No episodes available right now.</p>';
      return;
    }
    listEl.innerHTML = state.episodes.map((ep, i) => `
      <button class="replay-card" type="button" data-ep="${ep.id}" ${ep.playable ? '' : 'disabled'}>
        <div class="replay-thumb">
          ${ep.image ? `<img src="${ep.image}" alt="" loading="lazy" onerror="this.remove()">` : ''}
          <span class="replay-play-badge" aria-hidden="true">
            <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
          </span>
          <span class="replay-dur">${fmtDuration(ep.duration)}</span>
          <span class="replay-ep-num">EP ${i + 1}</span>
        </div>
        <div class="replay-meta">
          <strong class="replay-name">${escapeHtml(ep.title)}</strong>
          <span class="replay-sub">${escapeHtml(ep.label)}</span>
        </div>
      </button>`).join('');

    listEl.querySelectorAll('.replay-card').forEach((card) => {
      card.addEventListener('click', () => openReplay(card.dataset.ep));
    });
  }

  function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function isIos() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text || '';
  }

  async function openReplay(epId) {
    const ep = state.episodes.find((e) => e.id === epId);
    state.currentEp = ep || null;
    if (titleEl) titleEl.textContent = ep ? `${ep.title} — ${ep.label}` : 'Replay';
    modalEl.hidden = false;
    document.body.classList.add('replay-open');
    setStatus('Loading replay...');
    videoEl.controls = true;
    videoEl.muted = true;

    try {
      await ensurePlayer();
      const kind = isIos() ? 'fp' : 'wv';
      const sessRes = await fetch(`/api/replay/session?id=${encodeURIComponent(epId)}&kind=${kind}`);
      if (!sessRes.ok) throw new Error('session ' + sessRes.status);
      const sess = await sessRes.json();

      const drm = {};
      if (kind === 'fp') {
        drm.servers = { 'com.apple.fps': sess.license };
        drm.advanced = { 'com.apple.fps.serverCertificateUri': 'https://mcnassets.akamaized.net/Test/fairplay.cer' };
      } else {
        drm.servers = { 'com.widevine.alpha': sess.license };
      }
      state.player.configure({ drm });
      await state.player.unload();
      await state.player.load(new URL(sess.manifest, window.location.origin).href);
      setStatus('');
      videoEl.play().catch(() => { /* autoplay blocked — user presses play */ });
    } catch (err) {
      console.error('[replay]', err);
      setStatus('Could not load this replay. Please try again.');
    }
  }

  async function ensurePlayer() {
    if (state.player) return;
    if (!window.shaka || !shaka.Player.isBrowserSupported()) {
      throw new Error('browser unsupported');
    }
    shaka.polyfill.installAll();
    state.player = new shaka.Player();
    await state.player.attach(videoEl);
    state.player.configure({
      abr: { enabled: true, defaultBandwidthEstimate: 5000000 },
      streaming: {
        bufferingGoal: 15,
        rebufferingGoal: 3,
        bufferBehind: 30,
        retryParameters: { maxAttempts: 5, baseDelay: 500, backoffFactor: 2, timeout: 15000 },
      },
    });
    state.player.addEventListener('error', (e) => {
      console.error('[replay shaka]', e.detail);
      setStatus('Playback error — try another episode.');
    });
  }

  async function closeReplay() {
    modalEl.hidden = true;
    document.body.classList.remove('replay-open');
    videoEl.pause();
    if (state.player) {
      try { await state.player.unload(); } catch {}
    }
    state.currentEp = null;
  }

  document.getElementById('replay-close')?.addEventListener('click', closeReplay);
  modalEl.querySelector('.replay-modal-backdrop')?.addEventListener('click', closeReplay);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modalEl.hidden) closeReplay();
  });

  // Load episode list once the sidebar exists
  fetch('/api/replays')
    .then((r) => r.json())
    .then((d) => { state.episodes = d.episodes || []; render(); })
    .catch(() => {
      listEl.innerHTML = '<p class="replay-empty">Replays are unavailable right now.</p>';
    });
})();
