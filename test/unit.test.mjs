import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const EXT = path.resolve(ROOT, '..', 'extension');

const ctx = {
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  URL,
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
      onMessage: { addListener() {} },
      sendMessage: async () => ({ ok: true })
    }
  }
};
ctx.window = ctx;
ctx.self = ctx;
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(EXT, 'offscreen.js'), 'utf8'), ctx, { filename: 'offscreen.js' });

/* ------------------------------------------------------------------ */
/* playlist parsing                                                   */
/* ------------------------------------------------------------------ */
const master = ctx.parseMaster(`#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="audio",DEFAULT=YES,URI="audio/index.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=640x360,AUDIO="aud"
video/index.m3u8
`, 'https://example.com/stream/master.m3u8');
assert.equal(master.variants.length, 1);
assert.equal(master.variants[0].height, 360);
assert.equal(master.variants[0].url, 'https://example.com/stream/video/index.m3u8');
assert.equal(master.audioGroups[0].uri, 'https://example.com/stream/audio/index.m3u8');

const media = ctx.parseMedia(`#EXTM3U
#EXT-X-MEDIA-SEQUENCE:7
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x000102030405060708090a0b0c0d0e0f
#EXT-X-MAP:URI="init.mp4",BYTERANGE="720@0"
#EXTINF:4,
#EXT-X-BYTERANGE:1000@720
seg0.m4s
#EXTINF:4,
#EXT-X-BYTERANGE:500
seg1.m4s
#EXT-X-ENDLIST`, 'https://example.com/stream/video/index.m3u8');
assert.equal(media.segments.length, 2);
assert.equal(media.duration, 8);
assert.equal(media.live, false);
assert.equal(media.segments[0].seq, 7);
assert.equal(media.segments[0].key.method, 'AES-128');
assert.equal(media.segments[0].key.uri, 'https://example.com/stream/video/key.bin');
assert.equal(media.segments[0].range.length, 1000);
assert.equal(media.segments[0].range.offset, 720);
assert.equal(media.segments[1].range.length, 500);
assert.equal(media.segments[1].range.offset, 1720);
assert.equal(media.segments[0].map.url, 'https://example.com/stream/video/init.mp4');
assert.equal(media.segments[0].map.range.offset, 0);

const drm = ctx.parseMedia(`#EXTM3U
#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://x",KEYFORMAT="com.apple.streamingkeydelivery"
#EXTINF:4,
a.ts
#EXT-X-ENDLIST`, 'https://example.com/y.m3u8');
assert.ok(drm.drm);

const live = ctx.parseMedia(`#EXTM3U
#EXTINF:4,
a.ts`, 'https://example.com/y.m3u8');
assert.equal(live.live, true);

/* ------------------------------------------------------------------ */
/* AES key normalization                                              */
/* ------------------------------------------------------------------ */
const keyBytes = Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
const hex = [...keyBytes].map((b) => b.toString(16).padStart(2, '0')).join('');
const b64 = Buffer.from(keyBytes).toString('base64');
const sameKey = (buf) => buf && buf.byteLength === 16 && Buffer.from(buf).equals(Buffer.from(keyBytes));
assert.ok(sameKey(ctx.normalizeKey(keyBytes.buffer)));
assert.ok(sameKey(ctx.normalizeKey(new TextEncoder().encode(hex).buffer)));
assert.ok(sameKey(ctx.normalizeKey(new TextEncoder().encode(b64).buffer)));
assert.ok(sameKey(ctx.normalizeKey(new TextEncoder().encode(JSON.stringify({ key: b64 })).buffer)));
assert.ok(sameKey(ctx.normalizeKey(new TextEncoder().encode(hex + '\n').buffer)));
assert.equal(ctx.normalizeKey(new TextEncoder().encode('<html>login</html>').buffer), null);

/* ------------------------------------------------------------------ */
/* fMP4 track-ID normalization (fixtures use track_ID 0)              */
/* ------------------------------------------------------------------ */
const init = new Uint8Array(fs.readFileSync(path.join(ROOT, 'fixtures', 'trackid-zero-init.mp4')));
const { idMap } = ctx.normalizeFmp4Init(init);
assert.equal(idMap.get(0), 1, 'track 0 should map to 1');

const moov = ctx.listBoxes(init, 0, init.length).find((b) => b.type === 'moov');
const trak = ctx.children(init, moov, 'trak')[0];
const tkhd = ctx.children(init, trak, 'tkhd')[0];
const version = init[tkhd.payload];
const tkhdId = ctx.readU32(init, tkhd.payload + (version === 1 ? 20 : 12));
assert.equal(tkhdId, 1, 'tkhd track_ID');

const mvex = ctx.children(init, moov, 'mvex')[0];
const trex = ctx.children(init, mvex, 'trex')[0];
assert.equal(ctx.readU32(init, trex.payload + 4), 1, 'trex track_ID');

const frag = new Uint8Array(fs.readFileSync(path.join(ROOT, 'fixtures', 'trackid-zero-seg.m4s')));
ctx.normalizeFmp4Fragment(frag, idMap);
const moof = ctx.listBoxes(frag, 0, frag.length).find((b) => b.type === 'moof');
const traf = ctx.children(frag, moof, 'traf')[0];
const tfhd = ctx.children(frag, traf, 'tfhd')[0];
assert.equal(ctx.readU32(frag, tfhd.payload + 4), 1, 'tfhd track_ID');

console.log('unit tests passed');
