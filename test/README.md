# Tests

## Quick tests (no media, no network)

```bash
npm test
```

Covers playlist parsing, AES-128 key normalization, and fMP4 `track_ID`
rewriting. Fixtures live in `fixtures/`.

## Integration test (local HLS)

Requires Node.js and `ffmpeg` in `PATH`.

```bash
node test/make-fixtures.mjs
python -m http.server 8765 --bind 127.0.0.1 --directory test
node test/core-test.mjs
```

`make-fixtures.mjs` creates:

| Directory | Stream |
| --- | --- |
| `stream/720p`, `stream/480p`, `stream/master.m3u8` | TS HLS, two qualities |
| `stream/aes` | MPEG-TS HLS encrypted with AES-128 |
| `stream/fmp4` | fragmented-MP4 HLS |
| `stream/av` | separate video/audio HLS with `EXT-X-MEDIA` |

`core-test.mjs` downloads each stream through the offscreen pipeline and writes
`test/out/*.mp4` / `.m4a` / `.ts`. It does not use Chrome.

Set `FFMPEG=/path/to/ffmpeg` if it is not on `PATH`.

## Browser E2E (optional)

Requires Chrome and a matching `chromedriver`.

```bash
# terminal 1
python -m http.server 8765 --bind 127.0.0.1 --directory test

# terminal 2
export CHROMEDRIVER=/path/to/chromedriver
export CHROME_BIN="/path/to/Chrome"
node test/bidi-e2e.mjs
```

The script installs the extension through WebDriver BiDi, opens the test page,
verifies sniffing/probing, starts a download, and saves screenshots to
`test/` (gitignored). `MG_UI_ONLY=1` stops after the quality panel;
`MG_HEADED=1` runs a visible browser so a manual “Save” click can be tested.

Some sandboxed/headless environments block writes to the download directory and
report `FILE_FAILED` or `USER_CANCELED`; that is an environment limitation, not
the extension's merge pipeline.
