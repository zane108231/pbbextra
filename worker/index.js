    function z(data) { return new DataView(data.buffer, data.byteOffset, data.byteLength); }
    function P(data, offset) { return z(data).getUint32(offset); }
    function U(data, offset) { return z(data).getUint16(offset); }
    function T(data, offset) { return Number(z(data).getBigUint64(offset)); }
    function R(data, offset, val) { z(data).setUint32(offset, val >>> 0); }
    function I(data, offset, val) { z(data).setBigUint64(offset, BigInt(val)); }

    function D(arrays) {
        let total = 0;
        for (let i = 0; i < arrays.length; i++) total += arrays[i].length;
        let out = new Uint8Array(total), pos = 0;
        for (let i = 0; i < arrays.length; i++) {
            out.set(arrays[i], pos);
            pos += arrays[i].length;
        }
        return out;
    }

    function B(data, start, end) {
        let boxes = [], offset = start;
        while (offset + 8 <= end) {
            let size = P(data, offset);
            let typ = String.fromCharCode(data[offset + 4], data[offset + 5], data[offset + 6], data[offset + 7]);
            let hdr = 8;
            if (size === 1) { size = T(data, offset + 8); hdr = 16; }
            else if (size === 0) { size = end - offset; }
            if (size < hdr || offset + size > end) break;
            boxes.push({ typ, offset, size, hdr });
            offset += size;
        }
        return boxes;
    }

    function O(data, path, start = 0, end = null) {
        let currentLimit = [{ offset: start, size: (end === null ? data.length : end) - start, hdr: 0, typ: "" }];
        let result = [];
        for (let i = 0; i < path.length; i++) {
            let targetTyp = path[i], found = null;
            for (let j = 0; j < currentLimit.length; j++) {
                let container = currentLimit[j];
                let subBoxes = B(data, container.offset, container.offset + container.size);
                for (let k = 0; k < subBoxes.length; k++) {
                    if (subBoxes[k].typ === targetTyp) { found = subBoxes[k]; break; }
                }
                if (found) break;
            }
            if (!found) return null;
            result.push({ typ: found.typ, offset: found.offset + found.hdr, size: found.size - found.hdr, hdr: 0 });
            currentLimit = [{ offset: found.offset + found.hdr, size: found.size - found.hdr, hdr: 0, typ: found.typ }];
        }
        return result;
    }

    function F(data, start, end, depth = 0) {
        let list = [], boxes = B(data, start, end);
        for (let i = 0; i < boxes.length; i++) {
            let box = boxes[i];
            list.push(box);
            if (depth >= 8) continue;
            let typ = box.typ, children = null;
            if (["moov", "trak", "mdia", "minf", "stbl", "edts", "dinf", "mvex"].includes(typ)) {
                children = F(data, box.offset + box.hdr, box.offset + box.size, depth + 1);
            } else if (typ === "stsd") {
                children = F(data, box.offset + box.hdr + 8, box.offset + box.size, depth + 1);
            } else if (typ === "encv" || typ === "avc1") {
                children = F(data, box.offset + box.hdr + 78, box.offset + box.size, depth + 1);
            } else if (typ === "enca" || typ === "mp4a") {
                children = F(data, box.offset + box.hdr + 28, box.offset + box.size, depth + 1);
            } else if (["encs", "dfxp", "stpp", "wvtt", "tx3g"].includes(typ)) {
                children = F(data, box.offset + box.hdr + 8, box.offset + box.size, depth + 1);
            }
            if (children) {
                for (let j = 0; j < children.length; j++) list.push(children[j]);
            }
        }
        return list;
    }

    function H(data, targetBox) {
        let allBoxes = F(data, 0, data.length);
        data.copyWithin(targetBox.offset, targetBox.offset + targetBox.size);
        for (let i = 0; i < allBoxes.length; i++) {
            let box = allBoxes[i];
            if (box.offset < targetBox.offset && box.offset + box.size >= targetBox.offset + targetBox.size) {
                if (box.size === 1) I(data, box.offset + 8, T(data, box.offset + 8) - targetBox.size);
                else R(data, box.offset, box.size - targetBox.size);
            }
        }
        return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.length - targetBox.size));
    }

    function $(typ, payload) {
        let box = new Uint8Array(8 + payload.length);
        R(box, 0, box.length);
        box[4] = typ.charCodeAt(0); box[5] = typ.charCodeAt(1); box[6] = typ.charCodeAt(2); box[7] = typ.charCodeAt(3);
        box.set(payload, 8);
        return box;
    }

    // 3. Clear MP4 Init Segment Sanitizer
    function cleanInitSegment(initBytes) {
        let data = new Uint8Array(initBytes);
        let moovPath = O(data, ["moov"]);
        if (!moovPath) return data;

        let textTracks = [], disabledTracks = {};
        let moovBoxes = B(data, moovPath[0].offset, moovPath[0].offset + moovPath[0].size);
        for (let i = 0; i < moovBoxes.length; i++) {
            let box = moovBoxes[i];
            if (box.typ !== "trak") continue;
            let stsdPath = O(data, ["mdia", "minf", "stbl", "stsd"], box.offset + box.hdr, box.offset + box.size);
            if (!stsdPath) continue;
            let lastStsd = stsdPath[stsdPath.length - 1];
            let entries = B(data, lastStsd.offset + lastStsd.hdr + 8, lastStsd.offset + lastStsd.size);
            for (let j = 0; j < entries.length; j++) {
                let entry = entries[j];
                if (["dfxp", "stpp", "wvtt", "tx3g", "encs"].includes(entry.typ)) {
                    textTracks.push({ offset: box.offset, size: box.size, hdr: box.hdr, typ: box.typ });
                    let tkhdPath = O(data, ["tkhd"], box.offset + box.hdr, box.offset + box.size);
                    if (tkhdPath) {
                        let tkhd = tkhdPath[0];
                        let ver = data[tkhd.offset];
                        let trackId = P(data, tkhd.offset + (ver === 0 ? 12 : 20));
                        disabledTracks[trackId] = 1;
                    }
                    break;
                }
            }
        }

        textTracks.sort((a, b) => b.offset - a.offset);
        for (let i = 0; i < textTracks.length; i++) {
            data = H(data, textTracks[i]);
        }

        let mvexPath = O(data, ["moov", "mvex"]);
        if (mvexPath) {
            let mvex = mvexPath[mvexPath.length - 1];
            let trexList = B(data, mvex.offset, mvex.offset + mvex.size).reverse();
            for (let i = 0; i < trexList.length; i++) {
                let trex = trexList[i];
                if (trex.typ === "trex") {
                    let trackId = P(data, trex.offset + trex.hdr + 4);
                    if (trackId !== 0 && disabledTracks[trackId]) data = H(data, trex);
                }
            }
        }

        moovPath = O(data, ["moov"]);
        if (!moovPath) return data;

        let moov = moovPath[0];
        let sinfBoxes = [];
        let trakBoxes = B(data, moov.offset, moov.offset + moov.size);
        for (let i = 0; i < trakBoxes.length; i++) {
            let trak = trakBoxes[i];
            if (trak.typ !== "trak") continue;
            let stsdPath = O(data, ["mdia", "minf", "stbl", "stsd"], trak.offset + trak.hdr, trak.offset + trak.size);
            if (!stsdPath) continue;
            let lastStsd = stsdPath[stsdPath.length - 1];
            let entries = B(data, lastStsd.offset + lastStsd.hdr + 8, lastStsd.offset + lastStsd.size);
            for (let j = 0; j < entries.length; j++) {
                let entry = entries[j];
                let headerSize = (entry.typ === "encv" || entry.typ === "avc1") ? 78 : ((entry.typ === "enca" || entry.typ === "mp4a") ? 28 : 8);
                let subEntries = B(data, entry.offset + entry.hdr + headerSize, entry.offset + entry.size);
                for (let k = 0; k < subEntries.length; k++) {
                    if (subEntries[k].typ === "sinf") sinfBoxes.push({ box: subEntries[k], sampleEntry: entry });
                }
            }
        }

        sinfBoxes.sort((a, b) => b.box.offset - a.box.offset);
        const typeMapping = { encv: "avc1", enca: "mp4a", encs: "stpp" };
        for (let i = 0; i < sinfBoxes.length; i++) {
            let targetBox = sinfBoxes[i].box;
            let sampleEntry = sinfBoxes[i].sampleEntry;
            let allBoxes = F(data, 0, data.length);
            data.copyWithin(targetBox.offset, targetBox.offset + targetBox.size);
            for (let j = 0; j < allBoxes.length; j++) {
                let box = allBoxes[j];
                if (box.offset < targetBox.offset && box.offset + box.size >= targetBox.offset + targetBox.size) {
                    if (box.size === 1) I(data, box.offset + 8, T(data, box.offset + 8) - targetBox.size);
                    else R(data, box.offset, box.size - targetBox.size);
                }
            }
            data = new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.length - targetBox.size));
            let mapped = typeMapping[sampleEntry.typ];
            if (mapped) {
                data[sampleEntry.offset + 4] = mapped.charCodeAt(0);
                data[sampleEntry.offset + 5] = mapped.charCodeAt(1);
                data[sampleEntry.offset + 6] = mapped.charCodeAt(2);
                data[sampleEntry.offset + 7] = mapped.charCodeAt(3);
            }
        }

        moovPath = O(data, ["moov"]);
        if (moovPath) {
            let allMoovBoxes = F(data, moovPath[0].offset, moovPath[0].offset + moovPath[0].size);
            for (let i = 0; i < allMoovBoxes.length; i++) {
                let box = allMoovBoxes[i];
                let mapped = typeMapping[box.typ];
                if (mapped) {
                    data[box.offset + 4] = mapped.charCodeAt(0);
                    data[box.offset + 5] = mapped.charCodeAt(1);
                    data[box.offset + 6] = mapped.charCodeAt(2);
                    data[box.offset + 7] = mapped.charCodeAt(3);
                }
            }
            let boxes = B(data, moovPath[0].offset, moovPath[0].offset + moovPath[0].size).reverse();
            for (let i = 0; i < boxes.length; i++) {
                if (boxes[i].typ === "pssh") data = H(data, boxes[i]);
            }
        }
        return data;
    }

    // 4. Decrypt AES-CTR Media Segment and Strip DRM Boxes
    const cryptoKeysMap = new Map();
    async function getCryptoKey(keyHex) {
        if (!keyHex) throw new Error('Missing encryption key');
        const cleanHex = keyHex.replace(/[^0-9a-fA-F]/g, '');
        if (cryptoKeysMap.has(cleanHex)) return cryptoKeysMap.get(cleanHex);
        let keyBytes = new Uint8Array(cleanHex.length / 2);
        for (let i = 0; i < keyBytes.length; i++) keyBytes[i] = parseInt(cleanHex.substr(2 * i, 2), 16);
        const cryptoKey = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-CTR" }, false, ["decrypt"]);
        cryptoKeysMap.set(cleanHex, cryptoKey);
        return cryptoKey;
    }

    const initSegmentCache = new Map();
    const MAX_INIT_SEGMENTS = 24;
    async function getCleanInitSegment(initUrl) {
        if (initSegmentCache.has(initUrl)) {
            const cached = initSegmentCache.get(initUrl);
            initSegmentCache.delete(initUrl);
            initSegmentCache.set(initUrl, cached);
            return new Uint8Array(cached);
        }
        const raw = await fetchBuffer(initUrl);
        const cleaned = cleanInitSegment(raw);
        if (initSegmentCache.size >= MAX_INIT_SEGMENTS) {
            const oldestKey = initSegmentCache.keys().next().value;
            initSegmentCache.delete(oldestKey);
        }
        initSegmentCache.set(initUrl, cleaned);
        return new Uint8Array(cleaned);
    }

    async function decryptAndCleanSegment(segmentBytes, keyHex) {
        let data = new Uint8Array(segmentBytes);
        let cryptoKey = await getCryptoKey(keyHex);

        let topBoxes = B(data, 0, data.length);
        let runPairs = [];
        for (let i = 0; i < topBoxes.length; i++) {
            let box = topBoxes[i];
            if (box.typ !== "moof") continue;
            let moofChildren = B(data, box.offset + box.hdr, box.offset + box.size);
            let trafBox = moofChildren.find(c => c.typ === "traf");
            if (!trafBox) continue;
            let trafChildren = B(data, trafBox.offset + trafBox.hdr, trafBox.offset + trafBox.size);
            let trun = trafChildren.find(c => c.typ === "trun");
            let senc = trafChildren.find(c => c.typ === "senc");
            let mdat = null;
            for (let j = i + 1; j < topBoxes.length; j++) {
                if (topBoxes[j].typ === "mdat") { mdat = topBoxes[j]; break; }
            }
            if (trun && senc && mdat) runPairs.push({ trun, senc, mdat });
        }

        for (let i = 0; i < runPairs.length; i++) {
            let { trun, senc, mdat } = runPairs[i];
            let trunFlags = P(data, trun.offset + 8);
            let sampleCount = P(data, trun.offset + 12);
            let hasDataOffset = !!(1 & trunFlags);
            let hasSampleSize = !!(512 & trunFlags);
            let hasSampleDuration = !!(256 & trunFlags);
            let hasSampleFlags = !!(1024 & trunFlags);
            let hasSampleComposition = !!(2048 & trunFlags);

            let ptr = trun.offset + 16;
            if (hasDataOffset) {
                ptr = (4 & trunFlags) ? trun.offset + 24 : trun.offset + 20;
            }

            let sampleSizes = [];
            for (let s = 0; s < sampleCount; s++) {
                let size = 0;
                if (hasSampleDuration) ptr += 4;
                if (hasSampleSize) { size = P(data, ptr); ptr += 4; }
                if (hasSampleFlags) ptr += 4;
                if (hasSampleComposition) ptr += 4;
                sampleSizes.push(size);
            }

            let sencFlags = 0xffffff & P(data, senc.offset + 8);
            let sencCount = P(data, senc.offset + 12);
            let useSubsamples = (sencFlags & 2) === 2;
            let sencPtr = senc.offset + 16;
            let ivEntries = [];

            for (let s = 0; s < sencCount; s++) {
                let iv = data.slice(sencPtr, sencPtr + 8);
                sencPtr += 8;
                if (useSubsamples) {
                    let subCount = U(data, sencPtr);
                    sencPtr += 2;
                    let subs = [];
                    for (let k = 0; k < subCount; k++) {
                        subs.push({ c: U(data, sencPtr), e: P(data, sencPtr + 2) });
                        sencPtr += 6;
                    }
                    ivEntries.push({ iv, ranges: subs });
                } else {
                    ivEntries.push({ iv, ranges: null });
                }
            }

            let mdatPtr = mdat.offset + 8;
            let decryptTasks = [];
            for (let s = 0; s < sampleSizes.length; s++) {
                let size = sampleSizes[s];
                let ivInfo = ivEntries[s];
                let sampleOffset = mdatPtr;
                mdatPtr += size;
                if (!ivInfo || !size) continue;

                let counter = new Uint8Array(16);
                counter.set(ivInfo.iv, 0);

                let cipherBuf;
                if (!ivInfo.ranges) {
                    cipherBuf = data.subarray(sampleOffset, sampleOffset + size);
                } else if (ivInfo.ranges.length === 1) {
                    let r0 = ivInfo.ranges[0];
                    if (r0.e <= 0) continue;
                    cipherBuf = data.subarray(sampleOffset + r0.c, sampleOffset + r0.c + r0.e);
                } else {
                    let encryptedPayload = [];
                    let readPtr = sampleOffset;
                    for (let k = 0; k < ivInfo.ranges.length; k++) {
                        let r = ivInfo.ranges[k];
                        readPtr += r.c;
                        if (r.e > 0) encryptedPayload.push(data.subarray(readPtr, readPtr + r.e));
                        readPtr += r.e;
                    }
                    if (encryptedPayload.length === 0) continue;
                    cipherBuf = D(encryptedPayload);
                }

                decryptTasks.push(
                    crypto.subtle.decrypt({ name: "AES-CTR", counter, length: 128 }, cryptoKey, cipherBuf)
                        .then(decBuf => ({ sampleOffset, size, ivInfo, decrypted: new Uint8Array(decBuf) }))
                );
            }

            if (decryptTasks.length > 0) {
                const decryptedSamples = await Promise.all(decryptTasks);
                for (let dIdx = 0; dIdx < decryptedSamples.length; dIdx++) {
                    const { sampleOffset, size, ivInfo, decrypted } = decryptedSamples[dIdx];
                    if (!ivInfo.ranges) {
                        data.set(decrypted.subarray(0, size), sampleOffset);
                    } else {
                        let writePtr = sampleOffset;
                        let decOffset = 0;
                        for (let k = 0; k < ivInfo.ranges.length; k++) {
                            let r = ivInfo.ranges[k];
                            writePtr += r.c;
                            if (r.e > 0) {
                                data.set(decrypted.subarray(decOffset, decOffset + r.e), writePtr);
                                decOffset += r.e;
                            }
                            writePtr += r.e;
                        }
                    }
                }
            }
        }

        // Strip styp, sidx, senc, pssh from moof/traf
        let top = B(data, 0, data.length);
        let cleanedTopBoxes = [];
        for (let i = 0; i < top.length; i++) {
            let box = top[i];
            if (box.typ === "styp" || box.typ === "sidx") continue;
            if (box.typ === "moof") {
                let moofInner = [];
                let moofSub = B(data, box.offset + box.hdr, box.offset + box.size);
                for (let j = 0; j < moofSub.length; j++) {
                    let sub = moofSub[j];
                    if (sub.typ === "mfhd") {
                        moofInner.push(data.slice(sub.offset, sub.offset + sub.size));
                    } else if (sub.typ === "traf") {
                        let trafInner = [];
                        let trafSub = B(data, sub.offset + sub.hdr, sub.offset + sub.size);
                        for (let k = 0; k < trafSub.length; k++) {
                            let t = trafSub[k];
                            if (t.typ === "tfhd" || t.typ === "tfdt" || t.typ === "trun") {
                                trafInner.push(data.slice(t.offset, t.offset + t.size));
                            }
                        }
                        moofInner.push($("traf", D(trafInner)));
                    }
                }
                cleanedTopBoxes.push($("moof", D(moofInner)));
            } else {
                cleanedTopBoxes.push(data.slice(box.offset, box.offset + box.size));
            }
        }

        let finalData = D(cleanedTopBoxes);
        let finalBoxes = B(finalData, 0, finalData.length);
        let curMoof = null;
        for (let i = 0; i < finalBoxes.length; i++) {
            let box = finalBoxes[i];
            if (box.typ === "moof") { curMoof = box; continue; }
            if (box.typ === "mdat" && curMoof) {
                let moofChildren = B(finalData, curMoof.offset + 8, curMoof.offset + curMoof.size);
                let traf = moofChildren.find(c => c.typ === "traf");
                if (traf) {
                    let trafChildren = B(finalData, traf.offset + traf.hdr, traf.offset + traf.size);
                    let trun = trafChildren.find(c => c.typ === "trun");
                    if (trun && (1 & P(finalData, trun.offset + 8))) {
                        let targetPtr = trun.offset + 16;
                        let correctOffset = box.offset + 8 - curMoof.offset;
                        z(finalData).setInt32(targetPtr, correctOffset);
                    }
                }
                curMoof = null;
            }
        }
        return finalData;
    }
/* ============================================================
   PBB Extra — Cloudflare Worker decrypt-proxy
   - /stream/all.mpd  : serves MPD rewritten so all media URLs
                        resolve to /d/* on this worker
   - /d/<file>        : proxies + CENC-decrypts Akamai segments
                        (init segments are sanitized, media
                        segments AES-CTR decrypted + stripped)
   - everything else  : static assets
   ============================================================ */

const UPSTREAM_BASE = 'https://abslive.akamaized.net/dash/live/2099522/pbbcollaballaccesslivestream/';
const UPSTREAM_MANIFEST = UPSTREAM_BASE + 'manifest.mpd';

// KID (hex, no dashes) -> AES-128 key (hex). Both encodes' keys are known;
// we pick per-file by scanning the init segment for the KID bytes.
const KEYS = {
  'b75e0a8315d0499b834c00a3d5b91935': '39876c3c4f32a11dee56078febbb67dd',
  '1044e7ece2d741bcafe80d8613da104f': 'f5e17f169ff05ea40c5d3f065f523942',
};

const keyByInitUrl = new Map();

function corsHeaders(extra = {}) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Cache-Control': 'no-store',
    ...extra,
  };
}

async function fetchBuffer(url, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cf: { cacheTtl: 2 } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return new Uint8Array(await res.arrayBuffer());
  } finally {
    clearTimeout(t);
  }
}

function bytesToHex(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

// Pick the right key by finding which known KID appears in the init segment.
async function resolveKeyForFile(name, initCache) {
  if (keyByInitUrl.has(name)) return keyByInitUrl.get(name);
  const initName = name.replace(/\.mp4$/, '_init.mp4');
  let keyHex = KEYS[Object.keys(KEYS)[0]];
  try {
    const initBytes = await fetchBuffer(UPSTREAM_BASE + initName);
    const hex = bytesToHex(initBytes);
    for (const kid of Object.keys(KEYS)) {
      if (hex.includes(kid)) { keyHex = KEYS[kid]; break; }
    }
  } catch (e) { /* fall back to primary key */ }
  keyByInitUrl.set(name, keyHex);
  return keyHex;
}

function rewriteManifest(mpdText, origin) {
  // Strip any upstream BaseURL (relative segment URLs must resolve to /d/*)
  let out = mpdText.replace(/<BaseURL>[^<]*<\/BaseURL>/g, '');
  // Segments are served DECRYPTED — remove all DRM signaling or Shaka
  // refuses to load (it would look for a key system that isn't configured).
  out = out
    .replace(/<ContentProtection[^>]*>[\s\S]*?<\/ContentProtection>/g, '')
    .replace(/<ContentProtection[^>]*\/>/g, '')
    .replace(/<cenc:pssh>[\s\S]*?<\/cenc:pssh>/g, '');
  const base = `<BaseURL>${origin}/d/</BaseURL>`;
  // Inject right after the opening <MPD ...> tag, before <Period>
  out = out.replace(/<MPD([^>]*)>/, (m) => m + base);
  return out;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    // --- Clear DASH manifest for proxy-mode clients (iOS/Android fallback) ---
    if (path === '/stream/all.mpd' || path === '/manifest/all.mpd') {
      try {
        const res = await fetch(UPSTREAM_MANIFEST, { cf: { cacheTtl: 2 } });
        if (!res.ok) return new Response('upstream ' + res.status, { status: 502, headers: corsHeaders() });
        const text = await res.text();
        return new Response(rewriteManifest(text, url.origin), {
          headers: corsHeaders({ 'Content-Type': 'application/dash+xml; charset=utf-8' }),
        });
      } catch (e) {
        return new Response('manifest fetch failed: ' + e.message, { status: 502, headers: corsHeaders() });
      }
    }

    // --- Decrypting media proxy: /d/<file> -> upstream file, cleaned+decrypted ---
    if (path.startsWith('/d/')) {
      const file = decodeURIComponent(path.slice(3));
      // Only allow known segment filenames — no traversal, no arbitrary proxy
      if (!/^[\w.\-]+\.mp4$/.test(file) || file.includes('..')) {
        return new Response('bad file', { status: 400, headers: corsHeaders() });
      }
      try {
        const upstream = UPSTREAM_BASE + file;
        if (file.endsWith('_init.mp4')) {
          const raw = await fetchBuffer(upstream);
          const cleaned = cleanInitSegment(raw);
          return new Response(cleaned, {
            headers: corsHeaders({ 'Content-Type': 'video/mp4' }),
          });
        }
        const raw = await fetchBuffer(upstream);
        const keyHex = await resolveKeyForFile(file);
        const cleaned = await decryptAndCleanSegment(raw, keyHex);
        return new Response(cleaned, {
          headers: corsHeaders({ 'Content-Type': 'video/mp4' }),
        });
      } catch (e) {
        return new Response('segment failed: ' + e.message, { status: 502, headers: corsHeaders() });
      }
    }

    // --- Static assets ---
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    return new Response('not found', { status: 404 });
  },
};
