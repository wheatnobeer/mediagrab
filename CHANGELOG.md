# Changelog

## 1.1.1 — 2026-11-08

- Normalize fragmented-MP4 track IDs (`tkhd` / `trex` / `tfhd`) to 1, 2, …
  Some HLS packagers emit `track_ID = 0`, which breaks import in several editors.
- Applies to both fMP4 HLS input and mux.js MP4 output.

## 1.1.0 — 2026-11-05

- Support HLS with separate audio and video tracks: download **audio only**
  (M4A) or **video only** (MP4).
- Recognize direct audio streams by `audio/*` content type or `mime=audio`
  query parameter.
- Show audio files as a separate media type in the popup.

## 1.0.0 — 2026-11-03

- Initial release: HLS/MP4 sniffing, AES-128, TS → MP4 (mux.js), fMP4 concat,
  quality selection, progress, cancel, notifications, DRM detection.
