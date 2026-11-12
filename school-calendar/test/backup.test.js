'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { test } = require('node:test');
const { CalendarStore } = require('../store');
const { writeZip, readZip, safeEntryName } = require('../backup');

const qaRoot = path.join(__dirname, '..', '.qa');
const noteId = '0_202611100000000001_0';

async function setup(t) {
  await fs.mkdir(qaRoot, { recursive: true });
  const root = await fs.mkdtemp(path.join(await fs.realpath(qaRoot), 'backup-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const ruleSeed = path.join(root, 'rules.md');
  await fs.writeFile(ruleSeed, '# 정리 기준 1판\n');
  const place = name => ({ dataDir: path.join(root, name, 'data'), inboxDir: path.join(root, name, 'inbox') });
  const makeStore = async (where, options = {}) => {
    await fs.mkdir(path.join(where.inboxDir, 'notes'), { recursive: true });
    const store = new CalendarStore({ ...where, ruleSeed, ...options });
    await store.init();
    return store;
  };
  return { root, ruleSeed, place, makeStore };
}

const writeNote = (inboxDir, id, extra = {}) => fs.writeFile(path.join(inboxDir, 'notes', `${id}.json`), JSON.stringify({
  id, title: '백업 시험 쪽지', sender: '가상 발신자', datetime: '2026-11-10 08:00', verified: true, body: '본문', ...extra
}));

test('ZIP 쓰기·읽기는 한글 이름과 압축·비압축 항목을 그대로 돌려주고 위험한 이름은 막는다', () => {
  const entries = [{ name: 'data/정리-기준.md', data: Buffer.from('가'.repeat(500)) }, { name: 'inbox/files/a/b.bin', data: Buffer.from([1, 2, 3]) }];
  assert.deepEqual(readZip(writeZip(entries)).map(({ name, data }) => [name, data.toString('hex')]), entries.map(({ name, data }) => [name, data.toString('hex')]));
  for (const bad of ['../x', '/x', 'a\b', 'a/../b', 'C:/x', 'a/ ']) assert.equal(safeEntryName(bad), false, bad);
  assert.throws(() => readZip(writeZip([{ name: '../evil', data: Buffer.from('x') }])), /Unsafe/);
  assert.throws(() => readZip(Buffer.from('not a zip')), /Not a zip/);
});

test('백업은 API 키를 빼고, 다른 PC에서 되돌리면 지금 자료를 먼저 떠 두고 AI 연결을 끈다', async (t) => {
  const { place, makeStore } = await setup(t);
  const first = place('pc1');
  const store = await makeStore(first);
  await writeNote(first.inboxDir, noteId);
  await fs.mkdir(path.join(first.inboxDir, 'files', noteId), { recursive: true });
  await fs.writeFile(path.join(first.inboxDir, 'files', noteId, '안내.pdf'), '첨부');
  await fs.writeFile(path.join(first.inboxDir, 'watch.log'), '로그는 넣지 않음');
  await store.refresh();
  const manual = await store.create({ title: '백업할 업무', due: '2026-11-20', memo: '메모도 남는다' });
  await store.saveAiConnection('factchat', 'ENCRYPTED-ONLY-HERE');
  const { buffer, manifest } = await store.createBackup();
  assert.equal(manifest.tasks, 2);
  assert.equal(manifest.notes, 1);
  const names = readZip(buffer).map(entry => entry.name);
  assert.ok(names.includes('inbox/files/0_202611100000000001_0/안내.pdf'));
  assert.ok(!names.some(name => name.includes('watch.log') || name.includes('profile')));
  const savedSettings = JSON.parse(readZip(buffer).find(entry => entry.name === 'data/settings.json').data);
  assert.equal(savedSettings.factchatKeyEncrypted, undefined);
  assert.equal(savedSettings.inboxDir, undefined);
  assert.equal(savedSettings.aiProvider, 'factchat');

  const second = place('pc2');
  const other = await makeStore(second);
  const before = await other.create({ title: '되돌리기 전에 있던 업무', due: '2026-11-21' });
  const result = await other.restoreBackup(buffer);
  assert.equal(result.aiReset, true);
  assert.equal(other.settings.aiProvider, 'none');
  assert.equal(other.settings.automatic, false);
  assert.equal(other.settings.inboxDir, path.resolve(second.inboxDir));
  await other.refresh();
  const titles = other.snapshot().tasks.map(task => task.title).sort();
  assert.deepEqual(titles, ['백업 시험 쪽지', '백업할 업무']);
  assert.equal(other.snapshot().tasks.find(task => task.id === manual.id).memo, '메모도 남는다');
  assert.equal((await other.detail(other.snapshot().tasks.find(task => task.noteId).id)).note.attachments.length, 0);
  assert.equal(await fs.readFile(path.join(second.inboxDir, 'files', noteId, '안내.pdf'), 'utf8'), '첨부');
  // 되돌리기 전 자료는 따로 남아 있다.
  const safety = readZip(await fs.readFile(result.safety));
  assert.ok(JSON.parse(safety.find(entry => entry.name === 'data/tasks.json').data).some(task => task.id === before.id));
  // 되돌린 쪽지는 자동 분류 대상으로 다시 잡지 않는다.
  assert.equal(other.snapshot().tasks.some(task => task.autoPending), false);

  await assert.rejects(other.restoreBackup(Buffer.from('zip 아님')), /읽지 못했습니다/);
  await assert.rejects(other.restoreBackup(writeZip([{ name: 'backup.json', data: Buffer.from('{"kind":"other"}') }])), /백업 파일이 아닙니다/);
  const extra = writeZip([...readZip(buffer), { name: 'data/profile/x', data: Buffer.from('x') }]);
  await assert.rejects(other.restoreBackup(extra), /알 수 없는 항목/);
});

test('정리 기준: 고치지 않았으면 새 판으로 바로 갈고, 고쳤으면 묻고, 고른 대로 한다', async (t) => {
  const { ruleSeed, place, makeStore } = await setup(t);
  const where = place('pc');
  const rulesPath = path.join(where.dataDir, '정리-기준.md');
  let store = await makeStore(where);
  assert.equal(store.snapshot().rulesUpdate, null);
  assert.ok(store.settings.rulesSeedHash);

  await fs.writeFile(ruleSeed, '# 정리 기준 2판\n');
  store = await makeStore(where);
  assert.equal(await fs.readFile(rulesPath, 'utf8'), '# 정리 기준 2판\n');
  assert.equal(store.snapshot().rulesUpdate, null);

  await fs.writeFile(rulesPath, '# 정리 기준 2판\n내가 더한 줄\n');
  await fs.writeFile(ruleSeed, '# 정리 기준 3판\n');
  store = await makeStore(where);
  assert.deepEqual(store.snapshot().rulesUpdate, { pending: true });
  assert.match(await fs.readFile(rulesPath, 'utf8'), /내가 더한 줄/);
  await store.resolveRules('keep');
  store = await makeStore(where);
  assert.equal(store.snapshot().rulesUpdate, null);

  await fs.writeFile(ruleSeed, '# 정리 기준 4판\n');
  store = await makeStore(where);
  assert.deepEqual(store.snapshot().rulesUpdate, { pending: true });
  await store.resolveRules('replace');
  assert.equal(await fs.readFile(rulesPath, 'utf8'), '# 정리 기준 4판\n');
  const kept = (await fs.readdir(where.dataDir)).filter(name => name.startsWith('정리-기준.내가-고친-'));
  assert.equal(kept.length, 1);
  assert.match(await fs.readFile(path.join(where.dataDir, kept[0]), 'utf8'), /내가 더한 줄/);
  assert.throws(() => store.resolveRules('delete'), /선택을 확인/);
});

test('예전에 배포한 정리 기준을 그대로 쓰고 있으면 묻지 않고 새 판으로 바꾼다', async (t) => {
  const { ruleSeed, place, makeStore } = await setup(t);
  const where = place('old');
  const rulesPath = path.join(where.dataDir, '정리-기준.md');
  await fs.mkdir(where.dataDir, { recursive: true });
  const { execFileSync } = require('node:child_process');
  const shipped = execFileSync('git', ['show', '9bf0b76:school-calendar/rules-seed.md'], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
  await fs.writeFile(rulesPath, shipped);
  await fs.writeFile(path.join(where.dataDir, 'settings.json'), '{}');
  const store = await makeStore(where);
  assert.equal(store.snapshot().rulesUpdate, null);
  assert.equal(await fs.readFile(rulesPath, 'utf8'), await fs.readFile(ruleSeed, 'utf8'));
});
