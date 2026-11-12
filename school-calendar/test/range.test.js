'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { test } = require('node:test');
const { CalendarStore } = require('../store');

const qaRoot = path.join(__dirname, '..', '.qa');
const listDate = path.join(__dirname, '..', '..', 'collector', 'list-date.ps1');

test('브리티 쪽지 목록의 날짜(월·일, 시각, 연도 포함)를 읽고 연도는 오늘보다 늦지 않게 정한다', { skip: process.platform !== 'win32' }, () => {
  const cases = [
    ['가상 제목, 가상 보낸이, 8월 27일', '2026-08-27'],
    ['가상 제목, 가상 보낸이, 12월 30일', '2025-12-30'],
    ['안 읽음, 가상 제목, 오후 1:54', '2026-11-12'],
    ['가상 제목, 2025년 3월 2일', '2025-03-02'],
    ['가상 제목, 2026.01.05.', '2026-01-05'],
    ['가상 제목, 2월 30일', ''],
    ['가상 제목만', '']
  ];
  const script = `. '${listDate.replace(/'/g, "''")}'; $today = [datetime]'2026-11-12'; ` +
    cases.map(([text]) => `[string](Get-ListDate '${text.replace(/'/g, "''")}' $today)`).join('; ');
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${script}`], { encoding: 'utf8' });
  assert.deepEqual(out.split(/\r?\n/).slice(0, cases.length), cases.map(([, expected]) => expected));
});

test('기간으로 불러온 쪽지는 첨부를 복사하지 않고 묻기 전에는 분류하지 않으며, 분류 뒤 지난 까지는 끝낸 것으로 둔다', async (t) => {
  await fs.mkdir(qaRoot, { recursive: true });
  const root = await fs.mkdtemp(path.join(await fs.realpath(qaRoot), 'range-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const inboxDir = path.join(root, 'inbox');
  const dataDir = path.join(root, 'data');
  const downloadsDir = path.join(root, 'Downloads');
  const ruleSeed = path.join(root, 'rules.md');
  await fs.mkdir(path.join(inboxDir, 'notes'), { recursive: true });
  await fs.mkdir(downloadsDir, { recursive: true });
  await fs.writeFile(ruleSeed, '# 기준\n');
  const store = new CalendarStore({ dataDir, inboxDir, ruleSeed, downloadsDir });
  await store.init();
  await store.saveAiConnection('factchat', 'ENCRYPTED');
  await store.refresh();
  const id = '0_202608270000000001_0';
  const source = path.join(inboxDir, 'files', id, '지난 안내.pdf');
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.writeFile(source, '첨부');
  await fs.writeFile(path.join(inboxDir, 'notes', `${id}.json`), JSON.stringify({
    id, title: '지난 쪽지', sender: '가상', datetime: '2026-08-27 09:00', verified: true, body: '9월 5일까지 제출, 12월 1일 협의회',
    saved: [{ name: '지난 안내.pdf', path: source }], imported: 'range'
  }));
  const later = new Date(Date.now() + 2000);
  await fs.utimes(path.join(inboxDir, 'notes', `${id}.json`), later, later);
  await store.refresh();
  const [task] = store.tasks;
  assert.ok(task.rangeImported?.day);
  assert.equal(task.autoPending, false);
  assert.equal(store.nextAutomatic(), null);
  assert.deepEqual(await fs.readdir(downloadsDir), []);
  assert.equal(store.snapshot().rangePending, 1);

  assert.equal(await store.queueRangeClassify(), 1);
  assert.equal(store.nextAutomatic(), task.id);
  task.rangeImported.day = '2026-11-12';
  const { task: done } = await store.refine(task.id, async () => ({
    type: '할 일', title: '지난 제출', summary: '', uncertain: false,
    dates: [{ date: '2026-09-05', label: '제출', kind: '까지' }, { date: '2026-12-01', label: '협의회', kind: '그날' }, { date: '2026-12-10', label: '보고', kind: '까지' }]
  }), { automatic: true });
  assert.deepEqual(done.dates.map(entry => [entry.date, entry.done]), [['2026-09-05', true], ['2026-12-01', undefined], ['2026-12-10', false]]);
  assert.equal(store.snapshot().rangePending, 0);
});
