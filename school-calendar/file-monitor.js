'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { fileTrack, findTracked, validTrack } = require('./file-track');

const ADD = 1, REMOVE = 2, RENAME_FROM = 4, RENAME_TO = 5;
const OFFICE = {
  '.docx': { saved: /^~wrd[0-9a-f]+\.tmp$/i, backup: /^~wrl[0-9a-f]+\.tmp$/i },
  '.xlsx': { saved: /^[0-9a-f]{1,8}$/i, backup: /^[0-9a-f]{1,8}\.tmp$/i },
  '.pptx': { saved: /^ppt[0-9a-f]+\.tmp$/i, backup: /^[0-9a-f]{1,8}\.tmp$/i }
};
const temporaryNames = Object.values(OFFICE).map(format => format.saved);
const local = file => process.platform === 'win32' && /^[a-z]:[\\/]/i.test(file);
const directoryKey = dir => path.normalize(dir).toLowerCase();
const validName = name => typeof name === 'string' && !!name && !/[\\/:]/.test(name) && name !== '.' && name !== '..';

function sameTrack(left, right) {
  return left?.volume === right?.volume && left?.dev === right?.dev && left?.ino === right?.ino;
}

async function resolveFileLink(file, track, locate = findTracked) {
  if (!path.isAbsolute(file)) return null;
  const here = await fileTrack(file);
  if (here && (!validTrack(track) || sameTrack(here, track))) return { path: file, track: here };
  if (!validTrack(track)) {
    const stat = await fs.stat(file).catch(() => null);
    return stat?.isFile() ? { path: file } : null;
  }
  const found = await locate(track);
  const format = OFFICE[path.extname(file).toLowerCase()];
  if (found && format?.backup.test(path.basename(found)) &&
      directoryKey(path.dirname(found)) === directoryKey(path.dirname(file))) return null;
  return found ? { path: found, track } : null;
}

class DirectoryWorker {
  constructor(onMessage) {
    this.onMessage = onMessage;
    this.requests = new Map();
    this.sequence = 0;
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = this.child = spawn(powershell, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'file-watch.ps1')
    ], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    this.ready = new Promise(resolve => {
      const timer = setTimeout(() => this.markReady(false), 10000);
      this.markReady = ok => { clearTimeout(timer); resolve(ok); };
    });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.type === 'ready') this.markReady(true);
      else if (message.type === 'ack') this.requests.get(message.requestId)?.(message.ok === true ? message : false);
      else this.onMessage(message);
    });
    this.exited = new Promise(resolve => child.once('close', () => {
      this.markReady(false);
      for (const complete of this.requests.values()) complete(false);
      this.closed = true;
      lines.close();
      resolve();
    }));
    child.on('error', () => this.markReady(false));
    child.stdin.on('error', () => {});
  }

  async command(op, dir, ino) {
    if (!(await this.ready) || this.closed || this.child.stdin.writableEnded) return false;
    const requestId = ++this.sequence;
    return new Promise(resolve => {
      const timer = setTimeout(() => complete(false), 5000);
      const complete = ok => {
        clearTimeout(timer);
        this.requests.delete(requestId);
        resolve(ok);
      };
      this.requests.set(requestId, complete);
      this.child.stdin.write(JSON.stringify({ op, dir, ino, requestId }) + '\n', error => { if (error) complete(false); });
    });
  }

  close() {
    if (!this.closed && !this.child.stdin.writableEnded) this.child.stdin.end(JSON.stringify({ op: 'stop' }) + '\n');
    return this.exited;
  }
}

class FileMonitor {
  constructor(onChange) {
    this.onChange = onChange;
    this.entries = new Map();
    this.directories = new Map();
    this.dirty = new Set();
    this.watchQueue = Promise.resolve();
  }

  async sync(links) {
    const added = [];
    for (const key of this.entries.keys()) if (!links.has(key) || !local(links.get(key).path)) this.entries.delete(key);
    for (const [key, link] of links) {
      if (!local(link.path)) continue;
      const previous = this.entries.get(key);
      if (previous && ((previous.savedPath === link.path && sameTrack(previous.savedTrack, link.track)) ||
          (previous.path === link.path && sameTrack(previous.track, link.track)))) {
        previous.savedPath = link.path;
        previous.savedTrack = link.track;
        continue;
      }
      const entry = { key, savedPath: link.path, savedTrack: link.track, path: link.path, track: link.track, revision: 0, priorTracks: [] };
      this.entries.set(key, entry);
      added.push(entry);
    }
    await Promise.all(added.filter(entry => !validTrack(entry.track)).map(async entry => {
      entry.track = await fileTrack(entry.path);
    }));
    await this.alignWatches();
    if (this.closed) return;
    await Promise.all(added.map(async entry => {
      const here = await fileTrack(entry.path);
      const watching = this.directories.has(directoryKey(path.dirname(entry.path)));
      if (watching && (!sameTrack(here, entry.track) || !sameTrack(entry.track, entry.savedTrack))) this.changed(entry);
    }));
  }

  alignWatches() {
    const update = async () => {
      if (this.closed) return;
      const wanted = new Map();
      for (const entry of this.entries.values()) {
        const dir = path.dirname(entry.path);
        const key = directoryKey(dir);
        if (!wanted.has(key)) wanted.set(key, { dir, entries: new Set() });
        wanted.get(key).entries.add(entry);
      }
      if (wanted.size && (!this.worker || this.worker.closed)) {
        this.directories.clear();
        this.worker = new DirectoryWorker(event => this.observe(event));
      }
      const attach = [];
      for (const [key, group] of wanted) {
        const directory = this.directories.get(key);
        if (directory) directory.entries = group.entries;
        else {
          this.directories.set(key, { ...group, temporary: new Map(), renames: new Map() });
          attach.push(this.worker.command('watch', group.dir).then(ok => { if (!ok) this.directories.delete(key); }));
        }
      }
      await Promise.all(attach);
      await Promise.all([...this.directories].filter(([key]) => !wanted.has(key)).map(async ([key, group]) => {
        this.directories.delete(key);
        await this.worker.command('unwatch', group.dir);
      }));
      if (!wanted.size && this.worker) {
        await this.worker.close();
        this.worker = null;
      }
    };
    const result = this.watchQueue.then(update);
    this.watchQueue = result.catch(() => {});
    return result;
  }

  drain() {
    return this.worker?.command('barrier');
  }

  followsTrack(key, track) {
    return this.entries.get(key)?.priorTracks.some(previous => sameTrack(previous, track)) === true;
  }

  async locate(dir, track) {
    const group = this.directories.get(directoryKey(dir));
    if (!group) return undefined;
    const result = await this.worker?.command('locate', group.dir, track.ino);
    if (!result) return undefined;
    return typeof result.path === 'string' && local(result.path) ? result.path : null;
  }

  async trackMovedFile(entry) {
    const revision = entry.revision;
    const dir = path.dirname(entry.path);
    const found = await this.locate(dir, entry.track);
    if (!found || entry !== this.entries.get(entry.key) || revision !== entry.revision) return;
    if (directoryKey(path.dirname(found)) !== directoryKey(dir)) {
      entry.path = found;
      entry.revision++;
      entry.backup = null;
      await this.alignWatches();
      this.changed(entry);
    }
  }

  async resolve(key, file, track, drain = true) {
    if (drain) await this.drain();
    const entry = this.entries.get(key);
    if (!entry || entry.savedPath !== file || !sameTrack(entry.savedTrack, track)) return resolveFileLink(file, track);
    for (;;) {
      const revision = entry.revision;
      const current = await resolveFileLink(entry.path, entry.track, async expected => {
        const found = await this.locate(path.dirname(entry.path), expected);
        if (found === undefined) return findTracked(expected);
        return found && sameTrack(await fileTrack(found), expected) ? found : null;
      });
      if (entry !== this.entries.get(key)) return resolveFileLink(file, track);
      if (revision !== entry.revision) continue;
      if (entry.backup && current?.path === path.join(path.dirname(entry.path), entry.backup.name)) return null;
      if (current && current.path !== entry.path) {
        const changedDirectory = directoryKey(path.dirname(current.path)) !== directoryKey(path.dirname(entry.path));
        entry.path = current.path;
        entry.revision++;
        entry.backup = null;
        if (changedDirectory) await this.alignWatches();
      }
      return current;
    }
  }

  changed(entry) {
    this.dirty.add(entry.key);
    if (this.dispatch || this.closed) return;
    this.dispatch = setImmediate(() => this.flushChanges());
  }

  flushChanges() {
    clearImmediate(this.dispatch);
    this.dispatch = null;
    const dirty = [...this.dirty];
    this.dirty.clear();
    for (const key of dirty) if (this.entries.has(key)) this.onChange(key);
  }

  observe(event) {
    if (this.closed || typeof event.dir !== 'string') return;
    const key = directoryKey(event.dir);
    const group = this.directories.get(key);
    if (!group) return;
    if (event.type === 'overflow' || event.type === 'error') {
      group.temporary.clear();
      group.renames.clear();
      for (const entry of group.entries) entry.backup = null;
      if (event.type === 'error') this.directories.delete(key);
      return;
    }
    const { name, ino, action } = event;
    if (event.type !== 'event' || !validName(name) || !/^[0-9a-f]{1,16}$/.test(ino || '') || (event.attributes & 16)) return;
    if (action === ADD && temporaryNames.some(pattern => pattern.test(name))) {
      if (group.temporary.size >= 256) group.temporary.delete(group.temporary.keys().next().value);
      group.temporary.set(ino, name);
    }
    const from = group.renames.get(ino);
    for (const entry of group.entries) {
      if (directoryKey(path.dirname(entry.path)) !== key || !validTrack(entry.track)) continue;
      const base = path.basename(entry.path);
      const format = OFFICE[path.extname(base).toLowerCase()];
      const known = entry.track.ino === ino;
      if (entry.backup?.saved && name === base &&
          ((ino === entry.backup.saved.ino && (action === REMOVE || action === RENAME_FROM)) ||
           (ino !== entry.backup.saved.ino && (action === ADD || action === RENAME_TO)))) entry.backup.saved = null;
      if (action === RENAME_FROM && ((known && name === base) || group.temporary.get(ino) === name)) {
        group.renames.set(ino, name);
      }
      if (action === RENAME_TO && known && name === base) entry.backup = null;
      if (action === RENAME_TO && known && from === base) {
        if (format?.backup.test(name)) entry.backup = { name, saved: null };
        else {
          entry.path = path.join(group.dir, name);
          entry.backup = null;
          entry.revision++;
          this.changed(entry);
        }
      } else if (action === RENAME_TO && name === base && entry.backup &&
          format?.saved.test(from || '') && group.temporary.get(ino) === from) {
        entry.backup.saved = { ...entry.track, ino };
      }
      // Office swaps its temporary file into the document name and removes the backup of the exact old ID.
      if (action === REMOVE && known && name === entry.backup?.name) {
        if (entry.backup.saved) {
          entry.priorTracks.push(entry.track);
          if (entry.priorTracks.length > 8) entry.priorTracks.shift();
          entry.track = entry.backup.saved;
        }
        entry.backup = null;
        entry.revision++;
        this.changed(entry);
      } else if (action === REMOVE && known && name === base) {
        entry.revision++;
        void this.trackMovedFile(entry).catch(() => {});
        this.changed(entry);
      }
    }
    if (action === RENAME_TO || action === REMOVE) {
      group.renames.delete(ino);
      group.temporary.delete(ino);
    }
  }

  async close() {
    this.closed = true;
    clearImmediate(this.dispatch);
    this.dirty.clear();
    await this.watchQueue;
    await this.worker?.close();
    this.directories.clear();
    this.entries.clear();
  }
}

module.exports = { FileMonitor, resolveFileLink, sameTrack };
