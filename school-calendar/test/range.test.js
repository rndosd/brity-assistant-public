'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { test } = require('node:test');
const { CalendarStore } = require('../store');

const qaRoot = path.join(__dirname, '..', '.qa');
const listDate = path.join(__dirname, '..', '..', 'collector', 'list-date.ps1');
const goeCollector = path.join(__dirname, '..', '..', 'collector', 'goe', 'collect-goe.ps1');

test('브리티 쪽지 목록의 날짜(월·일, 시각, 연도 포함)를 읽고 연도는 오늘보다 늦지 않게 정한다', { skip: process.platform !== 'win32' }, () => {
  const cases = [
    ['가상 제목, 가상 보낸이, 8월 27일', '2026-08-27'],
    ['가상 제목, 가상 보낸이, 12월 30일', '2025-12-30'],
    ['안 읽음, 가상 제목, 오후 1:54', '2026-11-12'],
    ['가상 제목, 2025년 3월 2일', '2025-03-02'],
    ['가상 제목, 2026.01.05.', '2026-01-05'],
    ['가상 제목, 2월 30일', ''],
    ['가상 제목만', '']
  ];
  const script = `. '${listDate.replace(/'/g, "''")}'; $today = [datetime]'2026-11-12'; ` +
    cases.map(([text]) => `[string](Get-ListDate '${text.replace(/'/g, "''")}' $today)`).join('; ');
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${script}`], { encoding: 'utf8' });
  assert.deepEqual(out.split(/\r?\n/).slice(0, cases.length), cases.map(([, expected]) => expected));
});

test('GOE 저장 폴더(다운로드 등)에서 쪽지에 적힌 첨부만 골라 저장하고 원본과 다른 파일은 그대로 둔다', { skip: process.platform !== 'win32' }, async (t) => {
  await fs.mkdir(qaRoot, { recursive: true });
  const root = await fs.mkdtemp(path.join(await fs.realpath(qaRoot), 'goe-attachment-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    "[Console]::OutputEncoding = [Text.Encoding]::UTF8",
    "$names = 'Get-PhysicalDirectory','Download-State','Test-SameDownloadFile','Test-FromInternet','Test-AttachmentPrefix','Select-Attachments','Get-DownloadBatch','Get-EditDistance','Test-SimilarName','Find-ExistingAttachments','Save-DownloadBatch','Write-Note','Get-SavedAttachmentCount'",
    "$parseErrors = $null",
    "$ast = [Management.Automation.Language.Parser]::ParseFile($env:GOE_COLLECTOR_TEST, [ref]$null, [ref]$parseErrors)",
    "if ($parseErrors) { throw $parseErrors[0].Message }",
    "$native = $ast.Find({param($n) $n -is [Management.Automation.Language.CommandAst] -and $n.GetCommandName() -eq 'Add-Type' -and $n.Extent.Text.Contains('namespace GoeWin')}, $true)",
    ". ([scriptblock]::Create($native.Extent.Text))",
    "foreach ($fn in $ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -in $names}, $true)) { . ([scriptblock]::Create($fn.Extent.Text)) }",
    "function Goe-IsForeground { $false }",
    "$inbox = Join-Path $env:GOE_TEST_ROOT 'inbox'",
    "$notesDir = [IO.Directory]::CreateDirectory((Join-Path $inbox 'notes')).FullName",
    "$directory = [IO.Directory]::CreateDirectory((Join-Path $env:GOE_TEST_ROOT 'Downloads')).FullName",
    "$userFile = Join-Path $directory 'manual.pdf'",
    "[IO.File]::WriteAllText($userFile, 'manual')",
    "$before = Download-State $directory",
    "$download = Join-Path $directory '받은 파일.pdf'",
    "$partial = Join-Path $directory 'unfinished.part'",
    "[IO.File]::WriteAllText($download, 'live attachment')",
    "[IO.File]::WriteAllText($partial, 'partial')",
    "$current = Download-State $directory",
    "$waiting = (Get-DownloadBatch $before $current $current 1 @()).status",
    "[IO.File]::Delete($partial)",
    "$current = Download-State $directory",
    "$unstable = (Get-DownloadBatch $before $current @{} 1 @('받은 파일.pdf')).status",
    "[IO.File]::WriteAllText((Join-Path $directory 'web.zip'), 'browser'); Set-Content -LiteralPath (Join-Path $directory 'web.zip') -Stream Zone.Identifier 'ZoneId=3'",
    "$current = Download-State $directory",
    "$changed = (Get-DownloadBatch $before $current $current 1 @()).status",
    "$files = (Get-DownloadBatch $before $current $current 1 @('받은 파일.pdf')).files",
    "$existingState = @{}; foreach ($k in $current.Keys) { $existingState[$k] = $current[$k] }",
    "$skipped = @(Find-ExistingAttachments $existingState @([pscustomobject]@{ name='받은 파일.pdf'; size=15; tolerance=1025 }) @()).Name",
    "$batch = @{ before=$before; directory=$directory; files=$files }",
    "$id = 'goe_202611121259_aabbcc00'",
    "$note = [pscustomobject]@{ id=$id; source='goe'; body='existing body'; imported='range'; files=@('wrong OCR.pdf'); saved=@(); attachCount=2; attachStatus='failed' }",
    "$notePath = Join-Path $notesDir ($id + '.json')",
    "$retryResult = Save-DownloadBatch $batch $note $notePath $true",
    "$actualFolder = Join-Path (Join-Path $inbox 'files') $id",
    "$rollback = @{ status=$retryResult.status; download=[IO.File]::Exists($download); savedFiles=@(Get-ChildItem -LiteralPath $actualFolder -File).Count }",
    "$existing = Join-Path $actualFolder '받은 파일.pdf'",
    "[IO.File]::WriteAllText($existing, 'earlier attachment')",
    "Write-Note $note $notePath",
    "$saved = Save-DownloadBatch $batch $note $notePath $true",
    "$read = Get-Content -LiteralPath $notePath -Raw -Encoding UTF8 | ConvertFrom-Json",
    "$outcome = @{ status=$saved.status; name=$read.saved[0].name; body=$read.body; imported=$read.imported; attachmentStatus=$read.attachStatus; linked=(Get-SavedAttachmentCount $read); bytes=[IO.File]::ReadAllText($read.saved[0].path); earlier=[IO.File]::ReadAllText($existing); manual=[IO.File]::ReadAllText($userFile); download=[IO.File]::Exists($download); original=($read.saved[0].originalPath -eq $download) }",
    "[pscustomobject]@{ waiting=$waiting; unstable=$unstable; changed=$changed; skipped=$skipped; rollback=$rollback; outcome=$outcome } | ConvertTo-Json -Depth 4 -Compress"
  ].join('\n');
  const command = Buffer.from(script, 'utf16le').toString('base64');
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', command], {
    encoding: 'utf8', env: { ...process.env, GOE_COLLECTOR_TEST: goeCollector, GOE_TEST_ROOT: root }
  });
  assert.deepEqual(JSON.parse(output), {
    waiting: 'waiting', unstable: 'waiting', changed: 'waiting', skipped: '받은 파일.pdf',
    rollback: { status: 'review', download: true, savedFiles: 0 },
    outcome: {
      status: 'saved', name: '받은 파일.pdf', body: 'existing body', imported: 'range', attachmentStatus: 'saved',
      linked: 1, bytes: 'live attachment', earlier: 'earlier attachment', manual: 'manual', download: true, original: true
    }
  });
});

// 2026-11-17 “첨부파일 있는건데” 못 찾음: 같은 이름 파일이 이미 있어 GOE가 하나도 받지 않고, 창에는 8개 중 2개 이름만 잘려 보이며 크기도 없다.
test('GOE가 이미 있는 첨부를 건너뛰면 보이는 이름 하나로 같은 때 함께 받은 파일 묶음을 찾는다', { skip: process.platform !== 'win32' }, async (t) => {
  await fs.mkdir(qaRoot, { recursive: true });
  const root = await fs.mkdtemp(path.join(await fs.realpath(qaRoot), 'goe-existing-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    "[Console]::OutputEncoding = [Text.Encoding]::UTF8",
    "$names = 'Get-PhysicalDirectory','Download-State','Test-FromInternet','Test-AttachmentPrefix','Select-Attachments','Find-ExistingBatch'",
    "$parseErrors = $null",
    "$ast = [Management.Automation.Language.Parser]::ParseFile($env:GOE_COLLECTOR_TEST, [ref]$null, [ref]$parseErrors)",
    "if ($parseErrors) { throw $parseErrors[0].Message }",
    "foreach ($fn in $ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -in $names}, $true)) { . ([scriptblock]::Create($fn.Extent.Text)) }",
    "$dir = [IO.Directory]::CreateDirectory((Join-Path $env:GOE_TEST_ROOT 'Downloads')).FullName",
    "$at = [datetime]'2026-11-16T18:53:49'",
    "function Put($name, $time) { $p = Join-Path $dir $name; [IO.File]::WriteAllText($p, $name); [IO.File]::SetLastWriteTime($p, $time) }",
    "Put '(서룡초등학교-15217 (본문) 경기도용인교육지원청 초등교육지원과) 2026년 교육감 표창 계획 안내 및 대상자 추천 요청.odt' $at",
    "Put '(서룡초등학교-15217 (첨부) 경기도용인교육지원청 초등교육지원과) [붙임1] 목록.xlsx' $at.AddSeconds(1)",
    "Put '(서룡초등학교-15217 (첨부) 경기도용인교육지원청 초등교육지원과) [붙임2] 계획.hwpx' $at.AddSeconds(1)",
    "Put 'old.pdf' $at.AddDays(-1)",
    // OCR가 몇 글자 틀리고(름·정·장·주) 점 두 개로 잘린 이름
    "$label = '(서름초등학교-15217 (본문) 경기도용인교육지원정 초등교육지원과) 2026년 교육감 표장 계획 안내 및 대상자 주전...'",
    "$three = @(Find-ExistingBatch (Download-State $dir) 3 @($label)).Name",
    "$four = @(Find-ExistingBatch (Download-State $dir) 4 @($label)).Count",
    "Put 'photo.png' $at.AddSeconds(2)",
    "$mixed = @(Find-ExistingBatch (Download-State $dir) 3 @($label)).Count",
    "$none = @(Find-ExistingBatch (Download-State $dir) 3 @('전혀 다른 이름의 첨부 파일 제목입니다...')).Count",
    "[pscustomobject]@{ three=$three.Count; first=$three[0]; four=$four; mixed=$mixed; none=$none } | ConvertTo-Json -Compress"
  ].join('\n');
  const command = Buffer.from(script, 'utf16le').toString('base64');
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', command], {
    encoding: 'utf8', env: { ...process.env, GOE_COLLECTOR_TEST: goeCollector, GOE_TEST_ROOT: root }
  });
  assert.deepEqual(JSON.parse(output), {
    three: 3, first: '(서룡초등학교-15217 (본문) 경기도용인교육지원청 초등교육지원과) 2026년 교육감 표창 계획 안내 및 대상자 추천 요청.odt',
    four: 0, mixed: 3, none: 0
  });
});

test('기간으로 불러온 쪽지는 첨부를 복사하지 않고 묻기 전에는 분류하지 않으며, 분류 뒤 지난 까지는 끝낸 것으로 둔다', async (t) => {
  await fs.mkdir(qaRoot, { recursive: true });
  const root = await fs.mkdtemp(path.join(await fs.realpath(qaRoot), 'range-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const inboxDir = path.join(root, 'inbox');
  const dataDir = path.join(root, 'data');
  const downloadsDir = path.join(root, 'Downloads');
  const ruleSeed = path.join(root, 'rules.md');
  await fs.mkdir(path.join(inboxDir, 'notes'), { recursive: true });
  await fs.mkdir(downloadsDir, { recursive: true });
  await fs.writeFile(ruleSeed, '# 기준\n');
  const store = new CalendarStore({ dataDir, inboxDir, ruleSeed, downloadsDir });
  await store.init();
  await store.saveAiConnection('factchat', 'ENCRYPTED');
  await store.refresh();
  const id = '0_202608270000000001_0';
  const source = path.join(inboxDir, 'files', id, '지난 안내.pdf');
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.writeFile(source, '첨부');
  await fs.writeFile(path.join(inboxDir, 'notes', `${id}.json`), JSON.stringify({
    id, title: '지난 쪽지', sender: '가상', datetime: '2026-08-27 09:00', verified: true, body: '9월 5일까지 제출, 12월 1일 협의회',
    saved: [{ name: '지난 안내.pdf', path: source }], imported: 'range'
  }));
  const later = new Date(Date.now() + 2000);
  await fs.utimes(path.join(inboxDir, 'notes', `${id}.json`), later, later);
  await store.refresh();
  const [task] = store.tasks;
  assert.ok(task.rangeImported?.day);
  assert.equal(task.autoPending, false);
  assert.equal(store.nextAutomatic(), null);
  assert.deepEqual(await fs.readdir(downloadsDir), []);
  assert.equal(store.snapshot().rangePending, 1);

  assert.equal(await store.queueRangeClassify(), 1);
  assert.equal(store.nextAutomatic(), task.id);
  task.rangeImported.day = '2026-11-12';
  const { task: done } = await store.refine(task.id, async () => ({
    type: '할 일', title: '지난 제출', summary: '', uncertain: false,
    dates: [{ date: '2026-09-05', label: '제출', kind: '까지' }, { date: '2026-12-01', label: '협의회', kind: '그날' }, { date: '2026-12-10', label: '보고', kind: '까지' }]
  }), { automatic: true });
  assert.deepEqual(done.dates.map(entry => [entry.date, entry.done]), [['2026-09-05', true], ['2026-12-01', undefined], ['2026-12-10', false]]);
  assert.equal(store.snapshot().rangePending, 0);
});
