import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const EXT = path.resolve(ROOT, '..', 'extension');
const DL = path.resolve(ROOT, 'downloads');
const DRIVER = process.env.CHROMEDRIVER || 'chromedriver';
const CHROME_BIN = process.env.CHROME_BIN || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9515;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.rmSync(DL, { recursive: true, force: true });
fs.mkdirSync(DL, { recursive: true });
fs.rmSync(path.resolve(ROOT, '.bidi-profile'), { recursive: true, force: true });

let driver;
let sessionId = null;
let ws;

async function startDriver() {
  const tmp = path.join(process.env.LOCALAPPDATA || 'C:\\Windows\\Temp', 'mg-tmp');
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  driver = spawn(DRIVER, ['--port=' + PORT, '--verbose', '--log-path=' + path.resolve(ROOT, 'chromedriver.log')], {
    stdio: 'ignore',
    env: { ...process.env, TEMP: tmp, TMP: tmp, TMPDIR: tmp }
  });
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/status`);
      if (r.ok) return;
    } catch { /* retry */ }
    await sleep(200);
  }
  throw new Error('chromedriver did not start');
}

async function createSession() {
  const body = {
    capabilities: {
      alwaysMatch: {
        browserName: 'chrome',
        webSocketUrl: true,
        'goog:chromeOptions': {
          binary: CHROME_BIN,
          args: [
            ...(process.env.MG_HEADED ? ['--window-position=-10000,-10000', '--start-minimized'] : ['--headless=new']),
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-gpu',
            '--no-sandbox',
            '--disable-dev-shm-usage',
            '--remote-debugging-port=9223',
            '--window-size=420,760',
            '--autoplay-policy=no-user-gesture-required',
            '--enable-unsafe-extension-debugging',
            '--user-data-dir=' + path.resolve(ROOT, '.bidi-profile')
          ],
          excludeSwitches: ['load-extension'],
          prefs: {
            'download.default_directory': DL,
            'download.prompt_for_download': false,
            'download.directory_upgrade': true,
            'profile.default_content_setting_values.automatic_downloads': 1
          }
        }
      }
    }
  };
  const res = await fetch(`http://127.0.0.1:${PORT}/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const json = await res.json();
  if (!json.value) throw new Error('session failed: ' + JSON.stringify(json));
  sessionId = json.value.sessionId;
  const wsUrl = json.value.capabilities.webSocketUrl;
  console.log('SESSION', sessionId);
  console.log('BIDI', wsUrl);
  console.log('CAPS', JSON.stringify(json.value.capabilities, null, 2));
  return wsUrl;
}

class Bidi {
  constructor(url) { this.url = url; this.id = 1; this.pending = new Map(); }
  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((res, rej) => {
      this.ws.addEventListener('open', res);
      this.ws.addEventListener('error', rej);
    });
    this.ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.type === 'error') p.reject(new Error(m.message || JSON.stringify(m)));
        else p.resolve(m.result);
      }
    });
  }
  send(method, params = {}) {
    const id = this.id++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('BiDi timeout ' + method)); }
      }, 45000);
    });
  }
}

async function evalJson(bidi, context, expression) {
  const wrapped = `(async () => { const __v = await (${expression}); return JSON.stringify(__v === undefined ? null : __v); })()`;
  const r = await bidi.send('script.evaluate', {
    expression: wrapped,
    target: { context },
    awaitPromise: true,
    resultOwnership: 'none'
  });
  if (r.type === 'exception') throw new Error('eval exception: ' + JSON.stringify(r));
  const val = r.result && r.result.value;
  return val ? JSON.parse(val) : null;
}

async function setDownloadBehavior() {
  let version = null;
  for (let i = 0; i < 40; i++) {
    try {
      version = await (await fetch('http://127.0.0.1:9223/json/version')).json();
      break;
    } catch { await sleep(250); }
  }
  if (!version) throw new Error('Chrome CDP endpoint not available');
  const sock = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((res, rej) => { sock.addEventListener('open', res); sock.addEventListener('error', rej); });
  const result = await new Promise((resolve, reject) => {
    sock.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id === 1) {
        if (m.error) reject(new Error(JSON.stringify(m.error)));
        else resolve(m.result);
      }
    });
    sock.send(JSON.stringify({
      id: 1,
      method: 'Browser.setDownloadBehavior',
      params: { behavior: 'allow', downloadPath: DL, eventsEnabled: true }
    }));
    setTimeout(() => reject(new Error('setDownloadBehavior timeout')), 5000);
  });
  sock.close();
  console.log('DOWNLOAD_BEHAVIOR', JSON.stringify(result));
}

async function main() {
  await startDriver();
  const wsUrl = await createSession();
  await setDownloadBehavior();

  ws = new Bidi(wsUrl);
  await ws.connect();

  let install;
  try {
    install = await ws.send('webExtension.install', {
      extensionData: { type: 'path', path: EXT }
    });
    console.log('INSTALL', JSON.stringify(install));
  } catch (e) {
    console.log('INSTALL FAILED', e.message);
    throw e;
  }
  const id = install.extension;
  if (!id) throw new Error('no extension id');

  const { context: testCtx } = await ws.send('browsingContext.create', { type: 'tab' });
  await ws.send('browsingContext.navigate', {
    context: testCtx,
    url: 'http://127.0.0.1:8765/index.html?src=' + (process.env.MG_SRC || 'stream/master.m3u8'),
    wait: 'complete'
  });
  await sleep(5000);
  const video = await evalJson(ws, testCtx, `(() => { const v = document.querySelector('video'); return v ? {src:v.currentSrc,duration:v.duration,ready:v.readyState,w:v.videoWidth,h:v.videoHeight} : null; })()`);
  console.log('VIDEO', JSON.stringify(video));

  const { context: popupCtx } = await ws.send('browsingContext.create', { type: 'tab' });
  await ws.send('browsingContext.navigate', {
    context: popupCtx,
    url: `chrome-extension://${id}/popup/popup.html`,
    wait: 'complete'
  });
  await sleep(1200);

  const info = await evalJson(ws, popupCtx, `(() => ({href:location.href, hasTabs:!!(chrome&&chrome.tabs), body:document.body.innerText.slice(0,200)}))()`);
  console.log('POPUP', JSON.stringify(info));

  const tabs = await evalJson(ws, popupCtx, `chrome.tabs.query({}).then(ts => ts.map(t => ({id:t.id,url:t.url,title:t.title})))`);
  console.log('TABS', JSON.stringify(tabs));
  const target = tabs.find((t) => t.url && t.url.includes('127.0.0.1:8765'));
  if (!target) throw new Error('test tab not found');

  await ws.send('browsingContext.navigate', {
    context: popupCtx,
    url: `chrome-extension://${id}/popup/popup.html?tabId=${target.id}`,
    wait: 'complete'
  });
  await sleep(4000);

  const text = await evalJson(ws, popupCtx, `document.body.innerText`);
  console.log('POPUP_TEXT\n' + text);

  const shot = await ws.send('browsingContext.captureScreenshot', { context: popupCtx });
  fs.writeFileSync(path.resolve(ROOT, 'popup-e2e.png'), Buffer.from(shot.data, 'base64'));

  const state = await evalJson(ws, popupCtx, `chrome.runtime.sendMessage({type:'GET_STATE',tabId:${target.id}}).then(r => ({ok:r.ok,streams:r.streams,videos:r.videos,drm:r.drm}))`);
  console.log('STATE', JSON.stringify(state, null, 2));

  const clicked = await evalJson(ws, popupCtx, `(() => { const b=document.querySelector('.stream .btn.primary[data-act="toggle"]'); if(!b) return false; b.click(); return true; })()`);
  console.log('CLICK', clicked);
  await sleep(2500);
  const panel = await evalJson(ws, popupCtx, `(() => { const p=document.querySelector('.panel'); return p ? p.innerText : ''; })()`);
  console.log('PANEL\n' + panel);

  if (process.env.MG_UI_ONLY) {
    const shotUi = await ws.send('browsingContext.captureScreenshot', { context: popupCtx });
    fs.writeFileSync(path.resolve(ROOT, 'popup-av.png'), Buffer.from(shotUi.data, 'base64'));
    console.log('UI_ONLY_DONE');
    return;
  }

  const started = await evalJson(ws, popupCtx, `(() => { const b=document.querySelector('.panel .btn.primary[data-act="start"]'); if(!b) return false; b.click(); return true; })()`);
  console.log('START', started);

  let jobs = [];
  let notified = false;
  const maxPolls = process.env.MG_SAVE_ONLY ? 180 : 90;
  for (let i = 0; i < maxPolls; i++) {
    await sleep(1000);
    jobs = await evalJson(ws, popupCtx, `chrome.runtime.sendMessage({type:'GET_JOBS',tabId:${target.id}}).then(r => r.jobs)`);
    if (i % 5 === 0) console.log('JOB', JSON.stringify(jobs.map((j) => ({s:j.status,p:j.progress,m:j.message,e:j.error}))));
    if (!notified && jobs.some((j) => j.status === 'saving')) {
      notified = true;
      console.log('*** 请在弹出的下载窗口点击「保存」 ***');
    }
    if (jobs.some((j) => j.status === 'done' || j.status === 'error')) break;
  }
  console.log('JOBS', JSON.stringify(jobs, null, 2));

  if (process.env.MG_SAVE_ONLY) {
    await sleep(1500);
    const files = fs.existsSync(DL) ? fs.readdirSync(DL) : [];
    console.log('SAVE_ONLY_FILES', JSON.stringify(files));
    for (const f of files) {
      const full = path.join(DL, f);
      console.log('SAVED_FILE', full, fs.statSync(full).size);
    }
    return;
  }

  await sleep(1000);
  console.log('FILES', JSON.stringify(fs.readdirSync(DL)));

  const shot2 = await ws.send('browsingContext.captureScreenshot', { context: popupCtx });
  fs.writeFileSync(path.resolve(ROOT, 'popup-e2e-done.png'), Buffer.from(shot2.data, 'base64'));
}

main()
  .catch((e) => { console.error('E2E ERROR', e); process.exitCode = 1; })
  .finally(async () => {
    try { ws?.ws.close(); } catch {}
    if (sessionId) {
      try { await fetch(`http://127.0.0.1:${PORT}/session/${sessionId}`, { method: 'DELETE' }); } catch {}
    }
    try { driver?.kill(); } catch {}
  });
