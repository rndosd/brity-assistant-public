'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const codexCli = require('../codex-cli');

function fakeChild(code, event = 'close') {
  const child = new EventEmitter();
  child.kill = () => {};
  child.unref = () => {};
  setImmediate(() => child.emit(event, code));
  return child;
}

test('Codex 로그인 상태는 codex login status의 종료 코드로 본다', async () => {
  const calls = [];
  const run = code => (file, args, options) => { calls.push({ file, args, options }); return fakeChild(code); };
  assert.equal(await codexCli.loginStatus('C:\\가상\\codex.exe', { run: run(0) }), true);
  assert.equal(await codexCli.loginStatus('C:\\가상\\codex.exe', { run: run(1) }), false);
  assert.deepEqual(calls[0].args, ['login', 'status']);
  assert.equal(calls[0].options.windowsHide, true);
});

test('켜지지 않는 Codex(권한 오류)는 쓸 수 없는 것으로 본다', async () => {
  const throwing = () => { const error = new Error('spawn EPERM'); error.code = 'EPERM'; throw error; };
  assert.equal(await codexCli.loginState('C:\\Program Files\\WindowsApps\\가상\\codex.exe', { run: throwing }), 'unusable');
  const failing = () => { const child = new EventEmitter(); child.kill = () => {}; setImmediate(() => child.emit('error', new Error('EPERM'))); return child; };
  assert.equal(await codexCli.loginState('C:\\가상\\codex.exe', { run: failing }), 'unusable');
});

test('설정 파일을 못 읽는 옛 Codex는 로그인 안 됨이 아니라 쓸 수 없는 것으로 본다', async () => {
  const printing = (code, text) => () => {
    const child = new EventEmitter();
    child.kill = () => {};
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => { child.stderr.emit('data', text); child.emit('close', code); });
    return child;
  };
  const configError = 'Error loading configuration: C:\\가상\\.codex\\config.toml:7:16: unknown variant `priority`, expected `fast` or `flex`';
  assert.equal(await codexCli.loginState('C:\\가상\\codex.cmd', { run: printing(1, configError) }), 'unusable');
  assert.equal(await codexCli.loginState('C:\\가상\\codex.exe', { run: printing(1, 'Not logged in') }), 'out');
});

test('npm으로 깐 codex.cmd는 cmd.exe로 감싸 부른다', () => {
  const direct = codexCli.codexCommand('C:\\가상\\codex.exe', ['login']);
  assert.equal(direct.file, 'C:\\가상\\codex.exe');
  assert.deepEqual(direct.args, ['login']);
  const shim = codexCli.codexCommand('C:\\가상 폴더\\codex.cmd', ['login', 'status']);
  assert.equal(path.basename(shim.file).toLowerCase(), 'cmd.exe');
  assert.equal(shim.verbatim, true);
  assert.equal(shim.args.at(-1), '""C:\\가상 폴더\\codex.cmd" login status"');
});

test('로그인 창은 보이는 새 창으로 열고, 창이 닫히면 돌아온다', async () => {
  let seen;
  const result = await codexCli.openCodexLogin('C:\\가상\\codex.exe', { run: (file, args, options) => { seen = { args, options }; return fakeChild(0, 'exit'); } });
  assert.deepEqual(result, { closed: true });
  assert.deepEqual(seen.args, ['login']);
  assert.equal(seen.options.windowsHide, false);
  assert.equal(seen.options.detached, true);
});

test('공식 설치 명령을 묻는 창 없이 돌리고, 설치 자리에 codex.exe가 없으면 실패로 알린다', async () => {
  let seen;
  const env = { LOCALAPPDATA: path.join(__dirname, '없는-폴더'), SystemRoot: 'C:\\Windows' };
  await assert.rejects(codexCli.installCodex({ env, run: (file, args, options) => { seen = { file, args, options }; return fakeChild(1); } }), /Codex 설치를 마치지 못했습니다/);
  assert.match(seen.args.at(-1), /irm https:\/\/chatgpt\.com\/codex\/install\.ps1 \| iex/);
  assert.equal(seen.options.env.CODEX_NON_INTERACTIVE, '1');
  assert.equal(seen.options.windowsHide, true);
});
