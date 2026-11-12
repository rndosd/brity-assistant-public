'use strict';

// 앱 안 업데이트(7단계). GitHub 릴리스의 최신 판에 올린 update.json을 읽고,
// 새 판이면 패치 ZIP을 받아 지문(sha256)을 맞춘 뒤 임시 폴더에 풀어 둔다.
// 실제 교체는 앱이 꺼진 뒤 update-apply.ps1이 한다(켜진 앱은 자기 파일을 바꿀 수 없다).
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { readZip } = require('./backup');

const PATCH_ROOT = 'School-Calendar-Patch/';
const MAX_PATCH = 200 * 1024 * 1024;
const MAX_MANIFEST = 256 * 1024;

function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(value || '').trim());
  return match ? match.slice(1).map(Number) : null;
}

function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) throw new Error('Invalid version');
  for (let index = 0; index < 3; index++) if (left[index] !== right[index]) return left[index] - right[index];
  return 0;
}

// from보다 높고 to까지인 판의 바뀐 점(최신부터).
function changesBetween(changes, from, to) {
  return (Array.isArray(changes) ? changes : [])
    .filter(entry => parseVersion(entry?.version) && Array.isArray(entry.items) &&
      (!from || compareVersions(entry.version, from) > 0) && compareVersions(entry.version, to) <= 0)
    .sort((a, b) => compareVersions(b.version, a.version))
    .map(({ version, date, items }) => ({ version, date: typeof date === 'string' ? date : '', items: items.filter(item => typeof item === 'string').slice(0, 30) }));
}

async function fetchLimited(url, { fetchImpl = fetch, limit, signal }) {
  const response = await fetchImpl(url, { headers: { 'User-Agent': 'school-calendar-updater', Accept: 'application/octet-stream, application/json' }, redirect: 'follow', signal });
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > limit) throw new Error('Download too large');
  return buffer;
}

function readManifest(buffer) {
  const manifest = JSON.parse(buffer.toString('utf8').replace(/^﻿/, ''));
  if (!manifest || !parseVersion(manifest.version) || typeof manifest.file !== 'string' || !/^[A-Za-z0-9._-]+\.zip$/.test(manifest.file) ||
      typeof manifest.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.sha256)) throw new Error('Invalid update manifest');
  return {
    version: manifest.version.replace(/^v/, ''), file: manifest.file, sha256: manifest.sha256,
    electron: typeof manifest.electron === 'string' ? manifest.electron : null,
    changes: changesBetween(manifest.changes, null, manifest.version.replace(/^v/, ''))
  };
}

// 결과 status: latest(최신), available(버튼으로 업데이트), full(Electron 판이 달라 전체 ZIP을 새로 받아야 함).
async function checkForUpdate({ manifestUrl, current, electron, fetchImpl, signal }) {
  const manifest = readManifest(await fetchLimited(manifestUrl, { fetchImpl, limit: MAX_MANIFEST, signal }));
  if (compareVersions(manifest.version, current) <= 0) return { status: 'latest', version: manifest.version };
  const changes = manifest.changes.filter(entry => compareVersions(entry.version, current) > 0);
  if (manifest.electron && electron && manifest.electron !== electron) return { status: 'full', ...manifest, changes };
  return { status: 'available', ...manifest, changes };
}

function assetUrl(manifestUrl, file) {
  return new URL(file, manifestUrl).href;
}

// 패치 ZIP 안에서 앱 폴더와 수집기 스크립트만 꺼낸다. 받은 쪽지(inbox)나 자료 폴더는 들어 있으면 거절한다.
function patchEntries(entries) {
  const files = [];
  for (const entry of entries) {
    if (!entry.name.startsWith(PATCH_ROOT)) throw new Error('Unexpected patch entry');
    const name = entry.name.slice(PATCH_ROOT.length);
    const ok = name === 'update-apply.ps1' || name === 'update.cmd' || name === 'update.json' || name === '읽어 보기.txt' ||
      name.startsWith('files/runtime/resources/app/') ||
      (/^files\/collector\/[^/]+$/.test(name) && /\.(ps1|json)$/i.test(name));
    if (!ok) throw new Error(`Unexpected patch entry: ${name}`);
    files.push({ name, data: entry.data });
  }
  if (!files.some(file => file.name === 'files/runtime/resources/app/main.js') || !files.some(file => file.name === 'update-apply.ps1')) {
    throw new Error('Incomplete patch');
  }
  return files;
}

async function downloadPatch({ manifestUrl, update, stagingRoot, fetchImpl, signal }) {
  const buffer = await fetchLimited(assetUrl(manifestUrl, update.file), { fetchImpl, limit: MAX_PATCH, signal });
  if (createHash('sha256').update(buffer).digest('hex') !== update.sha256) throw new Error('Checksum mismatch');
  const files = patchEntries(readZip(buffer));
  const staging = path.join(stagingRoot, update.version);
  await fs.rm(staging, { recursive: true, force: true });
  for (const file of files) {
    const target = path.join(staging, ...file.name.split('/'));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, file.data);
  }
  return staging;
}

module.exports = { parseVersion, compareVersions, changesBetween, readManifest, checkForUpdate, assetUrl, patchEntries, downloadPatch, PATCH_ROOT };
