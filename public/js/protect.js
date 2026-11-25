// Client-side protection layer — deters casual inspection and scraping.
// NOTE: determined attackers can bypass any client-side check; this is
// obfuscation, not security.
(function () {
  'use strict';

  var blocked = false;
  var BLOCK_URL = '/blocked.html';

  function block() {
    if (blocked) return;
    blocked = true;
    try { window.location.replace(BLOCK_URL); } catch (e) {}
    setTimeout(function () { try { window.location.href = BLOCK_URL; } catch (e) {} }, 500);
  }

  // --- 1. DevTools open detection (window chrome size heuristic) ---
  var SIZE_THRESHOLD = 170;
  function sizeCheck() {
    var w = window.outerWidth - window.innerWidth;
    var h = window.outerHeight - window.innerHeight;
    if (w > SIZE_THRESHOLD || h > SIZE_THRESHOLD) block();
  }
  setInterval(sizeCheck, 1200);
  window.addEventListener('resize', sizeCheck);

  // --- 2. Debugger timing trap ---
  // `debugger` pauses when devtools is open, making this delta large.
  setInterval(function () {
    var t0 = performance.now();
    try { (function () { debugger; })(); } catch (e) {}
    if (performance.now() - t0 > 250) block();
  }, 2000);

  // --- 3. Keyboard shortcuts: F12, Ctrl+Shift+I/J/C, Ctrl+U, Ctrl+S ---
  document.addEventListener('keydown', function (e) {
    var k = e.key || '';
    if (k === 'F12' ||
        (e.ctrlKey && e.shiftKey && /[IJCK]/i.test(k)) ||
        (e.ctrlKey && /[us]/i.test(k)) ||
        (e.metaKey && e.altKey && /[ij]/i.test(k))) {
      e.preventDefault();
      e.stopPropagation();
      block();
    }
  }, true);

  // --- 4. Context menu (right-click inspect) ---
  document.addEventListener('contextmenu', function (e) {
    e.preventDefault();
    return false;
  }, true);

  // --- 5. Console spoofing — fake warnings only, never reload ---
  // (Auto-reload on console use caused reload loops — players log constantly.)
  var fakeMsgs = [
    '%cStop!', 'color:#f00;font-size:20px;font-weight:bold',
    'This browser console is restricted.',
    '%cIf someone told you to paste something here, it is a scam. DO NOT PASTE ANYTHING HERE.',
    'color:#888;font-size:12px',
    'Protected content — debugging disabled.'
  ];
  try {
    var origLog = console.log;
    var spam = function () {
      try { origLog.apply(console, fakeMsgs); } catch (e) {}
    };
    ['log', 'warn', 'error', 'info', 'debug'].forEach(function (m) {
      try { console[m] = spam; } catch (e) {}
    });
  } catch (e) {}

  // --- 6. Detect devtools via console getter side-channel ---
  try {
    var el = new Image();
    Object.defineProperty(el, 'id', {
      get: function () { block(); return ''; }
    });
    setInterval(function () {
      try { console.log(el); console.clear(); } catch (e) {}
    }, 3000);
  } catch (e) {}
})();
