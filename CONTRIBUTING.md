# Contributing

Thanks for taking a look at MediaGrab.

## Scope

This project downloads media from the browser session for personal, lawful use.
**Do not open issues or pull requests that ask for DRM circumvention** (Widevine,
PlayReady, FairPlay, SAMPLE-AES keys, etc.). Such requests will be closed.

## Before opening an issue

- Confirm you are on the latest version in `chrome://extensions`.
- Include the browser version, the extension version, and the exact error text.
- If possible, include the relevant HLS manifest with tokens/URLs redacted.
- Never post cookies, account credentials, or paid content URLs public.

## Development

```bash
# Node.js 18+
npm run check     # manifest + JS syntax checks
npm test          # parser, key normalization, fMP4 track-ID tests

# Load extension/ via chrome://extensions -> Developer mode -> Load unpacked
```

For the full integration test, see [`test/README.md`](test/README.md). It needs
ffmpeg and ChromeDriver.

## Pull requests

- Keep the extension build-free: plain JS, no remote code.
- Do not add analytics, tracking, or network calls unrelated to media fetching.
- Update `README.md` / `CHANGELOG.md` when behavior changes.
- Run `npm run check` and `npm test` before submitting.
