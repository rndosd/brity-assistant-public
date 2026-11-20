'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { createHash, randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { CalendarError, writeJson } = require('./store');

const BRIDGE = 'CalendarMcp.exe';
const MANIFEST_LIMIT = 256 * 1024;
const SHARE_ID = /^[a-f0-9]{32}$/;
const run = promisify(execFile);

async function folder(file, create = false) {
  if (create) await fs.mkdir(file, { recursive: true });
  if (!(await fs.lstat(file)).isDirectory()) throw new CalendarError('AI 공유 폴더를 확인해 주세요.');
  return file;
}

class McpShare {
  constructor(root, edition) {
    this.root = path.resolve(root);
    this.edition = edition;
    this.shares = path.join(this.root, 'shares');
    this.index = path.join(this.root, 'share-v1.json');
    this.command = path.join(this.root, BRIDGE);
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
    try {
      await folder(this.root);
      const stat = await fs.lstat(this.index);
      if (!stat.isFile() || stat.size > MANIFEST_LIMIT) throw new Error('Invalid share-v1.json');
      const share = JSON.parse(await fs.readFile(this.index, 'utf8'));
      if (typeof share.id !== 'string' || !SHARE_ID.test(share.id) || typeof share.title !== 'string' ||
          typeof share.sharedAt !== 'string' || !Array.isArray(share.attachments)) throw new Error('Invalid share');
      return { share };
    } catch (error) {
      if (error.code === 'ENOENT') return { share: null };
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
      const { share: previous } = await this.status();
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

  async setup(format) {
    const command = JSON.stringify(this.command);
    const server = { command: this.command, args: [] };
    const toml = () => `[mcp_servers.calendar]\ncommand = ${command}\nargs = []\n`;
    const configs = {
      json: () => JSON.stringify({ mcpServers: { calendar: server } }, null, 2),
      codex: toml,
      grok: toml,
      vscode: () => JSON.stringify({ servers: { calendar: { type: 'stdio', ...server } } }, null, 2)
    };
    if (!Object.hasOwn(configs, format)) throw new CalendarError('AI 앱의 설정 형식을 골라 주세요.');
    await this.installBridge({ rebuildSource: true });
    return configs[format]();
  }

  async installBridge({ rebuildSource = false } = {}) {
    return this.exclusive(async () => {
      await folder(this.root, true);
      const installed = await fs.lstat(this.command).catch(error => {
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
      if (!content || (installed && content.equals(await fs.readFile(this.command)))) return;
      const staging = path.join(this.root, `CalendarMcp-${randomUUID()}.tmp`);
      try {
        await fs.writeFile(staging, content, { flag: 'wx' });
        await fs.rename(staging, this.command);
      } catch (error) {
        if (!installed || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
      } finally {
        await fs.unlink(staging).catch(() => {});
      }
    });
  }
}

module.exports = { McpShare };
