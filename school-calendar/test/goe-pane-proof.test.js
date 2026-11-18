'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { test } = require('node:test');

test('GOE 수신함은 발신함을 거쳐 같은 목록과 스크롤로 돌아올 때만 확정한다', { skip: process.platform !== 'win32' }, () => {
  const script = `
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    . $env:GOE_PROOF_HELPER
    function Wait-GoeNotePane { param($Main, $Previous, [switch]$RequireChange) $script:samples.Dequeue() }
    $a = @{ List = [IntPtr]10; Scroll = [IntPtr]11; Parent = [IntPtr]12 }
    $b = @{ List = [IntPtr]20; Scroll = [IntPtr]21; Parent = [IntPtr]22 }
    $new = @{ List = [IntPtr]30; Scroll = [IntPtr]31; Parent = [IntPtr]32 }
    $mixed = @{ List = $a.List; Scroll = $b.Scroll; Parent = $b.Parent }
    function Replay($first,$sent,$returned,[bool]$allowTrial) {
        $script:samples = [Collections.Queue]::new()
        foreach ($sample in $first,$sent,$returned) { $script:samples.Enqueue($sample) }
        $actions = [Collections.Generic.List[string]]::new()
        $proof = Get-GoeInboxPaneProof ([IntPtr]1) { $actions.Add('sent') } { $actions.Add('inbox') } { $allowTrial }
        [pscustomobject]@{ state=$proof.State; actions=($actions -join ','); acceptsFirst=(Test-GoeSamePane $proof.Pane $first); acceptsSent=(Test-GoeSamePane $proof.Pane $sent) }
    }
    @(
      Replay $a $b $a $true
      Replay $a $a $a $true
      Replay $a $b $new $true
      Replay $a $mixed $a $true
      Replay $a $null $a $true
      Replay $a $b $a $false
    ) | ConvertTo-Json -Compress
  `;
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, GOE_PROOF_HELPER: path.resolve(__dirname, '../../collector/goe/goe-folder-state.ps1') }
  });
  const replay = JSON.parse(output);
  assert.deepEqual(replay.map(r => r.state), ['inbox', 'shared', 'ambiguous', 'ambiguous', 'ambiguous', 'busy']);
  assert.equal(replay[0].acceptsFirst, true);
  assert.equal(replay[0].acceptsSent, false);
  assert.deepEqual(replay.map(r => r.actions), ['sent,inbox', 'sent,inbox', 'sent,inbox', 'sent,inbox', 'sent,inbox', '']);
});
