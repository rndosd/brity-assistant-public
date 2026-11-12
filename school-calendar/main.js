'use strict';

const { app, BrowserWindow, ipcMain, shell, clipboard, safeStorage, dialog, Notification } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { CalendarStore, CalendarError } = require('./store');
const { apiProviders, refineWithProvider, classifierSample, cleanReplyBody } = require('./ai-provider');
const claudeCli = require('./claude-cli');
const { inspectCollector, collectOnce, collectChats, listChatRooms, collectRange, openBrityReply } = require('./collector-link');
const { buildWorkPrompt } = require('./work-prompt');
const taskModel = require('./renderer/task-model');
const updater = require('./updater');
const CHANGES = require('./CHANGES.json');
const { spawn } = require('node:child_process');

const view = path.join(__dirname, 'renderer', 'index.html');
const demo = process.argv.includes('--demo') ? require('./demo') : null;
const dataDir = demo?.dataDir || path.resolve(process.env.SCHOOL_CALENDAR_DATA_DIR || path.join(__dirname, 'data'));
// 수집기는 저장소의 collector 폴더 하나만 쓴다(배포 ZIP도 같은 구성).
const defaultInbox = process.env.SCHOOL_CALENDAR_DEFAULT_INBOX_DIR || path.join(__dirname, '..', 'collector', 'inbox');
const scriptsDir = path.dirname(defaultInbox);
const profile = path.join(dataDir, 'profile');
fs.mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);

let window;
let ready;
let refreshInterval;
let updateInterval;
let draining = false;
let closing = false;
let testingAi = false;
let collectorRun;
let brityReplyRun;
let pausingCollector = false;
let collector = { status: 'idle', managed: false };
let collectorCheckedAt = null;
let activity = null;      // 'notes' | 'chats': 지금 브리티에서 읽는 중인 것(머리줄 진행 표시)
let lastImported = null;  // 마지막 쪽지 확인에서 새로 받은 건수
let chatRun = null;
let lastChatCollection = null;
let noteTimer = null;
let chatTimer = null;
let inUseNotified = false;
let rangeImport = null; // { running, done, total, stopping } 지난 쪽지 불러오기 진행
let chatRefreshFailed = false;
let retryTimer = null;
let unverifiedSince = 0;
const lifetime = new AbortController();

// 업데이트(7단계): 배포 ZIP(portable-entry.cjs가 SCHOOL_CALENDAR_PORTABLE_ROOT를 넣음)에서만 켠다.
const UPDATE_REPO = 'rndosd/brity-assistant-public';
const portableRoot = process.env.SCHOOL_CALENDAR_PORTABLE_ROOT ? path.resolve(process.env.SCHOOL_CALENDAR_PORTABLE_ROOT) : null;
const manifestUrl = process.env.SCHOOL_CALENDAR_UPDATE_URL || `https://github.com/${UPDATE_REPO}/releases/latest/download/update.json`;
const releasePage = `https://github.com/${UPDATE_REPO}/releases/latest`;
const updatesEnabled = !demo && !!portableRoot;
let update = { status: 'idle' };
let updateRun = null;
let whatsNew = null;
const UPDATE_EVERY = 6 * 60 * 60 * 1000;

function userDownloads() {
  if (demo || process.env.SCHOOL_CALENDAR_INBOX_DIR) return undefined;
  try {
    return app.getPath('downloads');
  } catch {
    return undefined;
  }
}

const store = new CalendarStore({
  dataDir, inboxDir: demo?.inboxDir || defaultInbox, inboxOverride: demo?.inboxDir || process.env.SCHOOL_CALENDAR_INBOX_DIR,
  downloadsDir: userDownloads(),
  ruleSeed: path.join(__dirname, 'rules-seed.md'),
  automaticDefault: !demo && process.env.SCHOOL_CALENDAR_AUTOMATIC !== '0',
  // 새로 설치하면 AI 연결 전이다. 연결 시험이 성공하면 자동 분류가 켜진다.
  aiDefault: process.env.SCHOOL_CALENDAR_AI_DEFAULT === 'codex' ? 'codex' : 'none'
});

function snapshot() {
  const saved = store.snapshot();
  return { ...saved, appVersion: app.getVersion(), shortcutAvailable: !!portableRoot && fs.existsSync(path.join(portableRoot, 'Brity Messenger Calendar.exe')), update: { enabled: updatesEnabled, status: update.status, version: update.version ?? null, changes: update.changes ?? [], error: update.error ?? null }, whatsNew, rangeImport, demo: !!demo, factchatOffered: factchatOffered(), factchatGuideAvailable, collector: { status: collector.status, managed: collector.managed, checkedAt: collectorCheckedAt, imported: lastImported }, activity, collectorAvailable: !demo && !store.inboxOverride, chatRefreshFailed, chatCollection: selectedChatCollection(saved.chatRooms) };
}

function publish() {
  if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
    window.webContents.send('calendar:changed', snapshot());
  }
}

// 새 판 확인. 손으로 누르면 결과를 꼭 알리고, 저절로 확인할 때는 실패해도 조용히 넘어간다.
function checkUpdate(manual = false) {
  if (!updatesEnabled || updateRun || ['downloading', 'installing'].includes(update.status)) return Promise.resolve(snapshot());
  updateRun = (async () => {
    const previous = update;
    if (manual) { update = { ...update, status: 'checking', error: null }; publish(); }
    try {
      const result = await updater.checkForUpdate({ manifestUrl, current: app.getVersion(), electron: process.versions.electron, signal: lifetime.signal });
      update = result.status === 'latest' ? { status: 'latest', version: app.getVersion(), checkedAt: Date.now() }
        : { status: result.status, version: result.version, changes: result.changes, checkedAt: Date.now(), manifest: result };
    } catch (error) {
      if (error?.status === 404) update = { status: 'unavailable', checkedAt: Date.now() };
      else update = manual ? { ...previous, status: 'failed', error: '새 판을 확인하지 못했습니다. 인터넷 연결을 확인한 뒤 다시 눌러 주세요.' } : previous;
    } finally {
      updateRun = null;
      publish();
    }
    return snapshot();
  })();
  return updateRun;
}

// 업데이트 버튼: 패치를 받아 지문을 맞추고 풀어 둔 뒤, 교체 스크립트를 띄우고 앱을 끈다.
async function applyUpdate() {
  if (!updatesEnabled || update.status !== 'available' || !update.manifest) throw new CalendarError('지금 받을 수 있는 새 판이 없습니다.');
  if (collectorRun || brityReplyRun || draining) throw new CalendarError('쪽지를 가져오거나 정리하는 중입니다. 잠시 뒤 다시 눌러 주세요.');
  const manifest = update.manifest;
  update = { ...update, status: 'downloading', error: null };
  publish();
  let staging;
  try {
    staging = await updater.downloadPatch({ manifestUrl, update: manifest, stagingRoot: path.join(portableRoot, 'update-staging'), signal: lifetime.signal });
  } catch {
    update = { ...update, status: 'available', error: '새 판을 받지 못했습니다. 인터넷 연결을 확인한 뒤 다시 눌러 주세요.' };
    publish();
    throw new CalendarError(update.error);
  }
  update = { ...update, status: 'installing' };
  publish();
  // 교체가 중간에 끊겨도 다음에 실행기로 켤 때 마저 바꾸도록 적어 둔다(update-apply.ps1이 끝나면 지운다).
  await fs.promises.writeFile(path.join(portableRoot, 'update-staging', 'pending.txt'), staging, 'utf8');
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
    '-File', path.join(staging, 'update-apply.ps1'), '-Root', portableRoot, '-Staging', staging, '-WaitPid', String(process.pid)],
  { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  setTimeout(() => app.quit(), 300);
  return snapshot();
}

// 판이 올라간 뒤 처음 켜면 무엇이 바뀌었는지 한 번 보여 준다. 새로 설치한 경우는 기록만 한다.
async function noteVersion() {
  if (demo) return;
  const current = app.getVersion();
  const seen = store.settings.seenVersion;
  if (seen === current) return;
  try {
    if (seen && updater.compareVersions(current, seen) > 0) whatsNew = { version: current, changes: updater.changesBetween(CHANGES, seen, current) };
  } catch {}
  await store.markVersionSeen(current);
}

function savedApiKey(connection) {
  const encrypted = store.settings[connection.keySetting];
  try {
    if (!encrypted || !safeStorage.isEncryptionAvailable()) throw new Error('Key unavailable');
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
  } catch {
    throw new CalendarError(`설정에서 ${connection.name} 키를 다시 연결해 주세요.`);
  }
}

// 일반판과 소스 실행에서는 기존 팩트챗 연결만 유지한다.
const seoryongEdition = process.env.SCHOOL_CALENDAR_SEORYONG === '1';
const factchatGuideUrl = URL.canParse(process.env.SCHOOL_CALENDAR_FACTCHAT_GUIDE)
  ? new URL(process.env.SCHOOL_CALENDAR_FACTCHAT_GUIDE) : null;
const factchatGuideAvailable = seoryongEdition && factchatGuideUrl?.protocol === 'https:' &&
  factchatGuideUrl.hostname.endsWith('.factchat.bot');
function factchatOffered() {
  return seoryongEdition || store.aiProvider === 'factchat';
}

function runRefiner(note, options) {
  const provider = store.aiProvider;
  const connection = apiProviders.get(provider);
  return refineWithProvider(provider, note, {
    ...options,
    apiKey: connection ? savedApiKey(connection) : undefined, signal: lifetime.signal
  });
}

async function connectAi(provider, inputKey) {
  if (demo || testingAi) throw new CalendarError('AI 연결 시험을 사용할 수 없습니다.');
  const connection = apiProviders.get(provider);
  if (!connection && provider !== 'none' && provider !== 'codex' && provider !== 'claude') throw new CalendarError('AI 연결 방식을 선택해 주세요.');
  if (provider === 'factchat' && !factchatOffered()) throw new CalendarError('이 판에서는 팩트챗을 쓸 수 없습니다. 다른 연결 방식을 골라 주세요.');
  testingAi = true;
  try {
    if (provider === 'none') {
      await store.saveAiConnection(provider);
      publish();
      return snapshot();
    }
    let apiKey;
    if (connection) {
      apiKey = typeof inputKey === 'string' ? inputKey.trim() : '';
      if (!apiKey && store.aiProvider === provider) apiKey = savedApiKey(connection);
      if (!connection.keyPattern.test(apiKey)) throw new CalendarError(`${connection.name} 키를 붙여 넣어 주세요.`);
      if (!safeStorage.isEncryptionAvailable()) throw new CalendarError('이 Windows 계정에서 API 키를 보호해 저장할 수 없습니다.');
    }
    const sample = await refineWithProvider(provider, classifierSample, {
      rulesPath: path.join(__dirname, 'rules-seed.md'), codexExecutable: store.settings.codexExecutable, claudeExecutable: store.settings.claudeExecutable,
      apiKey, signal: lifetime.signal
    });
    let checked;
    try { checked = taskModel.fromResult(sample, classifierSample.title); } catch { checked = null; }
    if (checked?.type !== '할 일' || !checked.dates.some(entry => entry.date === '2030-05-10')) {
      throw new CalendarError('가짜 쪽지의 분류 결과가 예상과 다릅니다. 연결 시험을 다시 눌러 주세요.');
    }
    const encrypted = apiKey ? safeStorage.encryptString(apiKey).toString('base64') : undefined;
    await store.saveAiConnection(provider, encrypted);
    publish();
    return snapshot();
  } finally {
    testingAi = false;
    void autoRefine();
  }
}

async function autoRefine() {
  if (demo || draining || testingAi || closing || store.aiProvider === 'none') return;
  draining = true;
  try {
    let id;
    while (!closing && !testingAi && (id = store.nextAutomatic())) {
      await store.refine(id, runRefiner, { automatic: true, onStarted: publish });
      publish();
    }
  } catch {
    publish();
  } finally {
    draining = false;
  }
}

async function refresh(options) {
  await store.refresh(options);
  // 샘플도 data/chats의 가상 대화로 후보함을 보여 준다(브리티 수집은 하지 않음).
  try {
    await store.refreshChat();
    chatRefreshFailed = false;
  } catch {
    chatRefreshFailed = true;
  }
  publish();
  void autoRefine();
  return snapshot();
}

// 쪽지 가져오기(2단계). 자동 갱신 주기·"쪽지 가져오기" 버튼·알림 클릭에서 부른다.
// manual: 버튼으로 가져옴(자동 분류가 꺼져 있어도 새 쪽지를 분류한다). force: 브리티를 쓰는 중이어도 가져온다(선생님이 확인함).
function pollCollector(connect = false, { manual = false, force = false, firstImport = false } = {}) {
  if (collectorRun) return collectorRun;
  if (chatRun) return chatRun.catch(() => {}).then(() => pollCollector(connect, { manual, force, firstImport }));
  if (!firstImport && store.settings.collectorFirstImportPending) return Promise.resolve(snapshot());
  if (closing || pausingCollector || brityReplyRun || demo || store.inboxOverride || (!connect && !store.settings.collectorConnected)) return Promise.resolve(snapshot());
  const started = Date.now();
  collectorRun = (async () => {
    try {
      if (connect || !collector.managed || !['ready', 'in-use'].includes(collector.status)) {
        if (connect || collector.status === 'idle') {
          collector = { status: 'connecting', managed: false };
          publish();
        }
        collector = await inspectCollector({ scriptsDir, signal: lifetime.signal });
        if (closing || pausingCollector) return snapshot();
        if (collector.status !== 'ready' || !collector.inboxDir) return firstImport ? snapshot() : await refresh();
        if (firstImport) {
          await store.saveCollectorConnection(collector.inboxDir, { firstImport: true });
          scheduleAutoRefresh();
          return snapshot();
        }
        if (!store.settings.collectorConnected || collector.inboxDir !== store.inboxDir) {
          await store.saveCollectorConnection(collector.inboxDir);
          await refresh();
        }
      }
      if (collector.managed && !closing && !pausingCollector) {
        // 머리줄에 "브리티에서 쪽지 확인 중"을 보인다. 돌려주는 snapshot에 남지 않게 수집이 끝나면 바로 지운다.
        activity = 'notes';
        publish();
        try { collector = await collectOnce({ scriptsDir, force, signal: lifetime.signal }); }
        finally { activity = null; }
        if (collector.status === 'ready') lastImported = Number.isSafeInteger(collector.imported) ? collector.imported : 0;
        if (collector.status === 'ready' && collector.inboxDir && collector.inboxDir !== store.inboxDir) {
          await store.saveCollectorConnection(collector.inboxDir);
        }
      }
      if (collector.status === 'in-use' && !manual) notifyInUse();
      if (collector.status !== 'in-use') inUseNotified = false;
      return closing ? snapshot() : await refresh(manual ? { classifyFrom: started } : undefined);
    } catch {
      collector = { status: 'unavailable', managed: false };
      return snapshot();
    } finally {
      collectorRun = null;
      collectorCheckedAt = Date.now();
      // Testing aid: set SCHOOL_CALENDAR_TRACE to a file path to record the result of every check.
      if (process.env.SCHOOL_CALENDAR_TRACE) fs.appendFile(process.env.SCHOOL_CALENDAR_TRACE, `${new Date().toTimeString().slice(0, 8)} calendar=${collector.status}\n`, () => {});
      publish();
      // Brity is running but unreadable (its window has not been shown since it started). Check again soon
      // so opening the window connects within seconds; after two minutes fall back to the regular interval.
      clearTimeout(retryTimer);
      if (collector.status !== 'unverified') unverifiedSince = 0;
      else if (!firstImport && !closing && !pausingCollector && store.settings.collectorConnected) {
        unverifiedSince ||= Date.now();
        if (Date.now() - unverifiedSince < 120_000) retryTimer = setTimeout(() => void pollCollector(), 5_000);
      }
    }
  })();
  return collectorRun;
}

// 지난 쪽지 불러오기(3단계). 수집기가 브리티 목록을 내려 가며 시작일까지 읽는다(실측 2026-11-12: 한 번에 10줄쯤만 나와 스크롤, 날짜는 월·일).
function rangeDays(from, to) {
  const day = /^\d{4}-\d{2}-\d{2}$/;
  if ((from && !day.test(from)) || (to && !day.test(to)) || (!from && !to)) throw new CalendarError('시작일과 끝일을 골라 주세요.');
  if (from && to && from > to) throw new CalendarError('시작일이 끝일보다 늦습니다.');
  return { from: from || '', to: to || '' };
}

function rangeReady() {
  if (demo || store.inboxOverride) throw new CalendarError('샘플에서는 지난 쪽지를 불러올 수 없습니다.');
  if (!store.settings.collectorConnected || !collector.managed) throw new CalendarError('머리줄에서 브리티를 먼저 연결해 주세요.');
  if (collectorRun || chatRun || brityReplyRun || rangeImport?.running) throw new CalendarError('브리티에서 처리 중입니다. 잠시 뒤 다시 눌러 주세요.');
}

async function previewRange(from, to) {
  const days = rangeDays(from, to);
  rangeReady();
  const run = collectRange({ preview: true, scriptsDir, signal: lifetime.signal, ...days });
  collectorRun = run.then(() => snapshot());
  try {
    const result = await run;
    if (result.status !== 'ready') throw new CalendarError('브리티 쪽지 목록을 읽지 못했습니다. 브리티 창을 한 번 열어 둔 뒤 다시 눌러 주세요.');
    return { visible: result.visible, matched: result.matched, fresh: result.fresh, unknown: result.unknown, oldest: result.oldest };
  } finally {
    collectorRun = null;
  }
}

async function importRange(from, to) {
  const days = rangeDays(from, to);
  rangeReady();
  rangeImport = { running: true, done: 0, total: 0, stopping: false };
  publish();
  const work = (async () => {
    let failed = false;
    // 한 번에 20건씩 연다. 확인하지 못한 쪽지가 남아 계속 돌지 않도록 횟수를 묶는다.
    for (let round = 0; round < 10 && !closing && !rangeImport.stopping; round++) {
      const result = await collectRange({ scriptsDir, signal: lifetime.signal, ...days });
      if (result.status !== 'ready') { failed = true; break; }
      rangeImport.done += result.imported;
      rangeImport.total = Math.max(rangeImport.total, rangeImport.done + result.remaining);
      await store.refresh();
      publish();
      if (!result.remaining || !result.opened) break;
    }
    return failed;
  })();
  collectorRun = work.then(() => snapshot(), () => snapshot());
  try {
    const failed = await work;
    const summary = { imported: rangeImport.done, stopped: rangeImport.stopping, failed, pending: store.rangePending().length };
    return summary;
  } catch {
    return { imported: rangeImport.done, stopped: false, failed: true, pending: store.rangePending().length };
  } finally {
    collectorRun = null;
    rangeImport = null;
    await refresh().catch(() => {});
  }
}

// 자동 갱신 때 브리티를 쓰는 중이면 Windows 알림으로 묻는다. 누르면 지금 가져오고, 그냥 두면 다음 주기에 다시 본다.
function notifyInUse() {
  if (inUseNotified || !Notification.isSupported()) return;
  inUseNotified = true;
  const note = new Notification({
    title: '브리티 메신저 캘린더', icon: path.join(__dirname, 'assets', 'app.png'),
    body: '브리티를 쓰는 중이라 새 쪽지를 가져오지 않았습니다. 이 알림을 누르면 지금 가져옵니다.'
  });
  note.on('click', () => {
    if (window && !window.isDestroyed()) { if (window.isMinimized()) window.restore(); window.focus(); }
    void pollCollector(false, { manual: true, force: true });
  });
  note.show();
}

function chatOptions() {
  return { scriptsDir, chatDirectory: path.join(dataDir, 'chats'), signal: lifetime.signal };
}

function chatBusy() {
  return chatRun || collectorRun || closing || pausingCollector || brityReplyRun;
}

function runChatOperation(action) {
  chatRun = Promise.resolve().then(action).finally(() => { chatRun = null; });
  return chatRun;
}

function checkChatResult(result) {
  if (result.status === 'ready') return result;
  const messages = {
    offline: '브리티 메신저에 로그인한 뒤 다시 눌러 주세요.',
    'in-use': '브리티를 쓰는 중이라 읽지 않았습니다. 다른 창을 누른 뒤 다시 눌러 주세요.',
    conflict: '브리티에서 처리 중입니다. 잠시 뒤 다시 눌러 주세요.'
  };
  throw new CalendarError(messages[result.status] || '브리티 대화방을 읽지 못했습니다. 브리티 창을 한 번 열었다가 다른 창으로 옮긴 뒤 다시 눌러 주세요.');
}

function chatCollectionSummary(result, roomKeys, checkedAt) {
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
  const status = result.status === 'waiting' ? 'in-use' : result.status === 'busy' ? 'conflict' : result.status;
  const holds = (Array.isArray(result.holds) ? result.holds : result.holds ? [result.holds] : [])
    .filter(item => typeof item?.key === 'string' && typeof item.reason === 'string').map(({ key, reason }) => ({ key, reason }));
  return {
    roomKeys, checkedAt, status, added: count(result.added), read: count(result.read),
    retry: count(result.retry), needsReview: count(result.needsReview), baselines: count(result.baselines),
    gaps: count(result.gaps), holds, candidates: count(result.candidates)
  };
}

function selectedChatCollection(rooms) {
  if (!lastChatCollection) return null;
  const { roomKeys, ...summary } = lastChatCollection;
  if (rooms.length !== roomKeys.length || rooms.some(room => !roomKeys.includes(room.key))) return null;
  return summary;
}

async function loadLastChatCollection() {
  lastChatCollection = null;
  if (demo || store.inboxOverride) return;
  try {
    const record = JSON.parse(await fs.promises.readFile(path.join(dataDir, 'chats', 'status.json'), 'utf8'));
    const checkedAt = Date.parse(record.checkedAt);
    if (Number.isFinite(checkedAt) && Array.isArray(record.roomKeys)) {
      lastChatCollection = chatCollectionSummary(record, record.roomKeys, checkedAt);
    }
  } catch {
    // 아직 기록이 없거나 이전 판에서 만든 상태 파일이다.
  }
}

async function loadChatRooms() {
  if (demo) return { roomChoices: demo.listChatRooms(), needsReview: 0 };
  if (store.inboxOverride) throw new CalendarError('이 실행 환경에서는 브리티 대화방을 읽을 수 없습니다.');
  if (chatBusy()) throw new CalendarError('브리티에서 처리 중입니다. 잠시 뒤 다시 눌러 주세요.');
  return runChatOperation(async () => checkChatResult(await listChatRooms(chatOptions())));
}

// 대화방 자동 갱신은 저장한 방만 읽는다.
async function pollChats() {
  if (collectorRun) await collectorRun.catch(() => {});
  if (demo || store.inboxOverride || chatBusy()) return;
  if (store.settings.collectorFirstImportPending || !store.autoRefreshValue('chats').enabled) return;
  const roomKeys = store.chatRooms().map(room => room.key);
  if (!roomKeys.length) return;
  return runChatOperation(() => collectChatRooms(roomKeys));
}

// 고른 방을 읽고, 새 글을 바로 묶어 후보를 찾는다(기다리지 않음). 머리줄은 읽는 중 → 후보 찾는 중으로 바뀐다.
async function collectChatRooms(roomKeys) {
  const live = () => new Set(store.tasks.filter(task => task.candidate && !task.candidate.discarded).map(task => task.id));
  const before = live();
  const result = await readChats(roomKeys);
  if (!closing) {
    activity = 'chat-deciding';
    publish();
    try { await refresh(); } finally { activity = null; }
  }
  const candidates = [...live()].filter(id => !before.has(id)).length;
  lastChatCollection = chatCollectionSummary({ ...result, candidates }, roomKeys, Date.now());
  publish();
  return snapshot();
}

// 대화방을 읽는 동안 머리줄에 "브리티에서 대화방 읽는 중"을 보인다.
async function readChats(roomKeys) {
  activity = 'chats';
  publish();
  try { return await collectChats({ ...chatOptions(), roomKeys }); }
  finally { activity = null; }
}

// 설정의 대화방 "지금 가져오기". 자동이 꺼져 있어도 저장한 방을 한 번 읽는다.
// 브리티를 쓰는 중(창이 맨 앞) 같은 사정은 오류로 던지지 않고 마지막 확인 기록에 남겨 화면이 보여 준다.
async function collectChatsNow() {
  if (demo || store.inboxOverride) throw new CalendarError('샘플에서는 대화방을 가져올 수 없습니다.');
  const roomKeys = store.chatRooms().map(room => room.key);
  if (!roomKeys.length) throw new CalendarError('가져올 대화방을 먼저 골라 저장해 주세요.');
  if (chatBusy()) throw new CalendarError('브리티에서 처리 중입니다. 잠시 뒤 다시 눌러 주세요.');
  return runChatOperation(() => collectChatRooms(roomKeys));
}

// 설정의 자동 갱신 주기로 타이머를 다시 건다.
function scheduleAutoRefresh() {
  clearInterval(noteTimer);
  noteTimer = null;
  const notes = store.autoRefreshValue('notes');
  if (!demo && !store.settings.collectorFirstImportPending && notes.enabled) {
    noteTimer = setInterval(() => void pollCollector(), notes.minutes * 60_000);
  }
  scheduleChatRefresh();
}

function scheduleChatRefresh() {
  clearInterval(chatTimer);
  chatTimer = null;
  if (demo || store.inboxOverride || store.settings.collectorFirstImportPending) return;
  const chats = store.autoRefreshValue('chats');
  if (chats.enabled && store.chatRooms().length) {
    chatTimer = setInterval(() => void pollChats().catch(() => {}), chats.minutes * 60_000);
  }
}

// 앱을 짧은 경로(C:\Users\WINDOW~1\…)로 켜면 창 주소와 view 경로의 글자가 달라진다. 실제 파일 경로로 견준다.
let viewRealPath = null;
function isCalendarPage(url) {
  if (url === pathToFileURL(view).href) return true;
  if (typeof url !== 'string' || !url.startsWith('file:')) return false;
  try {
    viewRealPath ??= fs.realpathSync.native(view).toLowerCase();
    return fs.realpathSync.native(fileURLToPath(url)).toLowerCase() === viewRealPath;
  } catch {
    return false;
  }
}

function bind(action, handler) {
  ipcMain.handle(`calendar:${action}`, async (event, ...args) => {
    const frame = event.senderFrame;
    if (!window || event.sender !== window.webContents || !frame || frame !== event.sender.mainFrame || !isCalendarPage(frame.url)) {
      return { ok: false, error: '캘린더 창에서만 사용할 수 있습니다.' };
    }
    try {
      await ready;
      return { ok: true, value: await handler(...args) };
    } catch (error) {
      return { ok: false, error: error instanceof CalendarError ? error.message : '작업을 완료하지 못했습니다. 잠시 뒤 다시 시도해 주세요.' };
    }
  });
}

function changed(task) {
  publish();
  return task;
}

async function replyInBrity(id) {
  if (demo || closing) throw new CalendarError('현재는 브리티 답장창을 열 수 없습니다.');
  const task = store.getTask(id);
  const note = store.notes.get(task.noteId);
  if (note?.verified !== true || store.inbox.status !== 'ready') {
    throw new CalendarError('캘린더에서 원문이 확인된 쪽지의 답장창을 열 수 있습니다.');
  }
  if (collectorRun || chatRun || brityReplyRun) throw new CalendarError('브리티에서 처리 중입니다. 잠시 뒤 다시 눌러 주세요.');
  brityReplyRun = openBrityReply(note, { scriptsDir });
  try {
    const result = await brityReplyRun;
    if (result === 'opened' || result === 'opened-background') return { foreground: result === 'opened' };
    // 답장창은 못 열었어도 브리티에 그 쪽지는 띄워 둔 경우: 실패가 아니라 안내로 돌려준다.
    const shown = {
      'reply-unavailable': '브리티에 쪽지를 띄웠습니다. 답장 버튼을 찾지 못해 답장창은 열지 않았습니다. 브리티에서 답장을 눌러 주세요.',
      'reply-in-use': '브리티에 쪽지를 띄웠습니다. 작성 중인 쪽지 창이 있어 답장창은 열지 않았습니다.',
      'reply-unconfirmed': '브리티에 쪽지를 띄웠습니다. 답장창이 열렸는지는 확인하지 못했습니다. 작업 표시줄에서 브리티 창을 확인해 주세요.'
    };
    if (shown[result]) return { foreground: false, notice: shown[result] };
    const messages = {
      busy: '브리티 수집기가 사용 중입니다. 아래 보낸 사람과 받은 시각으로 브리티에서 쪽지를 찾을 수 있습니다.',
      offline: '브리티 메신저에 로그인한 뒤 다시 눌러 주세요.',
      'not-found': '현재 쪽지 목록에서 찾지 못했습니다. 아래 보낸 사람과 받은 시각으로 찾아 주세요.',
      unverified: '브리티에 표시된 쪽지를 확인하지 못했습니다. 아래 보낸 사람과 받은 시각으로 찾아 주세요.'
    };
    throw new CalendarError(messages[result] || '브리티 답장창을 열 수 없습니다. 아래 보낸 사람과 받은 시각으로 찾아 주세요.');
  } finally {
    brityReplyRun = null;
  }
}

function bindHandlers() {
  bind('load', snapshot);
  bind('refresh', refresh);
  bind('detail', id => store.detail(id));
  bind('message-seen', async (kind, id) => changed(await store.markMessageSeen(kind, id)));
  bind('chat-batch', id => store.chatBatch(id));
  bind('forwarded-accept', async (batchId, messageIndex, lineIndex, input) => changed(await store.acceptForwardedLine(batchId, messageIndex, lineIndex, input)));
  bind('forwarded-review', async id => changed(await store.reviewForwardedBatch(id)));
  bind('chat-batch-finish', async (id, candidateIds) => {
    await store.finishChatBatch(id, candidateIds);
    return changed(snapshot());
  });
  bind('brity-reply', replyInBrity);
  bind('create', async input => changed(await store.create(input)));
  bind('update', async (id, input) => changed(await store.update(id, input)));
  bind('reference-seen', async id => changed(await store.markReferenceSeen(id)));
  bind('candidate-accept', async (id, input) => changed(await store.acceptCandidate(id, input)));
  bind('candidate-apply', async (id, targetId) => changed(await store.applyCandidateChange(id, targetId)));
  bind('candidate-discard', async input => changed(await store.discardCandidates({ id: input?.id, batchId: input?.batchId })));
  bind('candidate-restore', async id => changed(await store.restoreCandidate(id)));
  bind('done', async (id, done, index) => changed(await store.setDone(id, done, index === undefined ? 'all' : index)));
  bind('pinned', async (id, pinned) => changed(await store.setPinned(id, pinned)));
  bind('important', async (id, important) => changed(await store.setImportant(id, important)));
  bind('replied', async (id, replied) => changed(await store.setReplied(id, replied)));
  bind('profile', async input => changed(await store.setProfile(input)));
  bind('refine', async id => {
    if (demo) throw new CalendarError('샘플에 준비된 정리 내용을 볼 수 있습니다.');
    if (store.aiProvider === 'none') throw new CalendarError('설정에서 AI를 먼저 연결해 주세요.');
    return changed(await store.refine(id, runRefiner, { onStarted: publish }));
  });
  bind('refine-preview', async id => {
    // 다듬기 전에 보낼 내용을 보여 준다.
    const { note } = await store.detail(id);
    if (!note) throw new CalendarError('다듬을 원문을 불러올 수 없습니다.');
    const connection = apiProviders.get(store.aiProvider);
    return {
      provider: connection?.name ?? 'Codex CLI(OpenAI)',
      title: note.title, body: connection ? cleanReplyBody(note.body) : note.body,
      attachmentNames: connection ? [] : note.attachments.map(item => item.name)
    };
  });
  bind('ai-connect', connectAi);
  bind('claude-status', () => ({ executable: claudeCli.findClaude(store.settings.claudeExecutable) }));
  // 설치는 반드시 묻고 한다. 무엇을 어디서 받아 어디에 까는지 보여 준다.
  bind('claude-install', async () => {
    if (demo) throw new CalendarError('샘플에서는 쓸 수 없습니다.');
    const existing = claudeCli.findClaude(store.settings.claudeExecutable);
    if (existing) return { executable: existing, installed: false };
    const { response } = await dialog.showMessageBox(window, {
      type: 'question', buttons: ['설치', '취소'], defaultId: 0, cancelId: 1, noLink: true,
      title: 'Claude Code 설치', message: '이 PC에 Claude Code가 없습니다. 지금 설치할까요?',
      detail: `Anthropic 공식 설치 명령으로 Claude Code를 내려받아 이 Windows 사용자 폴더(${path.join(os.homedir(), '.local', 'bin')})에 설치합니다. 관리자 권한은 필요 없고 1~2분 걸립니다.\n\n실행할 명령: ${claudeCli.INSTALL_COMMAND}\n\n설치가 끝나면 로그인 창이 열립니다.`
    });
    if (response !== 0) return { executable: null, installed: false, cancelled: true };
    const { executable } = await claudeCli.installClaude({ signal: lifetime.signal });
    return { executable, installed: true };
  });
  bind('claude-login', async () => {
    if (demo) throw new CalendarError('샘플에서는 쓸 수 없습니다.');
    return claudeCli.openClaudeLogin(store.settings.claudeExecutable);
  });
  bind('claude-install-copy', () => {
    clipboard.writeText(claudeCli.INSTALL_COMMAND);
    return claudeCli.INSTALL_COMMAND;
  });
  bind('open-ai-guide', async page => {
    const urls = {
      key: 'https://platform.openai.com/api-keys',
      billing: 'https://platform.openai.com/settings/organization/billing/overview',
      codex: 'https://learn.chatgpt.com/docs/codex/cli'
    };
    if (page === 'factchat' && factchatGuideAvailable) {
      await shell.openExternal(factchatGuideUrl.href);
      return;
    }
    if (page === 'claude') {
      const failure = await shell.openPath(path.join(__dirname, 'Claude-연결-안내.html'));
      if (failure) throw new CalendarError('안내서를 열지 못했습니다. 앱 폴더의 Claude-연결-안내.html을 직접 열어 주세요.');
      return;
    }
    if (!Object.hasOwn(urls, page)) throw new CalendarError('열 수 없는 안내입니다.');
    await shell.openExternal(urls[page]);
  });
  bind('collector-connect', () => pollCollector(true, { firstImport: true }));
  bind('collector-first-import-finish', async automatic => {
    await store.finishCollectorFirstImport(automatic);
    scheduleAutoRefresh();
    publish();
    return snapshot();
  });
  // 쪽지 가져오기 버튼. force는 "브리티를 쓰는 중입니다. 지금 가져올까요?"에 예라고 답한 경우.
  bind('collect-now', force => pollCollector(!store.settings.collectorConnected, { manual: true, force: force === true }));
  bind('range-preview', previewRange);
  bind('range-import', importRange);
  bind('range-stop', () => { if (rangeImport) rangeImport.stopping = true; publish(); return snapshot(); });
  bind('range-classify', async () => {
    const count = await store.queueRangeClassify();
    publish();
    void autoRefine();
    return count;
  });
  bind('auto-refresh', async input => {
    await store.setAutoRefresh(input);
    scheduleAutoRefresh();
    publish();
    return snapshot();
  });
  bind('chats-collect-now', collectChatsNow);
  bind('chat-rooms-list', loadChatRooms);
  bind('chat-rooms-save', rooms => {
    if (chatBusy()) throw new CalendarError('브리티에서 처리 중입니다. 잠시 뒤 다시 저장해 주세요.');
    return runChatOperation(async () => {
      await store.setChatRooms(rooms);
      scheduleChatRefresh();
      publish();
      return snapshot();
    });
  });
  bind('automatic', async enabled => {
    if (demo) throw new CalendarError('샘플은 준비된 데이터로 표시합니다.');
    if (enabled && store.aiProvider === 'none') throw new CalendarError('AI 연결 시험을 먼저 완료해 주세요.');
    await store.setAutomatic(enabled);
    publish();
    if (enabled) void autoRefine();
    return snapshot();
  });
  // 첨부 저장 폴더: 폴더 고르기 창에서 고르거나 기본(Windows 다운로드)으로 되돌린다.
  bind('downloads-choose', async () => {
    if (!store.downloadsDir) throw new CalendarError('샘플에서는 첨부를 따로 저장하지 않습니다.');
    const { canceled, filePaths } = await dialog.showOpenDialog(window, {
      title: '첨부 저장 폴더 고르기', defaultPath: store.snapshot().downloads.folder, properties: ['openDirectory', 'createDirectory']
    });
    if (canceled || !filePaths?.[0]) return snapshot();
    await store.setDownloadsDir(filePaths[0]);
    publish();
    return snapshot();
  });
  bind('downloads-reset', async () => {
    await store.setDownloadsDir(null);
    publish();
    return snapshot();
  });
  bind('downloads-open', async () => {
    const { folder } = store.snapshot().downloads;
    if (!folder || await shell.openPath(folder)) throw new CalendarError('저장 폴더를 열 수 없습니다.');
  });
  // 7단계: 백업 만들기·되돌리기, 정리 기준 새 판 고르기.
  bind('backup-create', async () => {
    const { canceled, filePath } = await dialog.showSaveDialog(window, {
      title: '백업 저장', defaultPath: path.join(app.getPath('documents'), `BrityMessengerCalendar-backup-${new Date().toISOString().slice(0, 10)}.zip`),
      filters: [{ name: '백업 ZIP', extensions: ['zip'] }]
    });
    if (canceled || !filePath) return { saved: false };
    const { buffer, manifest } = await store.createBackup();
    await fs.promises.writeFile(filePath, buffer);
    return { saved: true, file: filePath, tasks: manifest.tasks, notes: manifest.notes };
  });
  bind('backup-restore', async () => {
    if (collectorRun || brityReplyRun || draining) throw new CalendarError('쪽지를 가져오거나 정리하는 중입니다. 잠시 뒤 다시 눌러 주세요.');
    const { canceled, filePaths } = await dialog.showOpenDialog(window, {
      title: '되돌릴 백업 고르기', defaultPath: app.getPath('documents'), properties: ['openFile'], filters: [{ name: '백업 ZIP', extensions: ['zip'] }]
    });
    if (canceled || !filePaths?.[0]) return { restored: false };
    const stat = await fs.promises.stat(filePaths[0]);
    if (stat.size > 2 * 1024 ** 3) throw new CalendarError('백업 파일이 너무 큽니다.');
    pausingCollector = true;
    try {
      await Promise.allSettled([collectorRun, chatRun]);
      const result = await store.restoreBackup(await fs.promises.readFile(filePaths[0]));
      await loadLastChatCollection();
      scheduleAutoRefresh();
      await refresh();
      return { restored: true, safety: result.safety, aiReset: result.aiReset, snapshot: snapshot() };
    } finally {
      pausingCollector = false;
    }
  });
  // 바탕 화면 바로 가기: 배포 폴더의 실행기(아이콘 있음)를 가리킨다.
  bind('shortcut-create', async () => {
    const launcher = portableRoot && path.join(portableRoot, 'Brity Messenger Calendar.exe');
    if (!launcher || !fs.existsSync(launcher)) throw new CalendarError('배포용 폴더에서 연 캘린더에서만 바로 가기를 만들 수 있습니다.');
    const link = path.join(app.getPath('desktop'), '브리티 메신저 캘린더.lnk');
    const ok = shell.writeShortcutLink(link, fs.existsSync(link) ? 'replace' : 'create', {
      target: launcher, cwd: portableRoot, icon: launcher, iconIndex: 0, description: '브리티 메신저 캘린더'
    });
    if (!ok) throw new CalendarError('바로 가기를 만들지 못했습니다.');
    return { link };
  });
  bind('update-check', () => checkUpdate(true));
  bind('update-apply', applyUpdate);
  bind('update-page', () => shell.openExternal(releasePage));
  bind('whats-new-dismiss', () => { whatsNew = null; return snapshot(); });
  bind('changes', () => ({ version: app.getVersion(), changes: updater.changesBetween(CHANGES, null, app.getVersion()).slice(0, 5) }));
  bind('rules-resolve', async choice => changed(await store.resolveRules(choice)));
  bind('periods', async enabled => changed(await store.setShowPeriods(enabled)));
  bind('rules', async () => {
    const error = await shell.openPath(store.rulesPath);
    if (error) throw new CalendarError('정리 기준 파일을 열 수 없습니다.');
  });
  bind('attachment', async (id, index, reveal) => {
    const attachment = await store.attachment(id, index);
    if (reveal === true || !attachment.direct) {
      shell.showItemInFolder(attachment.path);
      return { revealed: true };
    }
    const error = await shell.openPath(attachment.path);
    if (error) throw new CalendarError('첨부를 열 수 없습니다. 폴더에서 파일과 연결 프로그램을 확인해 주세요.');
    return { revealed: false };
  });
  bind('copy-work', async id => {
    const { task, note } = await store.detail(id);
    if (task.chatSource) throw new CalendarError('대화방 업무는 캘린더에서 확인해 주세요.');
    clipboard.writeText(buildWorkPrompt(task, note));
  });
}

function createWindow() {
  window = new BrowserWindow({
    title: '브리티 메신저 캘린더', width: 1320, height: 960, minWidth: 440, minHeight: 560,
    backgroundColor: '#f2f3ee',
    icon: path.join(__dirname, 'assets', 'app.ico'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, reply) => reply(false));
  void window.loadFile(view);
}

// 작업 표시줄에서 캘린더 아이콘으로 묶이게 한다.
if (process.platform === 'win32') app.setAppUserModelId('kr.rndosd.school-calendar');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });
  app.whenReady().then(() => {
    ready = (demo ? demo.seedDemo() : Promise.resolve()).then(() => store.init()).then(noteVersion).then(loadLastChatCollection).then(refresh);
    ready.catch(() => {});
    bindHandlers();
    createWindow();
    // 자동 갱신이 켜져 있으면 켤 때 한 번 가져오고, 그 뒤로는 고른 주기마다 가져온다.
    void ready.then(() => {
      scheduleAutoRefresh();
      if (store.snapshot().autoRefresh.notes.enabled) void pollCollector();
    }).catch(() => {});
    if (updatesEnabled) {
      void ready.then(() => setTimeout(() => void checkUpdate(), 15_000)).catch(() => {});
      updateInterval = setInterval(() => void checkUpdate(), UPDATE_EVERY);
    }
    // 30초마다 수집기 폴더의 파일만 다시 읽는다(브리티는 건드리지 않음).
    refreshInterval = setInterval(() => {
      void ready.then(() => refresh()).catch(() => {});
    }, 30_000);
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (closing) return;
    closing = true;
    clearInterval(refreshInterval);
    clearInterval(updateInterval);
    clearInterval(noteTimer);
    clearInterval(chatTimer);
    clearTimeout(retryTimer);
    lifetime.abort();
    if (collectorRun || brityReplyRun || chatRun) {
      event.preventDefault();
      void Promise.allSettled([collectorRun, brityReplyRun, chatRun]).then(() => app.quit());
    }
  });
}
