'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { CalendarError } = require('./store');
const { resolveClaude } = require('./claude-cli');

const exec = promisify(execFile);
const HANDOFF_DIR = '캘린더 쪽지';

async function readRegistry(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return {}; }
}

async function listWorkProjects(agent, env = process.env, home = os.homedir()) {
  const registered = [];
  if (agent === 'codex') {
    const config = await readRegistry(path.join(env.CODEX_HOME || path.join(home, '.codex'), '.codex-global-state.json'));
    const projects = config?.['local-projects'] || {};
    const order = Array.isArray(config?.['project-order']) ? config['project-order'] : [];
    for (const id of new Set([...order, ...Object.keys(projects)])) {
      const project = projects[id];
      if (!Array.isArray(project?.rootPaths)) continue;
      for (const folder of project.rootPaths) registered.push({ folder, name: project.name });
    }
    // Older Codex versions only persisted workspace roots.
    if (!Object.keys(projects).length) {
      for (const [key, roots] of Object.entries(config || {})) {
        if (key !== 'electron-saved-workspace-roots' && !key.startsWith('electron-owner-value:electron-saved-workspace-roots:')) continue;
        if (Array.isArray(roots)) for (const folder of roots) registered.push({ folder });
      }
    }
  } else if (agent === 'claude') {
    const files = env.CLAUDE_CONFIG_DIR ? [path.join(env.CLAUDE_CONFIG_DIR, '.claude.json')] : [
      path.join(home, '.claude.json'), path.join(home, '.claude', '.claude.json')
    ];
    for (const file of files) {
      const config = await readRegistry(file);
      for (const folder of Object.keys(config?.projects || {})) registered.push({ folder });
    }
  } else {
    throw new CalendarError('프로젝트에서 사용할 AI를 골라 주세요.');
  }
  const seen = new Set();
  const choices = [];
  for (const item of registered) {
    if (typeof item.folder !== 'string' || !path.isAbsolute(item.folder)) continue;
    try {
      const folder = await fs.realpath(item.folder);
      const key = process.platform === 'win32' ? folder.toLowerCase() : folder;
      if (seen.has(key) || !(await fs.stat(folder)).isDirectory()) continue;
      seen.add(key);
      const name = typeof item.name === 'string' && item.name.trim() ? item.name.trim() : folder;
      choices.push({ folder, name: path.basename(name) || '드라이브' });
    } catch { /* Moved or unavailable on this computer. */ }
  }
  return choices;
}

async function launchClaude(project, prompt, explicit) {
  const executable = resolveClaude(explicit);
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // Open a console with its own interactive stdin. Only the generated card reference is passed to Claude.
  const command = `Start-Process -ErrorAction Stop -FilePath $env:SCHOOL_CALENDAR_PROJECT_CLAUDE -WorkingDirectory $env:SCHOOL_CALENDAR_PROJECT_DIR -ArgumentList ('"' + $env:SCHOOL_CALENDAR_PROJECT_PROMPT + '"')`;
  const env = { ...process.env, SCHOOL_CALENDAR_PROJECT_CLAUDE: executable, SCHOOL_CALENDAR_PROJECT_DIR: project, SCHOOL_CALENDAR_PROJECT_PROMPT: prompt };
  delete env.CLAUDECODE;
  await exec(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], { cwd: project, env, windowsHide: true });
}

async function openProjectHandoff({ store, taskId, selection, projectDir, agent, instruction = '', openExternal, openClaude = launchClaude }) {
  if (agent !== 'codex' && agent !== 'claude') throw new CalendarError('프로젝트에서 사용할 AI를 골라 주세요.');
  if (typeof projectDir !== 'string' || !path.isAbsolute(projectDir)) throw new CalendarError('프로젝트 폴더를 다시 골라 주세요.');
  if (!Array.isArray(selection) || selection.some(item => !item || !Number.isSafeInteger(item.index) || item.index < 0 ||
      typeof item.name !== 'string') || new Set(selection.map(item => item.index)).size !== selection.length) {
    throw new CalendarError('보낼 첨부를 다시 골라 주세요.');
  }

  if (typeof instruction !== 'string' || instruction.length > 4000) throw new CalendarError('작업 지시는 4,000자 안에서 적어 주세요.');
  const request = instruction.trim();
  const project = await fs.realpath(projectDir).catch(() => null);
  if (!project || !(await fs.stat(project)).isDirectory()) throw new CalendarError('프로젝트 폴더를 찾을 수 없습니다. 다시 골라 주세요.');
  const parent = path.join(project, HANDOFF_DIR);
  await fs.mkdir(parent).catch(error => { if (error.code !== 'EEXIST') throw error; });
  if (!(await fs.lstat(parent)).isDirectory() || path.relative(project, await fs.realpath(parent)) !== HANDOFF_DIR) {
    throw new CalendarError('선택한 프로젝트 안에 쪽지 사본을 만들 수 없습니다.');
  }
  const folder = await fs.mkdtemp(path.join(parent, '쪽지-'));
  const card = path.join(folder, '업무.md');
  try {
    await store.prepareMcpWork(taskId, selection, folder);
    const relativeCard = path.relative(project, card).split(path.sep).join('/');
    let prompt = `이 프로젝트의 ${relativeCard} 파일에서 받은 쪽지 원문과 첨부 목록을 확인해 주세요. 이 자료와 프로젝트 맥락을 참고해서 아래에 적은 일을 도와주세요. 아직 요청이 없으면 어떤 일을 할지 물어봐 주세요.\n\n`;
    if (request) {
      await fs.appendFile(card, '\n\n## 사용자가 요청한 작업\n\n' + request + '\n', 'utf8');
      const reference = `이 프로젝트의 ${relativeCard} 파일에서 쪽지와 첨부를 확인하고 ‘사용자가 요청한 작업’을 진행해 주세요.`;
      const withRequest = reference + '\n\n' + request;
      // Keep arbitrary user text out of shell arguments and long Windows protocol URLs.
      prompt = agent === 'codex' && encodeURIComponent(withRequest).length < 6000 ? withRequest : reference;
    }
    try {
      if (agent === 'codex') {
        await openExternal(`codex://threads/new?path=${encodeURIComponent(project)}&prompt=${encodeURIComponent(prompt)}`);
      } else {
        await openClaude(project, prompt, store.settings.claudeExecutable);
      }
    } catch (error) {
      if (error instanceof CalendarError) throw error;
      throw new CalendarError(agent === 'codex' ? 'Codex를 열지 못했습니다. 데스크톱 앱 설치 상태를 확인해 주세요.'
        : 'Claude Code 터미널을 열지 못했습니다. 설치 상태를 확인해 주세요.');
    }
  } catch (error) {
    if (await fs.realpath(folder).catch(() => null) === folder && path.dirname(folder) === parent) {
      await fs.rm(folder, { recursive: true, force: true, maxRetries: 2 });
    }
    throw error;
  }
  return { agent, folder, card };
}

module.exports = { openProjectHandoff, listWorkProjects };
