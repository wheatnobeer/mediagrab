/* MediaGrab - offscreen downloader: HLS parsing, AES-128, TS -> fMP4, Blob save. */
'use strict';

const ctxs = new Map();       // jobId -> job context
const blobUrls = new Set();
const rawKeyCache = new Map(); // key url -> ArrayBuffer(16)
const cryptoKeyCache = new Map();
const MAX_BLOB_AGE = 30 * 60 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function errText(e) {
  if (!e) return '未知错误';
  if (typeof e === 'string') return e;
  return e.message || String(e);
}

function sendToBackground(message) {
  try {
    return chrome.runtime.sendMessage({ target: 'background', ...message });
  } catch (e) {
    return Promise.reject(e);
  }
}

/* ------------------------------------------------------------------ */
/* HLS parsing                                                        */
/* ------------------------------------------------------------------ */
function parseAttrs(input) {
  const out = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(input))) {
    let v = m[2].trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

function resolveUri(uri, base) {
  try { return new URL(uri, base).href; } catch (_) { return uri; }
}

function parseByteRange(value) {
  const parts = String(value || '').split('@');
  const length = parseInt(parts[0], 10);
  if (!Number.isFinite(length) || length <= 0) return null;
  const offset = parts.length > 1 ? parseInt(parts[1], 10) : null;
  return { length, offset: Number.isFinite(offset) ? offset : null };
}

function parseResolution(value) {
  const m = /^(\d+)x(\d+)$/i.exec(String(value || '').trim());
  return m ? { width: parseInt(m[1], 10), height: parseInt(m[2], 10) } : { width: 0, height: 0 };
}

function parseMaster(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  const variants = [];
  const audioGroups = [];
  const sessionDrm = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (line.startsWith('#EXT-X-MEDIA:')) {
      const a = parseAttrs(line.slice(13));
      if (String(a.TYPE || '').toUpperCase() === 'AUDIO') {
        audioGroups.push({
          groupId: a['GROUP-ID'] || '',
          name: a.NAME || '',
          language: a.LANGUAGE || '',
          uri: a.URI ? resolveUri(a.URI, baseUrl) : '',
          isDefault: a.DEFAULT === 'YES'
        });
      }
    } else if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const a = parseAttrs(line.slice(18));
      let j = i + 1;
      while (j < lines.length && (!lines[j].trim() || lines[j].trim().startsWith('#'))) j++;
      if (j >= lines.length) break;
      const uri = lines[j].trim();
      const res = parseResolution(a.RESOLUTION);
      variants.push({
        url: resolveUri(uri, baseUrl),
        bandwidth: parseInt(a.BANDWIDTH, 10) || 0,
        width: res.width,
        height: res.height,
        codecs: a.CODECS || '',
        audioGroup: a.AUDIO || '',
        name: a.NAME || ''
      });
      i = j;
    } else if (line.startsWith('#EXT-X-SESSION-KEY:')) {
      const a = parseAttrs(line.slice(18));
      const method = String(a.METHOD || '').toUpperCase();
      const keyFormat = a.KEYFORMAT || 'identity';
      if (method !== 'AES-128' || keyFormat !== 'identity') {
        sessionDrm.push({ method, keyFormat });
      }
    }
  }
  return { variants, audioGroups, sessionDrm };
}

function parseMedia(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  let mediaSequence = 0;
  let ended = false;
  let playlistType = '';
  let targetDuration = 0;
  let key = null;
  let map = null;
  let pendingDuration = 0;
  let pendingRange = null;
  let prevRangeEnd = 0;
  let duration = 0;
  let drm = null;
  const segments = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (line.startsWith('#')) {
      if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
        mediaSequence = parseInt(line.slice(22), 10) || 0;
      } else if (line.startsWith('#EXT-X-ENDLIST')) {
        ended = true;
      } else if (line.startsWith('#EXT-X-PLAYLIST-TYPE:')) {
        playlistType = line.slice(21).trim().toUpperCase();
      } else if (line.startsWith('#EXT-X-TARGETDURATION:')) {
        targetDuration = parseFloat(line.slice(22)) || 0;
      } else if (line.startsWith('#EXT-X-KEY:')) {
        const a = parseAttrs(line.slice(11));
        const method = String(a.METHOD || '').toUpperCase();
        const keyFormat = a.KEYFORMAT || 'identity';
        if (method === 'NONE') {
          key = null;
        } else if (method === 'AES-128' && keyFormat === 'identity') {
          if (!a.URI) throw new Error('HLS 密钥地址缺失');
          key = { method, uri: resolveUri(a.URI, baseUrl), iv: a.IV || '' };
        } else {
          drm = { method, keyFormat };
          key = null;
        }
      } else if (line.startsWith('#EXT-X-SESSION-KEY:')) {
        const a = parseAttrs(line.slice(18));
        const method = String(a.METHOD || '').toUpperCase();
        const keyFormat = a.KEYFORMAT || 'identity';
        if (method !== 'AES-128' || keyFormat !== 'identity') drm = { method, keyFormat };
      } else if (line.startsWith('#EXT-X-MAP:')) {
        const a = parseAttrs(line.slice(11));
        let mapRange = a.BYTERANGE ? parseByteRange(a.BYTERANGE) : null;
        if (mapRange && mapRange.offset == null) mapRange = { length: mapRange.length, offset: 0 };
        map = { url: resolveUri(a.URI, baseUrl), range: mapRange };
      } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
        pendingRange = parseByteRange(line.slice(17));
      } else if (line.startsWith('#EXTINF:')) {
        pendingDuration = parseFloat(line.slice(8).split(',')[0]) || 0;
      }
      continue;
    }

    const seq = mediaSequence + segments.length;
    let range = pendingRange;
    if (range && range.offset == null) range = { length: range.length, offset: prevRangeEnd };
    if (range) prevRangeEnd = range.offset + range.length;

    segments.push({
      url: resolveUri(line, baseUrl),
      duration: pendingDuration,
      seq,
      key,
      range,
      map
    });
    duration += pendingDuration;
    pendingDuration = 0;
    pendingRange = null;
  }

  return {
    segments,
    duration,
    live: !ended && playlistType !== 'VOD',
    drm,
    targetDuration,
    mediaSequence
  };
}

function pickBest(variants) {
  return variants.slice().sort((a, b) => (b.height - a.height) || (b.bandwidth - a.bandwidth))[0];
}

function drmMessage(info) {
  const method = info && info.method ? info.method : 'SAMPLE-AES';
  const kf = info && info.keyFormat ? info.keyFormat : '';
  const name = kf && kf !== 'identity' ? kf : method;
  return `检测到 ${name} 版权加密（DRM）。本插件不会绕过 DRM，无法下载该视频。`;
}

function assertNoDrm(media) {
  if (media && media.drm) throw new Error(drmMessage(media.drm));
  const sample = (media.segments || []).find((s) => s.key && s.key.method && s.key.method !== 'AES-128');
  if (sample) throw new Error(drmMessage(sample.key));
}

/* ------------------------------------------------------------------ */
/* network                                                            */
/* ------------------------------------------------------------------ */
async function request(url, opts = {}) {
  const { range = null, pageUrl = '', signal = null, timeout = 45000, retries = 3 } = opts;
  let lastErr = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');

    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => ctrl.abort(), timeout);

    try {
      const headers = {};
      if (range) headers.Range = `bytes=${range.offset}-${range.offset + range.length - 1}`;
      const init = {
        method: 'GET',
        credentials: 'include',
        headers,
        signal: ctrl.signal,
        cache: 'no-store',
        redirect: 'follow'
      };
      if (pageUrl) {
        init.referrer = pageUrl;
        init.referrerPolicy = 'unsafe-url';
      }

      let res;
      try {
        res = await fetch(url, init);
      } catch (e) {
        if (pageUrl && e && e.name === 'TypeError') {
          const retryInit = { ...init };
          delete retryInit.referrer;
          delete retryInit.referrerPolicy;
          res = await fetch(url, retryInit);
        } else {
          throw e;
        }
      }

      if (res.ok) return res;

      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      if ([408, 429, 500, 502, 503, 504].includes(res.status)) {
        lastErr = err;
      } else {
        throw err;
      }
    } catch (e) {
      if (e && e.name === 'AbortError') {
        if (signal && signal.aborted) throw e;
        lastErr = new Error('请求超时');
      } else if (e && e.status) {
        if (![408, 429, 500, 502, 503, 504].includes(e.status)) throw e;
        lastErr = e;
      } else {
        lastErr = e;
      }
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }

    if (attempt < retries) await sleep(500 * (attempt + 1));
  }
  throw lastErr || new Error('网络请求失败');
}

async function fetchText(url, opts = {}) {
  const res = await request(url, opts);
  const text = await res.text();
  return { text, finalUrl: res.url || url };
}

async function fetchBuf(url, opts = {}) {
  const res = await request(url, opts);
  let buf = await res.arrayBuffer();
  const range = opts.range;
  if (range && res.status === 200 && buf.byteLength > range.length) {
    buf = buf.slice(range.offset, range.offset + range.length);
  }
  return buf;
}

async function getCapturedManifest(tabId, url) {
  try {
    const res = await sendToBackground({ type: 'GET_MANIFEST', tabId, url });
    return (res && res.text) || '';
  } catch (_) {
    return '';
  }
}

function normalizeKey(buf, contentType = '') {
  if (!buf) return null;
  let u8 = new Uint8Array(buf);

  if (u8.length >= 3 && u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) u8 = u8.slice(3);
  while (u8.length > 16 && [0x0a, 0x0d, 0x20, 0x09, 0x00].includes(u8[u8.length - 1])) {
    u8 = u8.slice(0, -1);
  }
  if (u8.length === 16) return u8.buffer.slice(u8.byteOffset, u8.byteOffset + 16);

  const text = new TextDecoder('utf-8').decode(u8).trim();
  const compact = text.replace(/\s+/g, '');

  if (/^(?:0x)?[0-9a-f]{32}$/i.test(compact)) return hexToBytes(compact).buffer;

  if (/^[A-Za-z0-9+/_=-]{20,100}$/.test(compact)) {
    try {
      const b = base64ToBuf(compact);
      if (b.byteLength === 16) return b;
    } catch (_) { /* ignore */ }
  }

  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      const j = JSON.parse(text);
      const candidates = [j.key, j.Key, j.aes_key, j.aesKey, j.data, j.value, j.result, j.content];
      for (const c of candidates) {
        if (typeof c === 'string') {
          const n = normalizeKey(new TextEncoder().encode(c).buffer, contentType);
          if (n) return n;
        }
      }
    } catch (_) { /* ignore */ }
  }

  return null;
}

async function getKey(uri, pageUrl, signal) {
  if (rawKeyCache.has(uri)) return rawKeyCache.get(uri);

  let raw = null;
  let contentType = '';
  try {
    const res = await sendToBackground({ type: 'GET_KEY', url: uri });
    if (res && res.base64) {
      raw = base64ToBuf(res.base64);
      contentType = 'captured';
    }
  } catch (_) { /* fall through */ }

  if (!raw) {
    const res = await request(uri, { pageUrl, signal, timeout: 20000, retries: 2 });
    contentType = String(res.headers.get('content-type') || '').toLowerCase();
    raw = await res.arrayBuffer();
  }

  const key = normalizeKey(raw, contentType);
  if (!key) {
    let host = '';
    try { host = new URL(uri).host; } catch (_) { /* ignore */ }
    const len = raw ? raw.byteLength : 0;
    let hint = '不是原始 16 字节，也不是可识别的 Base64/Hex 密钥。';
    if (contentType.includes('html')) hint = '接口返回了网页，通常是登录已失效或链接已过期。';
    else if (len === 32) hint = '返回 32 字节，可能是 AES-256 密钥；当前只支持 AES-128。';
    else if (len === 0) hint = '接口返回了空内容。';
    throw new Error(`AES 密钥格式异常：${host ? host + ' ' : ''}返回 ${len} 字节${contentType && contentType !== 'captured' ? `（${contentType.split(';')[0]}）` : ''}。${hint}`);
  }

  rawKeyCache.set(uri, key);
  return key;
}

function base64ToBuf(b64) {
  let s = String(b64).replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

function hexToBytes(hex) {
  let h = String(hex || '').trim();
  if (h.toLowerCase().startsWith('0x')) h = h.slice(2);
  if (h.length % 2) h = '0' + h;
  if (h.length > 32) h = h.slice(-32);
  h = h.padStart(32, '0');
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function seqIv(seq) {
  const iv = new Uint8Array(16);
  const dv = new DataView(iv.buffer);
  dv.setBigUint64(8, BigInt(seq >>> 0));
  return iv;
}

/* ------------------------------------------------------------------ */
/* fMP4 track-ID normalization                                        */
/* ------------------------------------------------------------------ */
function readU32(b, o) {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}

function writeU32(b, o, v) {
  b[o] = (v >>> 24) & 0xff;
  b[o + 1] = (v >>> 16) & 0xff;
  b[o + 2] = (v >>> 8) & 0xff;
  b[o + 3] = v & 0xff;
}

function boxName(b, o) {
  return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
}

function listBoxes(b, start, end) {
  const out = [];
  let p = start;
  while (p + 8 <= end) {
    let size = readU32(b, p);
    const type = boxName(b, p + 4);
    let header = 8;
    if (size === 1) {
      if (p + 16 > end) break;
      size = readU32(b, p + 8) * 0x100000000 + readU32(b, p + 12);
      header = 16;
    } else if (size === 0) {
      size = end - p;
    }
    if (size < header || p + size > end) break;
    out.push({ type, start: p, payload: p + header, end: p + size });
    p += size;
  }
  return out;
}

function children(b, parent, type) {
  return listBoxes(b, parent.payload, parent.end).filter((x) => x.type === type);
}

/**
 * Rewrite track IDs in a fragmented-MP4 init segment so they start at 1.
 * Some HLS packagers emit track_ID 0, which several editors reject.
 */
function normalizeFmp4Init(init) {
  const empty = new Map();
  const moov = listBoxes(init, 0, init.length).find((b) => b.type === 'moov');
  if (!moov) return { idMap: empty };

  const tracks = [];
  for (const trak of children(init, moov, 'trak')) {
    const tkhd = children(init, trak, 'tkhd')[0];
    if (!tkhd) continue;
    const version = init[tkhd.payload];
    const offset = tkhd.payload + (version === 1 ? 20 : 12);
    if (offset + 4 > tkhd.end) continue;
    const oldId = readU32(init, offset);

    let handler = '';
    const mdia = children(init, trak, 'mdia')[0];
    if (mdia) {
      const hdlr = children(init, mdia, 'hdlr')[0];
      if (hdlr && hdlr.payload + 12 <= hdlr.end) {
        handler = String.fromCharCode(init[hdlr.payload + 8], init[hdlr.payload + 9], init[hdlr.payload + 10], init[hdlr.payload + 11]);
      }
    }
    tracks.push({ oldId, offset, handler });
  }

  if (!tracks.length) return { idMap: empty };
  if (new Set(tracks.map((t) => t.oldId)).size !== tracks.length) {
    // Duplicate IDs cannot be mapped reliably without parsing sample tables.
    return { idMap: empty };
  }

  // Keep video as track 1 when possible, audio after it.
  const order = tracks.slice().sort((a, b) => (a.handler === 'vide' ? 0 : 1) - (b.handler === 'vide' ? 0 : 1));
  const idMap = new Map();
  let next = 1;
  for (const t of order) idMap.set(t.oldId, next++);

  for (const t of tracks) {
    const nid = idMap.get(t.oldId);
    if (nid) writeU32(init, t.offset, nid);
  }

  const mvex = children(init, moov, 'mvex')[0];
  if (mvex) {
    for (const trex of children(init, mvex, 'trex')) {
      const oldId = readU32(init, trex.payload + 4);
      const nid = idMap.get(oldId);
      if (nid) writeU32(init, trex.payload + 4, nid);
    }
  }

  const mvhd = children(init, moov, 'mvhd')[0];
  if (mvhd) writeU32(init, mvhd.end - 4, next);

  return { idMap };
}

function normalizeFmp4Fragment(buf, idMap) {
  if (!idMap || !idMap.size) return;
  for (const moof of listBoxes(buf, 0, buf.length).filter((b) => b.type === 'moof')) {
    for (const traf of children(buf, moof, 'traf')) {
      const tfhd = children(buf, traf, 'tfhd')[0];
      if (!tfhd) continue;
      const oldId = readU32(buf, tfhd.payload + 4);
      const nid = idMap.get(oldId);
      if (nid) writeU32(buf, tfhd.payload + 4, nid);
    }
  }
}

async function getCryptoKey(uri, pageUrl, signal) {
  if (cryptoKeyCache.has(uri)) return cryptoKeyCache.get(uri);
  const raw = await getKey(uri, pageUrl, signal);
  const key = await crypto.subtle.importKey('raw', raw, { name: 'AES-CBC' }, false, ['decrypt']);
  cryptoKeyCache.set(uri, key);
  return key;
}

async function decrypt(data, keyInfo, seq, pageUrl, signal) {
  const key = await getCryptoKey(keyInfo.uri, pageUrl, signal);
  const iv = keyInfo.iv ? hexToBytes(keyInfo.iv) : seqIv(seq);
  try {
    const out = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, data);
    return new Uint8Array(out);
  } catch (e) {
    throw new Error('AES-128 解密失败：密钥不匹配或分片已损坏');
  }
}

/* ------------------------------------------------------------------ */
/* load playlist                                                      */
/* ------------------------------------------------------------------ */
async function loadPlaylist(url, text, pageUrl, signal) {
  let body = text;
  let base = url;
  if (!body) {
    const r = await fetchText(url, { pageUrl, signal, timeout: 30000, retries: 3 });
    body = r.text;
    base = r.finalUrl;
  }
  if (!/#EXTM3U/.test(body)) throw new Error('返回内容不是有效的 HLS 清单');
  if (body.includes('#EXT-X-STREAM-INF')) {
    return { master: parseMaster(body, base), base };
  }
  return { media: parseMedia(body, base), base };
}

async function resolveMedia(msg) {
  const pageUrl = msg.pageUrl || '';
  const signal = msg.signal;
  let text = msg.manifestText || '';
  if (!text) text = await getCapturedManifest(msg.tabId, msg.url);

  let pl = await loadPlaylist(msg.url, text, pageUrl, signal);
  let variant = null;

  if (pl.master) {
    if (pl.master.sessionDrm.length) throw new Error(drmMessage(pl.master.sessionDrm[0]));
    if (!pl.master.variants.length) throw new Error('视频清单中没有可用清晰度');
    if (msg.variantUrl) {
      variant = pl.master.variants.find((v) => v.url === msg.variantUrl) || { url: msg.variantUrl, height: 0, bandwidth: 0 };
    } else {
      variant = pickBest(pl.master.variants);
    }

    const audio = pl.master.audioGroups.find((g) => g.groupId === variant.audioGroup && g.uri);
    const track = audio ? (msg.track === 'video' ? 'video' : 'audio') : 'muxed';

    if (track === 'audio' && audio) {
      const ar = await fetchText(audio.uri, { pageUrl, signal, timeout: 30000, retries: 3 });
      const audioMedia = parseMedia(ar.text, ar.finalUrl);
      assertNoDrm(audioMedia);
      if (!audioMedia.segments.length) throw new Error('未找到音频分片');
      if (audioMedia.live) throw new Error('这是直播或实时流，暂不支持下载');
      return {
        media: audioMedia,
        variant: null,
        playlistUrl: ar.finalUrl,
        master: pl.master,
        audioOnly: true,
        separateAudio: true,
        audioName: audio.name || ''
      };
    }

    const r = await fetchText(variant.url, { pageUrl, signal, timeout: 30000, retries: 3 });
    const media = parseMedia(r.text, r.finalUrl);
    assertNoDrm(media);
    if (!media.segments.length) throw new Error('未找到视频分片');
    if (media.live) throw new Error('这是直播或实时流，暂不支持下载');
    return {
      media,
      variant,
      playlistUrl: r.finalUrl,
      master: pl.master,
      videoOnly: !!audio,
      separateAudio: !!audio
    };
  }

  assertNoDrm(pl.media);
  if (!pl.media.segments.length) throw new Error('未找到视频分片');
  if (pl.media.live) throw new Error('这是直播或实时流，暂不支持下载');
  return { media: pl.media, variant: null, playlistUrl: pl.base, master: null };
}

/* ------------------------------------------------------------------ */
/* probe                                                              */
/* ------------------------------------------------------------------ */
async function probe(msg) {
  const pageUrl = msg.pageUrl || '';
  let text = msg.manifestText || '';
  let base = msg.url;
  if (!text) {
    const r = await fetchText(msg.url, { pageUrl, timeout: 25000, retries: 2 });
    text = r.text;
    base = r.finalUrl;
  }
  if (!/#EXTM3U/.test(text)) throw new Error('返回内容不是有效的 HLS 清单');

  if (text.includes('#EXT-X-STREAM-INF')) {
    const master = parseMaster(text, base);
    if (!master.variants.length) throw new Error('清单中没有可用清晰度');
    const best = pickBest(master.variants);
    let media = null;
    try {
      const r = await fetchText(best.url, { pageUrl, timeout: 20000, retries: 1 });
      media = parseMedia(r.text, r.finalUrl);
    } catch (_) { /* keep master info */ }
    const audio = master.audioGroups.find((g) => g.groupId === best.audioGroup && g.uri);
    return {
      ok: true,
      probe: {
        master: true,
        variants: master.variants,
        duration: media ? media.duration : 0,
        segments: media ? media.segments.length : 0,
        encrypted: !!(media && media.segments.some((s) => s.key)),
        drm: !!(master.sessionDrm.length || (media && media.drm)),
        drmReason: master.sessionDrm.length ? drmMessage(master.sessionDrm[0]) : (media && media.drm ? drmMessage(media.drm) : ''),
        separateAudio: !!audio,
        audioUrl: audio ? audio.uri : '',
        audioName: audio ? audio.name : '',
        videoUrl: best.url,
        live: !!(media && media.live)
      }
    };
  }

  const media = parseMedia(text, base);
  return {
    ok: true,
    probe: {
      master: false,
      variants: [],
      duration: media.duration,
      segments: media.segments.length,
      encrypted: media.segments.some((s) => s.key),
      drm: !!media.drm,
      drmReason: media.drm ? drmMessage(media.drm) : '',
      separateAudio: false,
      live: media.live
    }
  };
}

/* ------------------------------------------------------------------ */
/* job execution                                                      */
/* ------------------------------------------------------------------ */
function startJob(msg) {
  if (ctxs.has(msg.jobId)) return;
  const ctx = {
    jobId: msg.jobId,
    canceled: false,
    controller: new AbortController(),
    downloadedBytes: 0,
    totalBytes: 0,
    segmentsDone: 0,
    segmentsTotal: 0,
    speed: 0,
    eta: 0,
    quality: '',
    parts: [],
    blobUrl: '',
    lastReportAt: 0,
    lastReportBytes: 0
  };
  ctxs.set(msg.jobId, ctx);

  runJob(msg, ctx)
    .then(() => { /* saving is handled by background */ })
    .catch((e) => {
      if (ctx.canceled) return;
      report(ctx, {
        status: 'error',
        error: errText(e),
        message: errText(e),
        speed: 0,
        eta: 0,
        force: true
      });
    })
    .finally(() => {
      ctxs.delete(msg.jobId);
      if (ctx.blobUrl) setTimeout(() => revoke(ctx.blobUrl), MAX_BLOB_AGE);
    });
}

function report(ctx, patch) {
  const now = Date.now();
  if (!patch.force && now - ctx.lastReportAt < 450) return;
  ctx.lastReportAt = now;

  const total = ctx.totalBytes || 0;
  const downloaded = ctx.downloadedBytes || 0;

  const job = {
    id: ctx.jobId,
    downloadedBytes: downloaded,
    totalBytes: total,
    segmentsDone: ctx.segmentsDone,
    segmentsTotal: ctx.segmentsTotal,
    speed: Math.round(ctx.speed || 0),
    eta: Math.round(ctx.eta || 0)
  };
  if (ctx.quality) job.quality = ctx.quality;
  if (patch.status) job.status = patch.status;
  if (patch.progress != null) job.progress = patch.progress;
  if (patch.message) job.message = patch.message;
  if (patch.error) job.error = patch.error;

  sendToBackground({ type: 'JOB_UPDATE', job }).catch(() => {});
}

function progress(ctx, force = false) {
  const ratio = ctx.segmentsTotal ? ctx.segmentsDone / ctx.segmentsTotal : 0;
  const pct = 3 + ratio * 87;

  const now = Date.now();
  const dt = (now - (ctx.speedAt || now)) / 1000;
  if (dt >= 0.5) {
    const inst = Math.max(0, (ctx.downloadedBytes - (ctx.speedBytes || 0)) / dt);
    ctx.speed = ctx.speed ? ctx.speed * 0.65 + inst * 0.35 : inst;
    ctx.speedAt = now;
    ctx.speedBytes = ctx.downloadedBytes;
    if (ctx.totalBytes > 0 && ctx.speed > 0) {
      ctx.eta = Math.max(0, (ctx.totalBytes - ctx.downloadedBytes) / ctx.speed);
    }
  }

  report(ctx, {
    status: 'downloading',
    progress: Math.min(90, pct),
    message: `正在下载分片 ${ctx.segmentsDone}/${ctx.segmentsTotal}`,
    force
  });
}

function throwIfCanceled(ctx) {
  if (ctx.canceled) throw new DOMException('Aborted', 'AbortError');
}

async function runJob(msg, ctx) {
  const pageUrl = msg.pageUrl || '';
  const signal = ctx.controller.signal;
  const format = msg.format === 'ts' ? 'ts' : 'mp4';

  report(ctx, { status: 'preparing', progress: 1, message: '正在读取视频清单…', force: true });

  const resolved = await resolveMedia({ ...msg, pageUrl, signal });
  throwIfCanceled(ctx);

  const media = resolved.media;
  const variant = resolved.variant;
  const parts = ctx.parts;
  const audioOnly = !!resolved.audioOnly;

  ctx.segmentsTotal = media.segments.length;
  if (audioOnly) ctx.quality = 'audio';
  else if (variant && variant.height) ctx.quality = `${variant.height}p`;
  else if (variant && variant.bandwidth) ctx.quality = `${Math.round(variant.bandwidth / 1000)}kbps`;

  let estimate = 0;
  if (variant && variant.bandwidth && media.duration) {
    estimate = Math.round((variant.bandwidth * media.duration) / 8);
  }
  ctx.totalBytes = estimate;

  report(ctx, {
    status: 'downloading',
    progress: 2,
    message: `开始下载 · ${ctx.segmentsTotal} 个分片`,
    quality: ctx.quality,
    segmentsTotal: ctx.segmentsTotal,
    totalBytes: estimate,
    force: true
  });

  let mode = 'ts';
  if (format === 'ts') {
    mode = 'ts';
  } else if (media.segments[0] && media.segments[0].map) {
    mode = 'fmp4';
  } else {
    mode = 'unknown';
  }

  let mux = null;
  let muxInit = false;
  let muxBytes = 0;
  let muxIdMap = null;
  let fmp4IdMap = null;

  if (mode === 'fmp4' && media.segments[0].map) {
    const map = media.segments[0].map;
    const init = new Uint8Array(await fetchBuf(map.url, { range: map.range, pageUrl, signal, timeout: 30000 }));
    fmp4IdMap = normalizeFmp4Init(init).idMap;
    parts.push(init);
    ctx.downloadedBytes += init.byteLength;
  }

  const ensureMux = () => {
    if (mux) return;
    if (typeof muxjs === 'undefined' || !muxjs.mp4 || !muxjs.mp4.Transmuxer) {
      throw new Error('MP4 转封装组件加载失败，请改用 TS 格式');
    }
    mux = new muxjs.mp4.Transmuxer();
    mux.on('data', (segment) => {
      if (!segment) return;
      if (segment.initSegment && !muxInit) {
        const initSeg = new Uint8Array(segment.initSegment);
        muxIdMap = normalizeFmp4Init(initSeg).idMap;
        parts.push(initSeg);
        muxInit = true;
      }
      if (segment.data && segment.data.byteLength) {
        const frag = new Uint8Array(segment.data);
        normalizeFmp4Fragment(frag, muxIdMap);
        parts.push(frag);
        muxBytes += segment.data.byteLength;
      }
    });
  };

  const pushMux = (data) => {
    ensureMux();
    mux.push(data);
    mux.flush();
  };

  const BATCH = 6;
  let index = 0;
  ctx.speedAt = Date.now();
  ctx.speedBytes = 0;

  while (index < media.segments.length) {
    throwIfCanceled(ctx);
    const batch = media.segments.slice(index, index + BATCH);

    const raws = await Promise.all(batch.map(async (seg) => {
      const buf = await fetchBuf(seg.url, { range: seg.range, pageUrl, signal, timeout: 60000 });
      let data = new Uint8Array(buf);
      if (seg.key) data = await decrypt(data, seg.key, seg.seq, pageUrl, signal);
      return data;
    }));

    for (const data of raws) {
      throwIfCanceled(ctx);
      ctx.downloadedBytes += data.byteLength;

      if (mode === 'ts') {
        parts.push(data);
      } else if (mode === 'fmp4') {
        normalizeFmp4Fragment(data, fmp4IdMap);
        parts.push(data);
      } else if (mode === 'unknown') {
        // Try to transmux one segment. If the codecs are unsupported, keep the
        // original TS bytes instead of failing the whole download.
        let ok = false;
        try {
          const tester = new muxjs.mp4.Transmuxer();
          tester.on('data', (segment) => {
            if (segment && segment.data && segment.data.byteLength) ok = true;
          });
          tester.push(data);
          tester.flush();
        } catch (_) { ok = false; }

        if (ok) {
          mode = 'mp4';
          pushMux(data);
        } else {
          mode = 'ts';
          parts.push(data);
        }
      } else if (mode === 'mp4') {
        pushMux(data);
      }

      index++;
      ctx.segmentsDone++;
    }

    progress(ctx);
  }

  throwIfCanceled(ctx);

  if (!parts.length) throw new Error('没有下载到任何媒体数据');

  let ext = 'mp4';
  let mime = 'video/mp4';
  if (mode === 'ts') {
    ext = 'ts';
    mime = 'video/mp2t';
  } else if (audioOnly) {
    ext = 'm4a';
    mime = 'audio/mp4';
  } else if (mode === 'mp4' && muxBytes <= 0) {
    throw new Error('未能识别视频编码，转封装结果为空。请重试并选择“TS 原样”格式');
  }

  report(ctx, {
    status: 'processing',
    progress: 92,
    message: mode === 'ts' ? '正在整理媒体数据…' : (audioOnly ? '正在生成音频文件…' : '正在合并为 MP4…'),
    force: true
  });

  const blob = new Blob(parts, { type: mime });
  parts.length = 0;

  if (!blob.size) throw new Error('生成的媒体文件为空');

  const blobUrl = URL.createObjectURL(blob);
  ctx.blobUrl = blobUrl;
  blobUrls.add(blobUrl);

  report(ctx, { status: 'saving', progress: 96, message: '正在保存文件…', force: true });

  const saved = await sendToBackground({
    type: 'SAVE_BLOB',
    jobId: ctx.jobId,
    blobUrl,
    size: blob.size,
    ext
  });

  if (!saved || !saved.ok) {
    throw new Error((saved && saved.error) || '保存文件失败');
  }
}

function cancel(jobId) {
  const ctx = ctxs.get(jobId);
  if (!ctx) return;
  ctx.canceled = true;
  try { ctx.controller.abort(); } catch (_) { /* ignore */ }
}

function revoke(url) {
  if (!url) return;
  try { URL.revokeObjectURL(url); } catch (_) { /* ignore */ }
  blobUrls.delete(url);
}

/* ------------------------------------------------------------------ */
/* messaging                                                          */
/* ------------------------------------------------------------------ */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return;

  switch (msg.type) {
    case 'PROBE': {
      probe(msg)
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, error: errText(e) }));
      return true;
    }
    case 'START': {
      startJob(msg);
      sendResponse({ ok: true });
      return false;
    }
    case 'CANCEL': {
      cancel(msg.jobId);
      sendResponse({ ok: true });
      return false;
    }
    case 'REVOKE': {
      revoke(msg.url);
      sendResponse({ ok: true });
      return false;
    }
    default:
      return false;
  }
});

// Make sure the service worker knows the document is alive.
sendToBackground({ type: 'OFFSCREEN_READY' }).catch(() => {});

void blobUrls;
