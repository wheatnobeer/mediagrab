/* MediaGrab - MV3 service worker: sniffing, state, jobs, downloads. */

const MEDIA_TYPES = new Set(['hls', 'dash', 'file']);
const ACTIVE_STATES = new Set(['preparing', 'downloading', 'processing', 'saving']);
const JOB_TTL = 30 * 60 * 1000;

const tabs = new Map();       // tabId -> tab state
const jobs = new Map();       // jobId -> job
const manifests = new Map();  // `${tabId}|${url}` -> {text, at}
const keys = new Map();       // url -> base64
const probeCache = new Map(); // url -> {at, result}
const injected = new Set();
const pollTimers = new Map();
let persistTimer = 0;
let broadcastTimer = 0;

/* ------------------------------------------------------------------ */
/* boot                                                               */
/* ------------------------------------------------------------------ */
const ready = (async () => {
  try {
    const stored = await chrome.storage.session.get('mgTabs');
    const data = stored && stored.mgTabs;
    if (data && typeof data === 'object') {
      for (const [id, s] of Object.entries(data)) {
        if (!s || tabs.has(Number(id))) continue;
        tabs.set(Number(id), {
          ...s,
          streams: Array.isArray(s.streams) ? s.streams : [],
          videos: Array.isArray(s.videos) ? s.videos : [],
          manifests: {}
        });
      }
    }
  } catch (_) { /* ignore */ }
})();

/* ------------------------------------------------------------------ */
/* small helpers                                                      */
/* ------------------------------------------------------------------ */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function errText(e) {
  if (!e) return '未知错误';
  if (typeof e === 'string') return e;
  return e.message || String(e);
}

function canonical(url, type) {
  try {
    const u = new URL(url);
    const path = u.pathname.toLowerCase();
    if (/\.(m3u8|mpd|mp4|m4v|webm|mov|ogv)$/.test(path)) return `${type}|${u.origin}${u.pathname}`;
    const keep = [...u.searchParams]
      .filter(([k]) => /^(id|vid|video|video_id|content|content_id|movie|episode|file)$/i.test(k))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('&');
    return `${type}|${u.origin}${u.pathname}${keep ? '?' + keep : ''}`;
  } catch (_) {
    return `${type}|${url}`;
  }
}

function classify(url, contentType = '') {
  if (!/^https?:/i.test(url)) return null;
  const ct = String(contentType || '').toLowerCase();
  let path = '';
  let mime = '';
  try {
    const u = new URL(url);
    path = u.pathname.toLowerCase();
    mime = (u.searchParams.get('mime') || '').toLowerCase();
  } catch (_) { return null; }
  if (path.endsWith('.m3u8') || ct.includes('mpegurl') || ct.includes('vnd.apple.mpegurl')) return 'hls';
  if (path.endsWith('.mpd') || ct.includes('dash+xml')) return 'dash';
  if (path.endsWith('.ts') || path.endsWith('.m4s') || path.endsWith('.aac') ||
      ct.includes('mp2t') || ct.includes('mpeg-tts')) return 'segment';
  if (/\.(mp4|m4v|webm|mov|ogv|m4a|mp3|ogg|opus|flac|wav)$/.test(path)) return 'file';
  if (ct.startsWith('video/') || ct.startsWith('audio/')) return 'file';
  if (mime.startsWith('audio/') || mime.startsWith('video/')) return 'file';
  return null;
}

function sanitizeFilename(name) {
  let s = String(name || 'video')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '');
  if (!s) s = 'video';
  return s.slice(0, 100);
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

function buildFilename(title, ext, quality) {
  const base = sanitizeFilename(title || 'video');
  const q = quality ? `_${sanitizeFilename(quality).replace(/\s/g, '')}` : '';
  return `${base}${q}_${stamp()}.${ext}`;
}

function extFromUrl(url, contentType = '') {
  try {
    const m = /\.([a-z0-9]{2,5})$/i.exec(new URL(url).pathname);
    if (m) {
      const ext = m[1].toLowerCase();
      if (['mp4', 'webm', 'm4v', 'mov', 'ogv', 'mkv', 'm4a', 'mp3', 'ogg', 'opus', 'flac', 'wav'].includes(ext)) return ext;
    }
  } catch (_) { /* ignore */ }
  let mime = '';
  try { mime = String(new URL(url).searchParams.get('mime') || '').toLowerCase(); } catch (_) { /* ignore */ }
  if (mime.includes('audio/webm')) return 'webm';
  if (mime.includes('audio/mp4')) return 'm4a';
  if (mime.includes('audio/mpeg')) return 'mp3';
  const ct = String(contentType).toLowerCase();
  if (ct.includes('audio/webm')) return 'webm';
  if (ct.includes('audio/mp4') || ct.includes('audio/x-m4a')) return 'm4a';
  if (ct.includes('audio/mpeg') || ct.includes('audio/mp3')) return 'mp3';
  if (ct.includes('audio/aac')) return 'aac';
  if (ct.includes('audio/ogg')) return 'ogg';
  if (ct.includes('audio/opus')) return 'opus';
  if (ct.includes('webm')) return 'webm';
  if (ct.includes('quicktime')) return 'mov';
  return 'mp4';
}

function notify(title, message) {
  try {
    chrome.notifications.create('mg-' + Date.now().toString(36), {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title,
      message: String(message || '').slice(0, 300)
    }).catch(() => {});
  } catch (_) { /* ignore */ }
}

/* ------------------------------------------------------------------ */
/* tab state                                                          */
/* ------------------------------------------------------------------ */
function ensureTab(tabId) {
  let s = tabs.get(tabId);
  if (!s) {
    s = {
      tabId,
      url: '',
      title: '',
      streams: [],
      videos: [],
      meta: null,
      drm: null,
      updatedAt: Date.now()
    };
    tabs.set(tabId, s);
  }
  return s;
}

function resetTab(tabId, url = '', title = '') {
  const s = ensureTab(tabId);
  s.url = url || s.url;
  s.title = title || s.title;
  s.streams = [];
  s.videos = [];
  s.meta = null;
  s.drm = null;
  s.updatedAt = Date.now();
  for (const k of [...manifests.keys()]) if (k.startsWith(tabId + '|')) manifests.delete(k);
  schedulePersist();
  updateBadge(tabId);
}

function addStream(tabId, info) {
  if (!info || !info.url || !MEDIA_TYPES.has(info.type)) return;
  if (!/^https?:/i.test(info.url)) return;
  const s = ensureTab(tabId);
  const key = canonical(info.url, info.type);
  let item = s.streams.find((x) => x.key === key);
  const now = Date.now();
  if (item) {
    item.url = info.url;
    item.lastSeen = now;
    if (info.contentType) item.contentType = info.contentType;
    if (info.size) item.size = info.size;
    if (info.source) item.source = info.source;
    if (info.pageUrl) item.pageUrl = info.pageUrl;
  } else {
    item = {
      key,
      url: info.url,
      type: info.type,
      contentType: info.contentType || '',
      size: info.size || 0,
      source: info.source || 'network',
      firstSeen: now,
      lastSeen: now,
      pageUrl: info.pageUrl || s.url
    };
    s.streams.push(item);
  }
  s.updatedAt = now;
  if (s.streams.length > 80) {
    s.streams.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
    s.streams.length = 80;
  }
  schedulePersist();
}

function updateStreamMeta(tabId, url, patch) {
  const s = ensureTab(tabId);
  const key = canonical(url, patch.type || 'file');
  const item = s.streams.find((x) => x.key === key);
  if (item) {
    if (patch.size) item.size = patch.size;
    if (patch.contentType) item.contentType = patch.contentType;
    item.lastSeen = Date.now();
    schedulePersist();
  }
}

function addVideo(tabId, v) {
  if (!v) return;
  const s = ensureTab(tabId);
  const src = String(v.src || '');
  if (!src) return;
  let item = s.videos.find((x) => x.src === src);
  const now = Date.now();
  const next = {
    src,
    duration: Number(v.duration) || 0,
    width: Number(v.width) || 0,
    height: Number(v.height) || 0,
    poster: v.poster || '',
    paused: !!v.paused,
    drm: !!v.drm,
    title: v.title || s.title || '',
    lastSeen: now
  };
  if (item) Object.assign(item, next);
  else {
    s.videos.push({ ...next, firstSeen: now });
    if (s.videos.length > 12) s.videos.sort((a, b) => b.lastSeen - a.lastSeen).splice(12);
  }
  if (v.drm) addDrm(tabId, 'unknown');
  s.updatedAt = now;
  schedulePersist();
}

function addDrm(tabId, keySystem) {
  const s = ensureTab(tabId);
  const ks = String(keySystem || 'unknown');
  if (s.drm && s.drm.keySystem === ks) return;
  s.drm = { keySystem: ks, at: Date.now() };
  s.updatedAt = Date.now();
  schedulePersist();
}

function mergeScan(tabId, scan) {
  if (!scan) return;
  const s = ensureTab(tabId);
  if (scan.title) s.title = scan.title;
  if (scan.meta) s.meta = scan.meta;
  if (Array.isArray(scan.videos)) scan.videos.forEach((v) => addVideo(tabId, v));
  s.updatedAt = Date.now();
  schedulePersist();
}

/* ------------------------------------------------------------------ */
/* persistence                                                        */
/* ------------------------------------------------------------------ */
function schedulePersist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(persistNow, 700);
}

async function persistNow() {
  try {
    const data = {};
    const now = Date.now();
    let n = 0;
    for (const [id, s] of tabs) {
      if (n++ > 40) break;
      if (!s.updatedAt || now - s.updatedAt > 6 * 60 * 60 * 1000) continue;
      data[id] = {
        tabId: s.tabId,
        url: s.url,
        title: s.title,
        streams: s.streams,
        videos: s.videos,
        meta: s.meta,
        drm: s.drm,
        updatedAt: s.updatedAt
      };
    }
    await chrome.storage.session.set({ mgTabs: data });
  } catch (_) { /* ignore */ }
}

/* ------------------------------------------------------------------ */
/* badges                                                             */
/* ------------------------------------------------------------------ */
function updateBadge(tabId) {
  try {
    const active = [...jobs.values()].filter((j) => j.tabId === tabId && ACTIVE_STATES.has(j.status));
    if (active.length) {
      const p = Math.max(...active.map((j) => Number(j.progress) || 0));
      chrome.action.setBadgeBackgroundColor({ tabId, color: '#6D5EFC' }).catch(() => {});
      chrome.action.setBadgeText({ tabId, text: p > 0 ? `${Math.min(99, Math.floor(p))}%` : '…' }).catch(() => {});
      return;
    }
    const done = [...jobs.values()].find((j) => j.tabId === tabId && j.status === 'done' && Date.now() - (j.finishedAt || 0) < 15000);
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#16A34A' }).catch(() => {});
    chrome.action.setBadgeText({ tabId, text: done ? '✓' : '' }).catch(() => {});
  } catch (_) { /* tab may be gone */ }
}

/* ------------------------------------------------------------------ */
/* jobs                                                               */
/* ------------------------------------------------------------------ */
function createJob(input) {
  const job = {
    id: crypto.randomUUID(),
    tabId: input.tabId,
    url: input.url,
    pageUrl: input.pageUrl || '',
    title: input.title || 'video',
    kind: input.kind || 'hls',
    track: input.track || '',
    quality: input.quality || '',
    format: input.format || 'mp4',
    status: 'preparing',
    progress: 0,
    downloadedBytes: 0,
    totalBytes: 0,
    segmentsDone: 0,
    segmentsTotal: 0,
    speed: 0,
    eta: 0,
    message: '正在解析视频…',
    error: '',
    createdAt: Date.now()
  };
  jobs.set(job.id, job);
  return job;
}

function updateJob(id, patch, opts = {}) {
  const job = jobs.get(id);
  if (!job) return;
  if (job.status === 'canceled' && !opts.force) return;
  if (patch.status && job.status === 'canceled' && patch.status !== 'canceled') return;
  Object.assign(job, patch);
  if (typeof job.progress === 'number') job.progress = Math.max(0, Math.min(100, job.progress));
  job.updatedAt = Date.now();
  updateBadge(job.tabId);
  scheduleBroadcast();
}

function scheduleBroadcast() {
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = 0;
    chrome.runtime.sendMessage({ type: 'JOBS_CHANGED' }).catch(() => {});
  }, 250);
}

function jobsForTab(tabId) {
  const now = Date.now();
  return [...jobs.values()]
    .filter((j) => j.tabId === tabId && now - j.createdAt < JOB_TTL)
    .sort((a, b) => b.createdAt - a.createdAt);
}

function publicJob(j) {
  return {
    id: j.id,
    tabId: j.tabId,
    title: j.title,
    kind: j.kind,
    format: j.format,
    track: j.track || '',
    quality: j.quality,
    status: j.status,
    progress: Math.round(Number(j.progress) || 0),
    downloadedBytes: j.downloadedBytes || 0,
    totalBytes: j.totalBytes || 0,
    segmentsDone: j.segmentsDone || 0,
    segmentsTotal: j.segmentsTotal || 0,
    speed: j.speed || 0,
    eta: j.eta || 0,
    message: j.message || '',
    error: j.error || '',
    filename: j.filename || '',
    size: j.size || 0,
    createdAt: j.createdAt
  };
}

/* ------------------------------------------------------------------ */
/* offscreen                                                          */
/* ------------------------------------------------------------------ */
let offscreenCreating = null;

async function ensureOffscreen() {
  if (chrome.offscreen && chrome.offscreen.hasDocument) {
    if (await chrome.offscreen.hasDocument()) return true;
  }
  if (offscreenCreating) { await offscreenCreating; return true; }
  offscreenCreating = chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['BLOBS'],
    justification: '在后台下载并合并 HLS 分片，再生成可保存的 Blob 文件'
  }).catch((e) => {
    if (!String(e && e.message).includes('Only a single offscreen')) throw e;
  }).finally(() => { offscreenCreating = null; });
  await offscreenCreating;
  return true;
}

async function offscreenSend(message, timeout = 20000) {
  await ensureOffscreen();
  const payload = { target: 'offscreen', ...message };
  const started = Date.now();
  let lastErr;
  while (Date.now() - started < timeout) {
    try {
      const res = await chrome.runtime.sendMessage(payload);
      if (res !== undefined) return res;
    } catch (e) {
      lastErr = e;
      await sleep(150);
    }
  }
  throw lastErr || new Error('后台下载器没有响应');
}

/* ------------------------------------------------------------------ */
/* downloads                                                          */
/* ------------------------------------------------------------------ */
function startPolling(job) {
  stopPolling(job.id);
  const timer = setInterval(async () => {
    if (!job.downloadId) { stopPolling(job.id); return; }
    let item;
    try {
      [item] = await chrome.downloads.search({ id: job.downloadId });
    } catch (_) { return; }
    if (!item) return;
    if (job.status === 'canceled') { stopPolling(job.id); return; }
    if (item.state === 'in_progress') {
      const total = item.totalBytes > 0 ? item.totalBytes : (job.size || 0);
      let pct = job.progress;
      if (total > 0) pct = Math.max(job.progress, 92 + (item.bytesReceived / total) * 7);
      updateJob(job.id, {
        status: 'saving',
        progress: Math.min(99, pct),
        downloadedBytes: item.bytesReceived,
        totalBytes: total,
        message: '正在写入文件…'
      });
    } else if (item.state === 'complete') {
      stopPolling(job.id);
      finishJob(job, item);
    } else if (item.state === 'interrupted') {
      stopPolling(job.id);
      if (job.status === 'canceled') return;
      failJob(job, downloadErrorText(item.error));
    }
  }, 650);
  pollTimers.set(job.id, timer);
}

function stopPolling(id) {
  const t = pollTimers.get(id);
  if (t) { clearInterval(t); pollTimers.delete(id); }
}

function downloadErrorText(code) {
  const map = {
    SERVER_FORBIDDEN: '服务器拒绝下载（403）：链接可能已过期，或需要从页面内重新获取',
    SERVER_UNAUTHORIZED: '未授权（401）：请确认已登录该网站',
    SERVER_BAD_CONTENT: '服务器返回了无效内容（404/400）',
    NETWORK_FAILED: '网络错误，请检查网络或代理',
    NETWORK_TIMEOUT: '网络超时',
    USER_CANCELED: '下载被取消',
    FILE_FAILED: '无法写入下载目录：请检查文件夹权限，或在 Chrome 设置中更换下载位置',
    FILE_NO_SPACE: '磁盘空间不足，无法保存文件',
    FILE_TOO_LARGE: '文件过大，无法保存',
    CRASH: '下载进程异常退出'
  };
  return map[code] || `下载失败（${code || '未知原因'}）`;
}

function finishJob(job, item) {
  if (job.status === 'canceled' || job.status === 'done' || job.status === 'error') return;
  job.status = 'done';
  job.progress = 100;
  job.finishedAt = Date.now();
  job.size = item.fileSize || job.size || 0;
  job.downloadedBytes = job.size || job.downloadedBytes;
  job.totalBytes = job.size || job.totalBytes;
  job.filename = String(item.filename || job.filename || '').split(/[\\/]/).pop();
  job.message = '下载完成';
  job.speed = 0;
  job.eta = 0;
  updateJob(job.id, {}, { force: true });
  if (job.blobUrl) {
    chrome.runtime.sendMessage({ target: 'offscreen', type: 'REVOKE', url: job.blobUrl, jobId: job.id }).catch(() => {});
  }
  notify('下载完成', job.filename || job.title);
  updateBadge(job.tabId);
}

function failJob(job, message) {
  if (job.status === 'canceled' || job.status === 'done' || job.status === 'error') return;
  job.status = 'error';
  job.error = message || '下载失败';
  job.message = job.error;
  job.finishedAt = Date.now();
  job.speed = 0;
  job.eta = 0;
  updateJob(job.id, {}, { force: true });
  notify('下载失败', `${job.title}：${job.error}`);
  updateBadge(job.tabId);
}

async function cancelJob(id) {
  const job = jobs.get(id);
  if (!job) return;
  job.status = 'canceled';
  job.message = '已取消';
  job.finishedAt = Date.now();
  job.speed = 0;
  job.eta = 0;
  if (job.downloadId) {
    try { await chrome.downloads.cancel(job.downloadId); } catch (_) { /* ignore */ }
  }
  stopPolling(id);
  chrome.runtime.sendMessage({ target: 'offscreen', type: 'CANCEL', jobId: id }).catch(() => {});
  updateBadge(job.tabId);
  scheduleBroadcast();
}

/* ------------------------------------------------------------------ */
/* injection                                                          */
/* ------------------------------------------------------------------ */
async function ensureInjected(tabId) {
  if (injected.has(tabId)) return true;
  const run = async (allFrames) => {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames },
      files: ['content/hook.js'],
      world: 'MAIN'
    });
    await chrome.scripting.executeScript({
      target: { tabId, allFrames },
      files: ['content/bridge.js']
    });
  };
  try {
    await run(true);
    injected.add(tabId);
    return true;
  } catch (_) {
    try {
      await run(false);
      injected.add(tabId);
      return true;
    } catch (_) {
      return false;
    }
  }
}

async function scanTab(tabId) {
  let scan = null;
  try {
    scan = await chrome.tabs.sendMessage(tabId, { type: 'SCAN_PAGE' });
  } catch (_) { /* no receiver yet */ }
  if (!scan) {
    await ensureInjected(tabId);
    await sleep(150);
    try { scan = await chrome.tabs.sendMessage(tabId, { type: 'SCAN_PAGE' }); } catch (_) { /* ignore */ }
  }
  if (scan) mergeScan(tabId, scan);
  return scan;
}

/* ------------------------------------------------------------------ */
/* page events                                                        */
/* ------------------------------------------------------------------ */
function getManifestText(tabId, url) {
  const exact = manifests.get(`${tabId}|${url}`);
  if (exact) return exact.text;
  try {
    const want = new URL(url);
    for (const [k, v] of manifests) {
      if (!k.startsWith(tabId + '|')) continue;
      const have = new URL(k.slice(String(tabId).length + 1));
      if (have.origin === want.origin && have.pathname === want.pathname) return v.text;
    }
  } catch (_) { /* ignore */ }
  return '';
}

function handlePageEvent(payload, sender) {
  if (!payload || !sender || !sender.tab || sender.tab.id == null) return;
  const tabId = sender.tab.id;
  const s = ensureTab(tabId);
  if (sender.tab.url) s.url = sender.tab.url;
  if (sender.tab.title) s.title = sender.tab.title;
  const now = Date.now();

  switch (payload.kind) {
    case 'manifest': {
      if (!payload.url || !payload.text) return;
      if (!/^https?:/i.test(payload.url)) return;
      const key = `${tabId}|${payload.url}`;
      manifests.set(key, { text: String(payload.text).slice(0, 4 * 1024 * 1024), at: now });
      const mine = [...manifests.keys()].filter((k) => k.startsWith(tabId + '|'));
      if (mine.length > 12) {
        mine.sort((a, b) => (manifests.get(a)?.at || 0) - (manifests.get(b)?.at || 0));
        for (const k of mine.slice(0, mine.length - 12)) manifests.delete(k);
      }
      addStream(tabId, { url: payload.url, type: 'hls', source: 'page', pageUrl: s.url });
      break;
    }
    case 'key': {
      if (!payload.url || !payload.base64) return;
      keys.set(payload.url, payload.base64);
      if (keys.size > 120) keys.delete(keys.keys().next().value);
      break;
    }
    case 'drm': {
      addDrm(tabId, payload.keySystem || 'unknown');
      break;
    }
    case 'videos': {
      if (Array.isArray(payload.videos)) payload.videos.forEach((v) => addVideo(tabId, v));
      break;
    }
    case 'meta': {
      s.meta = {
        title: payload.title || '',
        artist: payload.artist || '',
        artwork: Array.isArray(payload.artwork) ? payload.artwork.slice(0, 6) : []
      };
      break;
    }
    case 'scan-result': {
      mergeScan(tabId, payload);
      break;
    }
    case 'resource': {
      const type = classify(payload.url, '');
      if (type && type !== 'segment') {
        addStream(tabId, { url: payload.url, type, source: 'page', pageUrl: s.url });
      }
      break;
    }
    default:
      break;
  }
  s.updatedAt = now;
  schedulePersist();
}

/* ------------------------------------------------------------------ */
/* webRequest                                                         */
/* ------------------------------------------------------------------ */
try {
  chrome.webRequest.onBeforeRequest.addListener((d) => {
    if (d.tabId == null || d.tabId < 0) return;
    if (d.initiator && String(d.initiator).startsWith('chrome-extension://')) return;
    const type = classify(d.url, '');
    if (!type || type === 'segment') return;
    addStream(d.tabId, { url: d.url, type, source: 'network' });
  }, { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other'] });
} catch (_) { /* ignore */ }

try {
  chrome.webRequest.onHeadersReceived.addListener((d) => {
    if (d.tabId == null || d.tabId < 0) return;
    if (d.initiator && String(d.initiator).startsWith('chrome-extension://')) return;
    let ct = '';
    let len = 0;
    for (const h of d.responseHeaders || []) {
      const n = String(h.name || '').toLowerCase();
      if (n === 'content-type') ct = String(h.value || '');
      if (n === 'content-length') len = parseInt(h.value, 10) || 0;
    }
    const type = classify(d.url, ct);
    if (!type || type === 'segment') return;
    addStream(d.tabId, { url: d.url, type, contentType: ct, size: len, source: 'network' });
  }, { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other'] }, ['responseHeaders']);
} catch (_) { /* ignore */ }

/* ------------------------------------------------------------------ */
/* tabs                                                               */
/* ------------------------------------------------------------------ */
chrome.tabs.onRemoved.addListener((tabId) => {
  tabs.delete(tabId);
  injected.delete(tabId);
  for (const k of [...manifests.keys()]) if (k.startsWith(tabId + '|')) manifests.delete(k);
  for (const j of [...jobs.values()]) {
    if (j.tabId === tabId && ACTIVE_STATES.has(j.status)) {
      cancelJob(j.id).catch(() => {});
    } else if (j.tabId === tabId) {
      stopPolling(j.id);
    }
  }
  schedulePersist();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading') {
    resetTab(tabId, changeInfo.url || tab.url || '', tab.title || '');
    injected.delete(tabId);
    return;
  }
  const s = tabs.get(tabId);
  if (!s) return;
  if (changeInfo.title) { s.title = changeInfo.title; schedulePersist(); }
  if (changeInfo.url) { s.url = changeInfo.url; schedulePersist(); }
});

chrome.tabs.onActivated.addListener(({ tabId }) => updateBadge(tabId));

/* ------------------------------------------------------------------ */
/* messaging                                                          */
/* ------------------------------------------------------------------ */
function reply(promise, sendResponse) {
  Promise.resolve(promise)
    .then((r) => sendResponse(r))
    .catch((e) => sendResponse({ ok: false, error: errText(e) }));
  return true;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  if (msg.target === 'offscreen') return;

  switch (msg.type) {
    case 'PAGE_EVENT': {
      handlePageEvent(msg.payload, sender);
      return false;
    }

    case 'GET_STATE': {
      return reply((async () => {
        await ready;
        const tabId = msg.tabId;
        let tab = null;
        try { tab = await chrome.tabs.get(tabId); } catch (_) { /* ignore */ }
        const s = ensureTab(tabId);
        if (tab) {
          s.url = tab.url || s.url;
          s.title = tab.title || s.title;
        }
        if (!injected.has(tabId)) await ensureInjected(tabId);
        await scanTab(tabId);
        const current = ensureTab(tabId);
        return {
          ok: true,
          tab: tab ? {
            id: tab.id,
            title: tab.title || '',
            url: tab.url || '',
            favIconUrl: tab.favIconUrl || ''
          } : { id: tabId, title: current.title, url: current.url, favIconUrl: '' },
          streams: current.streams.slice().sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0)),
          videos: current.videos.slice().sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0)),
          meta: current.meta,
          drm: current.drm,
          jobs: jobsForTab(tabId).map(publicJob)
        };
      })(), sendResponse);
    }

    case 'SCAN': {
      return reply((async () => {
        await ready;
        await ensureInjected(msg.tabId);
        const scan = await scanTab(msg.tabId);
        const s = ensureTab(msg.tabId);
        return { ok: true, scan, state: { videos: s.videos, streams: s.streams, drm: s.drm } };
      })(), sendResponse);
    }

    case 'PROBE': {
      return reply((async () => {
        await ready;
        const url = msg.url;
        const cached = probeCache.get(url);
        if (cached && Date.now() - cached.at < 60000) return { ok: true, probe: cached.result };
        const text = getManifestText(msg.tabId, url);
        const res = await offscreenSend({ type: 'PROBE', url, pageUrl: msg.pageUrl || '', manifestText: text }, 45000);
        if (!res || !res.ok) throw new Error((res && res.error) || '无法解析视频清单');
        probeCache.set(url, { at: Date.now(), result: res.probe });
        return { ok: true, probe: res.probe };
      })(), sendResponse);
    }

    case 'START_DOWNLOAD': {
      return reply((async () => {
        await ready;
        const job = createJob({
          tabId: msg.tabId,
          url: msg.url,
          pageUrl: msg.pageUrl || '',
          title: msg.title || 'video',
          kind: msg.kind || 'hls',
          track: msg.track || '',
          quality: msg.quality || '',
          format: msg.format || 'mp4'
        });
        updateBadge(job.tabId);
        scheduleBroadcast();

        if (job.kind === 'file') {
          try {
            const ext = extFromUrl(job.url, msg.contentType || '');
            job.filename = buildFilename(job.title, ext, '');
            job.status = 'downloading';
            job.message = '正在连接…';
            const opts = {
              url: job.url,
              filename: job.filename,
              conflictAction: 'uniquify',
              saveAs: false
            };
            if (job.pageUrl) {
              opts.headers = [{ name: 'Referer', value: job.pageUrl }];
            }
            let downloadId;
            try {
              downloadId = await chrome.downloads.download(opts);
            } catch (e) {
              if (opts.headers) {
                delete opts.headers;
                downloadId = await chrome.downloads.download(opts);
              } else {
                throw e;
              }
            }
            job.downloadId = downloadId;
            job.message = '正在下载…';
            updateJob(job.id, { status: 'downloading', progress: 1, message: '正在下载…' });
            startPolling(job);
            return { ok: true, jobId: job.id };
          } catch (e) {
            failJob(job, errText(e));
            throw e;
          }
        }

        try {
          const text = getManifestText(job.tabId, job.url);
          const res = await offscreenSend({
            type: 'START',
            jobId: job.id,
            url: job.url,
            variantUrl: msg.variantUrl || '',
            track: job.track || '',
            pageUrl: job.pageUrl,
            title: job.title,
            format: job.format,
            tabId: job.tabId,
            manifestText: text
          }, 30000);
          if (!res || !res.ok) throw new Error((res && res.error) || '无法启动后台下载');
          return { ok: true, jobId: job.id };
        } catch (e) {
          failJob(job, errText(e));
          throw e;
        }
      })(), sendResponse);
    }

    case 'JOB_UPDATE': {
      if (msg.job && msg.job.id) {
        const j = jobs.get(msg.job.id);
        if (j) {
          const patch = { ...msg.job };
          delete patch.id;
          updateJob(j.id, patch);
        }
      }
      return false;
    }

    case 'GET_JOBS': {
      return reply((async () => {
        await ready;
        return { ok: true, jobs: msg.tabId ? jobsForTab(msg.tabId).map(publicJob) : [...jobs.values()].map(publicJob) };
      })(), sendResponse);
    }

    case 'CANCEL_JOB': {
      return reply((async () => {
        await cancelJob(msg.jobId);
        return { ok: true };
      })(), sendResponse);
    }

    case 'SAVE_BLOB': {
      return reply((async () => {
        const job = jobs.get(msg.jobId);
        if (!job) return { ok: false, error: '任务不存在' };
        const filename = buildFilename(job.title, msg.ext || (job.format === 'ts' ? 'ts' : 'mp4'), job.quality);
        job.filename = filename;
        job.blobUrl = msg.blobUrl;
        job.size = msg.size || 0;
        job.status = 'saving';
        job.progress = 92;
        job.message = '正在保存文件…';
        try {
          const downloadId = await chrome.downloads.download({
            url: msg.blobUrl,
            filename,
            conflictAction: 'uniquify',
            saveAs: false
          });
          job.downloadId = downloadId;
          updateJob(job.id, { status: 'saving', progress: 92, message: '正在保存文件…' });
          startPolling(job);
          return { ok: true, downloadId };
        } catch (e) {
          const message = errText(e);
          if (/FILE_FAILED|Invalid URL|blob/i.test(message)) {
            try {
              await chrome.tabs.create({ url: msg.blobUrl });
              failJob(job, '自动保存失败，已在新标签页打开视频，请右键选择“视频另存为”');
              return { ok: false, error: message };
            } catch (_) { /* fall through */ }
          }
          failJob(job, '保存文件失败：' + message);
          return { ok: false, error: message };
        }
      })(), sendResponse);
    }

    case 'GET_MANIFEST': {
      return reply((async () => {
        await ready;
        return { ok: true, text: getManifestText(msg.tabId, msg.url) };
      })(), sendResponse);
    }

    case 'GET_KEY': {
      return reply((async () => {
        await ready;
        let found = keys.get(msg.url) || '';
        if (!found) {
          try {
            const want = new URL(msg.url);
            for (const [k, v] of keys) {
              const have = new URL(k);
              if (have.origin === want.origin && have.pathname === want.pathname) { found = v; break; }
            }
          } catch (_) { /* ignore */ }
        }
        return { ok: true, base64: found };
      })(), sendResponse);
    }

    case 'CLEAR_TAB': {
      return reply((async () => {
        resetTab(msg.tabId, msg.url || '');
        return { ok: true };
      })(), sendResponse);
    }

    case 'OFFSCREEN_READY': {
      return false;
    }

    default:
      return false;
  }
});

/* ------------------------------------------------------------------ */
/* misc                                                               */
/* ------------------------------------------------------------------ */
try {
  chrome.downloads.onChanged.addListener((delta) => {
    if (!delta || delta.id == null) return;
    const job = [...jobs.values()].find((j) => j.downloadId === delta.id);
    if (!job) return;
    if (delta.state && delta.state.current === 'complete' && job.status !== 'done') {
      chrome.downloads.search({ id: delta.id }).then(([item]) => {
        if (item) { stopPolling(job.id); finishJob(job, item); }
      }).catch(() => {});
    }
    if (delta.state && delta.state.current === 'interrupted' && job.status !== 'error' && job.status !== 'canceled') {
      failJob(job, downloadErrorText(delta.error && delta.error.current));
    }
  });
} catch (_) { /* ignore */ }

try {
  chrome.notifications.onClicked.addListener(() => {
    chrome.tabs.create({ url: 'chrome://downloads/' }).catch(() => {});
  });
} catch (_) { /* ignore */ }

setInterval(() => {
  const now = Date.now();
  for (const [id, j] of jobs) {
    if (j.finishedAt && now - j.finishedAt > JOB_TTL) jobs.delete(id);
  }
  for (const [k, v] of probeCache) if (now - v.at > 10 * 60 * 1000) probeCache.delete(k);
  for (const [id, s] of tabs) if (now - (s.updatedAt || 0) > 8 * 60 * 60 * 1000) tabs.delete(id);
}, 5 * 60 * 1000);

void ready;
