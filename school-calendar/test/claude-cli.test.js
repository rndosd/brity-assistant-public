'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { MODEL, resolveClaude, claudeArgs, claudeEnv, readClaudeResult, refineClaude } = require('../claude-cli');
const { classifierSample } = require('../ai-provider');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-cli-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function touch(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
  return file;
}

test('Claude Code 찾기: PATH → ~\\.local\\bin → 데스크톱 앱 안(가장 새 판) 순서', t => {
  const root = tempDir(t);
  const env = { PATH: path.join(root, 'empty'), USERPROFILE: path.join(root, 'home'), LOCALAPPDATA: path.join(root, 'local'), APPDATA: path.join(root, 'roaming') };
  assert.throws(() => resolveClaude(null, env), /찾지 못했습니다/);
  touch(path.join(env.LOCALAPPDATA, 'Claude-Data', 'anthropicpbc.claude_x', 'claude-code', '2.1.9', 'aaa', 'claude.exe'));
  const newer = touch(path.join(env.LOCALAPPDATA, 'Claude-Data', 'anthropicpbc.claude_x', 'claude-code', '2.1.321', 'bbb', 'claude.exe'));
  assert.equal(resolveClaude(null, env), newer);
  const native = touch(path.join(env.USERPROFILE, '.local', 'bin', 'claude.exe'));
  assert.equal(resolveClaude(null, env), native);
  const onPath = touch(path.join(root, 'bin', 'claude.exe'));
  assert.equal(resolveClaude(null, { ...env, PATH: [path.join(root, 'empty'), path.join(root, 'bin')].join(path.delimiter) }), onPath);
  assert.equal(resolveClaude(onPath, env), onPath);
  assert.throws(() => resolveClaude('claude.exe', env), /claudeExecutable/);
});

test('Claude Code 호출: Haiku·도구 끔·JSON 형식, 개인 지침(CLAUDE.md)은 넣지 않음', () => {
  const args = claudeArgs('{"type":"object"}');
  assert.equal(MODEL, 'claude-haiku-5-5');
  assert.deepEqual(args.slice(0, 7), ['-p', '--model', 'claude-haiku-5-5', '--output-format', 'json', '--json-schema', '{"type":"object"}']);
  assert.equal(args[args.indexOf('--tools') + 1], '');
  for (const flag of ['--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence', '--system-prompt']) assert.ok(args.includes(flag), flag);
  assert.ok(!args.includes('--bare'), 'bare 모드는 구독 로그인을 읽지 않는다');
  const env = claudeEnv({ PATH: 'x' });
  assert.equal(env.CLAUDE_CODE_DISABLE_CLAUDE_MDS, '1');
  assert.equal(env.PATH, 'x');
});

test('Claude Code 결과 읽기: structured_output, 로그인 안 됨, 한도, 실패', () => {
  const ok = { code: 0, output: JSON.stringify({ type: 'result', is_error: false, structured_output: { type: '할 일', title: '협의록 제출' } }), errors: '' };
  assert.deepEqual(readClaudeResult(ok), { type: '할 일', title: '협의록 제출' });
  assert.throws(() => readClaudeResult({ code: 1, output: JSON.stringify({ is_error: true, result: 'Not logged in · Please run /login' }), errors: '' }), /로그인/);
  assert.throws(() => readClaudeResult({ code: 1, output: JSON.stringify({ is_error: true, result: 'Claude usage limit reached' }), errors: '' }), /사용 한도/);
  assert.throws(() => readClaudeResult({ code: 0, output: JSON.stringify({ is_error: false, result: '답' }), errors: '' }), /정리를 받지 못했습니다/);
  assert.throws(() => readClaudeResult({ code: 1, output: 'not json', errors: '' }), /정리를 받지 못했습니다/);
});

test('Claude Code로 분류: 지침과 쪽지를 표준 입력으로 보내고 결과를 그대로 돌려준다', async t => {
  const root = tempDir(t);
  const exe = touch(path.join(root, 'bin', 'claude.exe'));
  const rulesPath = path.join(root, 'rules.md');
  fs.writeFileSync(rulesPath, '시험 지침');
  let call;
  const answer = { type: '할 일', title: '협의록 제출', summary: '', dates: [{ date: '2030-05-10', label: '협의록', kind: '까지' }], uncertain: false };
  const result = await refineClaude(classifierSample, {
    rulesPath, claudeExecutable: exe, env: { PATH: '' },
    run: async (file, args, options) => { call = { file, args, options }; return { code: 0, output: JSON.stringify({ is_error: false, structured_output: answer }), errors: '' }; }
  });
  assert.deepEqual(result, answer);
  assert.equal(call.file, exe);
  assert.ok(call.options.input.startsWith('시험 지침'));
  assert.ok(call.options.input.includes('"recipientRole"'));
  assert.equal(call.options.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS, '1');
  const schema = JSON.parse(call.args[call.args.indexOf('--json-schema') + 1]);
  assert.deepEqual(schema.properties.type.enum, ['할 일', '알아 둘 것', '없음']);
});

const { EventEmitter } = require('node:events');
const { installClaude, openClaudeLogin } = require('../claude-cli');

function fakeChild(code, output = '') {
  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {}; child.unref = () => {};
  setImmediate(() => { if (output) child.stderr.emit('data', output); child.emit('exit', code); child.emit('close', code); });
  return child;
}

test('Claude Code 설치: 공식 명령을 숨은 PowerShell로 돌리고, ~\.local\bin에 생긴 claude.exe를 돌려준다', async t => {
  const root = tempDir(t);
  const env = { SystemRoot: 'C:\Windows', USERPROFILE: path.join(root, 'home'), PATH: '' };
  let call;
  const result = await installClaude({ env, run: (file, args, options) => {
    call = { file, args, options };
    touch(path.join(env.USERPROFILE, '.local', 'bin', 'claude.exe'));
    return fakeChild(0);
  } });
  assert.ok(call.file.toLowerCase().endsWith('powershell.exe'));
  assert.ok(call.args.at(-1).includes('irm https://claude.ai/install.ps1 | iex'));
  assert.equal(call.options.windowsHide, true);
  assert.equal(result.executable, path.join(env.USERPROFILE, '.local', 'bin', 'claude.exe'));
  await assert.rejects(installClaude({ env: { ...env, USERPROFILE: path.join(root, 'none') }, run: () => fakeChild(1, 'The remote server returned an error: (403) Forbidden.') }), /학교망이나 보안 프로그램/);
  await assert.rejects(installClaude({ env: { ...env, USERPROFILE: path.join(root, 'none') }, run: () => fakeChild(1) }), /종료 코드 1/);
});

test('Claude 로그인 창: 창이 닫히면 돌아온다', async t => {
  const root = tempDir(t);
  const exe = touch(path.join(root, 'claude.exe'));
  let options;
  const result = await openClaudeLogin(exe, { PATH: '' }, { run: (file, args, opts) => { options = opts; return fakeChild(0); } });
  assert.deepEqual(result, { executable: exe, closed: true });
  assert.equal(options.windowsHide, false);
  assert.equal(options.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS, '1');
});

test('시험 스위치: 데스크톱 앱 안의 claude.exe를 못 본 척한다', t => {
  const root = tempDir(t);
  const env = { PATH: '', USERPROFILE: path.join(root, 'home'), LOCALAPPDATA: path.join(root, 'local') };
  touch(path.join(env.LOCALAPPDATA, 'Claude-Data', 'x', 'claude-code', '2.1.1', 'h', 'claude.exe'));
  assert.ok(resolveClaude(null, env));
  assert.throws(() => resolveClaude(null, { ...env, SCHOOL_CALENDAR_CLAUDE_NO_BUNDLED: '1' }), /찾지 못했습니다/);
});
