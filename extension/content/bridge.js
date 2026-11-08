/* MediaGrab - isolated world bridge between the page hook and the extension. */
(() => {
  'use strict';
  if (window.__MEDIAGRAB_BRIDGE__) return;
  window.__MEDIAGRAB_BRIDGE__ = true;

  function send(payload) {
    try {
      chrome.runtime.sendMessage({
        type: 'PAGE_EVENT',
        payload,
        pageUrl: location.href,
        frameUrl: location.href
      }).catch(() => {});
    } catch (_) { /* extension context invalidated */ }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.__mediagrab !== true || !data.payload) return;
    send(data.payload);
  });

  function scan() {
    const videos = [];
    try {
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
    } catch (_) { /* ignore */ }

    let meta = null;
    try {
      if ('mediaSession' in navigator && navigator.mediaSession.metadata) {
        const m = navigator.mediaSession.metadata;
        meta = {
          title: m.title || '',
          artist: m.artist || '',
          artwork: (m.artwork || []).map((a) => a.src).filter(Boolean)
        };
      }
    } catch (_) { /* ignore */ }

    return { videos, meta, title: document.title, url: location.href };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg) return;
    if (msg.type === 'SCAN_PAGE' || msg.type === 'PING') {
      const result = scan();
      sendResponse(result);
      return false;
    }
    return false;
  });

  // Report once the page has a chance to create its player, then let the
  // hook's event listeners take over.
  setTimeout(() => send({ kind: 'scan-result', ...scan() }), 800);
  setTimeout(() => send({ kind: 'scan-result', ...scan() }), 3000);
})();
