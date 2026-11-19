'use strict';

// 브리티를 못 읽은 까닭이 수집기 → 연결 코드로 그대로 넘어와야 앱이 맞는 안내를 띄운다(2026-11-18).
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

async function collector(t, fakeScreen) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'brity-reason-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(__dirname, '..', '..', 'collector');
  for (const name of ['labels.json', 'list-date.ps1']) await fs.copyFile(path.join(source, name), path.join(root, name));
  const program = await fs.readFile(path.join(source, 'collect-notes.ps1'), 'utf8');
  const marker = '# ---- main ----';
  assert.ok(program.includes(marker));
  const entry = path.join(root, 'collect-notes.ps1');
  await fs.writeFile(entry, program.replace(marker, () => fakeScreen + '\n' + marker));
  return args => {
    try {
      return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', entry,
        '-Inbox', path.join(root, 'inbox'), ...args], { encoding: 'utf8', env: { ...process.env, LOCALAPPDATA: root } });
    } catch (error) { return String(error.stdout); }
  };
}

const quiet = `
    function Start-Sleep {}
    function Reset-NoteList {}
    function Get-BrityWindows {}
    function Get-Foreground { [IntPtr]::Zero }
    function Start-Keeper {}
    function Arm-Keeper {}
    function Stop-Keeper {}
    function Restore-Foreground {}
`;

test('the collector names why it could not read Brity', { skip: process.platform !== 'win32' }, async t => {
  const noWindow = await collector(t, quiet + 'function Get-AppWindow { $null }');
  assert.match(noWindow([]), /reason=window-not-found/);
  const noMenu = await collector(t, quiet + 'function Get-AppWindow { 1 }\nfunction Find-ByName { $null }');
  assert.match(noMenu([]), /reason=note-menu-not-found/);
});

test('a classic view that opens nothing asks for One view', { skip: process.platform !== 'win32' }, async t => {
  const run = await collector(t, quiet + `
    function Get-AppWindow { 1 }
    function Find-ByName { 1 }
    function Get-NoteItems {
      foreach ($n in 1..3) { [pscustomobject]@{ id=('0_20261118000000003' + $n + '_0'); text=('Title ' + $n + ', Sender, 2026-11-18'); unread=$true; hasFile=$false } }
    }
    function Find-NoteRow { 1 }
    function Get-VisibleNoteRow { 1 }
    function Open-NoteRow { $true }
    function Open-NoteWindow { $true }
    function Find-AlternativeDetail {}
    function Read-Detail {}
  `);
  assert.match(run(['-Open']), /reason=classic-unreadable[\s\S]*view=classic[\s\S]*opened=3 verified=0/);
});

// 2026-11-19: 클래식 뷰는 다른 PC에서 0.5.12로도 실패했다. 읽기에 성공해도 view=classic을 알려 앱이 원 뷰를 권한다.
function readable(where) {
  const detail = `[pscustomobject]@{ title='Title 1'; sender='Sender'; org=''; datetime='2026-11-18 09:00'; recipients=''; body='Body'; files=@(); group=$null${where === 'window' ? '; detailWindow=42' : ''} }`;
  return quiet + `
    function Get-AppWindow { 1 }
    function Find-ByName { 1 }
    function Get-NoteItems { [pscustomobject]@{ id='0_202611180000000031_0'; text='Title 1, Sender, 2026-11-18'; unread=$true; hasFile=$false } }
    function Find-NoteRow { 1 }
    function Get-VisibleNoteRow { 1 }
    function Open-NoteRow { $true }
    function Open-NoteWindow { $script:windowOpened = $true; $true }
    function Get-NewNoteWindows { @() }
    function Close-NewNoteWindows {}
    function Test-Match($d) { [bool]$d }
    function Get-HeadSig($d) { if ($d) { 'head' } else { '' } }
    function Get-RestSig($d) { if ($d) { 'rest' } else { '' } }
    function Read-Detail { ${where === 'window' ? '$null' : `if ($script:rowOpened) { ${detail} }`} }
    function Find-AlternativeDetail { ${where === 'window' ? `if ($script:windowOpened) { ${detail} }` : '$null'} }
  ` + (where === 'window' ? '' : `
    function Open-NoteRow { $script:rowOpened = $true; $true }`);
}

test('the collector says which Brity view the notes were read in', { skip: process.platform !== 'win32' }, async t => {
  const classic = await collector(t, readable('window'));
  const classicOut = classic(['-Open']);
  assert.match(classicOut, /^view=classic\s*$/m);
  assert.match(classicOut, /verified=1/);
  assert.doesNotMatch(classicOut, /reason=/);
  const one = await collector(t, readable('main'));
  const oneOut = one(['-Open']);
  assert.match(oneOut, /^view=one\s*$/m);
  assert.match(oneOut, /verified=1/);
});
