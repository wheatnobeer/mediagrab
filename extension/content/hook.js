/*
 * MediaGrab - MAIN world hook
 * Runs before the page's own scripts and observes media requests without
 * changing how they behave. Captured manifests/keys are forwarded to the
 * isolated content script through window.postMessage.
 */
(() => {
  'use strict';
  if (window.__MEDIAGRAB_HOOKED__) return;
  window.__MEDIAGRAB_HOOKED__ = true;

  const seen = new Map();
  const MAX_TEXT = 4 * 1024 * 1024;

  function post(payload) {
    try {
      window.postMessage({ __mediagrab: true, payload }, '*');
    } catch (_) { /* ignore */ }
  }

  function abs(u) {
    try { return new URL(String(u), location.href).href; } catch (_) { return String(u || ''); }
  }

  function once(key, ttl = 4000) {
    const now = Date.now();
    const last = seen.get(key) || 0;
    if (now - last < ttl) return false;
    seen.set(key, now);
    if (seen.size > 500) {
      for (const [k, t] of seen) if (now - t > 60000) seen.delete(k);
    }
    return true;
  }

  const isM3u8 = (u) => /\.m3u8(?:$|[?#])/i.test(u);
  const isMpd = (u) => /\.mpd(?:$|[?#])/i.test(u);
  const isKey = (u) => /\.key(?:$|[?#])/i.test(u) || /(?:^|[/_.?&=-])(?:aes[-_]?)?keys?(?:[/_.?&=-]|$)/i.test(u);
  const isMp4 = (u) => /\.(?:mp4|m4v|mov|webm)(?:$|[?#])/i.test(u);

  function b64(buf) {
    const bytes = new Uint8Array(buf);
    let out = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      out += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(out);
  }

  function postManifest(url, text) {
    if (!text || text.length > MAX_TEXT) return;
    if (!/#EXTM3U|#EXT-X-/.test(text)) return;
    if (!once('m:' + url)) return;
    post({ kind: 'manifest', url, text });
  }

  function postKey(url, buf) {
    if (!buf || buf.byteLength !== 16) return;
    if (!once('k:' + url)) return;
    post({ kind: 'key', url, base64: b64(buf) });
  }

  /* ------------------------------------------------------------------ */
  /* fetch                                                              */
  /* ------------------------------------------------------------------ */
  try {
    const origFetch = window.fetch;
    if (typeof origFetch === 'function') {
      window.fetch = function mediagrabFetch(input, init) {
        let raw = '';
        try {
          raw = typeof input === 'string' ? input : (input && input.url) || '';
        } catch (_) { /* ignore */ }
        const promise = origFetch.apply(this, arguments);
        try {
          const url = abs(raw);
          if (url && isKey(url)) {
            promise.then((res) => {
              if (!res || !res.ok) return;
              res.clone().arrayBuffer().then((b) => postKey(url, b)).catch(() => {});
            }).catch(() => {});
          } else if (url && (isM3u8(url) || isMpd(url))) {
            promise.then((res) => {
              if (!res || !res.ok) return;
              const ct = String(res.headers.get('content-type') || '').toLowerCase();
              if (isM3u8(url) || ct.includes('mpegurl')) {
                res.clone().text().then((t) => postManifest(url, t)).catch(() => {});
              }
            }).catch(() => {});
          }
        } catch (_) { /* ignore */ }
        return promise;
      };
    }
  } catch (_) { /* ignore */ }

  /* ------------------------------------------------------------------ */
  /* XMLHttpRequest                                                     */
  /* ------------------------------------------------------------------ */
  try {
    const proto = XMLHttpRequest.prototype;
    const origOpen = proto.open;
    const origSend = proto.send;
    proto.open = function mediagrabOpen(method, url) {
      try { this.__mediagrabUrl = abs(url); } catch (_) { /* ignore */ }
      return origOpen.apply(this, arguments);
    };
    proto.send = function mediagrabSend() {
      try {
        const url = this.__mediagrabUrl || '';
        if (url && (isM3u8(url) || isMpd(url) || isKey(url))) {
          this.addEventListener('load', () => {
            try {
              if (isKey(url)) {
                if (this.response instanceof ArrayBuffer) postKey(url, this.response);
                return;
              }
              let text = null;
              if (this.responseType === '' || this.responseType === 'text') {
                text = this.responseText;
              } else if (this.responseType === 'arraybuffer' && this.response) {
                text = new TextDecoder('utf-8').decode(this.response);
              } else if (this.responseType === 'json' && this.response) {
                text = JSON.stringify(this.response);
              }
              if (text) postManifest(url, text);
            } catch (_) { /* ignore */ }
          });
        }
      } catch (_) { /* ignore */ }
      return origSend.apply(this, arguments);
    };
  } catch (_) { /* ignore */ }

  /* ------------------------------------------------------------------ */
  /* EME / DRM detection (report only - never bypassed)                 */
  /* ------------------------------------------------------------------ */
  try {
    const origAccess = navigator.requestMediaKeySystemAccess;
    if (typeof origAccess === 'function') {
      navigator.requestMediaKeySystemAccess = function mediagrabKeySystem(keySystem, configs) {
        try { post({ kind: 'drm', keySystem: String(keySystem || 'unknown') }); } catch (_) { /* ignore */ }
        return origAccess.call(this, keySystem, configs);
      };
    }
  } catch (_) { /* ignore */ }

  try {
    const origSetKeys = HTMLMediaElement.prototype.setMediaKeys;
    if (typeof origSetKeys === 'function') {
      HTMLMediaElement.prototype.setMediaKeys = function mediagrabSetMediaKeys(keys) {
        try { post({ kind: 'drm', keySystem: (keys && keys.keySystem) || 'unknown' }); } catch (_) { /* ignore */ }
        return origSetKeys.call(this, keys);
      };
    }
  } catch (_) { /* ignore */ }

  /* ------------------------------------------------------------------ */
  /* DOM / media element reporting                                      */
  /* ------------------------------------------------------------------ */
  let scanTimer = 0;
  function scanVideos() {
    try {
      const videos = [];
      document.querySelectorAll('video,audio').forEach((el) => {
        const src = el.currentSrc || el.src || '';
        if (!src && !el.srcObject) return;
        videos.push({
          src,
          duration: Number.isFinite(el.duration) ? el.duration : 0,
          width: el.videoWidth || 0,
          height: el.videoHeight || 0,
          poster: el.poster || '',
          paused: !!el.paused,
          readyState: el.readyState || 0,
          drm: !!(el.mediaKeys || el.webkitKeys),
          title: document.title || ''
        });
      });
      if (videos.length) post({ kind: 'videos', videos });

      if ('mediaSession' in navigator && navigator.mediaSession.metadata) {
        const m = navigator.mediaSession.metadata;
        const artwork = (m.artwork || []).map((a) => a.src).filter(Boolean);
        post({ kind: 'meta', title: m.title || '', artist: m.artist || '', artwork });
      }
    } catch (_) { /* ignore */ }
  }

  function scheduleScan(delay = 400) {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scanVideos, delay);
  }

  try {
    ['play', 'playing', 'loadedmetadata', 'durationchange', 'canplay'].forEach((evt) => {
      document.addEventListener(evt, (e) => {
        if (e.target && (e.target.tagName === 'VIDEO' || e.target.tagName === 'AUDIO')) scheduleScan(150);
      }, true);
    });
  } catch (_) { /* ignore */ }

  try {
    const mo = new MutationObserver(() => scheduleScan(600));
    const start = () => {
      const root = document.documentElement || document.body;
      if (root) mo.observe(root, { childList: true, subtree: true });
    };
    if (document.documentElement) start();
    else document.addEventListener('DOMContentLoaded', start, { once: true });
  } catch (_) { /* ignore */ }

  /* ------------------------------------------------------------------ */
  /* Resource timing fallback                                           */
  /* ------------------------------------------------------------------ */
  function scanPerf() {
    try {
      performance.getEntriesByType('resource').forEach((e) => {
        const url = e.name || '';
        if (!url) return;
        if (isM3u8(url) || isMpd(url) || isMp4(url)) {
          if (!once('r:' + url, 15000)) return;
          post({ kind: 'resource', url, initiatorType: e.initiatorType || '', size: e.transferSize || 0 });
        }
      });
    } catch (_) { /* ignore */ }
  }

  scanVideos();
  setTimeout(scanVideos, 1200);
  setTimeout(scanVideos, 3500);
  const perfTimer = setInterval(scanPerf, 3000);
  // Resource timing keeps being useful while the page is alive; the interval
  // is cheap and is torn down automatically with the document.
  void perfTimer;
})();
