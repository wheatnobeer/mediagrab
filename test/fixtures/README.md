# Fixtures

`trackid-zero-init.mp4` and `trackid-zero-seg.m4s` are a tiny audio-only fMP4
init/fragment pair whose `tkhd`, `trex`, and `tfhd` boxes all use `track_ID = 0`.
They are used by `test/unit.test.mjs` to verify that MediaGrab rewrites the IDs
to `1` before saving.

Generated with ffmpeg, then patched with a small box-level script. The media is
silent test audio and contains no third-party content.
