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
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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

/* ============================================================
   On-Demand Replays — iWantTFC "PBB Collab 3.0 Extra"
   GraphQL gives episode metadata; the entitlement service
   (playback/start) issues 60-second Akamai tokens + DRM
   license URLs. We proxy manifests, segments AND license
   requests so tokens are always fresh and never exposed.
   ============================================================ */

const IW_GQL = 'https://api.iwanttfc.com/consumer/graphql';
const IW_ENTITLEMENT = 'https://api.iwanttfc.com/entitlement';
const IW_SHOW_ID = 'c56baf24-4ec7-49bd-94ef-6cf6f6b12d77';
const IW_SHOW_FILTER = { year: 2026, month: 11 };
const IW_SKUS = ['SVOD033'];
const IW_IMAGE_BASE = 'https://img.iwanttfc.com';

const IW_HEADERS = {
  'Content-Type': 'application/json',
  'Accept': 'application/graphql-response+json',
  'x-country-code': 'PH',
  'x-device-platform': 'web',
  'x-iw-useragent': 'iWant=3.0.0; Platform=web; OSVersion=; Model=chrome; BuildType=release; Environment=production',
  'Origin': 'https://www.iwanttfc.com',
  'Referer': 'https://www.iwanttfc.com/',
};

// kind 'wv' -> Widevine DASH (desktop/Android), 'fp' -> FairPlay HLS (iOS)
const REPLAY_KINDS = {
  wv: { drm: ['wv'], streamType: ['dash'], subPlatform: 'chrome', manifest: 'manifest.mpd' },
  fp: { drm: ['fp'], streamType: ['hls'], subPlatform: 'safari', manifest: 'master.m3u8' },
};

// `${epId}:${kind}` -> { contentBase, tokenQuery, licenseUrl, fetchedAt, pending }
const replaySessions = new Map();
const SESSION_TTL_MS = 45_000; // upstream tokens live ~60s — refresh early

async function iwGraphql(query, variables) {
  const res = await fetch(IW_GQL, {
    method: 'POST',
    headers: IW_HEADERS,
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error('graphql ' + res.status);
  const json = await res.json();
  if (json.errors) throw new Error(json.errors[0].message || 'graphql error');
  return json.data;
}

async function getReplayEpisodes() {
  const data = await iwGraphql(
    `query TvShowEpisodes($tvShowEpisodesId: ID, $filters: TvShowEpisodesFilterInput, $skus: [String!]) {
      tvShowEpisodes(id: $tvShowEpisodesId, filters: $filters, skus: $skus) {
        items { id title subHeader isPlayable durationInSeconds imagesV2 { lt } }
        totalItems
      }
    }`,
    { tvShowEpisodesId: IW_SHOW_ID, filters: IW_SHOW_FILTER, skus: IW_SKUS });
  const items = data.tvShowEpisodes.items || [];
  return items.map((it) => ({
    id: it.id,
    title: it.title,
    label: it.subHeader || it.title,
    duration: it.durationInSeconds || 0,
    playable: !!it.isPlayable,
    image: it.imagesV2 && it.imagesV2.lt ? IW_IMAGE_BASE + it.imagesV2.lt : '',
  }));
}

async function startPlayback(epId, kind) {
  const k = REPLAY_KINDS[kind];
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
  const res = await fetch(url, { method: 'POST', headers: IW_HEADERS, body: JSON.stringify(body) });
  if (!res.ok) throw new Error('playback/start ' + res.status);
  const json = await res.json();
  const streamUrl = json.playbackInfo && json.playbackInfo.url;
  const licenseUrl = json.playbackInfo && json.playbackInfo.licenseUrl;
  if (!streamUrl) throw new Error('no stream url');
  const qIdx = streamUrl.indexOf('?');
  return {
    contentBase: qIdx >= 0 ? streamUrl.slice(0, qIdx).replace(/[^/]+$/, '') : streamUrl.replace(/[^/]+$/, ''),
    tokenQuery: qIdx >= 0 ? streamUrl.slice(qIdx) : '',
    licenseUrl: licenseUrl || '',
    fetchedAt: Date.now(),
  };
}

async function getReplaySession(epId, kind) {
  const key = `${epId}:${kind}`;
  let s = replaySessions.get(key);
  if (s && !s.pending && Date.now() - s.fetchedAt < SESSION_TTL_MS) return s;
  if (s && s.pending) return s.pending;
  const pending = startPlayback(epId, kind)
    .then((fresh) => { replaySessions.set(key, fresh); return fresh; })
    .finally(() => { /* pending cleared implicitly by replacement */ });
  replaySessions.set(key, { ...(s || {}), pending });
  try {
    const fresh = await pending;
    return fresh;
  } finally {
    const cur = replaySessions.get(key);
    if (cur && cur.pending === pending) delete cur.pending;
  }
}

function replayUpstreamUrl(session, relPath) {
  // relPath is the path relative to the content root, e.g.
  // 'manifest/video/avc1/1/seg-12.m4s' or 'master/media-2/stream.m3u8'
  const clean = relPath.replace(/^\/+/, '');
  if (clean.includes('..')) throw new Error('bad path');
  return session.contentBase + clean + session.tokenQuery;
}

function contentTypeFor(path) {
  if (path.endsWith('.mpd')) return 'application/dash+xml; charset=utf-8';
  if (path.endsWith('.m3u8')) return 'application/vnd.apple.mpegurl';
  if (path.endsWith('.mp4') || path.endsWith('.m4s') || path.endsWith('.ts') || path.endsWith('.m4a') || path.endsWith('.aac')) {
    return path.endsWith('.ts') ? 'video/mp2t' : 'video/mp4';
  }
  if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'image/jpeg';
  if (path.endsWith('.vtt')) return 'text/vtt';
  if (path.endsWith('.json')) return 'application/json';
  return 'application/octet-stream';
}

/* ============================================================
   ChatRoom Durable Object — shared chat history + live viewer
   count + SSE broadcast for all connected clients.
   ============================================================ */
export class ChatRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this._messages = null;
    this._viewers = null;
    this.sseClients = new Set();
  }

  async messages() {
    if (this._messages === null) {
      this._messages = (await this.ctx.storage.get('messages')) || [];
    }
    return this._messages;
  }

  async viewers() {
    if (this._viewers === null) {
      this._viewers = (await this.ctx.storage.get('viewers')) || {};
    }
    return this._viewers;
  }

  broadcast(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    const bytes = new TextEncoder().encode(payload);
    for (const controller of this.sseClients) {
      try { controller.enqueue(bytes); }
      catch { this.sseClients.delete(controller); }
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/messages' && request.method === 'GET') {
      const msgs = await this.messages();
      return Response.json({ messages: msgs.slice(-50) },
        { headers: { 'Cache-Control': 'no-store' } });
    }

    if (path === '/messages' && request.method === 'POST') {
      let body = {};
      try { body = await request.json(); } catch {}
      const name = String(body.name || '').trim();
      const text = String(body.text || '').trim();
      if (!name || name.length > 24 || !text || text.length > 280) {
        return Response.json(
          { error: 'Enter a name (up to 24 characters) and a message (up to 280 characters).' },
          { status: 400 });
      }
      const msgs = await this.messages();
      const message = {
        id: Date.now(),
        name,
        text,
        createdAt: new Date().toISOString(),
      };
      msgs.push(message);
      if (msgs.length > 100) msgs.shift();
      await this.ctx.storage.put('messages', msgs);
      this.broadcast('message', message);
      return Response.json({ message }, { status: 201, headers: { 'Cache-Control': 'no-store' } });
    }

    if (path === '/stream' && request.method === 'GET') {
      const encoder = new TextEncoder();
      const self = this;
      let keepAlive;
      let controllerRef = null;
      const stream = new ReadableStream({
        start(controller) {
          controllerRef = controller;
          self.sseClients.add(controller);
          const send = (s) => { try { controller.enqueue(encoder.encode(s)); } catch {} };
          keepAlive = setInterval(() => send(': keep-alive\n\n'), 15000);
          self.messages().then((msgs) => {
            send(`event: history\ndata: ${JSON.stringify(msgs.slice(-50))}\n\n`);
          }).catch(() => {});
        },
        cancel() {
          clearInterval(keepAlive);
          if (controllerRef) self.sseClients.delete(controllerRef);
        },
      });
      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
        },
      });
    }

    if (path === '/viewers' && request.method === 'POST') {
      let body = {};
      try { body = await request.json(); } catch {}
      const id = String(body.id || '');
      if (!/^[a-z0-9-]{16,64}$/i.test(id)) {
        return Response.json({ error: 'invalid viewer id' }, { status: 400 });
      }
      const viewers = await this.viewers();
      const now = Date.now();
      for (const key of Object.keys(viewers)) {
        if (now - viewers[key] > 45_000) delete viewers[key];
      }
      viewers[id] = now;
      await this.ctx.storage.put('viewers', viewers);
      return Response.json({ count: Object.keys(viewers).length },
        { headers: { 'Cache-Control': 'no-store' } });
    }

    return new Response('not found', { status: 404 });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    // --- Chat + viewer count API (Durable Object backed) ---
    if (path.startsWith('/api/chat/') || path === '/api/viewers/heartbeat') {
      try {
        const id = env.CHAT_ROOM.idFromName('global');
        const stub = env.CHAT_ROOM.get(id);
        const subPath = path === '/api/viewers/heartbeat'
          ? '/viewers'
          : path.slice('/api/chat'.length);
        return await stub.fetch(new Request(`https://chat-room${subPath}${url.search}`, request));
      } catch (e) {
        return Response.json({ error: 'chat backend unavailable' }, { status: 503 });
      }
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

    // --- Replay episode list ---
    if (path === '/api/replays') {
      try {
        const episodes = await getReplayEpisodes();
        return Response.json({ episodes }, {
          headers: { 'Cache-Control': 'public, max-age=120', ...corsHeaders() },
        });
      } catch (e) {
        return Response.json({ error: 'replays unavailable: ' + e.message }, { status: 502, headers: corsHeaders() });
      }
    }

    // --- Replay session bootstrap: returns proxied manifest + license URLs ---
    if (path === '/api/replay/session') {
      const epId = url.searchParams.get('id') || '';
      const kind = url.searchParams.get('kind') === 'fp' ? 'fp' : 'wv';
      if (!/^[0-9a-f-]{36}$/i.test(epId)) {
        return Response.json({ error: 'bad episode id' }, { status: 400, headers: corsHeaders() });
      }
      try {
        const s = await getReplaySession(epId, kind);
        const manifest = REPLAY_KINDS[kind].manifest;
        return Response.json({
          manifest: `/api/replay/${epId}/${kind}/${manifest}`,
          license: `/api/replay/license?id=${epId}&kind=${kind}`,
        }, { headers: { 'Cache-Control': 'no-store', ...corsHeaders() } });
      } catch (e) {
        return Response.json({ error: 'session failed: ' + e.message }, { status: 502, headers: corsHeaders() });
      }
    }

    // --- DRM license proxy: forwards the challenge to ezdrm with a fresh token ---
    if (path === '/api/replay/license' && request.method === 'POST') {
      const epId = url.searchParams.get('id') || '';
      const kind = url.searchParams.get('kind') === 'fp' ? 'fp' : 'wv';
      try {
        const s = await getReplaySession(epId, kind);
        if (!s.licenseUrl) return new Response('no license url', { status: 502, headers: corsHeaders() });
        const body = await request.arrayBuffer();
        const upstream = await fetch(s.licenseUrl, {
          method: 'POST',
          headers: {
            'Content-Type': request.headers.get('Content-Type') || 'application/octet-stream',
          },
          body,
        });
        const respBody = await upstream.arrayBuffer();
        return new Response(respBody, {
          status: upstream.status,
          headers: {
            ...corsHeaders(),
            'Content-Type': upstream.headers.get('Content-Type') || 'application/octet-stream',
          },
        });
      } catch (e) {
        return new Response('license proxy failed: ' + e.message, { status: 502, headers: corsHeaders() });
      }
    }

    // --- Replay manifest + media proxy: /api/replay/<ep>/<kind>/<path> ---
    const replayMatch = path.match(/^\/api\/replay\/([0-9a-f-]{36})\/(wv|fp)\/(.+)$/i);
    if (replayMatch) {
      const [, epId, kind, relPath] = replayMatch;
      try {
        const s = await getReplaySession(epId, kind);
        const upstream = replayUpstreamUrl(s, decodeURIComponent(relPath));
        const upstreamRes = await fetch(upstream, {
          headers: { 'User-Agent': 'Mozilla/5.0', 'Origin': 'https://www.iwanttfc.com', 'Referer': 'https://www.iwanttfc.com/' },
          cf: { cacheTtl: 2 },
        });
        if (!upstreamRes.ok) {
          return new Response('upstream ' + upstreamRes.status, { status: upstreamRes.status, headers: corsHeaders() });
        }
        const isManifest = /\.(mpd|m3u8)$/i.test(relPath);
        const headers = corsHeaders({
          'Content-Type': contentTypeFor(relPath),
          ...(isManifest ? { 'Cache-Control': 'no-store' } : {}),
        });
        // Manifests/playlists are small text — pass through as-is; relative
        // URLs inside resolve back against our proxy path automatically.
        return new Response(upstreamRes.body, { headers });
      } catch (e) {
        return new Response('replay proxy failed: ' + e.message, { status: 502, headers: corsHeaders() });
      }
    }

    // --- Static assets ---
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    return new Response('not found', { status: 404 });
  },
};
