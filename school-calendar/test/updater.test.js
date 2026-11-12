'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { test } = require('node:test');
const updater = require('../updater');
const { writeZip } = require('../backup');

const manifestUrl = 'https://example.test/releases/latest/download/update.json';
const changes = [
  { version: '0.3.0', date: '2026-11-12', items: ['첫 판'] },
  { version: '0.3.1', date: '2026-11-20', items: ['상시 고침'] },
  { version: '0.4.0', date: '2026-12-01', items: ['대화방'] }
];

function fakeFetch(files) {
  return async url => {
    if (!Object.hasOwn(files, url)) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    const body = Buffer.from(files[url]);
    return { ok: true, status: 200, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length) };
  };
}

function patchZip(extra = []) {
  return writeZip([
    { name: 'School-Calendar-Patch/update-apply.ps1', data: Buffer.from('# apply') },
    { name: 'School-Calendar-Patch/update.cmd', data: Buffer.from('@echo off') },
    { name: 'School-Calendar-Patch/files/runtime/resources/app/main.js', data: Buffer.from('// new main') },
    { name: 'School-Calendar-Patch/files/runtime/resources/app/renderer/app.js', data: Buffer.from('// new app') },
    { name: 'School-Calendar-Patch/files/collector/watch.ps1', data: Buffer.from('# watch') },
    ...extra
  ]);
}

test('판 비교와 판 사이 바뀐 점을 최신부터 고른다', () => {
  assert.ok(updater.compareVersions('0.3.10', '0.3.9') > 0);
  assert.equal(updater.compareVersions('v0.3.0', '0.3.0'), 0);
  assert.throws(() => updater.compareVersions('0.3', '0.3.0'));
  assert.deepEqual(updater.changesBetween(changes, '0.3.0', '0.4.0').map(entry => entry.version), ['0.4.0', '0.3.1']);
  assert.deepEqual(updater.changesBetween(changes, null, '0.3.1').map(entry => entry.version), ['0.3.1', '0.3.0']);
});

test('update.json으로 최신·새 판·전체 새로 받기를 가리고, 릴리스가 없으면 404를 알린다', async () => {
  const manifest = sha => JSON.stringify({ version: '0.4.0', electron: '45.2.3', file: 'school-calendar-patch-0.4.0.zip', sha256: sha, changes });
  const sha = 'a'.repeat(64);
  const fetchImpl = fakeFetch({ [manifestUrl]: manifest(sha) });
  const available = await updater.checkForUpdate({ manifestUrl, current: '0.3.0', electron: '45.2.3', fetchImpl });
  assert.equal(available.status, 'available');
  assert.deepEqual(available.changes.map(entry => entry.version), ['0.4.0', '0.3.1']);
  assert.equal((await updater.checkForUpdate({ manifestUrl, current: '0.4.0', electron: '45.2.3', fetchImpl })).status, 'latest');
  assert.equal((await updater.checkForUpdate({ manifestUrl, current: '0.3.0', electron: '46.0.0', fetchImpl })).status, 'full');
  await assert.rejects(updater.checkForUpdate({ manifestUrl, current: '0.3.0', electron: '45.2.3', fetchImpl: fakeFetch({}) }), error => error.status === 404);
  const bad = fakeFetch({ [manifestUrl]: JSON.stringify({ version: '0.4.0', file: '../x.zip', sha256: sha }) });
  await assert.rejects(updater.checkForUpdate({ manifestUrl, current: '0.3.0', fetchImpl: bad }), /Invalid update manifest/);
});

test('패치는 지문이 맞을 때만 풀고, 앱 코드·수집기 스크립트 밖의 항목이 있으면 거절한다', async (t) => {
  const root = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'updater-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const zip = patchZip();
  const sha256 = createHash('sha256').update(zip).digest('hex');
  const update = { version: '0.4.0', file: 'school-calendar-patch-0.4.0.zip', sha256 };
  const fetchImpl = fakeFetch({ 'https://example.test/releases/latest/download/school-calendar-patch-0.4.0.zip': zip });
  const staging = await updater.downloadPatch({ manifestUrl, update, stagingRoot: root, fetchImpl });
  assert.equal(staging, path.join(root, '0.4.0'));
  assert.equal(await fs.readFile(path.join(staging, 'files', 'runtime', 'resources', 'app', 'main.js'), 'utf8'), '// new main');
  assert.equal(await fs.readFile(path.join(staging, 'files', 'collector', 'watch.ps1'), 'utf8'), '# watch');

  await assert.rejects(updater.downloadPatch({ manifestUrl, update: { ...update, sha256: 'b'.repeat(64) }, stagingRoot: root, fetchImpl }), /Checksum/);
  assert.throws(() => updater.patchEntries([{ name: 'School-Calendar-Patch/files/collector/inbox/notes/x.json', data: Buffer.from('') }]), /Unexpected/);
  assert.throws(() => updater.patchEntries([{ name: 'School-Calendar-Patch/files/calendar-data/tasks.json', data: Buffer.from('') }]), /Unexpected/);
  assert.throws(() => updater.patchEntries([{ name: 'School-Calendar-Patch/update-apply.ps1', data: Buffer.from('') }]), /Incomplete/);
});
