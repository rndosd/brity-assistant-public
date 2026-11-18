'use strict';

// 같은 사람이 같은 날 같은 제목으로 두 번 보낸 쪽지(정정·재안내)를 연달아 가져올 때,
// 화면이 아직 앞 쪽지에 머물러 있으면 그 본문을 뒤 쪽지로 저장하면 안 된다(2026-11-18).
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

test('a resend with the same title waits for its own body', { skip: process.platform !== 'win32' }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'brity-resend-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(__dirname, '..', '..', 'collector');
  const inbox = path.join(root, 'inbox');
  await fs.mkdir(path.join(inbox, 'notes'), { recursive: true });
  for (const name of ['labels.json', 'list-date.ps1']) await fs.copyFile(path.join(source, name), path.join(root, name));
  const first = '0_202611180000000021_0';
  const resend = '0_202611180000000022_0';
  const program = await fs.readFile(path.join(source, 'collect-notes.ps1'), 'utf8');
  const fakeScreen = `
    $script:reads = 0
    function Get-AppWindow { 1 }
    function Find-ByName { 1 }
    function Reset-NoteList {}
    function Get-NoteItems {
      foreach ($n in '${first}', '${resend}') { [pscustomobject]@{ id=$n; text='Same title, Sender, 2026-11-18'; unread=$true; hasFile=$false } }
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
      $old = [pscustomobject]@{title='Same title'; sender='Sender'; datetime='2026-11-18 08:00'; body='First body'; files=@()}
      if ($t.id -eq '${first}') { return $old }
      # The pane stays on the first note for a few reads after the resend is clicked.
      $script:reads++
      if ($script:reads -le 4) { return $old }
      [pscustomobject]@{title='Same title'; sender='Sender'; datetime='2026-11-18 09:30'; body='Corrected body'; files=@()}
    }
  `;
  const entry = path.join(root, 'collect-notes.ps1');
  const marker = '# ---- main ----';
  assert.ok(program.includes(marker));
  await fs.writeFile(entry, program.replace(marker, () => fakeScreen + '\n' + marker));
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', entry, '-Open', '-Inbox', inbox], { encoding: 'utf8', env: { ...process.env, LOCALAPPDATA: root } });
  assert.match(output, /opened=2 verified=2/);
  const note = async id => JSON.parse((await fs.readFile(path.join(inbox, 'notes', id + '.json'), 'utf8')).replace(/^﻿/, ''));
  assert.equal((await note(first)).body, 'First body');
  assert.equal((await note(resend)).body, 'Corrected body', 'the first note\'s body was saved as the resend');
});
