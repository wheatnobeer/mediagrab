import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const EXT = path.resolve(ROOT, '..', 'extension');
const OUT = path.resolve(ROOT, 'out');
const BASE = 'http://127.0.0.1:8765';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.mkdirSync(OUT, { recursive: true });

const RealURL = URL;
let currentBlob = null;
let currentJobDone = null;
let currentJobError = null;
let lastUpdates = [];

class FakeURL extends RealURL {
  static createObjectURL(blob) {
    currentBlob = blob;
    return 'blob:fake-' + Math.random().toString(36).slice(2);
  }
  static revokeObjectURL() {}
}

function handleMessage(msg) {
  if (!msg || !msg.target) return Promise.resolve({ ok: true });
  if (msg.type === 'JOB_UPDATE') {
    lastUpdates.push(msg.job);
    if (msg.job && msg.job.status === 'error') {
      currentJobError = new Error(msg.job.error || 'job error');
      currentJobDone?.();
    }
    return Promise.resolve({ ok: true });
  }
  if (msg.type === 'SAVE_BLOB') {
    (async () => {
      try {
        if (!currentBlob) throw new Error('no blob');
        const buf = Buffer.from(await currentBlob.arrayBuffer());
        const file = path.join(OUT, `out.${msg.ext || 'mp4'}`);
        fs.writeFileSync(file, buf);
        console.log('SAVED', file, buf.length);
        currentJobDone?.();
      } catch (e) {
        currentJobError = e;
        currentJobDone?.();
      }
    })();
    return Promise.resolve({ ok: true });
  }
  if (msg.type === 'GET_MANIFEST') return Promise.resolve({ ok: true, text: '' });
  if (msg.type === 'GET_KEY') return Promise.resolve({ ok: true, base64: '' });
  return Promise.resolve({ ok: true });
}

const ctx = {
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  URL: FakeURL,
  URLSearchParams,
  TextDecoder,
  TextEncoder,
  Blob,
  atob,
  btoa,
  crypto: webcrypto,
  fetch,
  Headers,
  Request,
  Response,
  AbortController,
  DOMException,
  performance,
  chrome: {
    runtime: {
      onMessage: { addListener(fn) { ctx.__listener = fn; } },
      sendMessage: handleMessage
    }
  }
};
ctx.window = ctx;
ctx.self = ctx;
ctx.globalThis = ctx;
vm.createContext(ctx);

const muxCode = fs.readFileSync(path.join(EXT, 'lib', 'mux.min.js'), 'utf8');
vm.runInContext(muxCode, ctx, { filename: 'mux.min.js' });
console.log('muxjs?', typeof ctx.muxjs, !!(ctx.muxjs && ctx.muxjs.mp4 && ctx.muxjs.mp4.Transmuxer));

const offCode = fs.readFileSync(path.join(EXT, 'offscreen.js'), 'utf8');
vm.runInContext(offCode, ctx, { filename: 'offscreen.js' });

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT: ' + msg);
}

function load(name) {
  return fs.readFileSync(path.join(ROOT, 'stream', name), 'utf8');
}

/* ---------------- parser tests ---------------- */
{
  const master = ctx.parseMaster(load('master.m3u8'), BASE + '/stream/master.m3u8');
  assert(master.variants.length === 2, 'master variant count');
  assert(master.variants[0].height === 720, '720 height');
  assert(master.variants[0].url === BASE + '/stream/720p/index.m3u8', 'variant url');
  assert(ctx.pickBest(master.variants).height === 720, 'pick best');

  const media = ctx.parseMedia(load('720p/index.m3u8'), BASE + '/stream/720p/index.m3u8');
  assert(media.segments.length === 15, 'segment count ' + media.segments.length);
  assert(Math.abs(media.duration - 30) < 0.2, 'duration ' + media.duration);
  assert(!media.live, 'vod');
  assert(!media.drm, 'no drm');
  assert(media.segments[0].url === BASE + '/stream/720p/seg000.ts', 'segment url');

  const aes = ctx.parseMedia(load('aes/index.m3u8'), BASE + '/stream/aes/index.m3u8');
  assert(aes.segments.length === 8, 'aes segments');
  assert(aes.segments[0].key && aes.segments[0].key.method === 'AES-128', 'aes key');
  assert(aes.segments[0].key.iv === '0xd7b4fe4cdc494e6f2ca639df302b5278', 'aes iv');
  assert(aes.segments[0].key.uri === BASE + '/stream/aes/enc.key', 'aes key url');

  const fmp4 = ctx.parseMedia(load('fmp4/index.m3u8'), BASE + '/stream/fmp4/index.m3u8');
  assert(fmp4.segments[0].map && fmp4.segments[0].map.url === BASE + '/stream/fmp4/init.mp4', 'fmp4 map');

  const drm = ctx.parseMedia(`#EXTM3U
#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://x",KEYFORMAT="com.apple.streamingkeydelivery"
#EXTINF:4,
a.ts
#EXT-X-ENDLIST`, 'https://x/y.m3u8');
  assert(drm.drm && drm.segments.length === 1, 'drm detect');

  const live = ctx.parseMedia(`#EXTM3U
#EXTINF:4,
a.ts`, 'https://x/y.m3u8');
  assert(live.live, 'live detect');

  const range = ctx.parseMedia(`#EXTM3U
#EXT-X-MAP:URI="init.mp4",BYTERANGE="720@0"
#EXTINF:4,
#EXT-X-BYTERANGE:1000@720
a.m4s
#EXT-X-BYTERANGE:500
b.m4s
#EXT-X-ENDLIST`, 'https://x/y.m3u8');
  assert(range.segments[0].range.length === 1000 && range.segments[0].range.offset === 720, 'range 1');
  assert(range.segments[1].range.offset === 1720, 'range 2');
  assert(range.segments[0].map.range.offset === 0, 'map range');

  // AES key normalization: raw / hex text / base64 text / JSON / HTML
  const keyBytes = Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  const hex = [...keyBytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  const b64 = Buffer.from(keyBytes).toString('base64');
  const same = (buf) => buf && buf.byteLength === 16 && Buffer.from(buf).equals(Buffer.from(keyBytes));
  assert(same(ctx.normalizeKey(keyBytes.buffer)), 'key raw');
  assert(same(ctx.normalizeKey(new TextEncoder().encode(hex).buffer)), 'key hex');
  assert(same(ctx.normalizeKey(new TextEncoder().encode(b64).buffer)), 'key base64');
  assert(same(ctx.normalizeKey(new TextEncoder().encode(JSON.stringify({ key: b64 })).buffer)), 'key json');
  assert(same(ctx.normalizeKey(new TextEncoder().encode(hex + '\n').buffer)), 'key newline');
  assert(ctx.normalizeKey(new TextEncoder().encode('<html>login</html>').buffer) === null, 'key html reject');

  console.log('PARSER TESTS OK');
}

/* ---------------- download tests ---------------- */
async function runOne(name, url, format, opts = {}) {
  currentBlob = null;
  currentJobError = null;
  lastUpdates = [];
  const done = new Promise((resolve) => { currentJobDone = resolve; });
  const started = Date.now();

  ctx.startJob({
    jobId: name,
    url,
    pageUrl: BASE + '/',
    title: name,
    format,
    track: opts.track || '',
    tabId: 1,
    manifestText: ''
  });

  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('job timeout')), 90000));
  await Promise.race([done, timeout]);
  if (currentJobError) throw currentJobError;
  const ext = opts.ext || 'mp4';
  const file = path.join(OUT, `out.${ext}`);
  assert(fs.existsSync(file) && fs.statSync(file).size > 1000, `${name} output`);
  if (opts.keep) fs.renameSync(file, path.join(OUT, `${name}.${ext}`));
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`${name} OK in ${secs}s, updates=${lastUpdates.length}`);
}

await runOne('master-mp4', BASE + '/stream/master.m3u8', 'mp4');
const masterFile = path.join(OUT, 'out.mp4');
assert(fs.existsSync(masterFile) && fs.statSync(masterFile).size > 100000, 'master output size');
fs.renameSync(masterFile, path.join(OUT, 'master.mp4'));

await runOne('aes-mp4', BASE + '/stream/aes/index.m3u8', 'mp4');
assert(fs.existsSync(masterFile) && fs.statSync(masterFile).size > 50000, 'aes output size');
fs.renameSync(masterFile, path.join(OUT, 'aes.mp4'));

await runOne('fmp4-mp4', BASE + '/stream/fmp4/index.m3u8', 'mp4');
assert(fs.existsSync(masterFile) && fs.statSync(masterFile).size > 50000, 'fmp4 output size');
fs.renameSync(masterFile, path.join(OUT, 'fmp4.mp4'));

await runOne('ts-format', BASE + '/stream/720p/index.m3u8', 'ts', { ext: 'ts' });
assert(fs.existsSync(path.join(OUT, 'out.ts')) && fs.statSync(path.join(OUT, 'out.ts')).size > 50000, 'ts output size');

await runOne('av-audio', BASE + '/stream/av/master.m3u8', 'mp4', { track: 'audio', ext: 'm4a' });
fs.renameSync(path.join(OUT, 'out.m4a'), path.join(OUT, 'av-audio.m4a'));

await runOne('av-video', BASE + '/stream/av/master.m3u8', 'mp4', { track: 'video', ext: 'mp4' });
fs.renameSync(path.join(OUT, 'out.mp4'), path.join(OUT, 'av-video.mp4'));

console.log('ALL CORE TESTS DONE');
process.exit(0);
