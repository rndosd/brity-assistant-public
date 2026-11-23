'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

test('Brity finds notes above and below the cursor without a full-list round trip', { skip: process.platform !== 'win32' }, () => {
  const script = `
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    $tokens = $null; $errors = $null
    $ast = [Management.Automation.Language.Parser]::ParseFile($env:BRITY_SEEK_SOURCE, [ref]$tokens, [ref]$errors)
    if ($errors.Count) { throw ($errors | Out-String) }
    foreach ($name in 'Norm','Get-NoteDateRange','Find-NoteRow') {
      $definition = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
      if (-not $definition) { throw ('Missing function: ' + $name) }
      Invoke-Expression $definition.Extent.Text
    }
    . (Join-Path (Split-Path $env:BRITY_SEEK_SOURCE) 'list-date.ps1')
    function Get-NoteRows { $script:pages[$script:page] }
    function Get-VisibleNoteRow($win, $id) {
      @(Get-NoteRows $win) | Where-Object { $_.Current.AutomationId -eq $id } | Select-Object -First 1
    }
    function Move-NoteList($win, [switch]$Up) {
      $script:moves.Add($(if ($Up) { 'U' } else { 'D' }))
      $next = $script:page + $(if ($Up) { -1 } else { 1 })
      if ($next -lt 0 -or $next -ge $script:pages.Count) { return $false }
      $script:page = $next
      return $true
    }
    function Reset-NoteList { $script:moves.Add('R'); $script:page = 0 }
    function Replay($name, $start, $target, $datetime, $mode = '') {
      $script:pages = @()
      for ($p = 0; $p -lt 4; $p++) {
        $day = 23 - 2 * $p
        $first = 'Title, Sender, 2026-11-' + $day
        $second = $first
        if ($mode -eq 'unknown') { $first = 'Title, Sender, unknown'; $second = $first }
        if ($mode -eq 'nonmonotonic' -and $p -eq $start) { $second = 'Title, Sender, 2026-11-24' }
        if ($mode -eq 'later-unknown' -and $p -eq 1) { $first = 'unknown'; $second = $first }
        if ($mode -eq 'same-day') { $first = 'Title, Sender, 2026-11-20'; $second = $first }
        if ($mode -eq 'boundary-day' -and $p -eq $start) { $first = 'Title, Sender, 2026-11-23' }
        $script:pages += ,@(
          [pscustomobject]@{ Current = [pscustomobject]@{ AutomationId = ('n' + $p); Name = $first } },
          [pscustomobject]@{ Current = [pscustomobject]@{ AutomationId = ('extra' + $p); Name = $second } }
        )
      }
      $script:page = $start
      $script:moves = [Collections.Generic.List[string]]::new()
      $found = Find-NoteRow 1 $target $datetime
      [pscustomobject]@{ name = $name; found = $found.Current.AutomationId; moves = ($script:moves -join ''); page = $script:page }
    }
    @(
      Replay 'newer' 2 'n0' '2026-11-23 09:00'
      Replay 'older' 0 'n3' '2026-11-17 09:00'
      Replay 'unknown' 1 'n0' '2026-11-23 09:00' 'unknown'
      Replay 'nonmonotonic' 1 'n0' '2026-11-23 09:00' 'nonmonotonic'
      Replay 'later-unknown' 2 'n0' '2026-11-23 09:00' 'later-unknown'
      Replay 'missing' 2 'absent' '2026-11-25 09:00'
      Replay 'legacy' 1 'n0' ''
      Replay 'visible' 2 'n2' '2026-11-19 09:00'
      Replay 'same-day' 1 'n0' '2026-11-20 09:00' 'same-day'
      Replay 'boundary-day' 1 'n0' '2026-11-23 09:00' 'boundary-day'
      Replay 'boundary-missing' 1 'absent' '2026-11-23 09:00' 'boundary-day'
    ) | ConvertTo-Json -Compress
  `;
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, BRITY_SEEK_SOURCE: path.resolve(__dirname, '../../collector/collect-notes.ps1') }
  });
  const results = Object.fromEntries(JSON.parse(output).map(result => [result.name, result]));
  assert.equal(results.newer.found, 'n0');
  assert.equal(results.newer.moves, 'UU', 'a newer note must not be sought below the cursor first');
  assert.equal(results.older.found, 'n3');
  assert.equal(results.older.moves, 'DDD', 'an older note should be reached directly below the cursor');
  assert.equal(results['boundary-day'].found, 'n0');
  assert.equal(results['boundary-day'].moves, 'U', 'a missing newest-day note belongs above a page that also contains older days');
  assert.equal(results['boundary-missing'].found, null);
  assert.ok(results['boundary-missing'].moves.length < 20, 'a missing boundary-day note must still terminate after a complete fallback');
  for (const name of ['unknown', 'nonmonotonic', 'legacy', 'same-day']) {
    assert.equal(results[name].found, 'n0', `${name}: fallback must still find the note`);
    assert.match(results[name].moves, /R/, `${name}: uncertain dates must allow a complete rescan`);
  }
  assert.equal(results['later-unknown'].found, 'n0', 'an unreadable intermediate date must not prevent an ID match');
  assert.equal(results.nonmonotonic.moves[0], 'D', 'unordered dates must not choose an upward shortcut');
  assert.equal(results.legacy.moves[0], 'D', 'existing import callers retain the undated search');
  assert.equal(results.missing.found, null);
  assert.ok(results.missing.moves.length < 20, 'a missing note must terminate at list boundaries');
  assert.equal(results.visible.found, 'n2');
  assert.equal(results.visible.moves, '', 'an already visible note must not scroll');
});

test('Brity ShowNote loads its date parser before opening the requested note', { skip: process.platform !== 'win32' }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brity-show-note-date-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.resolve(__dirname, '../../collector');
  for (const name of ['labels.json', 'list-date.ps1']) fs.copyFileSync(path.join(source, name), path.join(root, name));
  const program = fs.readFileSync(path.join(source, 'collect-notes.ps1'), 'utf8');
  const fake = `
    function Get-NoteRows {
      [pscustomobject]@{ Current = [pscustomobject]@{ Name = 'Title, Sender, 2026-11-23' } }
    }
    function Show-OriginalNote($note, [switch]$Reply) {
      $range = Get-NoteDateRange 1
      if ($range.newest -ne '2026-11-23') { throw 'date-helper-not-loaded' }
      Write-Output ($range.newest + '|' + $note.datetime)
    }
  `;
  const entry = path.join(root, 'collect-notes.ps1');
  fs.writeFileSync(entry, program.replace('# ---- main ----', fake + '\n# ---- main ----'));
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', entry, '-ShowNote'], {
    input: JSON.stringify({ id: 'fake-note', datetime: '2026-11-23 09:00' }),
    encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, LOCALAPPDATA: root }
  });
  assert.equal(output.trim(), '2026-11-23|2026-11-23 09:00');
});
