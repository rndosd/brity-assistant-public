'use strict';

// 자동 가져오기에서 쪽지를 열다가 본문을 못 읽어도(브리티에서는 이미 읽음이 됐을 수 있음)
// 캘린더에는 반드시 남아야 한다. 다음 가져오기에서 읽히면 진짜 본문으로 바뀐다.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { CalendarStore } = require('../store');

test('a note that failed to open still reaches the calendar and is read again later', { skip: process.platform !== 'win32' }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'brity-open-placeholder-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(__dirname, '..', '..', 'collector');
  const inbox = path.join(root, 'inbox');
  await fs.mkdir(path.join(inbox, 'notes'), { recursive: true });
  const id = '0_202611180000000001_0';
  const newer = '0_202611180000000002_0';
  for (const name of ['labels.json', 'list-date.ps1']) await fs.copyFile(path.join(source, name), path.join(root, name));
  const program = await fs.readFile(path.join(source, 'collect-notes.ps1'), 'utf8');
  const fakeScreen = `
    function Get-AppWindow { 1 }
    function Find-ByName { 1 }
    function Reset-NoteList {}
    function Get-NoteItems {
      if ($env:BRITY_OPEN_FIXTURE -ne 'fail') {
        [pscustomobject]@{ id='${newer}'; text='New note, Sender, 2026-11-18'; unread=$true; hasFile=$false }
      }
      $caption = if ($env:BRITY_OPEN_FIXTURE -eq 'truncated') { 'Target ti...' } else { 'Target title' }
      [pscustomobject]@{ id='${id}'; text=($caption + ', Sender, 2026-11-18'); unread=($env:BRITY_OPEN_FIXTURE -eq 'fail'); hasFile=$false }
    }
    function Find-NoteRow { 1 }
    function Get-AllNoteItems { Get-NoteItems }
    function Get-VisibleNoteRow { 1 }
    function Open-NoteRow {
      if (-not (Test-Path -LiteralPath (Join-Path $notesDir ($t.id + '.json')))) { throw 'Missing record before opening' }
      $env:BRITY_OPEN_FIXTURE -ne 'fail'
    }
    function Open-NoteWindow { $false }
    function Start-Sleep {}
    function Get-BrityWindows {}
    function Get-Foreground { [IntPtr]::Zero }
    function Start-Keeper {}
    function Arm-Keeper {}
    function Stop-Keeper {}
    function Restore-Foreground {}
    function Find-AlternativeDetail {}
    function Read-Detail {
      if ($env:BRITY_OPEN_FIXTURE -eq 'fail') { return $null }
      $title = if ($t.id -eq '${newer}') { 'New note' } elseif ($env:BRITY_OPEN_FIXTURE -eq 'stale') { 'Target title OLD' } else { 'Target title' }
      if ($t.id -eq '${id}' -and $env:BRITY_OPEN_FIXTURE -eq 'spacing') { $title = 'Targettitle' }
      $body = if ($env:BRITY_OPEN_FIXTURE -in 'empty', 'emptyWrongDay') { '' } else { 'Real body' }
      if ($env:BRITY_OPEN_FIXTURE -eq 'delayed' -and $t.id -eq '${id}') {
        $script:targetReads++
        if ($script:targetReads -lt 7) { $body = '' }
      }
      $date = if ($env:BRITY_OPEN_FIXTURE -eq 'emptyWrongDay') { '2026-11-17' } else { '2026-11-18' }
      $files = @()
      if ($t.id -eq '${id}' -and $env:BRITY_OPEN_FIXTURE -eq 'ok') { $files = @('calendar.txt') }
      [pscustomobject]@{title=$title; sender='Sender'; datetime=($date + ' 08:00'); body=$body; files=$files}
    }
    function Save-Attachment($group, $name, $folder) {
      [void][IO.Directory]::CreateDirectory($folder)
      $dest = Join-Path $folder $name
      [IO.File]::WriteAllText($dest, 'Fixture attachment')
      $dest
    }
  `;
  const entry = path.join(root, 'collect-notes.ps1');
  const marker = '# ---- main ----';
  assert.ok(program.includes(marker));
  await fs.writeFile(entry, program.replace(marker, () => fakeScreen + '\n' + marker));
  const run = (fixture, mode = ['-Open']) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', entry, ...mode, '-Download', '-Inbox', inbox], {
    encoding: 'utf8', env: { ...process.env, LOCALAPPDATA: root, BRITY_OPEN_FIXTURE: fixture }
  });
  const readJson = async name => JSON.parse((await fs.readFile(path.join(inbox, name), 'utf8')).replace(/^﻿/, ''));

  assert.match(run('fail'), /opened=1 verified=0/);
  const placeholder = await readJson(path.join('notes', id + '.json'));
  assert.equal(placeholder.verified, false);
  assert.equal(placeholder.title, 'Target title, Sender');
  assert.match(placeholder.body, /Target title, Sender, 2026-11-18/);
  assert.deepEqual((await readJson('state.json')).processed, [], 'failed note must be retried');

  const downloadsDir = path.join(root, 'downloads');
  await fs.mkdir(downloadsDir);
  const options = { dataDir: path.join(root, 'data'), inboxDir: inbox, downloadsDir };
  const store = new CalendarStore(options);
  await store.init();
  await store.refresh();
  assert.deepEqual(store.tasks.map(task => task.noteId), [id], 'failed note is missing from the calendar');
  assert.equal(store.notes.get(id).verified, false);

  assert.match(run('stale'), /opened=2 verified=1/);
  assert.deepEqual((await readJson('state.json')).processed, [newer]);
  const relative = path.join('notes', id + '.json');
  const waiting = await readJson(relative);
  assert.equal(waiting.readAttempts, 2);
  assert.equal(waiting.body, 'Real body');
  assert.match(waiting.observedHeader, /Target title OLD/);
  await store.refresh();
  const reviewTask = store.tasks.find(task => task.noteId === id);
  const review = await store.detail(reviewTask.id);
  assert.equal(review.task.type, '알아 둘 것');
  assert.equal(review.task.noteState, 'unverified');
  assert.equal(review.note.body, 'Real body');
  assert.equal(store.autoRefinable(reviewTask), false);
  assert.match(run('ok'), /opened=0 verified=0/, 'repeated failure should cool down');
  const makeDue = async () => {
    const record = await readJson(relative);
    record.retryAfterUtc = '2000-01-01T00:00:00Z';
    await fs.writeFile(path.join(inbox, relative), JSON.stringify(record));
  };
  await makeDue();
  assert.match(run('emptyWrongDay'), /opened=1 verified=0/);
  assert.equal((await readJson(relative)).body, 'Real body');
  await makeDue();
  assert.match(run('ok'), /opened=0 verified=0/, 'third unsuccessful attempt ends automatic opening');
  assert.match(run('ok', ['-From', '2026-11-18', '-To', '2026-11-18']), /opened=1 verified=1/);
  await fs.writeFile(path.join(inbox, 'state.json'), JSON.stringify({ processed: [newer] }));
  // Replay independent third attempts from the same two-attempt checkpoint.
  const resetAttempt = async () => fs.writeFile(path.join(inbox, relative),
    JSON.stringify({ ...waiting, retryAfterUtc: '2000-01-01T00:00:00Z' }));
  await resetAttempt();
  assert.match(run('truncated'), /opened=1 verified=0/);
  assert.match((await readJson(relative)).observedHeader, /Target title \/ Sender/);
  for (const fixture of ['empty', 'spacing', 'delayed']) {
    await resetAttempt();
    assert.match(run(fixture), /opened=1 verified=1/);
    assert.equal((await readJson(relative)).body, fixture === 'empty' ? '' : 'Real body');
    await fs.writeFile(path.join(inbox, 'state.json'), JSON.stringify({ processed: [newer] }));
  }
  await resetAttempt();
  assert.match(run('ok'), /opened=1 verified=1/);
  assert.deepEqual((await readJson('state.json')).processed, [newer, id]);
  const restarted = new CalendarStore(options);
  await restarted.init();
  await restarted.refresh();
  const recovered = restarted.tasks.filter(task => task.noteId === id);
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].title, 'Target title');
  assert.equal(restarted.notes.get(id).verified, true);
  assert.equal(restarted.notes.get(id).body, 'Real body');
  await restarted.refresh();
  assert.deepEqual(await fs.readdir(downloadsDir), ['calendar.txt']);
  assert.equal(await fs.readFile(path.join(downloadsDir, 'calendar.txt'), 'utf8'), 'Fixture attachment');
});

test('mixed and all-unverified imports keep separate counts in the calendar status', { skip: process.platform !== 'win32' }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'brity-count-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const calendar = path.join(__dirname, '..');
  const adapter = await fs.readFile(path.join(calendar, 'collector-link.ps1'), 'utf8');
  // Isolate the messenger process check, watcher output and mutex. Run the normal Tick adapter.
  await fs.writeFile(path.join(root, 'collector-link.ps1'), adapter.replace('$mutex = $null',
    'function Get-Process { [pscustomobject]@{SessionId=$session} }\n$mutex = $null')
    .replaceAll('Local\\BrityAssistantWatch', 'Local\\' + path.basename(root)));
  await fs.copyFile(path.join(calendar, 'collector-link.js'), path.join(root, 'collector-link.js'));
  await fs.writeFile(path.join(root, 'collect-notes.ps1'), '');
  await fs.writeFile(path.join(root, 'labels.json'), '{}');
  const { collectOnce } = require(path.join(root, 'collector-link.js'));
  const source = await fs.readFile(path.join(calendar, 'renderer', 'app.js'), 'utf8');
  const render = source.slice(source.indexOf('function renderCollector()'), source.indexOf('\n}', source.indexOf('function renderCollector()')) + 2);
  const screen = new Map();
  const element = id => {
    if (!screen.has(id)) screen.set(id, { classList: { toggle() {} } });
    return screen.get(id);
  };
  for (const good of [1, 0]) {
    await fs.writeFile(path.join(root, 'watch.ps1'), `'collected=${good} unverified=2'`);
    const result = await collectOnce({ scriptsDir: root });
    assert.equal(result.status, 'ready');
    assert.equal(result.imported, good);
    assert.equal(result.unverified, 2);
    vm.runInNewContext(render + '\nrenderCollector()', {
      state: { messenger: { name: '브리티' }, snapshot: {
        collectorAvailable: true, collectorConnected: true, collector: { ...result, checkedAt: Date.now() }
      } },
      $: element, document: { querySelector: element }, renderNotesFetch() {}, nextCheckText() {},
      activityText() {}, messengerBusy() {}, renderMessengerButtons() {}
    });
    assert.ok(element('collector-status').textContent.endsWith(`쪽지 ${good}건 받음 · 이번에 원문 미확인 2건`));
  }
});
