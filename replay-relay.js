/* PBB replay session relay — tiny zero-dependency Node server.
   iWantTFC's entitlement API (EPS) blocks Cloudflare Worker IPs
   ("Access blocked due to VPN or proxy usage") but allows normal
   datacenter IPs. This relay performs the playback/start call and
   returns the stream session as JSON. Deploy on Render/free tier.

   GET /session?id=<episodeUuid>&kind=wv|fp
   -> { contentBase, tokenQuery, licenseUrl, manifest }
*/

const http = require('http');
const crypto = require('crypto');

const IW_ENTITLEMENT = 'https://api.iwanttfc.com/entitlement';
const IW_IDENTITY = 'https://api.iwanttfc.com/identity';
const IW_HEADERS = {
  'Content-Type': 'application/json',
  'Accept': 'application/json',
  'x-country-code': 'PH',
  'x-device-platform': 'web',
  'x-iw-useragent': 'iWant=3.0.0; Platform=web; OSVersion=; Model=chrome; BuildType=release; Environment=production',
  'Origin': 'https://www.iwanttfc.com',
  'Referer': 'https://www.iwanttfc.com/',
};

// EPS requires a logged-in iWant user from datacenter IPs. The refresh
// token (from iwanttfc.com localStorage) mints access tokens forever.
const REFRESH_TOKEN = process.env.IWANT_REFRESH_TOKEN || '';
let cachedAccessToken = null;
let accessTokenExp = 0;

async function getAccessToken() {
  if (!REFRESH_TOKEN) return null;
  if (cachedAccessToken && Date.now() < accessTokenExp - 60_000) return cachedAccessToken;
  const res = await fetch(`${IW_IDENTITY}/api/iam/refresh?api-version=1.2`, {
    method: 'POST',
    headers: IW_HEADERS,
    body: JSON.stringify({ token: REFRESH_TOKEN, country: 'PH' }),
  });
  if (!res.ok) throw new Error('token refresh ' + res.status);
  const json = await res.json();
  const data = json.data || {};
  if (!data.accessToken) throw new Error('no access token in refresh response');
  cachedAccessToken = data.accessToken;
  // Decode exp claim (JWT payload) — refresh 1 min early
  try {
    const payload = JSON.parse(Buffer.from(cachedAccessToken.split('.')[1], 'base64url').toString());
    accessTokenExp = (payload.exp || 0) * 1000;
  } catch { accessTokenExp = Date.now() + 30 * 60_000; }
  return cachedAccessToken;
}

const KINDS = {
  wv: { drm: ['wv'], streamType: ['dash'], subPlatform: 'chrome', manifest: 'manifest.mpd' },
  fp: { drm: ['fp'], streamType: ['hls'], subPlatform: 'safari', manifest: 'master.m3u8' },
};

// Tiny in-memory cache — tokens live ~60s, refresh a bit early.
const cache = new Map();
const TTL_MS = 45_000;

async function startPlayback(epId, kind) {
  const k = KINDS[kind];
  const body = {
    platform: 'web',
    subPlatform: k.subPlatform,
    appVersion: '3.0.0',
    appVersionCode: 1,
    playbackSessionId: crypto.randomUUID(),
    playbackCapabilities: {
      drm: k.drm,
      streamType: k.streamType,
      resolution: ['fhd', 'hd', 'sd'],
      audio: ['stereo'],
      hdr: ['hdr10'],
    },
    networkType: 'wifi',
    deviceId: '',
    referralProperties: { pageName: 'details' },
  };
  const url = `${IW_ENTITLEMENT}/playback/start/${epId}?offline=false&country=PH&contentId=${epId}&platform=web&subPlatform=${k.subPlatform}`;
  const headers = { ...IW_HEADERS };
  const accessToken = await getAccessToken();
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`playback/start ${res.status}: ${text.slice(0, 200)}`);
  const json = JSON.parse(text);
  const streamUrl = json.playbackInfo && json.playbackInfo.url;
  const licenseUrl = (json.playbackInfo && json.playbackInfo.licenseUrl) || '';
  if (!streamUrl) throw new Error('no stream url in response');
  const qIdx = streamUrl.indexOf('?');
  return {
    contentBase: qIdx >= 0 ? streamUrl.slice(0, qIdx).replace(/[^/]+$/, '') : streamUrl.replace(/[^/]+$/, ''),
    tokenQuery: qIdx >= 0 ? streamUrl.slice(qIdx) : '',
    licenseUrl,
    fetchedAt: Date.now(),
  };
}

async function getSession(epId, kind) {
  const key = `${epId}:${kind}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.fetchedAt < TTL_MS) return hit;
  if (hit && hit.pending) return hit.pending;
  const pending = startPlayback(epId, kind)
    .then((fresh) => { cache.set(key, fresh); return fresh; });
  cache.set(key, { ...(hit || {}), pending });
  try { return await pending; }
  finally {
    const cur = cache.get(key);
    if (cur && cur.pending === pending) delete cur.pending;
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end('{"ok":true}');
  }

  if (url.pathname === '/session' && req.method === 'GET') {
    const epId = url.searchParams.get('id') || '';
    const kind = url.searchParams.get('kind') === 'fp' ? 'fp' : 'wv';
    if (!/^[0-9a-f-]{36}$/i.test(epId)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end('{"error":"bad episode id"}');
    }
    try {
      const s = await getSession(epId, kind);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({
        contentBase: s.contentBase,
        tokenQuery: s.tokenQuery,
        licenseUrl: s.licenseUrl,
        manifest: KINDS[kind].manifest,
      }));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  res.writeHead(404); res.end('not found');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`replay relay on :${PORT}`));
