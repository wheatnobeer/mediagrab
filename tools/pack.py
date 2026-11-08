#!/usr/bin/env python3
"""Build dist/MediaGrab-extension-<version>.zip with forward-slash paths."""
import json
import os
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXT = os.path.join(ROOT, "extension")
DIST = os.path.join(ROOT, "dist")

with open(os.path.join(EXT, "manifest.json"), encoding="utf-8") as f:
    manifest = json.load(f)

os.makedirs(DIST, exist_ok=True)
out = os.path.join(DIST, f"MediaGrab-extension-{manifest['version']}.zip")

with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for dirpath, _dirs, files in os.walk(EXT):
        for name in sorted(files):
            if name in {".DS_Store", "Thumbs.db"}:
                continue
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, EXT).replace("\\", "/")
            z.write(full, rel)

print(f"{out} ({os.path.getsize(out)} bytes)")
