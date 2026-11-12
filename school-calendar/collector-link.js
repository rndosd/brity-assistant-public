'use strict';

const path = require('node:path');
const { execFile } = require('node:child_process');

const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const script = path.join(__dirname, 'collector-link.ps1');
const unavailable = Object.freeze({ status: 'unavailable', inboxDir: null, managed: false, imported: 0 });
// in-use: 선생님이 브리티를 쓰는 중이라 쪽지를 가져오지 않았다(캘린더가 확인을 묻는다).
const statuses = new Set(['ready', 'offline', 'unavailable', 'conflict', 'unverified', 'in-use']);

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;

function runCollector(mode, { scriptsDir, chatDirectory, roomKeys, signal, force = false, from = '', to = '' } = {}) {
  if (process.platform !== 'win32' || typeof scriptsDir !== 'string' || !path.isAbsolute(scriptsDir) || signal?.aborted) {
    return Promise.resolve(unavailable);
  }

  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Mode', mode, '-ScriptsDir', scriptsDir];
  const chatMode = mode === 'Chats' || mode === 'ChatRooms';
  if (chatMode) {
    if (typeof chatDirectory !== 'string' || !path.isAbsolute(chatDirectory)) return Promise.resolve(unavailable);
    args.push('-ChatDirectory', chatDirectory);
  }
  if (mode === 'Tick' && force === true) args.push('-Force');
  if (mode === 'Range' || mode === 'RangePreview') {
    if (from && !DAY.test(from)) return Promise.resolve(unavailable);
    if (to && !DAY.test(to)) return Promise.resolve(unavailable);
    if (from) args.push('-From', from);
    if (to) args.push('-To', to);
  }
  return new Promise(resolve => {
    // Collection can mark a message read. Once a tick has started, allow it to finish and save the note.
    const options = { windowsHide: true, encoding: 'utf8', maxBuffer: 16 * 1024 };
    if (mode === 'Inspect' || mode === 'RangePreview' || mode === 'ChatRooms') options.timeout = 45_000;
    if (mode === 'ChatRooms') options.maxBuffer = 512 * 1024;
    const child = execFile(powershell, args, options, (error, stdout) => {
      if (error) return resolve(unavailable);
      try {
        const result = JSON.parse(stdout);
        if (!statuses.has(result.status) || (result.inboxDir !== null && !path.isAbsolute(result.inboxDir))) return resolve(unavailable);
        const value = {
          status: result.status,
          inboxDir: result.inboxDir,
          managed: result.managed === true,
          imported: count(result.imported)
        };
        if (mode === 'Range' || mode === 'RangePreview') {
          Object.assign(value, {
            visible: count(result.visible), matched: count(result.matched), fresh: count(result.fresh), unknown: count(result.unknown),
            remaining: count(result.remaining), opened: count(result.opened), oldest: typeof result.oldest === 'string' && DAY.test(result.oldest) ? result.oldest : null
          });
        }
        if (chatMode) {
          Object.assign(value, {
            read: count(result.read), added: count(result.added), retry: count(result.retry), needsReview: count(result.needsReview),
            roomChoices: Array.isArray(result.roomChoices) ? result.roomChoices : []
          });
        }
        resolve(value);
      } catch {
        resolve(unavailable);
      }
    });
    if (mode === 'Chats') {
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify(roomKeys), 'utf8');
    }
  });
}

function inspectCollector(options) {
  return runCollector('Inspect', options);
}

// 쪽지만 가져온다. force면 브리티를 쓰는 중이어도 가져온다(선생님이 확인한 경우).
function collectOnce(options) {
  return runCollector('Tick', options);
}

// 대화방만 읽는다(쪽지와 따로 주기를 둔다).
function collectChats(options) {
  if (!Array.isArray(options?.roomKeys) || !options.roomKeys.length) return Promise.resolve({ status: 'ready', read: 0, added: 0 });
  return runCollector('Chats', options);
}

function listChatRooms(options) {
  return runCollector('ChatRooms', options);
}

function openBrityReply({ id, title, sender, datetime }, { scriptsDir } = {}) {
  if (process.platform !== 'win32' || typeof scriptsDir !== 'string' || !path.isAbsolute(scriptsDir)) return Promise.resolve('unavailable');
  const collector = path.join(scriptsDir, 'collect-notes.ps1');
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', collector, '-ShowNote', '-Reply'];
  return new Promise(resolve => {
    const child = execFile(powershell, args, {
      windowsHide: true, encoding: 'utf8', maxBuffer: 16 * 1024, timeout: 20_000
    }, (error, stdout) => resolve(error ? 'unavailable' : stdout.trim()));
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ id, title, sender, datetime }), 'utf8');
  });
}

// 지난 쪽지 불러오기(3단계): preview면 브리티 목록에 보이는 것 중 기간에 드는 수만 센다(아무것도 열지 않음).
function collectRange({ preview = false, ...options }) {
  return runCollector(preview ? 'RangePreview' : 'Range', options);
}

module.exports = { inspectCollector, collectOnce, collectChats, listChatRooms, collectRange, openBrityReply };
