'use strict';

// 자동 가져오기에서 쪽지를 열었는데 브리티 화면이 앞 쪽지에 머물러 있으면,
// 앞 쪽지의 본문을 이 쪽지의 "읽은 글"로 남기면 안 된다(2026-11-18).
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

test('a pane still showing the previous note is not kept as this note\'s body', { skip: process.platform !== 'win32' }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'brity-open-stale-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(__dirname, '..', '..', 'collector');
  const inbox = path.join(root, 'inbox');
  await fs.mkdir(path.join(inbox, 'notes'), { recursive: true });
  const id = '0_202611180000000003_0';
  for (const name of ['labels.json', 'list-date.ps1']) await fs.copyFile(path.join(source, name), path.join(root, name));
  const program = await fs.readFile(path.join(source, 'collect-notes.ps1'), 'utf8');
  const fakeScreen = `
    function Get-AppWindow { 1 }
    function Find-ByName { 1 }
    function Reset-NoteList {}
    function Get-NoteItems { [pscustomobject]@{ id='${id}'; text='Target title, Sender, 2026-11-18'; unread=$true; hasFile=$false } }
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
      [pscustomobject]@{title='Previous note'; sender='Other'; datetime='2026-11-17 09:00'; body='Previous body'; files=@()}
    }
  `;
  const entry = path.join(root, 'collect-notes.ps1');
  const marker = '# ---- main ----';
  assert.ok(program.includes(marker));
  await fs.writeFile(entry, program.replace(marker, () => fakeScreen + '\n' + marker));
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', entry, '-Open', '-Inbox', inbox], { encoding: 'utf8', env: { ...process.env, LOCALAPPDATA: root } });
  assert.match(output, /opened=1 verified=0/);
  const record = JSON.parse((await fs.readFile(path.join(inbox, 'notes', id + '.json'), 'utf8')).replace(/^﻿/, ''));
  assert.equal(record.verified, false);
  assert.doesNotMatch(record.body, /Previous body/);
  assert.ok(!record.observedHeader, 'previous note header was kept as observed');
});
