'use strict';

const { app, BrowserWindow, ipcMain, shell, clipboard, safeStorage, dialog, Notification, Menu, Tray } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { CalendarStore, CalendarError } = require('./store');
const { McpShare } = require('./mcp-share');
const { NoteWork } = require('./note-work');
const { apiProviders, refineWithProvider, classifierSample, cleanReplyBody } = require('./ai-provider');
const claudeCli = require('./claude-cli');
const codexCli = require('./codex-cli');
const { inspectCollector, collectOnce, collectChats, listChatRooms, collectRange, openBrityReply, openGoeReply, retryGoeAttachments } = require('./collector-link');
const GOE_NOTE_ID = /^goe_\d{12}_[a-f0-9]{8}$/;
const { buildWorkPrompt } = require('./work-prompt');
const taskModel = require('./renderer/task-model');
const neis = require('./neis');
const updater = require('./updater');
const feedback = require('./feedback');
const { GoogleCalendarSync } = require('./google-calendar');
const CHANGES = require('./CHANGES.json');
const { spawn } = require('node:child_process');

const goeEdition = process.env.SCHOOL_CALENDAR_GOE === '1';
const messenger = goeEdition
  ? { name: 'GOE 메신저', fullName: 'GOE 메신저', appName: 'GOE 메신저 캘린더', supportsChats: false, supportsReply: true }
  : { name: '브리티', fullName: '브리티 메신저', appName: '브리티 메신저 캘린더', supportsChats: true, supportsReply: true };
const launcherName = goeEdition ? 'GOE Messenger Calendar.exe' : 'Brity Messenger Calendar.exe';
const view = path.join(__dirname, 'renderer', 'index.html');
const demo = process.argv.includes('--demo') ? require('./demo') : null;
const appUserModelId = (goeEdition ? 'kr.rndosd.goe-calendar' : 'kr.rndosd.school-calendar') + (demo ? '.sample' : '');
const icoPath = path.join(__dirname, 'assets', 'app.ico');
const dataDir = demo?.dataDir || path.resolve(process.env.SCHOOL_CALENDAR_DATA_DIR || path.join(__dirname, goeEdition ? 'data-goe' : 'data'));
const sourceCollector = goeEdition ? path.join('collector', 'goe') : 'collector';
const defaultInbox = process.env.SCHOOL_CALENDAR_DEFAULT_INBOX_DIR || path.join(__dirname, '..', sourceCollector, 'inbox');
if (goeEdition) app.setName(messenger.appName);
const profile = path.join(dataDir, 'profile');
fs.mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);

let window;
let ready;
let refreshInterval;
let schoolInterval;
let alertInterval;
let updateInterval;
let draining = false;
let closing = false;
let testingAi = false;
let collectorRun;
let brityReplyRun;
let pausingCollector = false;
let collector = { status: 'idle', managed: false };
let collectorCheckedAt = null;
let activity = null;
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
// GOE판은 릴리스를 따로 둔다(2026-11-16 사용자 “goe판 저장소를 따로 만들자”): 두 판이 같은 '최신 릴리스'를 보면 한쪽만 올릴 때 다른 쪽 업데이트 확인이 깨진다.
const releases = goeEdition
  ? 'https://github.com/rndosd/goe-messenger-calendar/releases'
  : 'https://github.com/rndosd/brity-assistant-public/releases';
const portableRoot = process.env.SCHOOL_CALENDAR_PORTABLE_ROOT ? path.resolve(process.env.SCHOOL_CALENDAR_PORTABLE_ROOT) : null;
const manifestUrl = process.env.SCHOOL_CALENDAR_UPDATE_URL || `${releases}/latest/download/${goeEdition ? 'update-goe.json' : 'update.json'}`;
const updatesEnabled = !demo && !!portableRoot;
let update = { status: 'idle' };
let updateRun = null;
let whatsNew = null;
// 켜 둔 앱이 새 판을 알아채는 간격(2026-11-17 사용자 "6시간 좀 길지 않나"). 릴리스 파일 하나(약 20KB)라 API 횟수 제한과 무관.
const UPDATE_EVERY = 60 * 60 * 1000;

function userDownloads() {
  if (demo || process.env.SCHOOL_CALENDAR_INBOX_DIR) return undefined;
  try {
    return app.getPath('downloads');
  } catch {
    return undefined;
  }
}

const downloadsDir = userDownloads();
const mcpShare = new McpShare(process.env.SCHOOL_CALENDAR_MCP_DIR || path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
  demo ? 'MessengerCalendar-MCP-Sample' : 'MessengerCalendar-MCP'
), messenger.appName);
const collectorOptions = {
  scriptsDir: path.dirname(defaultInbox),
  goe: goeEdition,
  attachmentFolder: goeEdition && downloadsDir ? path.join(downloadsDir, 'GOE 첨부') : undefined
};
const store = new CalendarStore({
  dataDir, inboxDir: demo?.inboxDir || defaultInbox, inboxOverride: demo?.inboxDir || process.env.SCHOOL_CALENDAR_INBOX_DIR,
  downloadsDir,
  ruleSeed: path.join(__dirname, 'rules-seed.md'),
  automaticDefault: !demo && process.env.SCHOOL_CALENDAR_AUTOMATIC !== '0',
  // 새로 설치하면 AI 연결 전이다. 연결 시험이 성공하면 자동 분류가 켜진다.
  aiDefault: process.env.SCHOOL_CALENDAR_AI_DEFAULT === 'codex' ? 'codex' : 'none'
});
// 구글 캘린더로 보내기(한 방향). 앱 번호 파일이 없는 판·샘플에서는 숨긴다(google-calendar.js).
const googleCalendar = new GoogleCalendarSync({
  dataDir,
  clientFile: demo ? path.join(dataDir, 'no-google-client.json') : path.join(__dirname, 'google-client.json'),
  protect: text => {
    if (!safeStorage.isEncryptionAvailable()) throw new CalendarError('이 Windows 계정에서 구글 연결 정보를 보호해 저장할 수 없습니다.');
    return safeStorage.encryptString(text).toString('base64');
  },
  unprotect: value => safeStorage.decryptString(Buffer.from(value, 'base64')),
  openExternal: url => shell.openExternal(url),
  getTasks: () => store.tasks,
  onChange: () => publish()
});
store.onCommit = () => googleCalendar.schedule();
const noteWork = new NoteWork({
  bridge: mcpShare, store, signal: lifetime.signal,
  notify: taskId => {
    if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send('calendar:agent-work-changed', taskId);
    }
  }
});

function snapshot() {
  const saved = store.snapshot();
  return { ...saved, messenger, appVersion: app.getVersion(), shortcutAvailable: !!launcherPath && fs.existsSync(launcherPath), loginStart: loginStartState(), feedback: { available: feedback.feedbackAvailable(), info: feedbackInfo() }, google: googleCalendar.view(), update: { enabled: updatesEnabled, status: update.status, version: update.version ?? null, changes: update.changes ?? [], error: update.error ?? null }, whatsNew, rangeImport, demo: !!demo, factchatOffered: factchatOffered(), factchatGuideAvailable, collector: { status: collector.status, managed: collector.managed, checkedAt: collectorCheckedAt, imported: lastImported, unverified: collector.unverified ?? 0, busyReason: collector.status === 'in-use' ? collector.busyReason ?? null : null, goeReason: ['ready', 'in-use'].includes(collector.status) ? null : collector.goeReason ?? null, brityReason: collector.status === 'in-use' ? null : collector.brityReason ?? null }, activity, collectorAvailable: !demo && !store.inboxOverride, chatRefreshFailed, chatCollection: selectedChatCollection(saved.chatRooms) };
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
      const result = await updater.checkForUpdate({ manifestUrl, goe: goeEdition, current: app.getVersion(), electron: process.versions.electron, signal: lifetime.signal });
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
  if (noteWork.pending().length) throw new CalendarError('AI가 맡은 일을 마친 뒤 업데이트해 주세요.');
  const manifest = update.manifest;
  update = { ...update, status: 'downloading', error: null };
  publish();
  let staging;
  try {
    staging = await updater.downloadPatch({ manifestUrl, goe: goeEdition, update: manifest, stagingRoot: path.join(portableRoot, 'update-staging'), signal: lifetime.signal });
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
const seoryongEdition = process.env.SCHOOL_CALENDAR_SEORYONG === '1';  // GOE판과 함께 쓸 수 있다(GOE 서룡판)
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
  if (messenger.supportsChats) {
    try {
      await store.refreshChat();
      chatRefreshFailed = false;
    } catch {
      chatRefreshFailed = true;
    }
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
      if (connect || !collector.managed || !['ready', 'in-use', 'list-unreadable'].includes(collector.status)) {
        if (connect || collector.status === 'idle') {
          collector = { status: 'connecting', managed: false };
          publish();
        }
        collector = await inspectCollector({ ...collectorOptions, signal: lifetime.signal });
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
        try { collector = await collectOnce({ ...collectorOptions, force, signal: lifetime.signal }); }
        finally { activity = null; }
        // 클래식 뷰 안내는 원 뷰로 읽힐 때까지 남긴다(재시작 뒤에도). 쪽지를 안 읽은 주기는 판단을 바꾸지 않는다.
        if (collector.brityView) await store.setBrityView(collector.brityView).catch(() => {});
        lastImported = collector.status === 'ready' || collector.status === 'list-unreadable' && collector.imported > 0
          ? collector.imported : null;
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
      if (!['unverified', 'list-unreadable'].includes(collector.status) || collector.goeReason === 'no-korean-ocr') unverifiedSince = 0;
      else if (!firstImport && !closing && !pausingCollector && store.settings.collectorConnected && store.autoRefreshValue('notes').enabled) {
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
  if (!store.settings.collectorConnected || !collector.managed) throw new CalendarError(`머리줄에서 ${messenger.name}를 먼저 연결해 주세요.`);
  if (collectorRun || chatRun || brityReplyRun || rangeImport?.running) throw new CalendarError(`${messenger.name}에서 처리 중입니다. 잠시 뒤 다시 눌러 주세요.`);
}

async function previewRange(from, to) {
  const days = rangeDays(from, to);
  rangeReady();
  const run = collectRange({ preview: true, ...collectorOptions, signal: lifetime.signal, ...days });
  collectorRun = run.then(() => snapshot());
  try {
    const result = await run;
    if (result.status === 'in-use' && goeEdition) throw new CalendarError('GOE 메신저를 쓰는 중입니다. 캘린더 창에서 다시 눌러 주세요.');
    if (result.status === 'list-unreadable') throw new CalendarError('GOE 메신저에 연결했지만 기간 안의 쪽지 목록을 확인하지 못했습니다.');
    if (result.status !== 'ready') throw new CalendarError(`${messenger.name} 쪽지 목록을 읽지 못했습니다. ${messenger.name} 창을 한 번 열어 둔 뒤 다시 눌러 주세요.`);
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
  let unreadableNotes = 0;
  const work = (async () => {
    let failed = false;
    // 한 번에 20건씩 연다. 확인하지 못한 쪽지가 남아 계속 돌지 않도록 횟수를 묶는다.
    for (let round = 0; round < 10 && !closing && !rangeImport.stopping; round++) {
      const result = await collectRange({ ...collectorOptions, signal: lifetime.signal, ...days });
      if (result.brityView) await store.setBrityView(result.brityView).catch(() => {});
      rangeImport.done += result.imported;
      rangeImport.total = Math.max(rangeImport.total, rangeImport.done + (result.remaining ?? 0));
      await store.refresh();
      publish();
      if (result.status !== 'ready') { failed = true; break; }
      if (!goeEdition && result.opened && !result.imported) {
        unreadableNotes = result.opened;
        break;
      }
      if (!result.remaining || !result.opened) break;
    }
    return failed;
  })();
  collectorRun = work.then(() => snapshot(), () => snapshot());
  try {
    const failed = await work;
    const summary = { imported: rangeImport.done, stopped: rangeImport.stopping, failed, unreadableNotes, pending: store.rangePending().length };
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
    title: messenger.appName, icon: path.join(__dirname, 'assets', 'app.png'),
    body: collector.busyReason === 'note-open'
      ? `${messenger.name}에 쪽지 창이 열려 있어 새 쪽지를 가져오지 않았습니다. 쪽지 창을 닫으면 다음 확인 때 가져옵니다.`
      : `${messenger.name}를 쓰는 중이라 새 쪽지를 가져오지 않았습니다. 이 알림을 누르면 지금 가져옵니다.`
  });
  note.on('click', () => {
    showWindow();
    void pollCollector(false, { manual: true, force: true });
  });
  note.show();
}

function chatOptions() {
  return { ...collectorOptions, chatDirectory: path.join(dataDir, 'chats'), signal: lifetime.signal };
}

function chatBusy() {
  return chatRun || collectorRun || closing || pausingCollector || brityReplyRun;
}

function runChatOperation(action) {
  chatRun = Promise.resolve().then(action).finally(() => { chatRun = null; });
  return chatRun;
}

// 대화방을 못 읽은 까닭마다 선생님이 할 일(2026-11-12 실제 브리티 상황 시험, .qa/brity-cases-20261112.md).
// 모르는 까닭이면 해 볼 순서를 준다.
const CHAT_GUIDE = {
  'not-running': '브리티 메신저가 꺼져 있습니다. 브리티를 켜고 로그인한 뒤 다시 눌러 주세요.',
  tray: '브리티 창이 닫혀 트레이에만 있습니다. 화면 오른쪽 아래 트레이의 브리티 아이콘을 눌러 창을 연 뒤 다시 눌러 주세요.',
  'menu-open': '브리티 화면에 메뉴가 열려 있습니다. 브리티 창을 눌러 Esc를 누른 뒤 다시 눌러 주세요.',
  'not-minimized': '브리티 창이 열려 있어 자동으로는 가져오지 않았습니다. 지금 가져오기를 누르면 바로 가져옵니다(창을 최소화하거나 닫아 두면 자동으로 가져옵니다).',
  'in-use': '가져오는 중에 브리티를 쓰셔서 멈췄습니다. 다 쓰신 뒤 다시 눌러 주세요.',
  conflict: '브리티에서 다른 일을 처리하는 중입니다. 잠시 뒤 다시 눌러 주세요.'
};
const CHAT_UNKNOWN = '브리티 대화방 화면을 읽지 못했습니다. 이렇게 해 보세요: ① 브리티 창을 눌러 Esc ② 브리티에 로그인돼 있는지 확인 ③ 캘린더를 껐다 켜기 ④ 브리티를 껐다 켜기. 그래도 안 되면 알려 주세요.';

function chatGuide(result) {
  if (result.status === 'ready') return '';
  const status = result.status === 'waiting' ? 'in-use' : result.status === 'busy' ? 'conflict' : result.status;
  if (result.reason && CHAT_GUIDE[result.reason]) return CHAT_GUIDE[result.reason];
  if (status === 'offline') return CHAT_GUIDE['not-running'];
  return CHAT_GUIDE[status] || CHAT_UNKNOWN;
}

function checkChatResult(result) {
  if (result.status === 'ready') return result;
  throw new CalendarError(chatGuide(result));
}

function chatCollectionSummary(result, roomKeys, checkedAt) {
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
  const status = result.status === 'waiting' ? 'in-use' : result.status === 'busy' ? 'conflict' : result.status;
  const holds = (Array.isArray(result.holds) ? result.holds : result.holds ? [result.holds] : [])
    .filter(item => typeof item?.key === 'string' && typeof item.reason === 'string').map(({ key, reason }) => ({ key, reason }));
  return {
    roomKeys, checkedAt, status, added: count(result.added), read: count(result.read),
    retry: count(result.retry), needsReview: count(result.needsReview), baselines: count(result.baselines),
    gaps: count(result.gaps), holds, candidates: count(result.candidates),
    reason: typeof result.reason === 'string' ? result.reason : '', guide: chatGuide(result)
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
  if (!messenger.supportsChats || demo || store.inboxOverride) return;
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
  if (!messenger.supportsChats) throw new CalendarError('이 판에서는 대화방을 가져올 수 없습니다.');
  if (demo) return { roomChoices: demo.listChatRooms(), needsReview: 0 };
  if (store.inboxOverride) throw new CalendarError('이 실행 환경에서는 브리티 대화방을 읽을 수 없습니다.');
  if (chatBusy()) throw new CalendarError('브리티에서 처리 중입니다. 잠시 뒤 다시 눌러 주세요.');
  return runChatOperation(async () => checkChatResult(await listChatRooms({ ...chatOptions(), manual: true })));
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
async function collectChatRooms(roomKeys, { manual = false } = {}) {
  const live = () => new Set(store.tasks.filter(task => task.candidate && !task.candidate.discarded).map(task => task.id));
  const before = live();
  const result = await readChats(roomKeys, manual);
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
async function readChats(roomKeys, manual = false) {
  activity = 'chats';
  publish();
  try { return await collectChats({ ...chatOptions(), roomKeys, manual }); }
  finally { activity = null; }
}

// 설정의 대화방 "지금 가져오기". 자동이 꺼져 있어도 저장한 방을 한 번 읽는다.
// 브리티가 최소화돼 있지 않은 것 같은 사정은 오류로 던지지 않고 마지막 확인 기록에 남겨 화면이 보여 준다.
async function collectChatsNow() {
  if (!messenger.supportsChats) throw new CalendarError('이 판에서는 대화방을 가져올 수 없습니다.');
  if (demo || store.inboxOverride) throw new CalendarError('샘플에서는 대화방을 가져올 수 없습니다.');
  const roomKeys = store.chatRooms().map(room => room.key);
  if (!roomKeys.length) throw new CalendarError('가져올 대화방을 먼저 골라 저장해 주세요.');
  if (chatBusy()) throw new CalendarError('브리티에서 처리 중입니다. 잠시 뒤 다시 눌러 주세요.');
  // 선생님이 직접 누름: 브리티 창이 열려 있어도 잠깐 최소화해 읽고 되돌린다.
  return runChatOperation(() => collectChatRooms(roomKeys, { manual: true }));
}

// 설정의 자동 갱신 주기로 타이머를 다시 건다.
function scheduleAutoRefresh() {
  clearInterval(noteTimer);
  noteTimer = null;
  const notes = store.autoRefreshValue('notes');
  if (!notes.enabled || store.settings.collectorFirstImportPending) {
    clearTimeout(retryTimer);
    unverifiedSince = 0;
  }
  if (!demo && !store.settings.collectorFirstImportPending && notes.enabled) {
    noteTimer = setInterval(() => void pollCollector(), notes.minutes * 60_000);
  }
  scheduleChatRefresh();
}

function scheduleChatRefresh() {
  clearInterval(chatTimer);
  chatTimer = null;
  if (!messenger.supportsChats || demo || store.inboxOverride || store.settings.collectorFirstImportPending) return;
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

// 학교(나이스): 학사일정은 학교를 고를 때·켤 때(일주일 지났거나 학년도가 바뀌면)·다시 받기를 누를 때 받는다. 급식은 그날 것만 1시간 기억한다.
function neisOptions() {
  const key = process.env.SCHOOL_CALENDAR_NEIS_KEY || store.settings?.neisKey;
  return typeof key === 'string' && /^[A-Za-z0-9]{10,64}$/.test(key) ? { key } : {};
}
async function neisCall(work) {
  try {
    return await work();
  } catch (error) {
    if (error instanceof neis.NeisError) throw new CalendarError(error.message);
    throw error;
  }
}
let schoolRun = null;
function refreshSchoolSchedule() {
  schoolRun ??= (async () => {
    const school = store.settings?.school;
    if (!school) return;
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const range = neis.schoolYearRange(today);
    try {
      const events = await neis.fetchSchedule(school, range.from, range.to, neisOptions());
      await store.saveSchoolSchedule(school, events, range);
    } catch (error) {
      store.setSchoolError(error instanceof neis.NeisError ? error.message : '학사일정을 받지 못했습니다.');
    }
    publish();
  })().finally(() => { schoolRun = null; });
  return schoolRun;
}
// 마감 알림: 하루 한 번 Windows 알림. 누르면 앱 창을 앞으로. 알릴 것이 없는 날은 띄우지 않는다.
function alertLines({ dueToday, dueTomorrow, eventsToday }) {
  const names = list => list.slice(0, 3).map(item => `${item.time ? `${item.time} ` : ''}${item.label}`).join(', ') + (list.length > 3 ? ` 외 ${list.length - 3}` : '');
  return [
    dueToday.length && `오늘 마감 ${dueToday.length}: ${names(dueToday)}`,
    eventsToday.length && `오늘 일정 ${eventsToday.length}: ${names(eventsToday)}`,
    dueTomorrow.length && `내일 마감 ${dueTomorrow.length}: ${names(dueTomorrow)}`
  ].filter(Boolean);
}
function showDeadlineAlert(digest, test = false) {
  const lines = alertLines(digest);
  if (!Notification.isSupported()) throw new CalendarError('이 PC에서는 Windows 알림을 쓸 수 없습니다.');
  if (!lines.length && !test) return false;
  const note = new Notification({
    title: `${messenger.appName} · 오늘 할 일`, icon: path.join(__dirname, 'assets', 'app.png'),
    body: lines.length ? lines.join('\n') : '오늘·내일 마감과 오늘 일정이 없습니다. (시험 알림)'
  });
  note.on('click', showWindow);
  note.show();
  return true;
}
async function checkDeadlineAlert() {
  const digest = store.alertDue();
  if (!digest) return;
  await store.markAlerted(digest.day);
  showDeadlineAlert(digest);
}

const meals = new Map();
async function todayMeal(date) {
  const school = store.settings?.school;
  if (!school || !taskModel.validDate(date)) return null;
  const cacheKey = `${school.office}-${school.code}-${date}`;
  const cached = meals.get(cacheKey);
  if (cached && Date.now() - cached.at < 3_600_000) return cached.value;
  const value = { date, meals: await neisCall(() => neis.fetchMeals(school, date, neisOptions())) };
  meals.set(cacheKey, { at: Date.now(), value });
  return value;
}

async function retryNoteAttachments(id) {
  if (!goeEdition || demo || closing || pausingCollector || store.inboxOverride) {
    throw new CalendarError('현재는 GOE 첨부를 다시 받을 수 없습니다.');
  }
  if (collectorRun || chatRun || brityReplyRun || ['downloading', 'installing'].includes(update.status)) {
    throw new CalendarError('GOE 메신저 또는 캘린더에서 처리 중입니다. 잠시 뒤 다시 눌러 주세요.');
  }
  const note = store.notes.get(store.getTask(id).noteId);
  if (store.inbox.status !== 'ready' || !note?.goeAttachments || note.verified !== true) {
    throw new CalendarError('캘린더에서 원문이 확인된 GOE 쪽지의 첨부를 다시 받을 수 있습니다.');
  }
  if (!store.settings.collectorConnected) throw new CalendarError('GOE 메신저를 먼저 연결해 주세요.');
  const work = (async () => {
    const [active, managed] = await Promise.all([
      fs.promises.realpath(store.inboxDir),
      fs.promises.realpath(defaultInbox)
    ]).catch(() => []);
    if (!active || !managed || active.toLowerCase() !== managed.toLowerCase()) {
      throw new CalendarError('현재 캘린더의 GOE 수집 폴더를 확인하지 못했습니다.');
    }
    const result = await retryGoeAttachments(note.id, { ...collectorOptions, signal: lifetime.signal });
    if (result.status === 'in-use' && result.busyReason === 'note-open') {
      throw new CalendarError('GOE 메신저에 쪽지 창이 열려 있어 받지 않았습니다. 쪽지 창을 닫은 뒤 다시 눌러 주세요.');
    }
    if (result.status === 'in-use' || result.status === 'conflict') {
      throw new CalendarError('GOE 메신저를 처리 중입니다. 잠시 뒤 캘린더에서 다시 눌러 주세요.');
    }
    if (result.status === 'offline') throw new CalendarError('GOE 메신저를 열고 로그인한 뒤 다시 눌러 주세요.');
    if (result.status === 'list-unreadable') throw new CalendarError('GOE 메신저에 연결했지만 첨부를 찾을 쪽지 목록을 확인하지 못했습니다.');
    if (result.status !== 'ready') throw new CalendarError('GOE 쪽지 목록을 확인하지 못했습니다. GOE 창을 한 번 연 뒤 다시 시도해 주세요.');
    await store.refresh();
    return { attachStatus: result.attachStatus, attached: result.attached };
  })();
  collectorRun = work.then(() => snapshot(), () => snapshot());
  activity = 'attachments';
  publish();
  try {
    return await work;
  } finally {
    collectorRun = null;
    activity = null;
    publish();
  }
}

// GOE판 답장(2026-11-16 “답장기능도 브리티처럼”): 수집기가 GOE에서 그 쪽지를 찾아 열고 답장 단추를 누른다.
async function replyInGoe(note) {
  if (!GOE_NOTE_ID.test(note.id ?? '')) throw new CalendarError('GOE 메신저에서 가져온 쪽지만 답장창을 열 수 있습니다.');
  brityReplyRun = openGoeReply(note.id, collectorOptions);
  try {
    const result = await brityReplyRun;
    if (result.status === 'ready') {
      if (result.reply === 'opened' || result.reply === 'opened-background') return { foreground: result.reply === 'opened' };
      if (result.reply === 'reply-unavailable') return { foreground: false, notice: 'GOE 메신저에 쪽지를 띄웠습니다. 답장 단추를 찾지 못해 답장창은 열지 않았습니다. 쪽지 창에서 답장을 눌러 주세요.' };
      if (result.reply === 'reply-unconfirmed') return { foreground: false, notice: 'GOE 메신저에 쪽지를 띄우고 답장을 눌렀습니다. 답장창이 열렸는지는 확인하지 못했습니다. 작업 표시줄에서 GOE 메신저 창을 확인해 주세요.' };
    }
    const messages = {
      'in-use': 'GOE 메신저에 열린 쪽지 창이 있거나 쓰는 중이라 열지 않았습니다. 쪽지 창을 닫은 뒤 다시 눌러 주세요.',
      offline: 'GOE 메신저에 로그인한 뒤 다시 눌러 주세요.',
      'list-unreadable': 'GOE 메신저에 연결했지만 답장할 쪽지 목록을 확인하지 못했습니다.',
      conflict: 'GOE 메신저에서 쪽지를 가져오는 중입니다. 잠시 뒤 다시 눌러 주세요.',
      unverified: 'GOE 메신저 쪽지함 화면을 읽지 못했습니다. GOE 메신저 창에 열린 메뉴나 설정 창이 있으면 닫고 다시 눌러 주세요.'
    };
    throw new CalendarError(messages[result.status] || 'GOE 메신저 쪽지함에서 이 쪽지를 찾지 못했습니다. 아래 보낸 사람과 받은 시각으로 찾아 주세요.');
  } finally {
    brityReplyRun = null;
  }
}

async function replyInBrity(id) {
  if (!messenger.supportsReply || demo || closing) throw new CalendarError(`현재는 ${messenger.name} 답장창을 열 수 없습니다.`);
  const task = store.getTask(id);
  const note = store.notes.get(task.noteId);
  if (note?.verified !== true || store.inbox.status !== 'ready') {
    throw new CalendarError('캘린더에서 원문이 확인된 쪽지의 답장창을 열 수 있습니다.');
  }
  if (collectorRun || chatRun || brityReplyRun) throw new CalendarError(`${messenger.name}에서 처리 중입니다. 잠시 뒤 다시 눌러 주세요.`);
  // 머리줄에 "답장창 여는 중"을 보이고, 그동안 메신저를 쓰는 다른 버튼을 막는다.
  activity = 'reply';
  publish();
  try {
    return goeEdition ? await replyInGoe(note) : await replyInBrityNote(note);
  } finally {
    activity = null;
    publish();
  }
}

async function replyInBrityNote(note) {
  brityReplyRun = openBrityReply(note, collectorOptions);
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
  bind('search', query => store.search(query));
  bind('message-seen', async (kind, id) => changed(await store.markMessageSeen(kind, id)));
  bind('chat-batch', id => store.chatBatch(id));
  bind('forwarded-accept', async (batchId, messageIndex, lineIndex, input) => changed(await store.acceptForwardedLine(batchId, messageIndex, lineIndex, input)));
  bind('forwarded-review', async id => changed(await store.reviewForwardedBatch(id)));
  bind('chat-batch-finish', async (id, candidateIds) => {
    await store.finishChatBatch(id, candidateIds);
    return changed(snapshot());
  });
  bind('brity-reply', replyInBrity);
  bind('goe-attachment-retry', retryNoteAttachments);
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
  bind('school-search', name => neisCall(() => neis.searchSchools(name, neisOptions())));
  bind('school-set', async school => {
    const value = school ? await neisCall(() => neis.schoolValue(school)) : null;
    const next = changed(await store.setSchool(value));
    if (value) void refreshSchoolSchedule();
    return next;
  });
  bind('school-refresh', async () => {
    await refreshSchoolSchedule();
    return snapshot();
  });
  bind('meal', date => todayMeal(date));
  bind('remove', async id => {
    await store.remove(id);
    return changed(snapshot());
  });
  bind('deadline-alerts', async enabled => changed(await store.setDeadlineAlerts(enabled)));
  bind('show-meal', async enabled => changed(await store.setShowMeal(enabled)));
  bind('repeat', async (id, every) => changed(await store.setRepeat(id, every)));
  bind('repeat-skip', async id => {
    await store.skipOccurrence(id);
    return changed(snapshot());
  });
  bind('repeat-stop', async id => {
    const result = await store.stopSeries(id);
    return { ...changed(snapshot()), repeatRemoved: result.removed };
  });
  bind('deadline-alert-test', () => {
    const day = offset => { const date = new Date(); date.setDate(date.getDate() + offset); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; };
    return showDeadlineAlert(store.deadlineDigest(day(0), day(1)), true);
  });
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
  bind('claude-status', async () => {
    const executable = claudeCli.findClaude(store.settings.claudeExecutable);
    return { executable, loggedIn: executable ? await claudeCli.loginStatus(executable) : false };
  });
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
    const result = await claudeCli.openClaudeLogin(store.settings.claudeExecutable);
    return { ...result, loggedIn: await claudeCli.loginStatus(result.executable) };
  });
  bind('claude-install-copy', () => {
    clipboard.writeText(claudeCli.INSTALL_COMMAND);
    return claudeCli.INSTALL_COMMAND;
  });
  // Codex(ChatGPT 구독): 없으면 묻고 공식 명령으로 설치하고, 로그인이 안 됐으면 로그인 창을 연다.
  bind('codex-status', () => codexCli.codexStatus(store.settings.codexExecutable));
  bind('codex-install', async () => {
    if (demo) throw new CalendarError('샘플에서는 쓸 수 없습니다.');
    const { executable: existing } = await codexCli.codexStatus(store.settings.codexExecutable);
    if (existing) return { executable: existing, installed: false };
    const { response } = await dialog.showMessageBox(window, {
      type: 'question', buttons: ['설치', '취소'], defaultId: 0, cancelId: 1, noLink: true,
      title: 'Codex 설치', message: '이 PC에 캘린더가 쓸 수 있는 Codex가 없습니다. 지금 설치할까요?',
      detail: `OpenAI 공식 설치 명령으로 Codex를 내려받아 이 Windows 사용자 폴더(${path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'OpenAI', 'Codex')})에 설치합니다. 관리자 권한은 필요 없고 1~2분 걸립니다.\n\n실행할 명령: ${codexCli.INSTALL_COMMAND}\n\n설치가 끝나면 ChatGPT 로그인 창이 열립니다.`
    });
    if (response !== 0) return { executable: null, installed: false, cancelled: true };
    const { executable } = await codexCli.installCodex({ signal: lifetime.signal });
    return { executable, installed: true };
  });
  bind('codex-login', async () => {
    if (demo) throw new CalendarError('샘플에서는 쓸 수 없습니다.');
    const { executable } = await codexCli.codexStatus(store.settings.codexExecutable);
    if (!executable) throw new CalendarError('이 PC에서 쓸 수 있는 Codex를 찾지 못했습니다. ‘연결 시험 및 저장’을 누르면 설치할지 묻습니다.');
    const { closed } = await codexCli.openCodexLogin(executable);
    return { closed, loggedIn: await codexCli.loginStatus(executable) };
  });
  bind('codex-install-copy', () => {
    const command = `powershell -ExecutionPolicy ByPass -c "${codexCli.INSTALL_COMMAND}"`;
    clipboard.writeText(command);
    return command;
  });
  bind('open-ai-guide', async page => {
    const urls = {
      key: 'https://platform.openai.com/api-keys',
      billing: 'https://platform.openai.com/settings/organization/billing/overview',
      'anthropic-key': 'https://platform.claude.com/settings/keys'
    };
    if (page === 'anthropic-guide') {
      const failure = await shell.openPath(path.join(__dirname, 'Claude-API-연결-안내.html'));
      if (failure) throw new CalendarError('안내서를 열지 못했습니다. 앱 폴더의 Claude-API-연결-안내.html을 직접 열어 주세요.');
      return;
    }
    if (page === 'factchat' && factchatGuideAvailable) {
      await shell.openExternal(factchatGuideUrl.href);
      return;
    }
    // CLI 방식은 앱 폴더의 한국어 안내서를 연다(설치·로그인이 막혔을 때 따라 하는 순서).
    const localGuides = { claude: 'Claude-연결-안내.html', codex: 'Codex-연결-안내.html', 'openai-guide': 'API-연결-안내.html', start: '처음-시작-안내.html' };
    if (Object.hasOwn(localGuides, page)) {
      const failure = await shell.openPath(path.join(__dirname, localGuides[page]));
      if (failure) throw new CalendarError(`안내서를 열지 못했습니다. 앱 폴더의 ${localGuides[page]}을 직접 열어 주세요.`);
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
  bind('backlog-classify', async () => {
    const count = await store.queueBacklogClassify();
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
    if (!messenger.supportsChats) throw new CalendarError('이 판에서는 대화방을 가져올 수 없습니다.');
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
      title: '백업 저장', defaultPath: path.join(app.getPath('documents'), `${path.parse(launcherName).name.replaceAll(' ', '')}-backup-${new Date().toISOString().slice(0, 10)}.zip`),
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
  bind('feedback', async message => {
    if (!feedback.feedbackAvailable()) throw new CalendarError('의견 보내기가 준비되지 않았습니다.');
    const text = typeof message === 'string' ? message.trim() : '';
    if (!text) throw new CalendarError('보낼 내용을 적어 주세요.');
    if (Date.now() - feedbackSentAt < 20000) throw new CalendarError('방금 보냈습니다. 잠시 뒤 다시 보내 주세요.');
    try { await feedback.sendFeedback(text, feedbackInfo()); }
    catch { throw new CalendarError('보내지 못했습니다. 인터넷 연결을 확인하고 다시 눌러 주세요. 쓴 글은 그대로 남겨 두었습니다.'); }
    feedbackSentAt = Date.now();
    return true;
  });
  bind('google-connect', async () => {
    try { await googleCalendar.connect(); } catch (error) { throw new CalendarError(error.message || '구글 캘린더에 연결하지 못했습니다.'); }
    return snapshot();
  });
  bind('google-disconnect', async removeCalendars => {
    try {
      await googleCalendar.disconnect({ removeCalendars: removeCalendars === true });
    } catch (error) {
      throw new CalendarError(error.message || '구글 캘린더 연결을 끊지 못했습니다.');
    }
    return snapshot();
  });
  bind('google-sync', async () => {
    if (!googleCalendar.view().connected) throw new CalendarError('먼저 구글 캘린더에 연결해 주세요.');
    await googleCalendar.sync();
    if (googleCalendar.view().error) throw new CalendarError(googleCalendar.view().error);
    return snapshot();
  });
  // 시험 기간 테스터 신청: 의견 보내기와 같은 폼으로 이메일을 보낸다(개발자가 콘솔에 테스터로 등록).
  bind('google-tester', async email => {
    const value = String(email ?? '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) || value.length > 200) throw new CalendarError('구글 계정 이메일을 확인해 주세요.');
    if (!feedback.feedbackAvailable()) throw new CalendarError('신청 보내기가 준비되지 않았습니다.');
    if (Date.now() - feedbackSentAt < 20000) throw new CalendarError('방금 보냈습니다. 잠시 뒤 다시 보내 주세요.');
    try { await feedback.sendFeedback(`[구글 캘린더 테스터 신청] ${value}`, feedbackInfo()); }
    catch { throw new CalendarError('보내지 못했습니다. 인터넷 연결을 확인하고 다시 눌러 주세요.'); }
    feedbackSentAt = Date.now();
    return true;
  });
  bind('login-start', enabled => {
    if (!loginStartAvailable()) throw new CalendarError('배포용 폴더에서 연 캘린더에서만 켤 수 있습니다.');
    app.setLoginItemSettings({ openAtLogin: !!enabled, path: launcherPath, args: [] });
    if (loginStartState().enabled !== !!enabled) throw new CalendarError('Windows 시작 프로그램에 등록하지 못했습니다. 학교 PC 정책을 확인해 주세요.');
    return snapshot();
  });
  // 바탕 화면 바로 가기: 배포 폴더의 실행기(아이콘 있음)를 가리킨다.
  bind('shortcut-create', async () => {
    if (!launcherPath || !fs.existsSync(launcherPath)) throw new CalendarError('배포용 폴더에서 연 캘린더에서만 바로 가기를 만들 수 있습니다.');
    const link = path.join(app.getPath('desktop'), `${messenger.appName}.lnk`);
    const ok = shell.writeShortcutLink(link, fs.existsSync(link) ? 'replace' : 'create', {
      target: launcherPath, cwd: portableRoot, icon: icoPath, iconIndex: 0, description: messenger.appName, appUserModelId
    });
    if (!ok) throw new CalendarError('바로 가기를 만들지 못했습니다.');
    return { link };
  });
  bind('update-check', () => checkUpdate(true));
  bind('update-apply', applyUpdate);
  bind('update-page', () => shell.openExternal(goeEdition && update.version
    ? `${releases}/download/v${update.version}/goe-messenger-calendar-windows-x64-${update.version}.zip`
    : `${releases}/latest`));
  bind('whats-new-dismiss', () => { whatsNew = null; return snapshot(); });
  bind('changes', () => ({ version: app.getVersion(), changes: updater.changesBetween(CHANGES, null, app.getVersion()).slice(0, 5) }));
  bind('rules-resolve', async choice => changed(await store.resolveRules(choice)));
  bind('periods', async enabled => changed(await store.setShowPeriods(enabled)));
  bind('external-ai-work-visibility', async enabled => {
    await store.setShowExternalAiWork(enabled);
    return changed(snapshot());
  });
  bind('rules', async () => {
    const error = await shell.openPath(store.rulesPath);
    if (error) throw new CalendarError('정리 기준 파일을 열 수 없습니다.');
  });
  bind('mcp-status', () => mcpShare.status());
  bind('mcp-share', (id, attachments) => mcpShare.publish(store, id, attachments));
  bind('mcp-revoke', id => mcpShare.revoke(id));
  bind('mcp-open', async id => {
    const error = await shell.openPath(await mcpShare.bundle(id));
    if (error) throw new CalendarError('공유한 업무 폴더를 열 수 없습니다.');
  });
  bind('mcp-copy-setup', async format => {
    clipboard.writeText(await mcpShare.setup(format));
  });
  bind('agent-work-start', (id, input) => {
    if (['downloading', 'installing'].includes(update.status)) throw new CalendarError('업데이트가 끝난 뒤 AI에 맡겨 주세요.');
    return noteWork.start(id, input);
  });
  bind('agent-work-state', id => noteWork.state(id));
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
  // 쪽지 원문 링크(2026-11-17). http(s)만, 기본 브라우저로 연다.
  bind('open-link', async href => {
    let url;
    try {
      url = new URL(href);
    } catch {
      throw new CalendarError('열 수 없는 주소입니다.');
    }
    if (!/^https?:$/.test(url.protocol) || href.length > 4000) throw new CalendarError('웹 주소만 열 수 있습니다.');
    await shell.openExternal(url.href);
  });
  bind('copy-text', async text => {
    if (!text || text.length > 200000) throw new CalendarError('복사할 글이 없습니다.');
    clipboard.writeText(text);
  });
  bind('copy-work', async id => {
    const { task, note } = await store.detail(id);
    if (task.chatSource) throw new CalendarError('대화방 업무는 캘린더에서 확인해 주세요.');
    clipboard.writeText(buildWorkPrompt(task, note));
  });
}

// 오른쪽 클릭 메뉴(2026-11-17): Electron은 기본 메뉴가 없어 복사·붙여넣기·링크 열기를 직접 단다.
function showContextMenu(params) {
  const items = [];
  const link = /^https?:/i.test(params.linkURL || '') ? params.linkURL : '';
  if (link) {
    items.push({ label: '브라우저로 열기', click: () => void shell.openExternal(link) },
      { label: '링크 주소 복사', click: () => clipboard.writeText(link) }, { type: 'separator' });
  }
  if (params.isEditable) {
    items.push({ role: 'undo', label: '실행 취소', enabled: params.editFlags.canUndo }, { type: 'separator' },
      { role: 'cut', label: '잘라내기', enabled: params.editFlags.canCut },
      { role: 'copy', label: '복사', enabled: params.editFlags.canCopy },
      { role: 'paste', label: '붙여넣기', enabled: params.editFlags.canPaste },
      { role: 'selectAll', label: '모두 선택' });
  } else if (params.selectionText.trim()) {
    items.push({ role: 'copy', label: '복사' });
  }
  while (items.at(-1)?.type === 'separator') items.pop();
  if (items.length && window && !window.isDestroyed()) Menu.buildFromTemplate(items).popup({ window });
}

function createWindow() {
  window = new BrowserWindow({
    title: messenger.appName, width: 1320, height: 960, minWidth: 440, minHeight: 560,
    backgroundColor: '#f2f3ee',
    icon: icoPath,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false }
  });
  if (process.platform === 'win32' && launcherPath && fs.existsSync(launcherPath)) {
    window.setAppDetails({
      appId: appUserModelId, appIconPath: icoPath, relaunchCommand: `"${launcherPath}"`, relaunchDisplayName: messenger.appName
    });
  }
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, reply) => reply(false));
  window.webContents.on('context-menu', (_event, params) => showContextMenu(params));
  // 창을 닫으면 끄지 않고 트레이로 숨긴다(2026-11-19 사용자). 자동 가져오기·분류는 계속 돈다.
  // 끄기는 트레이 메뉴의 "종료"(또는 업데이트·Windows 종료)로만 한다.
  window.on('close', event => {
    if (closing || !tray) return;
    event.preventDefault();
    window.hide();
    if (!trayHintShown && Notification.isSupported()) {
      trayHintShown = true;
      new Notification({ title: messenger.appName, icon: path.join(__dirname, 'assets', 'app.png'),
        body: '캘린더는 꺼지지 않고 작업 표시줄 오른쪽 트레이에서 계속 새 쪽지를 가져옵니다. 끄려면 트레이 아이콘을 오른쪽 클릭해 "종료"를 누르세요.' }).show();
    }
  });
  // Windows를 끄거나 로그아웃할 때는 막지 않는다.
  window.on('query-session-end', () => { closing = true; });
  window.on('session-end', () => { closing = true; });
  void window.loadFile(view);
}

let tray = null;
let trayHintShown = false;
function showWindow() {
  if (!window || window.isDestroyed()) return;
  if (!window.isVisible()) window.show();
  if (window.isMinimized()) window.restore();
  window.focus();
}
function createTray() {
  try {
    tray = new Tray(icoPath);
  } catch {
    tray = null; // 트레이를 못 만들면 예전처럼 닫으면 꺼진다.
    return;
  }
  tray.setToolTip(messenger.appName);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '캘린더 열기', click: showWindow },
    { type: 'separator' },
    { label: '종료', click: () => app.quit() }
  ]));
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
}

// 컴퓨터를 켜면 자동 실행(2026-11-15 사용자): Windows 시작 프로그램(이 사용자의 Run 목록)에 실행기를 등록한다.
// electron.exe가 아니라 실행기를 등록해야 폴더 권한 고침·남은 업데이트 마저 설치·샌드박스 대비가 그대로 적용된다.
// 샘플과 소스 실행에서는 쓰지 않는다. 폴더를 옮기면 예전 자리를 가리키므로 설정에서 다시 켜야 한다.
const AI_LABELS = { none: 'AI 없음', codex: 'Codex', claude: 'Claude Code', openai: 'OpenAI', anthropic: 'Claude API', factchat: '팩트챗' };
function feedbackInfo() {
  return [app.getVersion(), goeEdition ? (seoryongEdition ? 'GOE 서룡판' : 'GOE판') : seoryongEdition ? '서룡판' : '일반판', `Windows ${os.release()}`, AI_LABELS[store.aiProvider] ?? store.aiProvider, demo ? '샘플' : null].filter(Boolean).join(' · ');
}
let feedbackSentAt = 0;

const launcherPath = portableRoot ? path.join(portableRoot, launcherName) : null;
function loginStartAvailable() {
  return !demo && process.platform === 'win32' && !!launcherPath && fs.existsSync(launcherPath);
}
function loginStartState() {
  if (!loginStartAvailable()) return { available: false, enabled: false };
  try { return { available: true, enabled: app.getLoginItemSettings({ path: launcherPath, args: [] }).openAtLogin === true }; }
  catch { return { available: true, enabled: false }; }
}

// 작업 표시줄에서 캘린더 아이콘으로 묶이게 한다.
if (process.platform === 'win32') app.setAppUserModelId(appUserModelId);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.whenReady().then(() => {
    if (fs.existsSync(mcpShare.command)) void mcpShare.installBridge().catch(() => {});
    ready = (demo ? demo.seedDemo() : Promise.resolve()).then(() => store.init()).then(noteVersion).then(loadLastChatCollection).then(refresh);
    ready.catch(() => {});
    bindHandlers();
    createWindow();
    createTray();
    // 자동 갱신이 켜져 있으면 켤 때 한 번 가져오고, 그 뒤로는 고른 주기마다 가져온다.
    void ready.then(() => {
      scheduleAutoRefresh();
      if (store.snapshot().autoRefresh.notes.enabled) void pollCollector();
      if (store.schoolNeedsRefresh()) void refreshSchoolSchedule();
    }).catch(() => {});
    schoolInterval = setInterval(() => {
      void ready.then(() => { if (store.schoolNeedsRefresh()) return refreshSchoolSchedule(); }).catch(() => {});
    }, 3_600_000);
    // 마감 알림: 켤 때와 10분마다 본다(하루 한 번만 띄움). 샘플에서는 띄우지 않는다.
    if (!demo) {
      void ready.then(() => setTimeout(() => void checkDeadlineAlert().catch(() => {}), 20_000)).catch(() => {});
      alertInterval = setInterval(() => void ready.then(checkDeadlineAlert).catch(() => {}), 600_000);
    }
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
    clearInterval(schoolInterval);
    clearInterval(alertInterval);
    clearInterval(updateInterval);
    clearInterval(noteTimer);
    clearInterval(chatTimer);
    clearTimeout(retryTimer);
    lifetime.abort();
    const pending = [collectorRun, brityReplyRun, chatRun, ...noteWork.pending()].filter(Boolean);
    if (pending.length) {
      event.preventDefault();
      void Promise.allSettled(pending).then(() => app.quit());
    }
  });
}
