'use strict';

// 자동 가져오기는 목록 첫 화면 아래로 밀린 새 쪽지·안 읽은 쪽지도 가져와야 한다.
// 이미 받은 쪽지가 보일 때까지 내려 읽고, 그 아래는 더 내려가지 않는다(2026-11-18).
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

test('automatic import reads down to the newest saved note', { skip: process.platform !== 'win32' }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'brity-below-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(__dirname, '..', '..', 'collector');
  const inbox = path.join(root, 'inbox');
  await fs.mkdir(path.join(inbox, 'notes'), { recursive: true });
  for (const name of ['labels.json', 'list-date.ps1']) await fs.copyFile(path.join(source, name), path.join(root, name));
  const id = n => `0_2026111800000000${String(n).padStart(2, '0')}_0`;
  // Screen 0: 10 rows, screen 1: 10 more, screen 2 holds the saved note, then older rows.
  const rows = [];
  for (let n = 1; n <= 20; n++) rows.push({ id: id(n), unread: n % 3 === 0 });
  rows.push({ id: id(21), unread: false, saved: true });
  for (let n = 22; n <= 40; n++) rows.push({ id: id(n), unread: false });
  await fs.writeFile(path.join(inbox, 'state.json'), JSON.stringify({ processed: [id(21)] }));
  const rowList = rows.map(r => `@('${r.id}', $${r.unread})`).join(',');
  const program = await fs.readFile(path.join(source, 'collect-notes.ps1'), 'utf8');
  const fakeScreen = `
    $script:rows = @(${rowList})
    $script:top = 0
    function Get-AppWindow { 1 }
    function Find-ByName { 1 }
    function Reset-NoteList { $script:top = 0 }
    function Move-NoteList { if ($script:top + 10 -ge $script:rows.Count) { return $false }; $script:top += 10; $true }
    function Get-NoteItems {
      foreach ($r in $script:rows[$script:top..([Math]::Min($script:top + 9, $script:rows.Count - 1))]) {
        [pscustomobject]@{ id=$r[0]; text=('Title ' + $r[0] + ', Sender, 2026-11-18'); unread=$r[1]; hasFile=$false }
      }
    }
    function Find-NoteRow { 1 }
    function Get-VisibleNoteRow { 1 }
    function Open-NoteRow { $true }
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
      [pscustomobject]@{title=('Title ' + $t.id); sender='Sender'; datetime='2026-11-18 08:00'; body=('Body ' + $t.id); files=@()}
    }
  `;
  const entry = path.join(root, 'collect-notes.ps1');
  const marker = '# ---- main ----';
  assert.ok(program.includes(marker));
  await fs.writeFile(entry, program.replace(marker, () => fakeScreen + '\n' + marker));
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', entry, '-Open', '-Max', '40', '-Inbox', inbox], {
    encoding: 'utf8', env: { ...process.env, LOCALAPPDATA: root }
  });
  assert.match(output, /opened=20 verified=20/, 'notes below the first screen were not imported');
  const state = JSON.parse((await fs.readFile(path.join(inbox, 'state.json'), 'utf8')).replace(/^﻿/, ''));
  const expected = [id(21), ...rows.slice(0, 20).map(r => r.id)];
  assert.deepEqual([...state.processed].sort(), expected.sort());
  for (let n = 22; n <= 40; n++) assert.ok(!state.processed.includes(id(n)), 'read past the saved note');
});
