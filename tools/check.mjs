#!/usr/bin/env node
/**
 * Static checks for the unpacked extension: manifest shape, referenced files,
 * and JavaScript syntax. No dependencies.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const EXT = path.resolve(ROOT, '..', 'extension');
const errors = [];

function fail(message) {
  errors.push(message);
}

function exists(rel) {
  const p = path.join(EXT, rel);
  if (!fs.existsSync(p)) fail(`missing file: ${rel}`);
  return p;
}

const manifestPath = path.join(EXT, 'manifest.json');
if (!fs.existsSync(manifestPath)) {
  console.error('manifest.json not found');
  process.exit(1);
}

let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
} catch (e) {
  console.error('manifest.json is not valid JSON:', e.message);
  process.exit(1);
}

if (manifest.manifest_version !== 3) fail('manifest_version must be 3');
if (!/^\d+\.\d+\.\d+$/.test(String(manifest.version || ''))) fail('version must be semver');
if (!manifest.name) fail('name is required');
if (!manifest.background || !manifest.background.service_worker) fail('background.service_worker is required');
if (!manifest.action || !manifest.action.default_popup) fail('action.default_popup is required');

for (const size of ['16', '32', '48', '128']) {
  const icon = manifest.icons && manifest.icons[size];
  if (!icon) fail(`icons.${size} is required`);
  else exists(icon);
}

if (!Array.isArray(manifest.permissions) || !manifest.permissions.includes('downloads')) {
  fail('downloads permission is required');
}

for (const script of manifest.content_scripts || []) {
  for (const file of script.js || []) exists(file);
}

exists(manifest.background.service_worker);
if (manifest.action.default_popup) exists(manifest.action.default_popup);

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

for (const file of walk(EXT).filter((f) => f.endsWith('.js') || f.endsWith('.mjs'))) {
  const res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (res.status !== 0) {
    fail(`syntax error in ${path.relative(EXT, file)}:\n${res.stderr.trim()}`);
  }
}

for (const html of walk(EXT).filter((f) => f.endsWith('.html'))) {
  const text = fs.readFileSync(html, 'utf8');
  for (const match of text.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)) {
    const src = match[1];
    if (/^https?:/i.test(src)) fail(`remote script in ${path.relative(EXT, html)}: ${src}`);
    else if (!src.startsWith('..') && !/^[a-z]+:/i.test(src)) {
      const target = path.resolve(path.dirname(html), src.split('?')[0]);
      if (!fs.existsSync(target)) fail(`missing script in ${path.relative(EXT, html)}: ${src}`);
    }
  }
}

if (errors.length) {
  console.error('Check failed:\n');
  for (const error of errors) console.error(' - ' + error);
  process.exit(1);
}

console.log(`Check OK: ${manifest.name} v${manifest.version}`);
