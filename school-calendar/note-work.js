'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { CalendarError, writeJson } = require('./store');
const { McpShare } = require('./mcp-share');
const { runCodexWork } = require('./codex-work');
const { runClaudeWork } = require('./claude-work');

const TASK_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const RESULT_FILE = /^(?:[a-f0-9]{32}|[a-f0-9]{64})\.json$/;
const CONTENT_LIMIT = 64 * 1024;
const RECORD_LIMIT = 6 * CONTENT_LIMIT + 4096;
const MAX_RESULTS = 30;
const agents = {
  codex: { name: 'Codex', run: runCodexWork },
  claude: { name: 'Claude Code', run: runClaudeWork }
};
const resultSources = new Set(['codex-app', 'claude-app', 'mcp', 'codex-mcp']);

async function directory(file, create = false) {
  if (create) await fs.mkdir(file, { recursive: true });
  if (!(await fs.lstat(file)).isDirectory()) throw new CalendarError('AI 작업 결과 폴더를 확인해 주세요.');
  return file;
}

function validDraft(draft) {
  return typeof draft?.title === 'string' && draft.title.trim() && draft.title.length <= 120 &&
    typeof draft.content === 'string' && draft.content.trim() && Buffer.byteLength(draft.content) <= CONTENT_LIMIT;
}

class NoteWork {
  constructor({ bridge, store, signal, notify }) {
    this.bridge = bridge;
    this.store = store;
    this.signal = signal;
    this.notify = notify;
    this.jobs = new Map();
    this.results = path.join(bridge.root, 'results-v1');
    this.preparingBridge = null;
  }

  async resultFolder(taskId, create = false) {
    if (typeof taskId !== 'string' || !TASK_ID.test(taskId)) throw new CalendarError('쪽지 업무를 확인해 주세요.');
    await directory(this.bridge.root, create);
    await directory(this.results, create);
    return directory(path.join(this.results, taskId), create);
  }

  async readResults(taskId) {
    const files = await this.resultFolder(taskId).then(folder => fs.readdir(folder, { withFileTypes: true })).catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    const candidates = await Promise.all(files.filter(file => file.isFile() && RESULT_FILE.test(file.name)).map(async file => {
      const target = path.join(this.results, taskId, file.name);
      const stat = await fs.lstat(target).catch(() => null);
      return stat?.isFile() && stat.size <= RECORD_LIMIT ? { name: file.name, target, mtime: stat.mtimeMs } : null;
    }));
    const latest = candidates.filter(Boolean).sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name)).slice(0, MAX_RESULTS);
    const records = await Promise.all(latest.map(async file => {
      try {
        const raw = await fs.readFile(file.target, 'utf8');
        if (Buffer.byteLength(raw) > RECORD_LIMIT) return null;
        const result = JSON.parse(raw);
        if (`${result.id}.json` !== file.name || !validDraft(result) || !Number.isFinite(Date.parse(result.completedAt)) ||
            !resultSources.has(result.source)) return null;
        return result;
      } catch {
        return null;
      }
    }));
    return records.filter(Boolean);
  }

  async state(taskId) {
    this.store.getTask(taskId);
    const results = await this.readResults(taskId);
    const job = this.jobs.get(taskId)?.status || null;
    return { job, results };
  }

  async save(taskId, draft, agent) {
    if (!validDraft(draft)) throw new CalendarError('저장할 수 있는 초안을 받지 못했습니다.');
    const folder = await this.resultFolder(taskId, true);
    const id = randomUUID().replaceAll('-', '');
    await writeJson(path.join(folder, `${id}.json`), {
      id, title: draft.title, content: draft.content, completedAt: new Date().toISOString(), source: `${agent}-app`
    });
  }

  start(taskId, input) {
    const task = this.store.getTask(taskId);
    const note = this.store.notes.get(task.noteId);
    if (note?.verified !== true || this.store.inbox.status !== 'ready') {
      throw new CalendarError('원문이 확인된 쪽지만 AI에 맡길 수 있습니다.');
    }
    if (this.signal.aborted) throw new CalendarError('캘린더를 종료하고 있습니다.');
    const request = typeof input?.request === 'string' ? input.request.trim() : '';
    if (!request || request.length > 2000) throw new CalendarError('맡길 일을 2,000자 안에서 적어 주세요.');
    const agent = input.agent;
    if (typeof agent !== 'string' || !Object.hasOwn(agents, agent)) throw new CalendarError('일을 맡길 AI를 골라 주세요.');
    if (this.jobs.get(taskId)?.status.status === 'running') throw new CalendarError('이미 이 쪽지의 일을 처리하고 있습니다.');
    const job = { status: { agent, request, status: 'running' }, promise: null };
    this.jobs.set(taskId, job);
    job.promise = this.run(taskId, request, input.attachments, agent).then(() => {
      this.jobs.delete(taskId);
    }, error => {
      job.status = { agent, request, status: 'failed', error: error instanceof CalendarError ? error.message : `${agents[agent].name}에 맡긴 일을 마치지 못했습니다.` };
    }).finally(() => this.notify(taskId));
    this.notify(taskId);
    return { accepted: true };
  }

  pending() {
    return [...this.jobs.values()].filter(job => job.status.status === 'running').map(job => job.promise);
  }

  async run(taskId, request, attachments, agent) {
    const temp = await fs.realpath(os.tmpdir());
    const folder = await fs.mkdtemp(path.join(temp, 'school-calendar-agent-work-'));
    try {
      const local = new McpShare(folder, this.bridge.edition);
      const share = await local.publish(this.store, taskId, attachments);
      const packaged = path.join(__dirname, 'CalendarMcp.exe');
      try {
        await fs.copyFile(packaged, local.command);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        this.preparingBridge ??= this.bridge.installBridge().finally(() => { this.preparingBridge = null; });
        await this.preparingBridge;
        await fs.copyFile(this.bridge.command, local.command);
      }
      const draft = await agents[agent].run({
        folder, command: local.command, shareId: share.id, request,
        codexExecutable: this.store.settings.codexExecutable,
        claudeExecutable: this.store.settings.claudeExecutable, signal: this.signal
      });
      if (this.signal.aborted) return;
      await this.save(taskId, draft, agent);
    } finally {
      const target = await fs.realpath(folder).catch(() => null);
      if (target && path.dirname(target) === temp && path.basename(target) === path.basename(folder)) {
        await fs.rm(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }).catch(() => {});
      }
    }
  }
}

module.exports = { NoteWork };
