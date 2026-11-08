/* MediaGrab - popup UI */
'use strict';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));

let tabId = null;
let tabInfo = null;
let state = null;
let currentStreams = [];
let currentJobs = [];
let probes = new Map();      // url -> {status, data, error}
let selection = new Map();   // stream key -> {variantUrl, format}
let openKey = '';
let hideDone = false;
let stateSig = '';
let jobsSig = '';
let refreshing = false;

init();

async function init() {
  bind();
  let tab = null;
  const forcedTabId = Number(new URLSearchParams(location.search).get('tabId'));
  try {
    if (forcedTabId) {
      tab = await chrome.tabs.get(forcedTabId);
    } else {
      [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    }
  } catch (_) { /* ignore */ }
  if (!tab) {
    $('page-title').textContent = '无法获取当前标签页';
    showToast('请在一个普通网页上打开此插件');
    return;
  }
  tabId = tab.id;
  tabInfo = tab;
  await refresh(true);
  loadJobs();
  setInterval(() => refresh(false), 2500);
  setInterval(loadJobs, 900);
}

function bind() {
  $('refresh').addEventListener('click', () => refresh(true));
  $('rescan').addEventListener('click', () => refresh(true));
  $('clear-done').addEventListener('click', () => {
    hideDone = true;
    jobsSig = '';
    loadJobs();
  });

  $('streams').addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const i = Number(el.dataset.i);
    const s = currentStreams[i];
    if (!s) return;
    const act = el.dataset.act;
    if (act === 'toggle') {
      openKey = openKey === s.key ? '' : s.key;
      renderStreams();
      if (openKey) ensureProbe(s);
    } else if (act === 'reprobe') {
      probes.delete(s.url);
      renderStreams();
      ensureProbe(s);
    } else if (act === 'start') {
      startDownload(s);
    }
  });

  $('streams').addEventListener('change', (e) => {
    const sel = e.target.closest('select[data-role]');
    if (!sel) return;
    const i = Number(sel.dataset.i);
    const s = currentStreams[i];
    if (!s) return;
    const cur = selection.get(s.key) || { variantUrl: '', format: 'mp4' };
    cur[sel.dataset.role] = sel.value;
    selection.set(s.key, cur);
  });

  $('jobs').addEventListener('click', (e) => {
    const el = e.target.closest('[data-cancel]');
    if (!el) return;
    send({ type: 'CANCEL_JOB', jobId: el.dataset.cancel });
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'JOBS_CHANGED') loadJobs();
  });
}

async function send(message) {
  try {
    const res = await chrome.runtime.sendMessage(message);
    return res || { ok: false, error: '扩展后台没有响应' };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

async function refresh(manual) {
  if (!tabId || refreshing) return;
  refreshing = true;
  if (manual) $('refresh').classList.add('spinning');
  const started = Date.now();

  const res = await send({ type: 'GET_STATE', tabId });
  if (!res || !res.ok) {
    showToast((res && res.error) || '读取页面失败');
  } else {
    tabInfo = res.tab || tabInfo;
    state = res;
    renderPage();
    renderDrm();
    if (manual || signature() !== stateSig) renderStreams();
    else renderHint();
    autoProbe();
  }

  if (manual) {
    const wait = Math.max(0, 420 - (Date.now() - started));
    setTimeout(() => $('refresh').classList.remove('spinning'), wait);
  } else {
    $('refresh').classList.remove('spinning');
  }
  refreshing = false;
}

/* ------------------------------------------------------------------ */
/* page + banners                                                     */
/* ------------------------------------------------------------------ */
function renderPage() {
  if (!tabInfo) return;
  const meta = state && state.meta;
  const title = (meta && meta.title) || tabInfo.title || '当前页面';
  $('page-title').textContent = title;

  let host = '';
  try {
    const u = new URL(tabInfo.url);
    host = u.host + (u.pathname === '/' ? '' : u.pathname);
  } catch (_) {
    host = tabInfo.url || '';
  }
  $('page-url').textContent = host;

  const fav = $('favicon');
  fav.onerror = () => {
    fav.onerror = null;
    fav.src = '../icons/icon32.png';
  };
  fav.src = tabInfo.favIconUrl || '../icons/icon32.png';
}

function renderDrm() {
  const banner = $('drm-banner');
  const drm = state && state.drm;
  if (!drm) {
    banner.classList.add('hidden');
    return;
  }
  const ks = String(drm.keySystem || '');
  let name = '浏览器 DRM';
  if (/widevine/i.test(ks)) name = 'Widevine';
  else if (/playready/i.test(ks)) name = 'PlayReady';
  else if (/fairplay/i.test(ks)) name = 'FairPlay';
  $('drm-text').textContent = `已检测到 ${name} 加密。本插件不会绕过 DRM，受保护的内容无法下载。`;
  banner.classList.remove('hidden');
}

function renderHint() {
  const banner = $('hint-banner');
  const hasStreams = state && state.streams && state.streams.length;
  if (hasStreams) {
    banner.classList.add('hidden');
    return;
  }
  const videos = (state && state.videos) || [];
  const strong = banner.querySelector('strong');
  const p = banner.querySelector('p');
  const restricted = tabInfo && /^(chrome|edge|about|chrome-extension):/i.test(tabInfo.url || '');

  if (restricted) {
    strong.textContent = '此页面不允许扩展运行';
    p.textContent = 'Chrome 内部页面、扩展商店等页面无法注入嗅探脚本。请在普通网页中使用。';
  } else if (videos.length) {
    strong.textContent = '已检测到播放器，等待媒体流';
    p.textContent = '继续播放或拖动一下进度条，扩展会自动捕获分片地址。也可以点“重新扫描”。';
  } else {
    strong.textContent = '没有检测到媒体';
    p.textContent = '请先在页面中开始播放。若刚安装插件，刷新一次页面后再试。';
  }
  banner.classList.remove('hidden');
}

/* ------------------------------------------------------------------ */
/* streams                                                            */
/* ------------------------------------------------------------------ */
function autoProbe() {
  if (!currentStreams.length) return;
  const todo = currentStreams.filter((s) => s.type === 'hls' && !probes.has(s.url)).slice(0, 3);
  for (const s of todo) ensureProbe(s);
}

async function ensureProbe(s, force = false) {
  if (!force && probes.has(s.url)) return;
  probes.set(s.url, { status: 'loading' });
  renderStreams();

  const res = await send({
    type: 'PROBE',
    tabId,
    url: s.url,
    pageUrl: (tabInfo && tabInfo.url) || ''
  });
  if (res && res.ok) {
    probes.set(s.url, { status: 'ready', data: res.probe });
  } else {
    probes.set(s.url, { status: 'error', error: (res && res.error) || '无法读取视频清单' });
  }
  renderStreams();
}

function streamProbe(s) {
  const p = probes.get(s.url);
  return p && p.status === 'ready' ? p.data : null;
}

function renderStreams() {
  if (!state) {
    renderHint();
    return;
  }

  currentStreams = (state.streams || []).slice().sort((a, b) => {
    const rank = { hls: 0, file: 1, dash: 2 };
    return (rank[a.type] ?? 9) - (rank[b.type] ?? 9) || (b.lastSeen || 0) - (a.lastSeen || 0);
  });

  $('stream-count').textContent = currentStreams.length ? `${currentStreams.length} 个` : '';
  $('empty').classList.toggle('hidden', currentStreams.length > 0);
  renderHint();

  if (!currentStreams.length) {
    $('streams').innerHTML = '';
    stateSig = signature();
    return;
  }

  const container = $('streams');
  container.innerHTML = currentStreams.map((s, i) => cardHtml(s, i)).join('');

  // Poster images are optional; hide broken ones and keep the type badge.
  container.querySelectorAll('img.thumb-img').forEach((img) => {
    img.addEventListener('error', () => img.remove());
  });

  const sig = signature();
  stateSig = sig;
}

function signature() {
  if (!state) return '';
  return [
    tabInfo && tabInfo.url,
    tabInfo && tabInfo.title,
    (state.streams || []).map((s) => `${s.key}:${s.type}:${s.size || 0}:${s.url}`).join(','),
    (state.videos || []).map((v) => `${v.src}:${Math.round(v.duration || 0)}:${v.poster ? 1 : 0}`).join(','),
    state.drm ? state.drm.keySystem : '',
    state.meta ? state.meta.title : ''
  ].join('|');
}

function cardHtml(s, i) {
  const probe = streamProbe(s);
  const open = openKey === s.key;
  const sel = selection.get(s.key) || { variantUrl: '', format: 'mp4' };
  const chosen = probe && probe.variants ? probe.variants.find((v) => v.url === sel.variantUrl) : null;
  const quality = chosen && chosen.height ? `${chosen.height}p` : '';

  const isAudio = s.type === 'file' && (
    String(s.contentType || '').toLowerCase().startsWith('audio/') ||
    /[?&]mime=audio(?:%2F|\/)/i.test(s.url)
  );
  const typeName = isAudio ? '音频文件' : s.type === 'hls' ? 'HLS 视频' : s.type === 'dash' ? 'DASH 视频' : '视频文件';
  const typeShort = isAudio ? 'AUDIO' : s.type === 'hls' ? 'HLS' : s.type === 'dash' ? 'DASH' : 'MP4';
  const poster = pickPoster(s);

  let dur = probe && probe.duration ? probe.duration : 0;
  if (!dur) {
    const v = (state.videos || []).find((x) => x.width && x.height);
    if (v && v.duration > 0) dur = v.duration;
  }
  let est = 0;
  if (probe && probe.variants && probe.duration) {
    const v = chosen || pickBest(probe.variants);
    if (v && v.bandwidth) est = (v.bandwidth * probe.duration) / 8;
  }

  const subParts = [];
  try { subParts.push(new URL(s.url).host); } catch (_) { /* ignore */ }
  if (dur) subParts.push(fmtDur(dur));
  if (s.type !== 'hls' && s.size) subParts.push(fmtBytes(s.size));
  else if (est) subParts.push('约 ' + fmtBytes(est));

  const tags = [];
  tags.push(`<span class="tag ${s.type === 'hls' ? 'hls' : ''}">${s.type === 'hls' ? 'HLS' : s.type === 'dash' ? 'DASH' : 'FILE'}</span>`);
  if (probe && probe.encrypted) tags.push('<span class="tag aes">AES-128</span>');
  if (probe && probe.drm) tags.push('<span class="tag drm">DRM</span>');
  if (probe && probe.separateAudio) tags.push('<span class="tag">分离音轨</span>');
  if (probe && probe.live) tags.push('<span class="tag">直播</span>');
  if (s.type === 'hls' && !probe) tags.push('<span class="tag">嗅探中</span>');

  const disabledDrm = probe && probe.drm;
  let action;
  if (s.type === 'dash') {
    action = '<button class="btn sm" disabled title="DASH 暂不支持">暂不支持</button>';
  } else if (disabledDrm) {
    action = '<button class="btn sm" disabled title="DRM 加密">DRM</button>';
  } else if (s.type === 'hls') {
    action = `<button class="btn primary sm" data-act="toggle" data-i="${i}">${open ? '收起' : '下载'}</button>`;
  } else {
    action = `<button class="btn primary sm" data-act="start" data-i="${i}">下载</button>`;
  }

  return `
    <div class="stream ${open ? 'open' : ''}">
      <div class="thumb">
        <span class="type">${typeShort}</span>
        ${poster ? `<img class="thumb-img" src="${esc(poster)}" alt="">` : ''}
      </div>
      <div class="stream-main">
        <div class="stream-title">${typeName}${quality ? `<span class="quality-pill">${esc(quality)}</span>` : ''}</div>
        <div class="stream-sub">${esc(subParts.join(' · '))}</div>
        <div class="tags">${tags.join('')}</div>
      </div>
      <div class="stream-actions">${action}</div>
    </div>
    ${open ? panelHtml(s, i, probe) : ''}
  `;
}

function panelHtml(s, i, probe) {
  if (!probe) {
    return `
      <div class="panel">
        <div class="probe-state"><span class="spinner"></span>正在读取清晰度…</div>
        <p class="panel-note">读取清单后会显示可选画质。</p>
      </div>`;
  }
  if (probe.error) {
    return `
      <div class="panel">
        <div class="probe-state">读取失败：${esc(probe.error)}</div>
        <div class="panel-foot">
          <span class="est">需要登录的站点请确认当前已登录</span>
          <button class="btn sm" data-act="reprobe" data-i="${i}">重试</button>
        </div>
      </div>`;
  }
  if (probe.drm) {
    return `
      <div class="panel">
        <div class="probe-state">${esc(probe.drmReason || '该视频受 DRM 保护，无法下载。')}</div>
      </div>`;
  }
  if (probe.live) {
    return `<div class="panel"><div class="probe-state">这是直播流，暂不支持下载。</div></div>`;
  }
  if (probe.separateAudio) {
    const sel = selection.get(s.key) || { variantUrl: '', format: 'mp4', track: 'audio' };
    const track = sel.track === 'video' ? 'video' : 'audio';
    const variants = (probe.variants || []).slice().sort((a, b) => (b.height - a.height) || (b.bandwidth - a.bandwidth));
    const chosen = variants.find((v) => v.url === sel.variantUrl) || null;
    const est = chosen && chosen.bandwidth && probe.duration ? (chosen.bandwidth * probe.duration) / 8 : 0;
    const options = [
      `<option value="" ${!sel.variantUrl ? 'selected' : ''}>自动（最佳画质）</option>`,
      ...variants.map((v) => `<option value="${esc(v.url)}" ${sel.variantUrl === v.url ? 'selected' : ''}>${esc(variantLabel(v))}</option>`)
    ].join('');
    const qualityRow = track === 'video' ? `
      <div class="panel-row">
        <span>清晰度</span>
        <select data-role="quality" data-i="${i}">${options}</select>
      </div>` : '';
    const fmtLabel = track === 'audio' ? 'M4A（推荐）' : 'MP4（推荐）';

    return `
      <div class="panel">
        <div class="panel-row">
          <span>下载内容</span>
          <select data-role="track" data-i="${i}">
            <option value="audio" ${track === 'audio' ? 'selected' : ''}>仅音频（推荐）</option>
            <option value="video" ${track === 'video' ? 'selected' : ''}>仅视频（无音轨）</option>
          </select>
        </div>
        ${qualityRow}
        <div class="panel-row">
          <span>保存格式</span>
          <select data-role="format" data-i="${i}">
            <option value="mp4" ${sel.format !== 'ts' ? 'selected' : ''}>${fmtLabel}</option>
            <option value="ts" ${sel.format === 'ts' ? 'selected' : ''}>TS 原样</option>
          </select>
        </div>
        <div class="panel-foot">
          <span class="est">${track === 'audio' ? '音频轨' + (probe.segments ? ` · ${probe.segments} 个分片` : '') : (est ? '约 ' + fmtBytes(est) : (probe.segments ? probe.segments + ' 个分片' : ''))}</span>
          <button class="btn primary" data-act="start" data-i="${i}">开始下载</button>
        </div>
        <p class="panel-note">该视频的画面和声音是分开的两条流，无法自动合并；可以分别下载音频和视频。</p>
      </div>`;
  }

  const sel = selection.get(s.key) || { variantUrl: '', format: 'mp4' };
  const variants = (probe.variants || []).slice().sort((a, b) => (b.height - a.height) || (b.bandwidth - a.bandwidth));
  const chosen = variants.find((v) => v.url === sel.variantUrl) || null;
  const est = chosen && chosen.bandwidth && probe.duration ? (chosen.bandwidth * probe.duration) / 8 : 0;

  const options = [
    `<option value="" ${!sel.variantUrl ? 'selected' : ''}>自动（最佳画质）</option>`,
    ...variants.map((v) => `<option value="${esc(v.url)}" ${sel.variantUrl === v.url ? 'selected' : ''}>${esc(variantLabel(v))}</option>`)
  ].join('');

  return `
    <div class="panel">
      <div class="panel-row">
        <span>清晰度</span>
        <select data-role="quality" data-i="${i}">${options}</select>
      </div>
      <div class="panel-row">
        <span>保存格式</span>
        <select data-role="format" data-i="${i}">
          <option value="mp4" ${sel.format !== 'ts' ? 'selected' : ''}>MP4（推荐）</option>
          <option value="ts" ${sel.format === 'ts' ? 'selected' : ''}>TS 原样（兼容性更好）</option>
        </select>
      </div>
      <div class="panel-foot">
        <span class="est">${est ? '约 ' + fmtBytes(est) : (probe.segments ? probe.segments + ' 个分片' : '')}</span>
        <button class="btn primary" data-act="start" data-i="${i}">开始下载</button>
      </div>
      <p class="panel-note">MP4 会自动转封装；若播放异常，请改用“TS 原样”（VLC 可播放）。</p>
    </div>`;
}

function pickPoster(s) {
  const vids = state.videos || [];
  const withPoster = vids.find((v) => v.poster && /^https?:|^data:/.test(v.poster));
  if (withPoster) return withPoster.poster;
  if (!s.type || s.type === 'file') {
    const v = vids.find((v) => v.poster && /^https?:|^data:/.test(v.poster));
    return v ? v.poster : '';
  }
  return '';
}

function pickBest(variants) {
  return variants.slice().sort((a, b) => (b.height - a.height) || (b.bandwidth - a.bandwidth))[0];
}

function variantLabel(v) {
  const h = v.height ? `${v.height}p` : '默认';
  const mb = v.bandwidth ? `${(v.bandwidth / 1000000).toFixed(1)} Mbps` : '';
  return mb ? `${h} · ${mb}` : h;
}

async function startDownload(s) {
  const probe = streamProbe(s);
  if (probe && (probe.drm || probe.live)) return;

  const sel = selection.get(s.key) || { variantUrl: '', format: 'mp4', track: 'audio' };
  const separate = !!(probe && probe.separateAudio);
  const track = separate ? (sel.track === 'video' ? 'video' : 'audio') : '';
  const chosen = !separate || track === 'video'
    ? (probe && probe.variants ? probe.variants.find((v) => v.url === sel.variantUrl) : null)
    : null;
  const quality = track === 'audio' ? 'audio' : (chosen && chosen.height ? `${chosen.height}p` : '');
  const title = (state.meta && state.meta.title) || (tabInfo && tabInfo.title) || 'video';

  const res = await send({
    type: 'START_DOWNLOAD',
    tabId,
    url: s.url,
    pageUrl: (tabInfo && tabInfo.url) || '',
    title,
    kind: s.type === 'file' ? 'file' : 'hls',
    track,
    variantUrl: (s.type === 'hls' && track !== 'audio') ? (sel.variantUrl || '') : '',
    quality,
    format: sel.format || 'mp4',
    contentType: s.contentType || ''
  });

  if (!res || !res.ok) {
    showToast((res && res.error) || '启动下载失败');
    return;
  }

  openKey = '';
  showToast(s.type === 'file' ? '已开始下载' : '已开始下载，正在后台合并…');
  renderStreams();
  loadJobs();
}

/* ------------------------------------------------------------------ */
/* jobs                                                               */
/* ------------------------------------------------------------------ */
async function loadJobs() {
  if (!tabId) return;
  const res = await send({ type: 'GET_JOBS', tabId });
  if (!res || !res.ok) return;
  const next = res.jobs || [];
  const sig = next.map((j) => `${j.id}:${j.status}:${j.progress}:${j.downloadedBytes}:${j.filename}:${j.error}`).join('|');
  if (sig === jobsSig) return;
  jobsSig = sig;
  currentJobs = next;
  renderJobs();
}

function renderJobs() {
  const section = $('jobs-section');
  const list = currentJobs.filter((j) => {
    if (!hideDone) return true;
    return !['done', 'error', 'canceled'].includes(j.status);
  });

  if (!list.length) {
    section.classList.add('hidden');
    $('jobs').innerHTML = '';
    return;
  }
  section.classList.remove('hidden');

  $('jobs').innerHTML = list.map((j) => {
    const status = j.status || '';
    const active = ['preparing', 'downloading', 'processing', 'saving'].includes(status);
    const done = status === 'done';
    const error = status === 'error';
    const canceled = status === 'canceled';
    let pct = Number(j.progress) || 0;
    if (done) pct = 100;
    if (error) pct = Math.max(pct, 100);

    const name = j.filename || j.title || '视频';
    const pctText = done ? '完成' : error ? '失败' : canceled ? '已取消' : `${pct}%`;

    let sub = '';
    if (error) {
      sub = j.error || '下载失败';
    } else if (done) {
      sub = j.size ? `已保存 · ${fmtBytes(j.size)}` : '已保存';
    } else if (canceled) {
      sub = '已取消';
    } else if (status === 'preparing') {
      sub = j.message || '正在解析视频…';
    } else if (status === 'processing') {
      sub = j.message || '正在合并视频…';
    } else if (status === 'saving') {
      sub = j.message || '正在写入文件…';
    } else {
      const total = j.totalBytes ? ` / ${fmtBytes(j.totalBytes)}` : '';
      const sp = j.speed ? ` · ${fmtBytes(j.speed)}/s` : '';
      const eta = j.eta ? ` · 剩余 ${fmtEta(j.eta)}` : '';
      sub = `${fmtBytes(j.downloadedBytes)}${total}${sp}${eta}`;
    }

    const cls = done ? 'done' : error ? 'error' : '';
    return `
      <div class="job ${cls}">
        <div class="job-top">
          <span class="job-name">${esc(name)}</span>
          <span class="job-pct">${pctText}</span>
          ${active ? `<button class="job-cancel" data-cancel="${esc(j.id)}">取消</button>` : ''}
        </div>
        <div class="bar"><i style="width:${Math.min(100, Math.max(0, pct))}%"></i></div>
        <div class="job-sub"><span>${esc(sub)}</span><span>${esc(j.quality === 'audio' ? '音频' : (j.quality || ''))}</span></div>
        ${error ? `<div class="job-msg">${esc(j.error || '')}</div>` : ''}
      </div>`;
  }).join('');
}

/* ------------------------------------------------------------------ */
/* formatting                                                         */
/* ------------------------------------------------------------------ */
function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let x = v;
  while (x >= 1024 && i < units.length - 1) { x /= 1024; i++; }
  return `${x >= 100 || i === 0 ? Math.round(x) : x.toFixed(1)} ${units[i]}`;
}

function fmtDur(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

function fmtEta(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  if (s < 60) return `${s} 秒`;
  if (s < 3600) return `${Math.ceil(s / 60)} 分钟`;
  return `${Math.floor(s / 3600)} 小时 ${Math.ceil((s % 3600) / 60)} 分`;
}

/* ------------------------------------------------------------------ */
/* toast                                                              */
/* ------------------------------------------------------------------ */
let toastTimer = 0;
function showToast(text, ms = 2600) {
  const el = $('toast');
  el.textContent = text;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), ms);
}
