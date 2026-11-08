/**
 * Generate the local HLS fixtures used by test/core-test.mjs.
 *
 * Requires ffmpeg in PATH (or set FFMPEG=/path/to/ffmpeg).
 * The generated test/stream/ directory is gitignored.
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const STREAM = path.join(ROOT, 'stream');
const FFMPEG = process.env.FFMPEG || 'ffmpeg';

function run(args, cwd) {
  const res = spawnSync(FFMPEG, args, { cwd, stdio: 'inherit' });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`ffmpeg exited with ${res.status}`);
}

function hlsArgs({ size, seconds, videoBitrate, audioBitrate, extra = [] }) {
  return [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=30`,
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', String(seconds),
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-g', '60', '-sc_threshold', '0',
    '-b:v', videoBitrate,
    '-c:a', 'aac', '-b:a', audioBitrate,
    '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod',
    ...extra
  ];
}

fs.mkdirSync(STREAM, { recursive: true });

const dir720 = path.join(STREAM, '720p');
const dir480 = path.join(STREAM, '480p');
for (const [dir, size, bitrate, audio] of [
  [dir720, '1280x720', '2800k', '128k'],
  [dir480, '854x480', '1200k', '96k']
]) {
  fs.mkdirSync(dir, { recursive: true });
  console.log('generating', dir);
  run(hlsArgs({
    size, seconds: 30, videoBitrate: bitrate, audioBitrate: audio,
    extra: ['-hls_segment_filename', 'seg%03d.ts', 'index.m3u8']
  }), dir);
}

fs.writeFileSync(path.join(STREAM, 'master.m3u8'), `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=2800000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2"
720p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1400000,RESOLUTION=854x480,CODECS="avc1.4d401f,mp4a.40.2"
480p/index.m3u8
`);

// AES-128
const aesDir = path.join(STREAM, 'aes');
fs.mkdirSync(aesDir, { recursive: true });
const key = crypto.randomBytes(16);
const iv = crypto.randomBytes(16).toString('hex');
fs.writeFileSync(path.join(aesDir, 'enc.key'), key);
fs.writeFileSync(path.join(aesDir, 'key_info'), `enc.key\n${path.join(aesDir, 'enc.key')}\n${iv}\n`);
console.log('generating', aesDir);
run(hlsArgs({
  size: '640x360', seconds: 16, videoBitrate: '800k', audioBitrate: '96k',
  extra: ['-hls_key_info_file', 'key_info', '-hls_segment_filename', 'seg%03d.ts', 'index.m3u8']
}), aesDir);

// fMP4
const fmp4Dir = path.join(STREAM, 'fmp4');
fs.mkdirSync(fmp4Dir, { recursive: true });
console.log('generating', fmp4Dir);
run(hlsArgs({
  size: '640x360', seconds: 16, videoBitrate: '800k', audioBitrate: '96k',
  extra: ['-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4', '-hls_segment_filename', 'seg%03d.m4s', 'index.m3u8']
}), fmp4Dir);

// Separate video/audio HLS
const avDir = path.join(STREAM, 'av');
const avVideo = path.join(avDir, 'video');
const avAudio = path.join(avDir, 'audio');
fs.mkdirSync(avVideo, { recursive: true });
fs.mkdirSync(avAudio, { recursive: true });
console.log('generating', avVideo);
run([
  '-y', '-hide_banner', '-loglevel', 'error',
  '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30',
  '-t', '20', '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-g', '60',
  '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod',
  '-hls_segment_filename', 'seg%03d.ts', 'index.m3u8'
], avVideo);
console.log('generating', avAudio);
run([
  '-y', '-hide_banner', '-loglevel', 'error',
  '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
  '-t', '20', '-vn', '-c:a', 'aac', '-b:a', '96k',
  '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod',
  '-hls_segment_filename', 'seg%03d.ts', 'index.m3u8'
], avAudio);
fs.writeFileSync(path.join(avDir, 'master.m3u8'), `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="audio",DEFAULT=YES,URI="audio/index.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=640x360,CODECS="avc1.64001e,mp4a.40.2",AUDIO="aud"
video/index.m3u8
`);

console.log('fixtures ready in', STREAM);
