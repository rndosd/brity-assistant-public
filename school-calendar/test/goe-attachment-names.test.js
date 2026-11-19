'use strict';

// GOE 첨부 이름은 쪽지 창 OCR이라 틀린다. 이미 받은 첨부를 다시 받을 때(GOE가 같은 이름 파일을 건너뜀)
// 이 이름으로 폴더의 기존 파일을 골라야 한다(2026-11-18 실제 쪽지 두 건에서 실패하던 경우).
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const collector = path.join(__dirname, '..', '..', 'collector', 'goe');

test('GOE attachment names: clipped label with size junk, and a short name with a misread letter', { skip: process.platform !== 'win32' }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'goe-names-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const folder = path.join(root, 'goe');
  await fs.mkdir(folder);
  const files = ['폰오프라스온 캠페인 홍보지.png', '(서룡초등학교-15330 (본문) 경기도용인교육지원청 생활교육과) 2026년 용감 폰프리 스쿨 중간 공유회(2차) 운영 계획.odt', '다른 홍보지.png',
    '(서룡초등학교-15217 (본문) 경기도용인교육지원청 초등교육지원과) 2026년 학교교육국 교육감 표창 계획 안내 및 대상자 추천 요청.odt',
    '(서룡초등학교-15217 (첨부) 경기도용인교육지원청 초등교육지원과) [붙임1] 2026년 학교교육국 교육감 표창 통합 운영 목록(용인).xlsx'];
  for (const name of files) await fs.writeFile(path.join(folder, name), name);
  // GOE's per-note folders: the same common name in two of them, told apart by the note's send time
  for (const sub of ['trebleclef_202611180857150009', 'other_202611091433460009']) {
    await fs.mkdir(path.join(folder, sub));
    await fs.writeFile(path.join(folder, sub, '(그림1).png'), sub);
  }
  const harness = path.join(root, 'harness.ps1');
  await fs.writeFile(harness, `
param([string]$Collector, [string]$Folder)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)   # the test reads stdout as UTF-8 (the console default is CP949)
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $Collector 'collect-goe.ps1'), [ref]$tokens, [ref]$errors)
$wanted = 'Read-AttachmentNames','Read-AttachmentNamesRaw','Read-AttachmentSizes','Repair-OcrName','Find-ClosestAttachment','Get-OcrDistance','Test-NoteFolder','Find-NoteFolderFiles','Select-Attachments','Test-AttachmentPrefix','Test-SimilarName','Get-EditDistance','Test-FromInternet','Download-State'
foreach ($f in $ast.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -in $wanted }, $true)) {
    . ([scriptblock]::Create($f.Extent.Text))
}
$header = [pscustomobject]@{ y = 512; x = 11; t = 'header' }
$lines = @(
    [pscustomobject]@{ y = 550; x = 38; t = '(서름초등학교-15330 (본문) 경기도용인교육지원정 성활교육과) 2026년 용감 돈프리 스쿨 중간 공유회(2자) 은영 계... 19 〈크' },
    [pscustomobject]@{ y = 585; x = 38; t = '폰오프라스은 캠페인 홍보지.png' }
)
$names = @(Read-AttachmentNames $lines $header 2 $null)
$state = Download-State $Folder
$picked = @(Select-Attachments $state.Values $names | ForEach-Object Name)
# 2026-11-19 cases: icon read as a letter, size on its own line, "|" in the extension, a long name 17% misread
$icon = @([pscustomobject]@{ y = 554; x = 17; t = '새 (그림l).png' }, [pscustomobject]@{ y = 552; x = 121; t = '96 KB' })
$iconNames = @(Read-AttachmentNames $icon $header 1 $null)
$iconSizes = @(Read-AttachmentSizes $icon $header 1)
$pipe = @(Read-AttachmentNames @([pscustomobject]@{ y = 554; x = 17; t = '네 배드민턴.x|sx' }) $header 1 $null)
$long = @(Select-Attachments $state.Values @('(서루조동학교-15217 (본문) 경기도용인교육지원정 조동교육지원과) 2026년 학교교육국 교육감 표장 계횟 안내 및 대상자 주전...') | ForEach-Object Name)
$noTime = @(Select-Attachments $state.Values @('(그림1).png')).Count
$script:noteTimes = @([datetime]::ParseExact('2026-11-18 08:58', 'yyyy-MM-dd HH:mm', $null))
$byTime = @(Select-Attachments $state.Values @('(그림1).png') | ForEach-Object Key)
$folderOnly = @(Find-NoteFolderFiles $state 1 | ForEach-Object Key)
[pscustomobject]@{ noTime = $noTime; byTime = $byTime; folderOnly = $folderOnly; names = $names; picked = $picked; iconNames = $iconNames; iconSize = $iconSizes[0].size; iconSizeName = $iconSizes[0].name
    pipe = $pipe; long = $long; similar = (Test-SimilarName $iconNames[0] '(그림1).png') } | ConvertTo-Json -Compress
`, 'utf8');
  // Windows PowerShell 5.1 reads a script without BOM as the ANSI code page: write the BOM so Korean survives.
  await fs.writeFile(harness, '﻿' + await fs.readFile(harness, 'utf8'), 'utf8');
  const out = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', harness, '-Collector', collector, '-Folder', folder], { encoding: 'utf8' }).trim());
  assert.equal(out.names.length, 2);
  assert.ok(out.names[0].endsWith('...'), 'clipped label keeps its ellipsis without the size junk');
  assert.deepEqual([...out.picked].sort(), [files[1], files[0]].sort());
  assert.deepEqual(out.iconNames, ['(그림l).png'], 'the icon letter is dropped');
  assert.equal(out.iconSize, 96 * 1024, 'a size on its own line belongs to the name beside it');
  assert.equal(out.iconSizeName, '(그림l).png');
  assert.equal(out.similar, true, 'l and 1 are the same to OCR');
  assert.deepEqual(out.pipe, ['배드민턴.xlsx'], '"|" in a name becomes l instead of breaking the path functions');
  assert.deepEqual(out.long, [files[3]], 'the clearly closest long name wins over its look-alike');
  assert.equal(out.noTime, 0, 'two files of the same common name: no pick without the note time');
  const own = 'trebleclef_202611180857150009\\(그림1).png';
  assert.deepEqual(out.byTime, [own], 'the note time (within a minute) picks GOE\'s folder for that note');
  assert.deepEqual(out.folderOnly, [own], 'with no name at all, the one folder of that time is used');
});
