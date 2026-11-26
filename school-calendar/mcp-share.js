'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { createHash, randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { CalendarError, writeJson } = require('./store');
const { normalizeProposals } = require('./memo');

const BRIDGE = 'CalendarMcp.exe';
const BRANDED_BRIDGE = 'CalendarMcp-Branded.exe';
const MCP_IDENTITIES = {
  brity: { calendarName: '브리티 캘린더', calendarServer: 'brity_calendar' },
  goe: { calendarName: 'GOE 캘린더', calendarServer: 'goe_calendar' }
};
const MANIFEST_LIMIT = 256 * 1024;
const SHARE_ID = /^[a-f0-9]{32}$/;
const SUBMISSION_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const INBOX_FILE_LIMIT = 64 * 1024;
const run = promisify(execFile);

async function folder(file, create = false) {
  if (create) await fs.mkdir(file, { recursive: true });
  if (!(await fs.lstat(file)).isDirectory()) throw new CalendarError('AI 공유 폴더를 확인해 주세요.');
  return file;
}

class McpShare {
  constructor(root, edition, product) {
    this.root = path.resolve(root);
    this.edition = edition;
    const identity = MCP_IDENTITIES[product];
    this.calendarName = identity?.calendarName ?? '메신저 캘린더';
    this.calendarServer = identity?.calendarServer ?? 'calendar';
    this.serverArgs = identity ? [`--edition=${product}`] : [];
    this.inboxRoot = identity && path.join(this.root, 'ai-inbox-v1', product);
    this.legacyCommand = path.join(this.root, BRIDGE);
    this.shares = path.join(this.root, 'shares');
    this.index = path.join(this.root, 'share-v1.json');
    this.command = identity ? path.join(this.root, BRANDED_BRIDGE) : this.legacyCommand;
    const key = createHash('sha256').update(this.root.toLowerCase()).digest('hex');
    this.pipe = '\\\\.\\pipe\\calendar-mcp-share-' + key;
  }

  async exclusive(operation) {
    // Both editions use the same share. The OS releases the pipe if either app exits mid-write.
    const listener = net.createServer(socket => socket.destroy());
    await new Promise((resolve, reject) => {
      listener.once('error', error => reject(error.code === 'EADDRINUSE'
        ? new CalendarError('다른 캘린더에서 공유를 바꾸는 중입니다. 잠시 뒤 다시 눌러 주세요.') : error));
      listener.listen(this.pipe, resolve);
    });
    try {
      return await operation();
    } finally {
      await new Promise(resolve => listener.close(resolve));
    }
  }

  async status() {
    const share = await this.readShare();
    return { share: this.serverArgs.length && share?.edition !== this.edition ? null : share };
  }

  async readShare() {
    try {
      await folder(this.root);
      const stat = await fs.lstat(this.index);
      if (!stat.isFile() || stat.size > MANIFEST_LIMIT) throw new Error('Invalid share-v1.json');
      const share = JSON.parse(await fs.readFile(this.index, 'utf8'));
      if (typeof share.id !== 'string' || !SHARE_ID.test(share.id) || typeof share.title !== 'string' ||
          typeof share.sharedAt !== 'string' || !Array.isArray(share.attachments)) throw new Error('Invalid share');
      return share;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async clearBundle(id) {
    if (!SHARE_ID.test(id)) return;
    await folder(this.shares);
    const candidate = await folder(path.join(this.shares, id));
    const [parent, bundle] = await Promise.all([fs.realpath(this.shares), fs.realpath(candidate)]);
    if (path.relative(parent, bundle) !== id) return;
    await fs.rm(bundle, { recursive: true, force: true, maxRetries: 2, retryDelay: 80 });
  }

  async publish(store, taskId, selection) {
    if (!Array.isArray(selection) || selection.some(item => !item || !Number.isSafeInteger(item.index) ||
      item.index < 0 || typeof item.name !== 'string') || new Set(selection.map(item => item.index)).size !== selection.length) {
      throw new CalendarError('공유할 첨부를 다시 골라 주세요.');
    }
    return this.exclusive(async () => {
      const previous = await this.readShare();
      await folder(this.root, true);
      await folder(this.shares, true);
      const id = randomUUID().replaceAll('-', '');
      const destination = path.join(this.shares, id);
      await fs.mkdir(destination);
      let share;
      try {
        const content = await store.prepareMcpWork(taskId, selection, destination);
        share = { id, ...content, taskId, sharedAt: new Date().toISOString(), edition: this.edition };
        if (Buffer.byteLength(JSON.stringify(share, null, 2)) + 1 > MANIFEST_LIMIT) {
          throw new CalendarError('첨부 목록이 너무 깁니다. 파일 수를 줄여 다시 공유해 주세요.');
        }
        await writeJson(this.index, share);
      } catch (error) {
        await this.clearBundle(id).catch(() => {});
        throw error;
      }
      if (previous) await this.clearBundle(previous.id).catch(() => {});
      return share;
    });
  }

  async current(id) {
    const { share } = await this.status();
    if (!share || share.id !== id) throw new CalendarError('공유한 업무가 바뀌었습니다. 창을 다시 열어 주세요.');
    return share;
  }

  async revoke(id) {
    return this.exclusive(async () => {
      const share = await this.current(id);
      await fs.unlink(this.index);
      await this.clearBundle(share.id).catch(() => {});
    });
  }

  async bundle(id) {
    await this.current(id);
    await folder(this.shares);
    return folder(path.join(this.shares, id));
  }

  async inboxFolder() {
    if (!this.inboxRoot) throw new CalendarError('받은함이 있는 캘린더를 연결해 주세요.');
    await folder(this.root);
    await folder(path.dirname(this.inboxRoot));
    return folder(this.inboxRoot);
  }

  async readInboxEntry(dir, id) {
    if (typeof id !== 'string' || !SUBMISSION_ID.test(id)) throw new CalendarError('받은함에서 업무 묶음을 다시 골라 주세요.');
    const file = path.join(dir, id + '.json');
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size > INBOX_FILE_LIMIT) throw new CalendarError('받은 업무 파일을 읽을 수 없습니다.');
    const input = await fs.open(file, 'r');
    let record;
    try {
      const buffer = Buffer.alloc(INBOX_FILE_LIMIT + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await input.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > INBOX_FILE_LIMIT) throw new CalendarError('받은 업무 파일을 읽을 수 없습니다.');
      record = JSON.parse(buffer.toString('utf8', 0, length));
    } finally {
      await input.close();
    }
    if (record?.id !== id || !/^[a-f0-9]{64}$/.test(record.fingerprint) || !['queued', 'registered', 'dismissed'].includes(record.status)) {
      throw new CalendarError('받은 업무 파일을 읽을 수 없습니다.');
    }
    if (record.status !== 'queued') return record;
    if (typeof record.source !== 'string' || !record.source.trim() || record.source.length > 120 ||
      typeof record.receivedAt !== 'string' || !Number.isFinite(Date.parse(record.receivedAt))) {
      throw new CalendarError('받은 업무 파일을 읽을 수 없습니다.');
    }
    const items = normalizeProposals(record.items);
    if (!items.length) throw new CalendarError('받은 업무 파일에 등록할 항목이 없습니다.');
    return { ...record, items };
  }

  async listInbox(store) {
    const dir = await this.inboxFolder().catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!dir) return [];
    const records = [];
    for await (const entry of await fs.opendir(dir)) {
      if (!entry.isFile() || !entry.name.endsWith('.json') || !SUBMISSION_ID.test(entry.name.slice(0, -5))) continue;
      const record = await this.readInboxEntry(dir, entry.name.slice(0, -5)).catch(() => null);
      if (record?.status !== 'queued' || await this.reconcileRegisteredInbox(store, dir, record.id)) continue;
      records.push({ id: record.id, source: record.source, receivedAt: record.receivedAt, count: record.items.length });
    }
    return records.sort((left, right) => Date.parse(left.receivedAt) - Date.parse(right.receivedAt) || left.receivedAt.localeCompare(right.receivedAt) || left.id.localeCompare(right.id));
  }

  async getInbox(id, store) {
    const dir = await this.inboxFolder();
    const { status, source, receivedAt, items } = await this.readInboxEntry(dir, id);
    if (status !== 'queued' || await this.reconcileRegisteredInbox(store, dir, id)) {
      throw new CalendarError('이미 처리한 업무 묶음입니다.');
    }
    return { id, source, receivedAt, items };
  }

  async reconcileRegisteredInbox(store, dir, id) {
    const count = store?.registeredAiInbox(id).length;
    if (!count) return false;
    await this.exclusive(async () => {
      const record = await this.readInboxEntry(dir, id);
      if (record.status === 'queued') await this.finishInboxEntry(dir, record, 'registered', count);
    }).catch(() => {});
    return true;
  }

  async registerInbox(store, id, items) {
    return this.exclusive(async () => {
      const dir = await this.inboxFolder();
      const record = await this.readInboxEntry(dir, id);
      if (record.status !== 'queued') throw new CalendarError('이미 처리한 업무 묶음입니다.');
      const previous = store.registeredAiInbox(id);
      if (previous.length) {
        await this.finishInboxEntry(dir, record, 'registered', previous.length).catch(() => {});
        throw new CalendarError('이미 달력에 넣은 업무 묶음입니다.');
      }
      if (!Array.isArray(items) || !items.length || items.length > record.items.length) {
        throw new CalendarError('달력에 넣을 업무를 골라 주세요.');
      }
      const referenceDate = new Date(Date.parse(record.receivedAt) + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const tasks = await store.registerMemo({ draft: { id, text: record.source, referenceDate }, items }, { aiInbox: true });
      await this.finishInboxEntry(dir, record, 'registered', tasks.length).catch(() => {});
      return tasks;
    });
  }

  async dismissInbox(store, id) {
    return this.exclusive(async () => {
      const dir = await this.inboxFolder();
      const record = await this.readInboxEntry(dir, id);
      if (record.status !== 'queued') return true;
      const tasks = store.registeredAiInbox(id);
      await this.finishInboxEntry(dir, record, tasks.length ? 'registered' : 'dismissed', tasks.length);
      return true;
    });
  }

  finishInboxEntry(dir, { id, fingerprint }, status, count) {
    return writeJson(path.join(dir, id + '.json'), { id, fingerprint, status, count });
  }

  async checkBridge() {
    await this.installBridge({ rebuildSource: true });
    const messages = [
      { id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'calendar-check', version: '1' } } },
      { method: 'notifications/initialized' },
      { id: 2, method: 'tools/list', params: {} }
    ];
    const input = messages.map(message => JSON.stringify({ jsonrpc: '2.0', ...message })).join('\n') + '\n';
    try {
      const child = run(this.command, this.serverArgs, { windowsHide: true, timeout: 5000, maxBuffer: 128 * 1024 });
      child.child.stdin.on('error', () => {}); // A failed launch can close the pipe before the write.
      child.child.stdin.end(input);
      const { stdout } = await child;
      const replies = stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
      const server = replies.find(reply => reply.id === 1)?.result?.serverInfo;
      const tools = replies.find(reply => reply.id === 2)?.result?.tools || [];
      const expectedName = this.serverArgs.length ? this.calendarServer : 'school-calendar';
      const expectedTools = ['list_shared_work', 'get_shared_work', 'read_shared_attachment', 'save_work_result'];
      if (this.serverArgs.length) expectedTools.push('send_tasks_to_inbox');
      if (server?.name !== expectedName || (this.serverArgs.length && server.title !== this.calendarName) ||
        !expectedTools.every(name => tools.some(tool => tool.name === name))) throw new Error('Unexpected MCP response');
      return true;
    } catch {
      throw new CalendarError('MCP 연결 프로그램이 응답하지 않았습니다. 캘린더를 다시 열고 확인해 주세요.');
    }
  }

  async setup(format, executables = {}) {
    const command = JSON.stringify(this.command);
    const name = this.calendarServer;
    const args = this.serverArgs;
    const server = { command: this.command, args };
    const toml = () => `[mcp_servers.${name}]\ncommand = ${command}\nargs = ${JSON.stringify(args)}\n`;
    const jsonConfig = () => JSON.stringify({ mcpServers: { [name]: server } }, null, 2);
    const setupRequest = () => {
      // PowerShell single-quoted arguments also handle spaces, dollar signs and apostrophes in a user profile path.
      const quote = value => "'" + value.replace(/['‘’‚‛]/g, match => "'" + match) + "'";
      const executable = [this.command, ...args].map(quote).join(' ');
      const codex = executables.codex ? '& ' + quote(executables.codex) : 'codex';
      const claude = executables.claude ? '& ' + quote(executables.claude) : 'claude';
      return [
        `이 Windows PC에서 지금 사용 중인 AI 앱에 ${this.calendarName} MCP를 연결해 주세요. 아래에서 현재 앱에 해당하는 방법으로 직접 등록하고 확인해 주세요.`,
        `서버 이름: ${name} / 전송: stdio / 인자: ${args.join(' ') || '없음'}`,
        '실행 파일: ' + this.command,
        '',
        `먼저 이 파일이 있는지 확인하고, 현재 앱에 ${name}가 이미 등록돼 있는지 조회하세요. 실행 파일과 인자가 모두 같으면 연결 확인으로 넘어가고, 이 이름의 설정이 다르면 기존 설정을 바꾸기 전에 알려 주세요.`,
        '',
        'PowerShell에서 현재 앱에 해당하는 명령만 사용하세요.',
        'Codex에서 현재 사용자 설정을 조회하고, 없으면 등록하세요.',
        `${codex} mcp get ${name} --json`,
        `${codex} mcp add ${name} -- ${executable}`,
        'Claude Code에서 조회하고, 없으면 현재 프로젝트에 등록하세요.',
        `${claude} mcp get ${name}`,
        `${claude} mcp add --scope local --transport stdio ${name} -- ${executable}`,
        '',
        `등록한 뒤 다시 조회해 실행 파일 경로와 stdio 설정 및 인자를 확인하세요. 현재 채팅에서 ${name}의 도구 목록에 list_shared_work, save_work_result${args.length ? ', send_tasks_to_inbox' : ''}가 보이는지 확인하세요. 등록과 연결 중 어디까지 확인했는지 알려 주고, 새 채팅이나 앱을 다시 열어야 하면 다음 동작을 한 줄로 안내하세요. 연결 시험은 도구 목록 확인까지만 진행하세요. 사용자가 “${this.calendarName}”라고 하면 이 서버를 사용하세요.`
      ].join('\n');
    };
    const configs = {
      'ai-request': setupRequest,
      json: jsonConfig,
      claude: jsonConfig,
      codex: toml,
      grok: toml,
      vscode: () => JSON.stringify({ servers: { [name]: { type: 'stdio', ...server } } }, null, 2)
    };
    if (!Object.hasOwn(configs, format)) throw new CalendarError('AI 앱의 설정 형식을 골라 주세요.');
    if (args.length) await this.checkBridge();
    else await this.installBridge({ rebuildSource: true });
    return configs[format]();
  }

  async refreshInstalledBridges() {
    for (const command of new Set([this.legacyCommand, this.command])) {
      const installed = await fs.lstat(command).catch(() => null);
      if (installed?.isFile()) await this.installBridge({ legacy: command === this.legacyCommand }).catch(() => {});
    }
  }

  async installBridge({ rebuildSource = false, legacy = false } = {}) {
    const command = legacy ? this.legacyCommand : this.command;
    return this.exclusive(async () => {
      await folder(this.root, true);
      const installed = await fs.lstat(command).catch(error => {
        if (error.code !== 'ENOENT') throw error;
        return null;
      });
      if (installed && !installed.isFile()) throw new CalendarError('AI 연결 프로그램의 위치를 확인해 주세요.');
      const packaged = path.join(__dirname, BRIDGE);
      const content = await fs.readFile(packaged).catch(async error => {
        if (error.code !== 'ENOENT') throw error;
        if (installed && !rebuildSource) return null;
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'calendar-mcp-build-'));
        try {
          const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
          await run(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
            path.resolve(__dirname, '..', 'tools', 'launcher', 'build-mcp.ps1'), '-OutputDirectory', directory],
          { windowsHide: true, timeout: 20000 });
          return await fs.readFile(path.join(directory, BRIDGE));
        } catch {
          throw new CalendarError('AI 연결 프로그램을 준비하지 못했습니다. 전체 설치 ZIP으로 캘린더를 다시 열어 주세요.');
        } finally {
          await fs.rm(directory, { recursive: true, force: true });
        }
      });
      if (!content || (installed && content.equals(await fs.readFile(command)))) return;
      const staging = path.join(this.root, `CalendarMcp-${randomUUID()}.tmp`);
      try {
        await fs.writeFile(staging, content, { flag: 'wx' });
        await fs.rename(staging, command);
      } catch (error) {
        if (!installed || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
      } finally {
        await fs.unlink(staging).catch(() => {});
      }
    });
  }
}

module.exports = { McpShare, MCP_IDENTITIES };
