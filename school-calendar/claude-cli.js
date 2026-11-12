'use strict';

// Claude Code CLI(claude -p)로 쪽지를 분류한다. Claude 구독(Pro 이상)의 CLI 로그인을 쓴다.
// 2026-11-12 사용자: "클로드는 haiku로 연결하도록 해야지 분류는 일단 나중에 신경쓰고".
// --bare는 구독 로그인을 읽지 않으므로(API 키 전용) 쓰지 않고, 도구·MCP·슬래시 명령·CLAUDE.md를 하나씩 끈다.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { CalendarError, aiStopError } = require('./store');
const { buildClassifierInput } = require('./refine');

const MODEL = 'claude-haiku-5-5';
const SCHEMA = path.join(__dirname, 'refinement-schema.json');
const SYSTEM_PROMPT = '너는 학교 쪽지 분류기다. 사용자가 준 지침과 쪽지 자료만 보고, 지정된 JSON 형식으로만 답한다. 도구를 쓰지 않는다.';
const INSTALL_COMMAND = 'irm https://claude.ai/install.ps1 | iex';
const LOGIN_MESSAGE = 'Claude Code에 로그인되어 있지 않습니다. 설정의 ‘로그인 창 열기’를 눌러 Claude 구독 계정(Pro 이상)으로 로그인한 뒤 다시 시험해 주세요.';
const MISSING_MESSAGE = '이 PC에서 Claude Code를 찾지 못했습니다. ‘연결 시험 및 저장’을 누르면 설치할지 묻습니다. 자동 설치가 안 되면 설정의 ‘설치·로그인이 안 될 때 안내’를 따라 주세요.';

function versionKey(name) {
  return String(name).split('.').map(part => Number.parseInt(part, 10) || 0);
}

function newerFirst(a, b) {
  const x = versionKey(a); const y = versionKey(b);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    if ((y[i] ?? 0) !== (x[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
  }
  return 0;
}

function isFile(file) {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

function listDirs(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name); } catch { return []; }
}

// Claude 데스크톱 앱에 들어 있는 claude.exe: <앱 자료>\claude-code\<판>\<해시>\claude.exe
function bundledCandidates(env) {
  const roots = [];
  if (env.LOCALAPPDATA) {
    const dataRoot = path.join(env.LOCALAPPDATA, 'Claude-Data');
    for (const name of listDirs(dataRoot)) roots.push(path.join(dataRoot, name, 'claude-code'));
  }
  if (env.APPDATA) roots.push(path.join(env.APPDATA, 'Claude', 'claude-code'));
  const found = [];
  for (const root of roots) {
    for (const version of listDirs(root).sort(newerFirst)) {
      const versionDir = path.join(root, version);
      const direct = path.join(versionDir, 'claude.exe');
      if (isFile(direct)) found.push(direct);
      for (const sub of listDirs(versionDir)) {
        const nested = path.join(versionDir, sub, 'claude.exe');
        if (isFile(nested)) found.push(nested);
      }
      if (found.length) return found;
    }
  }
  return found;
}

// 찾는 순서: 설정에 적은 경로 → PATH의 claude.exe → 기본 설치 위치(~\.local\bin) → Claude 데스크톱 앱 안의 claude.exe.
function resolveClaude(explicit, env = process.env) {
  if (explicit) {
    if (typeof explicit !== 'string' || !path.isAbsolute(explicit) || path.extname(explicit).toLowerCase() !== '.exe' || !isFile(explicit)) {
      throw aiStopError('settings.json에서 Claude Code 실행 파일 경로(claudeExecutable)를 확인해 주세요.');
    }
    return explicit;
  }
  for (const dir of String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean)) {
    const file = path.join(dir, 'claude.exe');
    if (isFile(file)) return file;
  }
  if (env.USERPROFILE) {
    const native = path.join(env.USERPROFILE, '.local', 'bin', 'claude.exe');
    if (isFile(native)) return native;
  }
  // 시험용: SCHOOL_CALENDAR_CLAUDE_NO_BUNDLED=1이면 데스크톱 앱 안의 claude.exe를 못 본 척한다("없는 PC" 흉내).
  const [bundled] = env.SCHOOL_CALENDAR_CLAUDE_NO_BUNDLED === '1' ? [] : bundledCandidates(env);
  if (bundled) return bundled;
  throw aiStopError(MISSING_MESSAGE);
}

function claudeArgs(schemaText) {
  return [
    '-p', '--model', MODEL, '--output-format', 'json', '--json-schema', schemaText,
    '--tools', '', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence',
    '--permission-mode', 'dontAsk', '--system-prompt', SYSTEM_PROMPT
  ];
}

function claudeEnv(env = process.env) {
  // 선생님 개인 지침(CLAUDE.md)과 자동 기억을 분류에 섞지 않고, 업데이트·원격 보고 같은 부수 통신을 끈다.
  return { ...env, CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
}

function runClaude(file, args, { input, signal, env }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const child = spawn(file, args, { windowsHide: true, cwd: os.tmpdir(), env, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    let errors = '';
    const abort = () => { child.kill(); reject(signal.reason); };
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { if (output.length < 2 * 1024 * 1024) output += chunk; });
    child.stderr.on('data', chunk => { if (errors.length < 8 * 1024) errors += chunk; });
    child.stdin.on('error', () => {});
    child.on('error', reject);
    child.on('close', code => {
      signal?.removeEventListener('abort', abort);
      resolve({ code, output, errors });
    });
    child.stdin.end(input, 'utf8');
  });
}

// claude -p --output-format json 의 결과 한 덩어리를 읽는다. 구조화 결과는 structured_output에 온다.
function readClaudeResult({ code, output, errors }) {
  let reply;
  try { reply = JSON.parse(String(output).trim()); } catch { reply = null; }
  const text = `${reply?.result ?? ''} ${errors ?? ''}`;
  if (/not logged in|\/login|invalid api key|oauth token|authentication/i.test(text)) throw aiStopError(LOGIN_MESSAGE);
  if (/usage limit|rate limit|limit reached|5-hour limit|weekly limit/i.test(text)) {
    throw aiStopError('Claude 구독 사용 한도에 닿았습니다. 한도가 풀린 뒤 다시 정리하거나, 다른 연결 방식을 골라 주세요.');
  }
  if (/model.*(not found|not available|access)|does not have access/i.test(text)) {
    throw aiStopError('이 Claude 계정에서 Haiku 모델을 쓸 수 없습니다. Claude Code를 최신으로 업데이트했는지, 구독이 Pro 이상인지 확인해 주세요.');
  }
  if (!reply || reply.is_error || code !== 0 || !reply.structured_output || typeof reply.structured_output !== 'object') {
    throw new CalendarError('Claude Code에서 정리를 받지 못했습니다. 로그인 상태와 버전을 확인한 뒤 다시 시도해 주세요.');
  }
  return reply.structured_output;
}

async function refineClaude(note, { rulesPath, claudeExecutable, signal, profile, env = process.env, run = runClaude }) {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new CalendarError('AI 정리가 90초 안에 끝나지 않았습니다. 다시 시도해 주세요.')), 90_000);
  const execution = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  try {
    const input = await buildClassifierInput(note, rulesPath, profile);
    const executable = resolveClaude(claudeExecutable, env);
    const schemaText = JSON.stringify(JSON.parse(await fsp.readFile(SCHEMA, 'utf8')));
    return readClaudeResult(await run(executable, claudeArgs(schemaText), { input, signal: execution, env: claudeEnv(env) }));
  } catch (error) {
    if (error instanceof CalendarError) throw error;
    if (execution.aborted) throw execution.reason;
    throw new CalendarError('Claude Code에서 정리를 받지 못했습니다. 로그인 상태와 버전을 확인한 뒤 다시 시도해 주세요.');
  } finally {
    clearTimeout(timer);
  }
}

function findClaude(claudeExecutable, env = process.env) {
  try { return resolveClaude(claudeExecutable, env); } catch { return null; }
}

// 로그인: 새 명령 창에서 claude를 대화형으로 켠다. 처음 켜면 브라우저 로그인 안내가 나온다.
// 창을 닫으면(프로세스가 끝나면) 돌아온다. 그 뒤 앱이 연결 시험을 다시 돌린다.
function openClaudeLogin(claudeExecutable, env = process.env, { timeoutMs = 15 * 60_000, run = spawn } = {}) {
  const executable = resolveClaude(claudeExecutable, env);
  return new Promise(resolve => {
    const child = run(executable, [], {
      cwd: os.homedir(), windowsHide: false, detached: true, stdio: 'ignore',
      env: { ...env, CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1' }
    });
    const timer = setTimeout(() => resolve({ executable, closed: false }), timeoutMs);
    child.on('error', () => { clearTimeout(timer); resolve({ executable, closed: false }); });
    child.on('exit', () => { clearTimeout(timer); resolve({ executable, closed: true }); });
    child.unref?.();
  });
}

// 설치: 공식 설치 명령(관리자 권한 필요 없음)을 숨은 PowerShell로 돌린다. 끝나면 ~\.local\bin\claude.exe를 찾는다.
function installClaude({ env = process.env, signal, timeoutMs = 5 * 60_000, run = spawn } = {}) {
  const powershell = path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((resolve, reject) => {
    const child = run(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      `[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; ${INSTALL_COMMAND}`],
    { windowsHide: true, cwd: os.homedir(), env, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    const keep = chunk => { if (log.length < 16 * 1024) log += chunk; };
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    const fail = message => reject(new CalendarError(message));
    const timer = setTimeout(() => { child.kill(); fail('Claude Code 설치가 5분 안에 끝나지 않았습니다. 인터넷 연결을 확인하거나 설정의 ‘설치·로그인이 안 될 때 안내’를 따라 직접 설치해 주세요.'); }, timeoutMs);
    signal?.addEventListener('abort', () => { clearTimeout(timer); child.kill(); reject(signal.reason); }, { once: true });
    child.on('error', () => { clearTimeout(timer); fail('설치 프로그램을 실행하지 못했습니다. 설정의 ‘설치·로그인이 안 될 때 안내’를 따라 직접 설치해 주세요.'); });
    child.on('close', code => {
      clearTimeout(timer);
      // 새로 깐 claude.exe는 ~\.local\bin에 생긴다. 이 앱의 PATH는 설치 전 값이라 그 자리를 직접 본다.
      const installed = findClaude(null, { ...env, PATH: '', SCHOOL_CALENDAR_CLAUDE_NO_BUNDLED: '1' });
      if (installed) return resolve({ executable: installed, log });
      const blocked = /403|blocked|unable to connect|could not resolve|ssl|tls|원격 서버/i.test(log);
      fail(blocked
        ? 'Claude Code를 내려받지 못했습니다. 학교망이나 보안 프로그램이 막았을 수 있습니다. 정보 담당자에게 claude.ai 접속을 확인하거나 설정의 ‘설치·로그인이 안 될 때 안내’를 따라 직접 설치해 주세요.'
        : `Claude Code 설치를 마치지 못했습니다(종료 코드 ${code}). 설정의 ‘설치·로그인이 안 될 때 안내’를 따라 직접 설치해 주세요.`);
    });
  });
}

module.exports = { MODEL, INSTALL_COMMAND, LOGIN_MESSAGE, resolveClaude, findClaude, bundledCandidates, claudeArgs, claudeEnv, readClaudeResult, refineClaude, openClaudeLogin, installClaude };
