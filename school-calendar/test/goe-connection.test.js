'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { randomUUID } = require('node:crypto');

test('GOE 연결은 수신함 확인 실패, 빈 수신함, 창을 찾지 못한 경우를 구분한다', { skip: process.platform !== 'win32' }, async t => {
  const scriptsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'goe-connection-test-'));
  t.after(() => fs.rm(scriptsDir, { recursive: true, force: true }));
  // 같은 PC에서 메신저 수집이 진행 중이어도 서로 기다리지 않도록 시험용 잠금을 쓴다.
  const bridge = await fs.readFile(path.join(__dirname, '..', 'collector-link-goe.ps1'), 'utf8');
  await fs.writeFile(path.join(scriptsDir, 'collector-link-goe.ps1'), bridge.replace('Local\\GoeAssistantCollector', `Local\\GoeTest-${randomUUID()}`));
  await fs.copyFile(path.join(__dirname, '..', 'collector-link.js'), path.join(scriptsDir, 'collector-link.js'));
  const { collectOnce } = require(path.join(scriptsDir, 'collector-link.js'));
  await fs.writeFile(path.join(scriptsDir, 'labels.json'), '{}');
  const cases = [
    ['ok', '', 'ready', true, 0],
    ['error', 'inbox-not-confirmed', 'list-unreadable', true, 0],
    ['error', 'inbox-lost-while-paging', 'list-unreadable', true, 2],
    ['error', 'list-unreadable', 'list-unreadable', true, 0],
    ['error', 'no-korean-ocr', 'unverified', false, 0],
    ['list-unreadable', 'no-korean-ocr', 'list-unreadable', true, 0],
    ['error', 'collection-failed:123', 'unverified', false, 0],
    ['offline', 'main-window-not-found', 'offline', false, 0]
  ];
  for (const [status, reason, expected, managed, imported] of cases) {
    const collector = `param($Inbox, [switch]$ResultObject, [switch]$Download, [switch]$Force, $SinceDays)
      [pscustomobject]@{status='${status}'; reason='${reason}'; imported=${imported}}`;
    await fs.writeFile(path.join(scriptsDir, 'collect-goe.ps1'), collector);
    const result = await collectOnce({ goe: true, scriptsDir });
    assert.equal(result.status, expected, reason);
    assert.equal(result.managed, managed, reason);
    assert.equal(result.inboxDir, managed ? path.join(scriptsDir, 'inbox') : null, reason);
    assert.equal(result.imported, imported, reason);
    assert.equal(result.goeReason, reason || undefined);
  }
});

test('GOE 원문 보기는 선택한 쪽지 ID만 넘기고 원문 창의 결과를 돌려준다', { skip: process.platform !== 'win32' }, async t => {
  const scriptsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'goe-original-test-'));
  t.after(() => fs.rm(scriptsDir, { recursive: true, force: true }));
  const bridge = await fs.readFile(path.join(__dirname, '..', 'collector-link-goe.ps1'), 'utf8');
  await fs.writeFile(path.join(scriptsDir, 'collector-link-goe.ps1'), bridge.replace('Local\\GoeAssistantCollector', `Local\\GoeTest-${randomUUID()}`));
  await fs.copyFile(path.join(__dirname, '..', 'collector-link.js'), path.join(scriptsDir, 'collector-link.js'));
  await fs.writeFile(path.join(scriptsDir, 'labels.json'), '{}');
  const { openGoeOriginal } = require(path.join(scriptsDir, 'collector-link.js'));
  const noteId = 'goe_202601021200_01234567';
  const options = { goe: true, scriptsDir };
  for (const original of ['opened', 'opened-background', 'not-found']) {
    const collector = `[CmdletBinding()]param($Inbox, [switch]$ResultObject, [switch]$ShowOriginal, $RetryId)
      if (!$ShowOriginal -or $RetryId -cne '${noteId}') { throw 'wrong action or note' }
      [pscustomobject]@{status='ok'; original='${original}'}`;
    await fs.writeFile(path.join(scriptsDir, 'collect-goe.ps1'), collector);
    const result = await openGoeOriginal(noteId, options);
    assert.equal(result.status, 'ready');
    assert.equal(result.original, original);
  }
  assert.equal((await openGoeOriginal('invalid', options)).status, 'unavailable');
});
