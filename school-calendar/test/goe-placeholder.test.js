'use strict';

// GOE판: 쪽지를 열었는데 본문을 못 읽어도 캘린더에는 남아야 한다(2026-11-18, 브리티와 같은 기준).
// 수집기의 자리표시 함수만 꺼내 임시 폴더에서 돌리고, 캘린더가 그것을 "확인할 것"으로 띄웠다가
// 진짜 쪽지가 같은 id로 들어오면 그대로 이어받는지 본다.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { CalendarStore } = require('../store');

const collector = path.join(__dirname, '..', '..', 'collector', 'goe');

test('GOE note that could not be read becomes a placeholder and the real note takes it over', { skip: process.platform !== 'win32' }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'goe-placeholder-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const inbox = path.join(root, 'inbox');
  const notesDir = path.join(inbox, 'notes');
  await fs.mkdir(notesDir, { recursive: true });
  const harness = path.join(root, 'harness.ps1');
  await fs.writeFile(harness, `
param([string]$Collector, [string]$NotesDir, [string]$Step)
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $Collector 'collect-goe.ps1'), [ref]$tokens, [ref]$errors)
$wanted = 'Row-Key','Test-SameNoteRow','Get-EditDistance','Find-Placeholder','Write-Placeholder','Write-Note','Known-Row','Known-RowLoose'
foreach ($f in $ast.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -in $wanted }, $true)) {
    . ([scriptblock]::Create($f.Extent.Text))
}
$L = Get-Content (Join-Path $Collector 'labels.json') -Raw -Encoding utf8 | ConvertFrom-Json
$calendar = [Globalization.CultureInfo]::InvariantCulture
$notesDir = $NotesDir
$result = [ordered]@{ placeholders = 0 }
$rowKeys = @{}; $dayNotes = @{}
$RangeImport = $false
$row = [pscustomobject]@{ datetime = '2026-11-18 14:40'; sender = 'Sender A'; titleOcr = 'Meeting plan'; unread = $true; attach = $true }
$ocrRow = [pscustomobject]@{ datetime = '2026-11-18 14:41'; sender = 'Sendr A'; titleOcr = 'Meeting pIan'; unread = $false; attach = $true }
switch ($Step) {
    'fail' { Write-Placeholder $row (Find-Placeholder $row) 'no-body-control' }
    'find' {
        $p = Find-Placeholder $ocrRow
        [pscustomobject]@{ id = $p.id; attempts = $p.readAttempts; known = (Known-Row $ocrRow (Row-Key $ocrRow)); loose = (Known-RowLoose $ocrRow) } | ConvertTo-Json -Compress
    }
}
`);
  const run = step => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', harness, '-Collector', collector, '-NotesDir', notesDir, '-Step', step], { encoding: 'utf8' }).trim();
  const readNote = async id => JSON.parse((await fs.readFile(path.join(notesDir, id + '.json'), 'utf8')).replace(/^﻿/, ''));

  run('fail');
  const [file] = await fs.readdir(notesDir);
  const id = file.slice(0, -5);
  assert.match(id, /^goe_202611181440_[a-f0-9]{8}$/);
  const placeholder = await readNote(id);
  assert.equal(placeholder.placeholder, true);
  assert.equal(placeholder.verified, false);
  assert.equal(placeholder.readAttempts, 1);
  assert.equal(placeholder.attachStatus, 'review');
  assert.match(placeholder.body, /Meeting plan \/ Sender A \/ 2026-11-18 14:40/);

  // the same row read again by OCR a letter or a minute off is still the same placeholder, and is not "known"
  const found = JSON.parse(run('find'));
  assert.deepEqual(found, { id, attempts: 1, known: false, loose: false });
  run('fail');
  run('fail');
  assert.equal((await readNote(id)).readAttempts, 3);
  assert.equal((await fs.readdir(notesDir)).length, 1);

  const store = new CalendarStore({ dataDir: path.join(root, 'data'), inboxDir: inbox, downloadsDir: path.join(root, 'downloads') });
  await store.init();
  await store.refresh();
  assert.deepEqual(store.tasks.map(task => task.noteId), [id], 'placeholder must reach the calendar');
  const waiting = await store.detail(store.tasks[0].id);
  assert.equal(waiting.task.noteState, 'unverified');
  assert.equal(waiting.task.type, '알아 둘 것');

  // the collector later writes the real note under the placeholder's id (Write-Note with replace)
  const { placeholder: _p, readAttempts: _a, readFailure: _f, ...rest } = placeholder;
  await fs.writeFile(path.join(notesDir, id + '.json'), JSON.stringify({ ...rest, verified: true, title: 'Meeting plan', body: 'Real body', attachStatus: 'none' }));
  await store.refresh();
  assert.equal(store.tasks.length, 1);
  const real = await store.detail(store.tasks[0].id);
  assert.equal(real.task.noteState, 'available');
  assert.equal(real.task.title, 'Meeting plan');
  assert.equal(real.note.body, 'Real body');
});
