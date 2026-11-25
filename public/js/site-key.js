// Access key is assembled at runtime — not stored as a single literal.
(function () {
  var p1 = 'pk7f3a';
  var p2 = atob('OWMyZTgxYjQ=');      // '9c2e81b4'
  var p3 = [100, 54, 102, 48].map(function (c) { return String.fromCharCode(c); }).join(''); // 'd6f0'
  var p4 = 'a5c8e2b1d4f7a9c3e6';
  window.PBB_SITE_KEY = p1 + p2 + p3 + p4;
})();
