'use strict';

// 첨부 하나가 실패해도 그 쪽지 본문과 다음 쪽지는 저장돼야 하고,
// 같은 때 내려받힌 다른 파일을 이 쪽지의 첨부로 붙이면 안 된다(2026-11-18).
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

test('attachment failures stay with their file and never take another download', { skip: process.platform !== 'win32' }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'brity-attach-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(__dirname, '..', '..', 'collector');
  const inbox = path.join(root, 'inbox');
  const downloads = path.join(root, 'download');
  await fs.mkdir(path.join(inbox, 'notes'), { recursive: true });
  await fs.mkdir(downloads);
  const labels = JSON.parse((await fs.readFile(path.join(source, 'labels.json'), 'utf8')).replace(/^﻿/, ''));
  labels.downloadDir = downloads;
  await fs.writeFile(path.join(root, 'labels.json'), JSON.stringify(labels));
  await fs.copyFile(path.join(source, 'list-date.ps1'), path.join(root, 'list-date.ps1'));
  const [a, b, c] = ['0_202611180000000011_0', '0_202611180000000012_0', '0_202611180000000013_0'];
  const program = await fs.readFile(path.join(source, 'collect-notes.ps1'), 'utf8');
  const fakeScreen = `
    $script:files = @{ '${a}' = 'broken.hwpx'; '${b}' = 'plan (draft).hwpx'; '${c}' = 'missing.hwpx' }
    function Get-AppWindow { 1 }
    function Find-ByName { 1 }
    function Reset-NoteList {}
    function Get-NoteItems {
      foreach ($n in '${a}', '${b}', '${c}') { [pscustomobject]@{ id=$n; text=('Title ' + $n + ', Sender, 2026-11-18'); unread=$true; hasFile=$true } }
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
      [pscustomobject]@{title=('Title ' + $t.id); sender='Sender'; datetime='2026-11-18 08:00'; body=('Body ' + $t.id); files=@($script:files[$t.id]); group=1}
    }
    function Invoke-El {
      $dir = $L.downloadDir
      if ($t.id -eq '${a}') { throw 'Copy failed' }
      if ($t.id -eq '${b}') { [IO.File]::WriteAllText((Join-Path $dir 'plan (draft).hwpx'), 'wanted') }
      # Another download finishing a moment later (and, for c, instead of the requested file).
      $other = Join-Path $dir ('other-' + $t.id + '.pdf')
      [IO.File]::WriteAllText($other, 'other')
      [IO.File]::SetLastWriteTime($other, (Get-Date).AddMilliseconds(150))
      $true
    }
  `;
  const entry = path.join(root, 'collect-notes.ps1');
  const marker = '# ---- main ----';
  assert.ok(program.includes(marker));
  await fs.writeFile(entry, program.replace(marker, () => fakeScreen + '\n' + marker));
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', entry, '-Open', '-Download', '-Inbox', inbox], { encoding: 'utf8', env: { ...process.env, LOCALAPPDATA: root } });
  assert.match(output, /opened=3 verified=3/);
  const note = async id => JSON.parse((await fs.readFile(path.join(inbox, 'notes', id + '.json'), 'utf8')).replace(/^﻿/, ''));

  const first = await note(a);
  assert.equal(first.body, 'Body ' + a, 'body lost when its attachment failed');
  assert.equal(first.saved[0].path, null);
  const second = await note(b);
  assert.equal(path.basename(second.saved[0].path), 'plan (draft).hwpx');
  assert.equal(await fs.readFile(second.saved[0].path, 'utf8'), 'wanted');
  const third = await note(c);
  assert.equal(third.saved[0].path, null, 'another download was taken as this attachment');
});
