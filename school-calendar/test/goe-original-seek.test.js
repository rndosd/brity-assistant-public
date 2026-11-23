'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

test('GOE original seek uses a verified narrow row and preserves full-reader fallbacks', { skip: process.platform !== 'win32' }, () => {
  const script = `
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    $tokens = $null; $errors = $null
    $ast = [Management.Automation.Language.Parser]::ParseFile($env:GOE_SEEK_SOURCE, [ref]$tokens, [ref]$errors)
    if ($errors.Count) { throw 'parse-error' }
    $f = $ast.Find({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Read-OriginalSeekRows' }, $true)
    if (!$f) { throw 'missing-original-seek-reader' }
    . ([scriptblock]::Create($f.Extent.Text))
    function Get-GoeScanFolder { $script:folderChecks++; if ($script:folderChecks -gt 1 -and $script:changed) { 'sent' } else { $script:folder } }
    function Read-ListTimes { param([switch]$Rows) $script:narrowReads++; $script:quick }
    function Read-Rows { param($Scale) $script:fullReads++; @{ inbox = $script:folder -eq 'inbox'; readable = $true; visual = $false; rows = @(@{ datetime = '2026-11-10 09:00'; sender = 'sender'; unread = $false; clickY = 40 }); reader = 'full' } }
    function Test-SameNoteRow($Row, $Note) { $Row.datetime -eq $Note.datetime -and $Row.sender -eq $Note.sender }
    $retryNote = @{ datetime = '2026-11-10 09:00'; sender = 'sender' }
    $timeColX = 600
    $results = @()
    foreach ($case in 'unique','missing','ambiguous','unread','unknown-read','no-sender','attachments','no-layout','visual','changed') {
      $ShowOriginal = $case -ne 'attachments'
      $script:timeColX = if ($case -eq 'no-layout') { 0 } else { 600 }
      $script:folder = if ($case -eq 'visual') { 'visual' } else { 'inbox' }
      $script:changed = $case -eq 'changed'
      $script:folderChecks = 0; $script:fullReads = 0; $script:narrowReads = 0
      $script:quick = @(@{ datetime = '2026-11-10 09:00'; sender = 'sender'; unread = $case -eq 'unread'; clickY = 40 })
      if ($case -eq 'missing') { $script:quick = @() }
      if ($case -eq 'ambiguous') { $script:quick += @{ datetime = '2026-11-10 09:00'; sender = 'sender'; unread = $false; clickY = 80 } }
      if ($case -eq 'unknown-read') { $script:quick[0].Remove('unread') }
      if ($case -eq 'no-sender') { $script:quick[0].sender = '' }
      $failure = ''
      try { $view = Read-OriginalSeekRows 3 } catch { $failure = $_.Exception.Message; $view = $null }
      $results += @{ case = $case; full = $script:fullReads; narrow = $script:narrowReads; error = $failure; rows = @($view.rows).Count }
    }
    $seek = $ast.Find({ param($n) $n -is [Management.Automation.Language.IfStatementAst] -and $n.Extent.Text.StartsWith('if ($retryNote -and @($view.rows).Count)') }, $true)
    if (!$seek) { throw 'missing-seek-block' }
    function Scroll-List { param($Ticks) $script:scrolls++ }
    function Start-Sleep { param($Milliseconds) }
    function Mark { param($Message) }
    function Read-ListTimes {
      param([switch]$Rows)
      $script:narrowReads++
      if ($Rows) { return $script:quick }
      '2026-11-10 09:00'
      if (!$script:singleton) { '2026-11-10 08:00' }
    }
    foreach ($case in 'seek-singleton','seek-multiple') {
      $script:singleton = $case -eq 'seek-singleton'
      $ShowOriginal = $true; $script:timeColX = 600; $script:folder = 'inbox'; $script:changed = $false
      $script:folderChecks = 0; $script:fullReads = 0; $script:narrowReads = 0; $script:scrolls = 0
      $script:quick = @(@{ datetime = '2026-11-10 09:00'; sender = 'sender'; unread = $false; clickY = 40 })
      $view = @{ rows = @(@{ datetime = '2026-11-20 09:00' }) }
      if (!$script:singleton) { $view.rows += @{ datetime = '2026-11-20 08:00' } }
      $MaxPages = 60; $listOcrScale = 3
      . ([scriptblock]::Create($seek.Extent.Text))
      $results += @{ case = $case; full = $script:fullReads; narrow = $script:narrowReads; scrolls = $script:scrolls; rows = @($view.rows).Count }
    }
    $results | ConvertTo-Json -Compress
  `;
  const result = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    encoding: 'utf8', timeout: 20_000,
    env: { ...process.env, GOE_SEEK_SOURCE: path.resolve(__dirname, '../../collector/goe/collect-goe.ps1') }
  }));
  const cases = Object.fromEntries(result.map(item => [item.case, item]));
  assert.equal(cases.unique.full, 0);
  assert.equal(cases.unique.rows, 1);
  for (const name of ['missing', 'ambiguous', 'unread', 'unknown-read', 'no-sender', 'attachments', 'no-layout', 'visual']) {
    assert.equal(cases[name].full, 1, name);
    assert.equal(cases[name].error, '', name);
  }
  for (const name of ['attachments', 'no-layout', 'visual']) assert.equal(cases[name].narrow, 0, name);
  assert.equal(cases.changed.error, 'inbox-lost-while-paging');
  assert.equal(cases.changed.full, 0);
  for (const name of ['seek-singleton', 'seek-multiple']) {
    assert.equal(cases[name].scrolls, 1, name);
    assert.equal(cases[name].full, 0, name);
    assert.equal(cases[name].narrow, 2, name);
    assert.equal(cases[name].rows, 1, name);
  }
});

test('GOE explicit original requests accept the foreground main window but still reject an open note', { skip: process.platform !== 'win32' }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'goe-original-options-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const script = `
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    $tokens = $null; $errors = $null
    $ast = [Management.Automation.Language.Parser]::ParseFile($env:GOE_SEEK_SOURCE, [ref]$tokens, [ref]$errors)
    if ($errors.Count) { throw 'parse-error' }
    $setup = @()
    foreach ($statement in $ast.EndBlock.Statements) {
      if ($statement.Extent.Text.StartsWith('$range =')) { break }
      $setup += $statement.Extent.Text
    }
    $guard = $ast.Find({ param($n) $n -is [Management.Automation.Language.IfStatementAst] -and $n.Extent.Text.StartsWith('if ((-not $Force -and (Goe-IsForeground)) -or (Get-NoteWindow))') }, $true)
    if (!$guard) { throw 'missing-open-note-guard' }
    function Goe-IsForeground { $true }
    function Get-NoteWindow { $script:noteOpen }
    function Hide-Main {}
    function Publish-Result { param($Reason) }
    $results = @()
    foreach ($original in $false, $true) {
      $Inbox = $env:GOE_OPTIONS_INBOX
      $RetryId = 'goe_202611230855_12345678'
      $ShowOriginal = $original
      $ResultObject = $true
      $ListOnly = $Inspect = $RangeImport = $false
      $From = $To = ''
      $Force = $true; $Download = $false; $MaxPages = 10
      [void][IO.Directory]::CreateDirectory((Join-Path $Inbox 'notes'))
      $note = @{ id = $RetryId; source = 'goe'; verified = $true; body = 'synthetic body'; datetime = (Get-Date).ToString('yyyy-MM-dd HH:mm') }
      [IO.File]::WriteAllText((Join-Path $Inbox ('notes/' + $RetryId + '.json')), ($note | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
      . ([scriptblock]::Create(($setup -join "\n")))
      $forceForRequest = [bool]$Force
      foreach ($noteOpen in $false, $true) {
        $script:noteOpen = $noteOpen
        $result = @{ status = 'ok'; busyReason = '' }
        $null = . ([scriptblock]::Create($guard.Extent.Text))
        $results += @{ original = $original; noteOpen = $noteOpen; force = $forceForRequest; download = [bool]$Download; status = $result.status; reason = $result.busyReason }
      }
    }
    $results | ConvertTo-Json -Compress
  `;
  const results = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    encoding: 'utf8', timeout: 20_000,
    env: { ...process.env, GOE_SEEK_SOURCE: path.resolve(__dirname, '../../collector/goe/collect-goe.ps1'), GOE_OPTIONS_INBOX: root }
  }));
  const retryMain = results.find(r => !r.original && !r.noteOpen);
  const originalMain = results.find(r => r.original && !r.noteOpen);
  assert.equal(retryMain.force, false);
  assert.equal(retryMain.download, true);
  assert.equal(retryMain.status, 'busy');
  assert.equal(retryMain.reason, 'in-goe');
  assert.equal(originalMain.force, true);
  assert.equal(originalMain.download, false);
  assert.equal(originalMain.status, 'ok');
  for (const row of results.filter(r => r.noteOpen)) {
    assert.equal(row.status, 'busy');
    assert.equal(row.reason, 'note-open');
  }
});

test('GOE explicit original fallback permits the main window but protects open notes', { skip: process.platform !== 'win32' }, () => {
  const script = `
    $ErrorActionPreference = 'Stop'
    $tokens = $null; $errors = $null
    $ast = [Management.Automation.Language.Parser]::ParseFile($env:GOE_SEEK_SOURCE, [ref]$tokens, [ref]$errors)
    $fallback = $ast.Find({ param($n) $n -is [Management.Automation.Language.IfStatementAst] -and $n.Extent.Text.StartsWith('if ($retryFullScan)') }, $true)
    if (!$fallback) { throw 'missing-fallback' }
    $guard = $fallback.Find({ param($n) $n -is [Management.Automation.Language.IfStatementAst] -and $n.Extent.Text.StartsWith('if ((-not $Force') -and $n.Extent.Text.Contains("throw 'folder-busy'") }, $false)
    if (!$guard) { throw 'missing-fallback-note-guard' }
    function Goe-IsForeground { $true }
    function Get-NoteWindow { $script:noteOpen }
    @(foreach ($Force in $false, $true) {
      foreach ($script:noteOpen in $false, $true) {
        $status = 'allowed'
        try { & ([scriptblock]::Create($guard.Extent.Text)) } catch { $status = $_.Exception.Message }
        @{ force = $Force; noteOpen = $script:noteOpen; status = $status }
      }
    }) | ConvertTo-Json -Compress
  `;
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    encoding: 'utf8', timeout: 20_000, env: { ...process.env, GOE_SEEK_SOURCE: path.resolve(__dirname, '../../collector/goe/collect-goe.ps1') }
  });
  for (const row of JSON.parse(output)) assert.equal(row.status, row.force && !row.noteOpen ? 'allowed' : 'folder-busy');
});
