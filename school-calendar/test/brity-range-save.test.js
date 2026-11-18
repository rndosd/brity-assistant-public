'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { CalendarStore } = require('../store');

test('range import verifies the target while the detail pane changes', { skip: process.platform !== 'win32' }, () => {
  const fixture = path.resolve(__dirname, '../../tools/brity-import-diagnose/test-detail-identity.ps1');
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fixture]);
});

test('range import keeps existing copies and leaves mismatches available for retry', { skip: process.platform !== 'win32' }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'brity-range-save-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(__dirname, '..', '..', 'collector');
  const inbox = path.join(root, 'inbox');
  const notes = path.join(inbox, 'notes');
  await fs.mkdir(notes, { recursive: true });
  const id = '0_202611100000000001_0';
  const missing = '0_202611100000000002_0';
  const oldCopy = JSON.stringify({ id, title: 'Previous verified title', body: 'Original body', verified: true });
  const file = path.join(notes, id + '.json');
  await fs.writeFile(file, oldCopy);
  for (const name of ['labels.json', 'list-date.ps1']) await fs.copyFile(path.join(source, name), path.join(root, name));
  const program = await fs.readFile(path.join(source, 'collect-notes.ps1'), 'utf8');
  const fakeScreen = `
    function Get-AppWindow { 1 }
    function Find-ByName { 1 }
    function Reset-NoteList {}
    function Get-AllNoteItems {
      foreach ($testId in '${id}', '${missing}') {
        [pscustomobject]@{ id=$testId; text=('Target ' + $testId + ', Sender, 2026-11-10'); unread=$false }
      }
    }
    function Find-NoteRow { 1 }
    function Get-VisibleNoteRow { 1 }
    function Open-NoteRow { $true }
    function Start-Sleep {}
    function Get-BrityWindows {}
    function Find-AlternativeDetail {}
    function Read-Detail {
      $title = if ($env:BRITY_SAVE_FIXTURE -eq 'retry') { 'Target ' + $t.id } else { 'Foreign heading' }
      $sender = if ($env:BRITY_SAVE_FIXTURE -eq 'retry') { 'Sender' } else { 'Foreign sender' }
      [pscustomobject]@{title=$title; sender=$sender; datetime='2026-11-10 08:00'; body='Body from pane'; files=@()}
    }
  `;
  const entry = path.join(root, 'collect-notes.ps1');
  const marker = '# ---- main ----';
  assert.ok(program.includes(marker));
  await fs.writeFile(entry, program.replace(marker, () => fakeScreen + '\n' + marker));
  function run(fixture) {
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', entry, '-From', '2026-11-10', '-To', '2026-11-10', '-Inbox', inbox], {
      encoding: 'utf8', env: { ...process.env, LOCALAPPDATA: root, BRITY_SAVE_FIXTURE: fixture }
    });
  }
  async function readInbox(name) {
    return JSON.parse((await fs.readFile(path.join(inbox, name), 'utf8')).replace(/^\uFEFF/, ''));
  }

  assert.match(run('stale'), /opened=2 verified=0/);
  assert.equal(await fs.readFile(file, 'utf8'), oldCopy, 'failed retry overwrote verified note');
  assert.deepEqual(await fs.readdir(notes), [id + '.json']);
  assert.deepEqual((await readInbox('state.json')).processed, []);
  const attempts = (await readInbox('latest.json')).opened;
  assert.deepEqual(attempts.map(row => row.id), [id, missing]);
  assert.ok(attempts.every(row => row.verified === false && !('body' in row)));

  const store = new CalendarStore({ dataDir: path.join(root, 'data'), inboxDir: inbox });
  await store.init();
  await store.refresh();
  assert.deepEqual(store.tasks.map(task => task.noteId), [id]);
  assert.equal(store.notes.get(id).body, 'Original body');
  assert.match(run('retry'), /opened=2 verified=2/);
  assert.deepEqual((await readInbox('state.json')).processed, [id, missing]);
  await store.refresh();
  assert.equal(store.tasks.length, 2);
  assert.equal(store.notes.get(missing).verified, true);
});
