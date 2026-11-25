/**
 * PBB Collab 3.0 - High-Performance iOS / iPadOS Native DASH Player
 * Custom ManagedMediaSource + WebCrypto AES-CTR Decryption Engine + Adaptive Bitrate (ABR)
 * 
 * Solves Apple WebKit's lack of EME ClearKey CDM support:
 * 1. Fetches DASH MPD & resolves all live SegmentTemplate renditions (1080p/720p/360p).
 * 2. Rewrites init MP4 to pure AVC1/MP4A by stripping Widevine/sinf/text tracks.
 * 3. Decrypts live AES-CTR media segments in-memory via window.crypto.subtle.
 * 4. Strips encryption auxiliary info (senc/pssh) from moof/traf boxes.
 * 5. Dynamically adapts video quality (ABR) based on segment download throughput & buffer health.
 * 6. Automatically catches up to the live edge if playback drifts >18s behind (e.g. after tab sleep).
 */

(function (window) {
    'use strict';

    // 1. Device & Capability Detection
    function isAppleDevice() {
        if (typeof navigator === 'undefined') return false;
        const ua = navigator.userAgent;
        return !!(/iPad|iPhone|iPod/.test(ua) && !window.MSStream || /Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
    }

    function isIosMmsSupported() {
        return isAppleDevice() && typeof window.ManagedMediaSource !== 'undefined';
    }

    // Generic MSE check: ManagedMediaSource (Safari) or plain MediaSource
    // (Chrome/Edge/Firefox/Android) — the engine works on both.
    function isMmsSupported() {
        return typeof window.ManagedMediaSource !== 'undefined' ||
               typeof window.MediaSource !== 'undefined';
    }

    // 2. ISO-BMFF Byte & Box Helpers
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
        const cryptoKey = await window.crypto.subtle.importKey("raw", keyBytes, { name: "AES-CTR" }, false, ["decrypt"]);
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
                    window.crypto.subtle.decrypt({ name: "AES-CTR", counter, length: 128 }, cryptoKey, cipherBuf)
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

    // 5. MPD URL & Timeline Helpers
    function resolveUrl(baseUrl, relativePath) {
        if (!relativePath) return '';
        if (relativePath.startsWith('http://') || relativePath.startsWith('https://')) return relativePath;
        if (relativePath.startsWith('/')) {
            const origin = baseUrl.match(/^https?:\/\/[^\/]+/i);
            const hostOrigin = origin ? origin[0] : (typeof window !== 'undefined' && window.location ? window.location.origin : '');
            return hostOrigin + relativePath;
        }
        const lastSlash = baseUrl.lastIndexOf('/');
        return (lastSlash !== -1 ? baseUrl.substring(0, lastSlash + 1) : baseUrl + '/') + relativePath;
    }

    function formatSegmentUrl(template, num) {
        return template.replace(/\$Number(%0(\d+)d)?\$/g, (m, p1, p2) => {
            return p2 ? String(num).padStart(parseInt(p2, 10), '0') : String(num);
        });
    }

    // Safe live edge offset: 4 segments (~16s) behind wall clock to align with the upstream live edge
    // suggestedPresentationDelay and guarantee 100% of segments are packaged on the CDN edge.
    const LIVE_EDGE_SAFETY_SEGMENTS = 4;

    function parseIsoDurationMs(iso) {
        if (!iso || typeof iso !== 'string') return 0;
        const m = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?)?$/i.exec(iso.trim());
        if (!m) return 0;
        const weeks = parseFloat(m[1] || 0);
        const days = parseFloat(m[2] || 0) + weeks * 7;
        const hours = parseFloat(m[3] || 0);
        const mins = parseFloat(m[4] || 0);
        const secs = parseFloat(m[5] || 0);
        return (((days * 24 + hours) * 60 + mins) * 60 + secs) * 1000;
    }

    function calcLiveSegment(availabilityStartTime, track, clockOffset = 0, periodStartMs = 0, safetySegments = LIVE_EDGE_SAFETY_SEGMENTS) {
        const now = Date.now() + clockOffset;
        const periodAbsStart = availabilityStartTime + (periodStartMs || 0);
        const elapsed = Math.max(0, (now - periodAbsStart) / 1000);
        return track.startNumber + Math.floor(elapsed / track.segmentDuration) - safetySegments;
    }

    function selectActivePeriod(periods, availabilityStartTime, nowMs) {
        let runningStartMs = 0;
        let lastStarted = null;
        for (let i = 0; i < periods.length; i++) {
            const p = periods[i];
            const startAttr = p.getAttribute('start');
            const durAttr = p.getAttribute('duration');
            const periodStartMs = startAttr ? parseIsoDurationMs(startAttr) : runningStartMs;
            const periodDurationMs = durAttr ? parseIsoDurationMs(durAttr) : Infinity;
            const absStart = availabilityStartTime + periodStartMs;
            const absEnd = (periodDurationMs < Infinity) ? (absStart + periodDurationMs) : Infinity;
            const info = {
                period: p,
                periodId: p.getAttribute('id') || String(i + 1),
                periodStartMs,
                periodDurationMs
            };
            if (nowMs >= absStart && nowMs < absEnd) {
                return info;
            }
            if (nowMs >= absStart) {
                lastStarted = info;
            }
            if (periodDurationMs < Infinity) {
                runningStartMs = periodStartMs + periodDurationMs;
            }
        }
        if (lastStarted) return lastStarted;
        const fallback = periods[periods.length - 1];
        const fallbackStart = fallback.getAttribute('start');
        const fallbackDur = fallback.getAttribute('duration');
        return {
            period: fallback,
            periodId: fallback.getAttribute('id') || String(periods.length),
            periodStartMs: fallbackStart ? parseIsoDurationMs(fallbackStart) : runningStartMs,
            periodDurationMs: fallbackDur ? parseIsoDurationMs(fallbackDur) : Infinity
        };
    }

    function parseMpdTracks(xmlString, mpdUrl, targetHeight = 1080, clockOffset = 0) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(xmlString, 'application/xml');
        const mpdElem = doc.getElementsByTagName('MPD')[0];
        let availabilityStartTime = Date.now();
        if (mpdElem) {
            const availAttr = mpdElem.getAttribute('availabilityStartTime');
            if (availAttr) availabilityStartTime = Date.parse(availAttr);
        }

        const periods = doc.getElementsByTagName('Period');
        if (periods.length === 0) {
            return {
                periodId: '1',
                periodStartMs: 0,
                periodDurationMs: Infinity,
                videoTrack: null,
                videoRenditions: [],
                audioTrack: null,
                availabilityStartTime
            };
        }

        const active = selectActivePeriod(periods, availabilityStartTime, Date.now() + clockOffset);
        const adaptations = active.period.getElementsByTagName('AdaptationSet');
        let videoTrack = null, audioTrack = null;
        const videoRenditions = [];

        for (let i = 0; i < adaptations.length; i++) {
            const adapt = adaptations[i];
            const mimeType = adapt.getAttribute('mimeType') || '';
            const contentType = adapt.getAttribute('contentType') || mimeType.split('/')[0] || '';
            const mainTmpl = adapt.getElementsByTagName('SegmentTemplate')[0];
            if (!mainTmpl) continue;

            const baseTimescale = parseInt(mainTmpl.getAttribute('timescale') || '90000', 10);
            const baseDuration = parseInt(mainTmpl.getAttribute('duration') || '360360', 10);
            const baseStartNum = parseInt(mainTmpl.getAttribute('startNumber') || '1', 10);
            const baseInit = mainTmpl.getAttribute('initialization') || '';
            const baseMedia = mainTmpl.getAttribute('media') || '';

            if (contentType === 'video' || mimeType.includes('video')) {
                const representations = adapt.getElementsByTagName('Representation');
                const pick = (a, b) => a !== null && a !== undefined ? a : b;

                for (let j = 0; j < representations.length; j++) {
                    const r = representations[j];
                    const h = parseInt(r.getAttribute('height') || '0', 10);
                    const w = parseInt(r.getAttribute('width') || '0', 10);
                    const repId = r.getAttribute('id') || '';
                    const bandwidth = parseInt(r.getAttribute('bandwidth') || '0', 10);
                    const codecs = r.getAttribute('codecs') || adapt.getAttribute('codecs') || 'avc1.4d401e';
                    const repMime = r.getAttribute('mimeType') || adapt.getAttribute('mimeType') || 'video/mp4';
                    const repTmpl = r.getElementsByTagName('SegmentTemplate')[0];

                    const initPattern = pick(repTmpl?.getAttribute('initialization'), baseInit);
                    const mediaPattern = pick(repTmpl?.getAttribute('media'), baseMedia);
                    const timescale = parseInt(pick(repTmpl?.getAttribute('timescale'), String(baseTimescale)), 10);
                    const duration = parseInt(pick(repTmpl?.getAttribute('duration'), String(baseDuration)), 10);
                    const startNumber = parseInt(pick(repTmpl?.getAttribute('startNumber'), String(baseStartNum)), 10);

                    const sub = (s) => s.replace(/\$RepresentationID\$/g, repId).replace(/\$Bandwidth\$/g, String(bandwidth));

                    videoRenditions.push({
                        repId,
                        width: w,
                        height: h || 720,
                        bandwidth,
                        mimeCodec: `${repMime}; codecs="${codecs}"`,
                        initUrl: resolveUrl(mpdUrl, sub(initPattern)),
                        templateUrl: resolveUrl(mpdUrl, sub(mediaPattern)),
                        startNumber,
                        timescale,
                        duration,
                        segmentDuration: duration / timescale
                    });
                }

                // Sort renditions from lowest height/bandwidth to highest
                videoRenditions.sort((a, b) => (a.height - b.height) || (a.bandwidth - b.bandwidth));

                let minDiff = Infinity;
                for (let j = 0; j < videoRenditions.length; j++) {
                    const diff = Math.abs(videoRenditions[j].height - targetHeight);
                    if (diff <= minDiff) {
                        minDiff = diff;
                        videoTrack = videoRenditions[j];
                    }
                }
            } else if (contentType === 'audio' || mimeType.includes('audio')) {
                const reps = adapt.getElementsByTagName('Representation');
                if (reps.length > 0) {
                    const r = reps[0];
                    const repId = r.getAttribute('id') || '';
                    const bandwidth = r.getAttribute('bandwidth') || '';
                    const codecs = r.getAttribute('codecs') || adapt.getAttribute('codecs') || 'mp4a.40.2';
                    const repMime = r.getAttribute('mimeType') || adapt.getAttribute('mimeType') || 'audio/mp4';
                    const repTmpl = r.getElementsByTagName('SegmentTemplate')[0];

                    const pick = (a, b) => a !== null && a !== undefined ? a : b;
                    const initPattern = pick(repTmpl?.getAttribute('initialization'), baseInit);
                    const mediaPattern = pick(repTmpl?.getAttribute('media'), baseMedia);
                    const timescale = parseInt(pick(repTmpl?.getAttribute('timescale'), String(baseTimescale)), 10);
                    const duration = parseInt(pick(repTmpl?.getAttribute('duration'), String(baseDuration)), 10);
                    const startNumber = parseInt(pick(repTmpl?.getAttribute('startNumber'), String(baseStartNum)), 10);

                    const sub = (s) => s.replace(/\$RepresentationID\$/g, repId).replace(/\$Bandwidth\$/g, bandwidth);

                    audioTrack = {
                        mimeCodec: `${repMime}; codecs="${codecs}"`,
                        initUrl: resolveUrl(mpdUrl, sub(initPattern)),
                        templateUrl: resolveUrl(mpdUrl, sub(mediaPattern)),
                        startNumber,
                        timescale,
                        duration,
                        segmentDuration: duration / timescale
                    };
                }
            }
        }
        return {
            periodId: active.periodId,
            periodStartMs: active.periodStartMs,
            periodDurationMs: active.periodDurationMs,
            videoTrack,
            videoRenditions,
            audioTrack,
            availabilityStartTime
        };
    }

    // 6. SourceBuffer Append & Remove Serialization Queue
    function createSourceQueue() {
        let queue = [];
        let busy = false;
        async function process() {
            if (busy) return;
            busy = true;
            while (queue.length > 0) {
                let task = queue.shift();
                try {
                    await new Promise((resolve, reject) => {
                        let done = false;
                        let timeout = setTimeout(() => cleanup(new Error("Append timeout")), 15000);
                        function onUpdateEnd() {
                            if (!done) { done = true; cleanup(); resolve(); }
                        }
                        function onError(err) {
                            if (!done) { done = true; cleanup(); reject(err || new Error("SourceBuffer error")); }
                        }
                        function cleanup() {
                            clearTimeout(timeout);
                            task.sb.removeEventListener("updateend", onUpdateEnd);
                            task.sb.removeEventListener("error", onError);
                        }
                        task.sb.addEventListener("updateend", onUpdateEnd);
                        task.sb.addEventListener("error", onError);
                        try {
                            if (task.remove) {
                                task.sb.remove(task.start, task.end);
                            } else {
                                task.sb.appendBuffer(task.data);
                            }
                        } catch (e) {
                            cleanup();
                            reject(e);
                        }
                    });
                    task.resolve(true);
                } catch (e) {
                    console.warn("[iOS-Player] Buffer queue error:", e?.message);
                    task.reject(e);
                }
            }
            busy = false;
        }
        return {
            enqueue(sb, data) {
                return new Promise((resolve, reject) => {
                    queue.push({ sb, data, resolve, reject });
                    process();
                });
            },
            enqueueRemove(sb, start, end) {
                return new Promise((resolve, reject) => {
                    if (!sb || !(end > start)) return resolve(false);
                    queue.push({ sb, remove: true, start, end, resolve, reject });
                    process();
                });
            }
        };
    }

    async function fetchBuffer(url, timeoutMs = 9000) {
        const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), cache: 'default' });
        if (!res.ok) throw new Error(`Fetch ${res.status}: ${url}`);
        return new Uint8Array(await res.arrayBuffer());
    }

    async function fetchAndParseMpd(dashUrl, targetHeight, forceFresh = false) {
        const [base, query] = dashUrl.split('?');
        const bucket = Math.floor(Date.now() / 15000);
        const params = new URLSearchParams(query || '');
        params.set('_b', String(bucket));
        if (forceFresh) params.set('_r', String(Date.now()));
        const url = `${base}?${params.toString()}`;
        const mpdRes = await fetch(url, {
            signal: AbortSignal.timeout(8000),
            cache: forceFresh ? 'no-store' : 'default',
            credentials: 'same-origin'
        });
        if (!mpdRes.ok) throw new Error(`MPD fetch failed: ${mpdRes.status}`);
        const mpdXml = await mpdRes.text();

        let clockOffset = 0;
        const serverDateHeader = mpdRes.headers.get('date');
        if (serverDateHeader) {
            let serverMs = Date.parse(serverDateHeader);
            const ageSec = parseInt(mpdRes.headers.get('age') || '0', 10);
            if (!isNaN(ageSec) && ageSec > 0) serverMs += ageSec * 1000;
            if (!isNaN(serverMs)) {
                const diff = serverMs - Date.now();
                // Ignore cached manifest Date staleness (<60s); compensate only true client clock skew
                if (Math.abs(diff) >= 60000) clockOffset = diff;
            }
        }

        const parsed = parseMpdTracks(mpdXml, dashUrl, targetHeight || 1080, clockOffset);
        return { ...parsed, clockOffset };
    }

    // 7. Core ManagedMediaSource Session Controller with ABR & Live-Edge Catch-up
    async function startIosMmsSession(videoElement, config) {
        let stopped = false;
        let pollTimer = null;
        let mms = null;

        const stop = () => {
            stopped = true;
            if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
            if (mms) {
                try {
                    if (mms.readyState === 'open') mms.endOfStream();
                } catch (e) {}
                mms = null;
            }
            videoElement.removeAttribute('src');
            videoElement.load();
        };

        const isCancelled = () => stopped || (typeof config.isCancelled === 'function' && config.isCancelled());

        config.onLoading?.();

        // 1. Fetch & parse MPD (selecting active live Period + clock skew adjustment)
        let mpdState = await fetchAndParseMpd(config.dashUrl, config.targetHeight || 1080, false);
        if (isCancelled()) return { stop };
        let clockOffset = mpdState.clockOffset;
        let videoTrack = mpdState.videoTrack;
        let videoRenditions = mpdState.videoRenditions || [];
        let audioTrack = mpdState.audioTrack;
        let availabilityStartTime = mpdState.availabilityStartTime;
        let periodStartMs = mpdState.periodStartMs || 0;
        let periodDurationMs = mpdState.periodDurationMs || Infinity;
        let activePeriodId = mpdState.periodId;

        if (!videoTrack) throw new Error('No video track found in MPD');

        let currentRenditionIdx = Math.max(0, videoRenditions.indexOf(videoTrack));
        const isAutoAbr = !!config.autoQuality && videoRenditions.length > 1;

        // 2. Setup ManagedMediaSource
        mms = new (window.ManagedMediaSource || window.MediaSource)();
        videoElement.disableRemotePlayback = true;
        videoElement.setAttribute('playsinline', 'true');
        videoElement.setAttribute('webkit-playsinline', 'true');

        const mmsUrl = URL.createObjectURL(mms);
        videoElement.src = mmsUrl;

        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('MMS sourceopen timeout')), 10000);
            mms.addEventListener('sourceopen', () => {
                clearTimeout(timeout);
                resolve();
            }, { once: true });
        });
        // Keep the blob URL alive on non-Apple MSE — revoking immediately
        // after src assignment can break Chrome/Android MediaSource.
        if (isAppleDevice()) URL.revokeObjectURL(mmsUrl);
        if (isCancelled()) {
            stop();
            return { stop };
        }

        if (stopped) return { stop };

        let videoSb = null;
        const videoCodecCandidates = [
            'video/mp4; codecs="avc1.4d4029"',
            'video/mp4; codecs="avc1.4d4028"',
            videoTrack.mimeCodec,
            'video/mp4; codecs="avc1.4d401e"'
        ];
        for (let i = 0; i < videoCodecCandidates.length; i++) {
            try {
                videoSb = mms.addSourceBuffer(videoCodecCandidates[i]);
                break;
            } catch (e) {}
        }
        if (!videoSb) throw new Error('No supported video SourceBuffer codec');

        let audioSb = null;
        if (audioTrack && config.enableAudio !== false) {
            const audioCandidates = [
                audioTrack.mimeCodec,
                'audio/mp4; codecs="mp4a.40.2"',
                'audio/mp4; codecs=mp4a.40.2',
                'audio/mp4'
            ];
            for (let i = 0; i < audioCandidates.length; i++) {
                try {
                    audioSb = mms.addSourceBuffer(audioCandidates[i]);
                    break;
                } catch (e) {}
            }
        }

        const queue = createSourceQueue();

        // 3. Append Clean Init Segments (Video & Audio) in Parallel
        const [cleanVideoInit, cleanAudioInit] = await Promise.all([
            getCleanInitSegment(videoTrack.initUrl),
            (audioSb && audioTrack) ? getCleanInitSegment(audioTrack.initUrl).catch(() => null) : Promise.resolve(null)
        ]);

        if (stopped) return { stop };
        await queue.enqueue(videoSb, cleanVideoInit);
        config.onResolutionChange?.(videoTrack.height);

        if (audioSb && cleanAudioInit) {
            try {
                await queue.enqueue(audioSb, cleanAudioInit);
            } catch (e) {
                audioSb = null;
            }
        }

        if (stopped) return { stop };

        // 4. Instant Concurrent Pre-Buffer (Rock-Solid 12s Buffer Runway: 3 segments in parallel)
        async function fetchPrebufferBatch(safetyOffset) {
            const curVid = calcLiveSegment(availabilityStartTime, videoTrack, clockOffset, periodStartMs, safetyOffset);
            const sVid = Math.max(videoTrack.startNumber, curVid - 2);
            const curAud = audioTrack ? calcLiveSegment(availabilityStartTime, audioTrack, clockOffset, periodStartMs, safetyOffset) : -1;
            const sAud = audioTrack ? Math.max(audioTrack.startNumber, curAud - 2) : -1;

            const vTasks = [];
            for (let s = sVid; s <= curVid; s++) {
                vTasks.push((async (seg) => {
                    try {
                        const raw = await fetchBuffer(formatSegmentUrl(videoTrack.templateUrl, seg));
                        if (!raw || raw.length < 500) return null;
                        const cleaned = await decryptAndCleanSegment(raw, config.key);
                        return { seg, cleaned };
                    } catch (e) {
                        return null;
                    }
                })(s));
            }

            const aTasks = [];
            if (audioSb && audioTrack) {
                for (let s = sAud; s <= curAud; s++) {
                    aTasks.push((async (seg) => {
                        try {
                            const raw = await fetchBuffer(formatSegmentUrl(audioTrack.templateUrl, seg));
                            if (!raw || raw.length < 200) return null;
                            const cleaned = await decryptAndCleanSegment(raw, config.key);
                            return { seg, cleaned };
                        } catch (e) {
                            return null;
                        }
                    })(s));
                }
            }

            const [vRes, aRes] = await Promise.all([Promise.all(vTasks), Promise.all(aTasks)]);
            return { vRes, aRes, sVid, sAud };
        }

        let batch = await fetchPrebufferBatch(LIVE_EDGE_SAFETY_SEGMENTS);
        if (stopped) return { stop };

        // If 0 segments succeeded (e.g., cached MPD missed a brand-new Period boundary), force-refresh MPD once
        if (!batch.vRes.some(r => r && r.cleaned)) {
            const freshMpd = await fetchAndParseMpd(config.dashUrl, config.targetHeight || 1080, true);
            if (stopped) return { stop };
            if (freshMpd.videoTrack) {
                clockOffset = freshMpd.clockOffset;
                availabilityStartTime = freshMpd.availabilityStartTime;
                periodStartMs = freshMpd.periodStartMs || 0;
                periodDurationMs = freshMpd.periodDurationMs || Infinity;
                activePeriodId = freshMpd.periodId;
                videoTrack = freshMpd.videoTrack;
                videoRenditions = freshMpd.videoRenditions || videoRenditions;
                audioTrack = freshMpd.audioTrack || audioTrack;
                currentRenditionIdx = Math.max(0, videoRenditions.indexOf(videoTrack));
                const freshInit = await getCleanInitSegment(videoTrack.initUrl);
                if (stopped) return { stop };
                await queue.enqueue(videoSb, freshInit);
                if (audioSb && audioTrack) {
                    const freshAudInit = await getCleanInitSegment(audioTrack.initUrl).catch(() => null);
                    if (freshAudInit && !stopped) await queue.enqueue(audioSb, freshAudInit);
                }
                batch = await fetchPrebufferBatch(LIVE_EDGE_SAFETY_SEGMENTS + 1);
                if (stopped) return { stop };
            }
        }

        let lastAppendedVid = batch.sVid - 1;
        let lastAppendedAud = batch.sAud - 1;
        let appendedVidCount = 0;

        for (const res of batch.vRes) {
            if (res && res.cleaned) {
                if (stopped) return { stop };
                await queue.enqueue(videoSb, res.cleaned);
                lastAppendedVid = res.seg;
                appendedVidCount++;
            }
        }

        if (audioSb) {
            for (const res of batch.aRes) {
                if (res && res.cleaned) {
                    if (stopped) return { stop };
                    await queue.enqueue(audioSb, res.cleaned);
                    lastAppendedAud = res.seg;
                }
            }
        }

        if (appendedVidCount === 0 || videoSb.buffered.length === 0) {
            stop();
            throw new Error('No playable segments buffered yet');
        }

        // 5. Seek to aligned buffer start & Start Playback
        try {
            let startSeek = 0;
            const hasVideoBuf = videoSb && videoSb.buffered.length > 0;
            const hasAudioBuf = audioSb && audioSb.buffered.length > 0;

            if (hasVideoBuf && hasAudioBuf) {
                startSeek = Math.max(videoSb.buffered.start(0), audioSb.buffered.start(0)) + 0.08;
                const minEnd = Math.min(
                    videoSb.buffered.end(videoSb.buffered.length - 1),
                    audioSb.buffered.end(audioSb.buffered.length - 1)
                );
                if (startSeek >= minEnd) {
                    startSeek = Math.max(videoSb.buffered.start(0), audioSb.buffered.start(0));
                }
            } else if (hasVideoBuf) {
                startSeek = videoSb.buffered.start(0) + 0.05;
            }

            if (startSeek > 0) {
                videoElement.currentTime = startSeek;
            }
        } catch (e) {}

        config.onPlaying?.();

        try {
            await videoElement.play();
        } catch (e) {
            try {
                videoElement.muted = true;
                await videoElement.play();
            } catch (e2) {}
        }

        // 6. Live Polling Loop with ABR, Live-Edge Catch-up, Forward-Only Gap Healing & Parallel A/V Fetch
        let isPolling = false;
        let consecutiveFailures = 0;
        let slowDownloadStreak = 0;
        let fastDownloadStreak = 0;

        async function switchRendition(newIdx) {
            if (newIdx < 0 || newIdx >= videoRenditions.length || newIdx === currentRenditionIdx) return;
            const nextTrack = videoRenditions[newIdx];
            try {
                const nextInit = await getCleanInitSegment(nextTrack.initUrl);
                if (stopped) return;
                await queue.enqueue(videoSb, nextInit);
                currentRenditionIdx = newIdx;
                videoTrack = nextTrack;
                slowDownloadStreak = 0;
                fastDownloadStreak = 0;
                config.onResolutionChange?.(videoTrack.height);
            } catch (e) {
                console.warn('[iOS-Player] ABR switch skipped:', e.message);
            }
        }

        pollTimer = setInterval(async () => {
            if (stopped || isPolling) return;
            isPolling = true;
            try {
                // A. Buffer Health, Forward-Only Gap Healing & Extreme Drift Catch-Up
                let bufferRunway = 8;
                if (videoSb && videoSb.buffered.length > 0) {
                    const curTime = videoElement.currentTime;
                    const lastRangeIdx = videoSb.buffered.length - 1;
                    const firstBufStart = videoSb.buffered.start(0);
                    const liveBufEnd = videoSb.buffered.end(lastRangeIdx);
                    bufferRunway = Math.max(0, liveBufEnd - curTime);

                    if (!videoElement.paused) {
                        // Case 1: Playhead fell behind the earliest buffered range (e.g. after buffer pruning)
                        if (curTime < firstBufStart - 0.25) {
                            const safeStart = (audioSb && audioSb.buffered.length > 0)
                                ? Math.max(firstBufStart, audioSb.buffered.start(0))
                                : firstBufStart;
                            videoElement.currentTime = safeStart + 0.08;
                        } else if (videoSb.buffered.length > 1) {
                            // Case 2: Multiple disjoint ranges exist and playhead is stuck in an unbuffered gap between range i and i+1
                            for (let i = 0; i < lastRangeIdx; i++) {
                                const rangeEnd = videoSb.buffered.end(i);
                                const nextStart = videoSb.buffered.start(i + 1);
                                if (curTime >= rangeEnd - 0.15 && curTime < nextStart) {
                                    videoElement.currentTime = nextStart + 0.05;
                                    break;
                                }
                            }
                        } else if (bufferRunway > 45) {
                            // Case 3: Playhead drifted >45s behind live buffer edge (e.g. after locking phone / backgrounding tab)
                            const catchupTime = Math.max(videoSb.buffered.start(lastRangeIdx), liveBufEnd - 10);
                            videoElement.currentTime = catchupTime;
                        }
                    }
                }

                // B. Wall-Clock Drift Catch-up & Active Period Boundary Check
                const targetVid = calcLiveSegment(availabilityStartTime, videoTrack, clockOffset, periodStartMs);
                if (targetVid - lastAppendedVid > 6) {
                    lastAppendedVid = Math.max(videoTrack.startNumber, targetVid - 2);
                    if (audioTrack) {
                        const targetAudNow = calcLiveSegment(availabilityStartTime, audioTrack, clockOffset, periodStartMs);
                        lastAppendedAud = Math.max(audioTrack.startNumber, targetAudNow - 2);
                    }
                }

                // Check if current Period duration elapsed -> refresh MPD cleanly
                const periodEnded = (periodDurationMs < Infinity) &&
                    ((Date.now() + clockOffset) >= (availabilityStartTime + periodStartMs + periodDurationMs - 1000));

                // C. Fetch & Decrypt Next Video & Audio Segments Concurrently
                let hadFailure = false;
                const nextVidSeg = lastAppendedVid + 1;
                const nextAudSeg = (audioSb && audioTrack) ? (lastAppendedAud + 1) : -1;
                const targetAud = (audioSb && audioTrack) ? calcLiveSegment(availabilityStartTime, audioTrack, clockOffset, periodStartMs) : -1;

                const needVid = !periodEnded && nextVidSeg <= targetVid;
                const needAud = !periodEnded && audioSb && audioTrack && nextAudSeg <= targetAud;

                if (needVid || needAud) {
                    const vidTask = needVid ? (async () => {
                        const t0 = performance.now();
                        const url = formatSegmentUrl(videoTrack.templateUrl, nextVidSeg);
                        const raw = await fetchBuffer(url);
                        const dlMs = performance.now() - t0;
                        if (!raw || raw.length <= 500) return null;
                        const cleaned = await decryptAndCleanSegment(raw, config.key);
                        return { seg: nextVidSeg, cleaned, dlMs };
                    })().catch(() => { hadFailure = true; return null; }) : Promise.resolve(null);

                    const audTask = needAud ? (async () => {
                        const url = formatSegmentUrl(audioTrack.templateUrl, nextAudSeg);
                        const raw = await fetchBuffer(url);
                        if (!raw || raw.length <= 200) return null;
                        const cleaned = await decryptAndCleanSegment(raw, config.key);
                        return { seg: nextAudSeg, cleaned };
                    })().catch(() => { hadFailure = true; return null; }) : Promise.resolve(null);

                    const [vidRes, audRes] = await Promise.all([vidTask, audTask]);
                    if (stopped) return;

                    if (vidRes && vidRes.cleaned) {
                        await queue.enqueue(videoSb, vidRes.cleaned);
                        lastAppendedVid = vidRes.seg;

                        // ABR Throughput Heuristics (segmentDuration is ~4000ms)
                        const segDurMs = (videoTrack.segmentDuration || 4) * 1000;
                        const dlRatio = vidRes.dlMs / segDurMs;

                        if (dlRatio > 0.78 || (bufferRunway < 3.0 && dlRatio > 0.58)) {
                            slowDownloadStreak++;
                            fastDownloadStreak = 0;
                            if ((isAutoAbr && slowDownloadStreak >= 3) || (slowDownloadStreak >= 4 && bufferRunway < 2.2)) {
                                await switchRendition(currentRenditionIdx - 1);
                            }
                        } else if (dlRatio < 0.25 && bufferRunway > 9.0) {
                            fastDownloadStreak++;
                            slowDownloadStreak = 0;
                            if (isAutoAbr && fastDownloadStreak >= 6 && currentRenditionIdx < videoRenditions.length - 1) {
                                await switchRendition(currentRenditionIdx + 1);
                            }
                        } else {
                            slowDownloadStreak = Math.max(0, slowDownloadStreak - 1);
                        }
                    }

                    if (audRes && audRes.cleaned && audioSb) {
                        await queue.enqueue(audioSb, audRes.cleaned);
                        lastAppendedAud = audRes.seg;
                    }
                }

                if (hadFailure || periodEnded) {
                    if (periodEnded || ++consecutiveFailures >= 4) {
                        consecutiveFailures = 0;
                        try {
                            const freshMpd = await fetchAndParseMpd(config.dashUrl, videoTrack.height || config.targetHeight || 1080, true);
                            if (stopped) return;
                            if (freshMpd.videoTrack &&
                                (freshMpd.periodId !== activePeriodId || freshMpd.videoTrack.startNumber !== videoTrack.startNumber)) {
                                // Period rolled over (tfdt timeline may reset to 0) -> cleanly reload session
                                stop();
                                config.onPeriodRollover?.();
                                return;
                            }
                        } catch (mpdErr) {}

                        const latestVid = calcLiveSegment(availabilityStartTime, videoTrack, clockOffset, periodStartMs, LIVE_EDGE_SAFETY_SEGMENTS + 1);
                        lastAppendedVid = Math.max(videoTrack.startNumber, latestVid - 2);
                        if (audioTrack) {
                            const latestAud = calcLiveSegment(availabilityStartTime, audioTrack, clockOffset, periodStartMs, LIVE_EDGE_SAFETY_SEGMENTS + 1);
                            lastAppendedAud = Math.max(audioTrack.startNumber, latestAud - 2);
                        }
                    }
                } else {
                    consecutiveFailures = 0;
                }

                // E. Buffer Pruning: Keep forward runway deep (prune > 30s behind playhead)
                try {
                    if (videoSb && videoSb.buffered.length > 0) {
                        const start = videoSb.buffered.start(0);
                        const pruneTo = videoElement.currentTime - 30;
                        if (pruneTo > start + 12) {
                            await queue.enqueueRemove(videoSb, start, pruneTo);
                        }
                    }
                    if (audioSb && audioSb.buffered.length > 0) {
                        const start = audioSb.buffered.start(0);
                        const pruneTo = videoElement.currentTime - 30;
                        if (pruneTo > start + 12) {
                            await queue.enqueueRemove(audioSb, start, pruneTo);
                        }
                    }
                } catch (e) {}
            } catch (e) {
                console.warn('[iOS-Player] Poll loop tick notice:', e.message);
            } finally {
                isPolling = false;
            }
        }, 1000);

        return { stop };
    }

    // 8. Public High-Level Unified Player Wrapper
    class IosDashPlayer {
        constructor(videoElement) {
            this.video = videoElement;
            this.session = null;
            this.isIosPlayer = true;
            this.listeners = {};
            this._loadGen = 0;
        }

        addEventListener(event, callback) {
            if (!this.listeners[event]) this.listeners[event] = [];
            this.listeners[event].push(callback);
        }

        removeEventListener(event, callback) {
            if (!this.listeners[event]) return;
            this.listeners[event] = this.listeners[event].filter(cb => cb !== callback);
        }

        emit(event, data) {
            if (this.listeners[event]) {
                this.listeners[event].forEach(cb => {
                    try { cb(data); } catch (e) { console.error(e); }
                });
            }
        }

        async load(dashUrl, kid, key, options = {}) {
            await this.destroy();
            const myGen = ++this._loadGen;
            const runSession = async () => {
                if (this._destroying || myGen !== this._loadGen) return;
                const s = await startIosMmsSession(this.video, {
                    dashUrl,
                    kid,
                    key,
                    targetHeight: options.targetHeight || 1080,
                    autoQuality: !!options.autoQuality,
                    enableAudio: (options.enableAudio !== false && !options.videoOnly),
                    isCancelled: () => this._destroying || myGen !== this._loadGen,
                    onLoading: () => this.emit('buffering', { buffering: true }),
                    onPlaying: () => {
                        this.emit('buffering', { buffering: false });
                        this.emit('playing');
                        options.onPlaying?.();
                    },
                    onResolutionChange: (height) => {
                        this.emit('adaptation', { height });
                        options.onResolutionChange?.(height);
                    },
                    onPeriodRollover: () => {
                        if (!this._destroying && myGen === this._loadGen) {
                            setTimeout(() => { runSession().catch(() => {}); }, 150);
                        }
                    },
                    onError: (err) => this.emit('error', { detail: { message: err } })
                });
                if (this._destroying || myGen !== this._loadGen) {
                    if (s && s.stop) try { s.stop(); } catch (e) {}
                    return;
                }
                this.session = s;
            };
            this._destroying = false;
            try {
                await runSession();
            } catch (err) {
                if (this._destroying || myGen !== this._loadGen) return;
                console.error('[IosDashPlayer] Load failed:', err);
                this.emit('error', { detail: { message: err.message, code: 6099 } });
                throw err;
            }
        }

        async destroy() {
            this._destroying = true;
            this._loadGen++;
            if (this.session) {
                try { this.session.stop(); } catch (e) {}
                this.session = null;
            }
        }

        async unload() {
            await this.destroy();
        }
    }

    // Export to global scope
    window.isAppleDevice = isAppleDevice;
    window.isIosMmsSupported = isIosMmsSupported;
    window.isMmsSupported = isMmsSupported;
    window.IosDashPlayer = IosDashPlayer;

})(typeof window !== 'undefined' ? window : globalThis);
