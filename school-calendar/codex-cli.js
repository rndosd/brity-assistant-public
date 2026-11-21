'use strict';

// Codex CLI(ChatGPT 구독) 연결 준비: 설치돼 있는지, 로그인돼 있는지 보고, 없으면 묻고 설치·로그인 창을 연다.
// 2026-11-15 사용자: "cli 연결의 경우 연결이 안돼있으면 자동으로 뭔가 연결되게 안되나 … 구독을 했다는 가정하에서".
// 분류 자체는 refine.js(codex exec)가 한다. Claude Code는 claude-cli.js가 같은 일을 한다.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { CalendarError } = require('./store');
const { resolveCodex, POWERSHELL, SYSTEM } = require('./refine');

// 공식 설치 명령(github.com/openai/codex README, 2026-11). 관리자 권한 없이 사용자 폴더에 깐다.
const INSTALL_COMMAND = 'irm https://chatgpt.com/codex/install.ps1 | iex';
const GUIDE_HINT = '설정 → AI 연결의 ‘막히면 안내서’를 따라 직접 설치해 주세요.';

function installedPath(env = process.env) {
  const dir = env.CODEX_INSTALL_DIR || (env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Programs', 'OpenAI', 'Codex', 'bin') : '');
  const file = dir ? path.join(dir, 'codex.exe') : '';
  try { return file && fs.statSync(file).isFile() ? file : null; } catch { return null; }
}

async function findCodex(explicit, { timeoutMs = 20_000 } = {}) {
  try { return await resolveCodex(explicit, AbortSignal.timeout(timeoutMs)); } catch { return null; }
}

// .cmd(npm 설치)는 cmd.exe로, .exe는 바로 켠다.
function codexCommand(executable, args) {
  if (path.extname(executable).toLowerCase() !== '.cmd') return { file: executable, args, verbatim: false };
  return { file: path.join(SYSTEM, 'cmd.exe'), args: ['/d', '/s', '/c', `""${executable}" ${args.join(' ')}"`], verbatim: true };
}

// codex login status: 로그인돼 있으면 종료 코드 0('in'), 아니면 1("Not logged in", 'out').
// 켜지지 않는 실행 파일('unusable')도 있다: Codex 데스크톱 앱(WindowsApps) 안의 codex.exe는 다른 프로그램이 켜면
// 권한 오류(EPERM)가 날 수 있다(2026-11-15 이 PC에서 확인). 그때는 설치 안 된 것으로 보고 공식 설치를 권한다.
// 옛 Codex(npm 0.111 등)는 새 Codex가 쓴 ~/.codex/config.toml을 못 읽고 곧장 끝난다. 그러면 codex login도 같은 오류로
// 바로 꺼져 로그인 창이 안 열린 것처럼 보인다(2026-11-16 이 PC). 이때도 쓸 수 없는 것으로 보고 공식 설치를 권한다.
const CONFIG_ERROR = /error loading config|unknown variant|unknown field|invalid configuration/i;

function loginState(executable, { timeoutMs = 20_000, run = spawn } = {}) {
  return new Promise(resolve => {
    const { file, args, verbatim } = codexCommand(executable, ['login', 'status']);
    let child;
    try { child = run(file, args, { windowsHide: true, cwd: os.homedir(), stdio: ['ignore', 'pipe', 'pipe'], windowsVerbatimArguments: verbatim }); }
    catch { resolve('unusable'); return; }
    let log = '';
    const keep = chunk => { if (log.length < 8 * 1024) log += chunk; };
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    const timer = setTimeout(() => { child.kill(); resolve('out'); }, timeoutMs);
    child.on('error', () => { clearTimeout(timer); resolve('unusable'); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) return resolve('in');
      resolve(CONFIG_ERROR.test(log) ? 'unusable' : 'out');
    });
  });
}

async function loginStatus(executable, options) {
  return (await loginState(executable, options)) === 'in';
}

// 로그인: 새 창에서 codex login을 켠다. 브라우저가 열리고 ChatGPT 계정으로 허용하면 창이 저절로 닫힌다.
function openCodexLogin(executable, { timeoutMs = 15 * 60_000, run = spawn } = {}) {
  return new Promise(resolve => {
    const { file, args, verbatim } = codexCommand(executable, ['login']);
    let child;
    try { child = run(file, args, { cwd: os.homedir(), windowsHide: false, detached: true, stdio: 'ignore', windowsVerbatimArguments: verbatim }); }
    catch { resolve({ closed: false }); return; }
    const timer = setTimeout(() => resolve({ closed: false }), timeoutMs);
    child.on('error', () => { clearTimeout(timer); resolve({ closed: false }); });
    child.on('exit', () => { clearTimeout(timer); resolve({ closed: true }); });
    child.unref?.();
  });
}

// 설치: 공식 설치 명령을 숨은 PowerShell로 돌린다. CODEX_NON_INTERACTIVE=1이면 설치 중 묻는 창을 띄우지 않는다.
function installCodex({ env = process.env, signal, timeoutMs = 5 * 60_000, run = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = run(POWERSHELL, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      `[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; ${INSTALL_COMMAND}`],
    { windowsHide: true, cwd: os.homedir(), env: { ...env, CODEX_NON_INTERACTIVE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    const keep = chunk => { if (log.length < 16 * 1024) log += chunk; };
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    const fail = message => reject(new CalendarError(message));
    const timer = setTimeout(() => { child.kill(); fail(`Codex 설치가 5분 안에 끝나지 않았습니다. 인터넷 연결을 확인하거나 ${GUIDE_HINT}`); }, timeoutMs);
    signal?.addEventListener('abort', () => { clearTimeout(timer); child.kill(); reject(signal.reason); }, { once: true });
    child.on('error', () => { clearTimeout(timer); fail(`설치 프로그램을 실행하지 못했습니다. ${GUIDE_HINT}`); });
    child.on('close', code => {
      clearTimeout(timer);
      // 새로 깐 codex.exe는 이 앱의 PATH에 아직 없으므로 설치 자리를 직접 본다.
      const installed = installedPath(env);
      if (installed) return resolve({ executable: installed, log });
      const blocked = /403|blocked|unable to connect|could not resolve|ssl|tls|원격 서버/i.test(log);
      fail(blocked
        ? `Codex를 내려받지 못했습니다. 학교망이나 보안 프로그램이 막았을 수 있습니다. 정보 담당자에게 chatgpt.com 접속을 확인하거나 ${GUIDE_HINT}`
        : `Codex 설치를 마치지 못했습니다(종료 코드 ${code}). ${GUIDE_HINT}`);
    });
  });
}

// 쓸 수 있는 Codex와 로그인 상태. 켜지지 않는 Codex만 있으면 없는 것으로 본다.
async function codexStatus(explicit, options) {
  const executable = await findCodex(explicit);
  if (!executable) return { executable: null, loggedIn: false };
  const state = await loginState(executable, options);
  return state === 'unusable' ? { executable: null, loggedIn: false, unusable: executable } : { executable, loggedIn: state === 'in' };
}

module.exports = { INSTALL_COMMAND, installedPath, findCodex, codexCommand, loginState, loginStatus, codexStatus, openCodexLogin, installCodex };
