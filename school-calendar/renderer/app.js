'use strict';

const $ = id => document.getElementById(id);
const api = window.calendar;
const dateLabel = new Intl.DateTimeFormat('ko-KR', { dateStyle: 'full' });
const messageDate = new Intl.DateTimeFormat('ko-KR', { dateStyle: 'short', timeStyle: 'short' });
const { daysBetween, receivedDay } = calendarPeriods;
const WEEKDAYS = '일월화수목금토';
// 한 주는 월요일에 시작해 일요일에 끝난다(2026-11-15 사용자). 달력 칸·기간 띠·목록의 이번 주가 같은 기준을 쓴다.
const weekday = date => (date.getDay() + 6) % 7;
const TYPE_ORDER = { span: 0, event: 0, task: 1, loose: 1, ref: 2 };
const typeLabels = { '할 일': '할 일', '알아 둘 것': '확인할 것', '없음': '숨기기' };
const aiNames = { claude: 'Claude Code · Haiku', codex: 'Codex', openai: 'OpenAI API · Luna', anthropic: 'Claude API · Haiku', factchat: '서룡 팩트챗 API · Luna' };
const state = {
  snapshot: { tasks: [], messages: [], inbox: { status: 'loading', pending: 0 } },
  messenger: { name: '브리티', fullName: '브리티 메신저', appName: '브리티 메신저 캘린더', supportsChats: true, noteAction: 'reply' },
  month: new Date(), dayKey: '', selected: null, detailToken: 0, detail: null,
  spanColors: new Map(), expandedForwarded: new Set(), selectedChat: null, forwardedDraft: null,
  chatLoaded: false, readingSelection: false, dirty: false, revision: null, saving: false,
  taskViews: new Map(), attachmentRetry: null
};
const markingOpened = new Set();
let noticeTimer;
let agentWork = null;
let noteAi = null;
let projectSession = null;
const workAgents = { codex: 'Codex', claude: 'Claude Code' };

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// 원문 글을 넣으며 웹 주소는 링크로 만든다. 누르면 기본 브라우저로 연다(아래 클릭 처리).
function setLinkedText(node, text) {
  node.replaceChildren(...findLinks(text).map(part => {
    if (!part.url) return part.text;
    const link = element('a', 'note-link', part.text);
    link.href = part.url;
    link.title = `${part.url}
누르면 브라우저로 엽니다.`;
    return link;
  }));
  return node;
}

function button(className, text) {
  const node = element('button', className, text);
  node.type = 'button';
  return node;
}

function key(date) {
  return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function fromKey(value) {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setFullYear(year, month - 1, day);
  return date;
}

function shift(date, days) {
  const next = new Date(date);
  next.setDate(date.getDate() + days);
  return next;
}

// 'YYYY-MM-DD'의 다음 날(기간 끝일의 최솟값).
function nextDay(value) {
  return /^\d{4}-\d\d-\d\d$/.test(value || '') ? key(shift(fromKey(value), 1)) : '';
}

function monthOf(date) {
  const month = new Date(date);
  month.setDate(1);
  return month;
}

// 화면 분류: 유형은 할 일 · 알아 둘 것 · 없음(숨김). 기호는 날짜마다 정한다: 까지 □, 그날 ●, 알아 둘 것은 기호 없음.
let pendingPriority = null;
const { priorityLevel, checkable, boxes, finished, isPinned, pinnedDue, lastDay } = taskModel;
const chatLabels = { task: '대화방', confirmed: '대화방 확정', changed: '대화방 변경', cancelled: '대화방 취소' };

// 대화방 후보(분류할 것 탭). 아직 정하지 않은 것만 후보이고, 버린 후보는 숨긴 것에 둔다.
function isCandidate(task) {
  return !!task?.candidate && !task.candidate.discarded;
}

function candidateBadge(task) {
  if (task.candidate?.discarded) return '버린 후보';
  return task.candidate?.change ? (task.chatSource?.action === 'cancelled' ? '대화방 취소 후보' : '대화방 변경 후보') : '대화방 후보';
}

// 기한 없는 할 일(○): AI가 날짜를 주지 않아 받은 날에 놓은 할 일(답장할 질문 등).
// 마감·일정과 헷갈리지 않게 ○로 보이고, 끝낼 때까지 오늘 칸·오늘 묶음에 따라온다. 받은 날은 쪽지를 고르면 '받음'으로 보인다(2026-11-20 사용자).
function looseEntry(task, entry) {
  return task.type === '할 일' && entry?.kind === '그날' && entry.received === true;
}

// 끝내지 않은 기한 없는 할 일이 지금 뜨는 날: 받은 날이 지났으면 오늘.
function rolledDay(task, entry, today) {
  return looseEntry(task, entry) && entry.done !== true && entry.date < today ? today : entry.date;
}

// 받은 날부터 센 날수: 받은 날이 1일째.
function looseAge(entry, today) {
  return daysBetween(entry.date, today) + 1;
}

// 달력·목록에 뜨는 한 줄 = 업무의 날짜 하나.
function markType(task, entry) {
  if (task.type !== '할 일') return 'ref';
  if (!entry) return 'task';
  if (looseEntry(task, entry)) return 'loose';
  return entry.kind === '까지' ? 'task' : entry.kind === '기간' ? 'span' : 'event';
}

// 끝낸 일정(●)·기한 없는 할 일(○)은 끝낸 마감과 같은 칠한 체크로 보인다(2026-11-20).
function mark(type, done = false) {
  if (type === 'task' || ((type === 'event' || type === 'loose') && done)) return element('span', `box${done ? ' on' : ''}`);
  if (type === 'event') return element('span', 'disc');
  if (type === 'loose') return element('span', 'ring');
  if (type === 'span') return element('span', 'bar');
  return element('span', 'nomark');
}

function shortDate(value) {
  const date = fromKey(value);
  return `${date.getMonth() + 1}/${date.getDate()}(${WEEKDAYS[date.getDay()]})`;
}

// 2026-11-19 날짜 표기 맞추기: AI 정리·원문 머리의 '2026-11-12', '2026-11-05 09:30'을 날짜 줄과 같은 '11/12(목)' 꼴로.
// 올해가 아니면 앞에 'N년'을 붙인다. 화면에만 바꾸고 저장된 글은 그대로 둔다.
function friendlyDates(text, year = new Date().getFullYear()) {
  return String(text || '').replace(/(?<!\d)(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}:\d{2}))?(?![\d:])/gu, (whole, y, m, d, time) => {
    const date = new Date(Number(y), Number(m) - 1, Number(d));
    if (date.getMonth() !== Number(m) - 1 || date.getDate() !== Number(d)) return whole;
    const day = `${Number(y) === year ? '' : `${y}년 `}${shortDate(`${y}-${m}-${d}`)}`;
    return time ? `${day} ${time}` : day;
  });
}

function entryLate(task, entry, today = key(new Date())) {
  return task.type === '할 일' && entry?.kind === '까지' && !entry.done && entry.date < today;
}

function entryPastSchedule(task, entry, today) {
  return !task.candidate && task.type === '할 일' && entry?.kind === '그날' && !looseEntry(task, entry) && entry.done !== true && entry.date < today;
}

function isLate(task, today = key(new Date())) {
  return (task.dates || []).some(entry => entryLate(task, entry, today));
}

// AI 분류에 실패한 쪽지: 제목·유형이 처음 받은 그대로(할 일·날짜 없음)라 선생님이 정해야 한다.
function classifyFailed(task) {
  return !!task.noteId && task.refined === 'failed' && !!task.refineFailure && !task.refining;
}

function needsCheck(task) {
  return !!task.noteId && (task.noteState === 'unverified' || task.noteState === 'missing' || !!task.uncertain || classifyFailed(task));
}

function checkLabel(task) {
  if (task.noteState === 'unverified') return '원문 확인 필요';
  if (task.noteState === 'missing') return '원문 없음';
  if (classifyFailed(task)) return '분류 실패';
  if (task.uncertain) return task.type === '할 일' ? '확인 필요' : `${typeLabels[task.type]}?`;
  return '확인';
}

// 미완료 할 일과 분류가 애매한 쪽지 가운데 확인이 필요한 것.
function needsNoteReview(task) {
  if (!task.noteId || !needsCheck(task)) return false;
  if (classifyFailed(task)) return true;
  if (task.type === '할 일') return !finished(task);
  return task.uncertain === true && !(task.type === '알아 둘 것' && task.referenceSeen);
}

// 쪽지의 현재 유형을 누르면 그대로 맞다고 확인한다.
function checkActions(task) {
  const bar = element('div', 'check-actions');
  bar.setAttribute('role', 'group');
  bar.setAttribute('aria-label', `${task.title} 바로 고르기`);
  const failed = classifyFailed(task);
  const quick = (task.uncertain || failed) && task.noteState === 'available';
  const choices = quick ? Object.entries(typeLabels) : [];
  if (failed) {
    const retrying = task.refineFailure.retry && task.refineFailure.attempts < 2;
    bar.append(element('span', 'check-reason', `AI 분류 실패: ${task.refineFailure.message}${retrying ? ' 다음 확인 때 한 번 더 시도합니다.' : ''} 유형을 고르거나 열어서 다시 다듬어 주세요.`));
  }
  for (const [type, label] of choices) {
    const current = task.type === type && !failed;
    const choice = button(`chip${current ? ' current' : ''}`, current ? `${label} 맞음` : label);
    choice.dataset.focusKey = `check-${task.id}-${type}`;
    choice.addEventListener('click', () => void resolveCheck(task, type));
    bar.append(choice);
  }
  const dates = button('chip', quick ? '날짜' : '열어서 확인');
  dates.dataset.focusKey = `check-${task.id}-dates`;
  dates.addEventListener('click', () => {
    if (quick && task.type !== '없음') state.pendingDateEdit = task.id;
    selectTask(task.id, dates.dataset.focusKey);
  });
  bar.append(dates);
  return bar;
}

async function resolveCheck(task, type) {
  if (task.id === state.selected && state.dirty) { notice('자세히에서 저장하지 않은 변경을 먼저 저장해 주세요.'); return; }
  try {
    await api.update(task.id, { type, revision: task.revision });
    notice(type === task.type ? '확인했습니다.' : type === '할 일' ? '할 일로 옮겼습니다.' : `‘${type === '없음' ? '숨긴 것' : typeLabels[type]}’으로 옮겼습니다.`);
  } catch (error) {
    notice(error.message);
  }
}

function audience(count) {
  if (!count) return '';
  return count === 1 ? '나에게만' : `${count}명에게`;
}

function setMessage(id, message, error = false) {
  const node = $(id);
  node.textContent = message;
  node.classList.toggle('error', error);
  node.hidden = !message;
}

function notice(message) {
  clearTimeout(noticeTimer);
  setMessage('notice', message);
  noticeTimer = setTimeout(() => setMessage('notice', ''), 3800);
}

// 끝냄·중요 같은 짧은 결과 안내는 잠깐 보였다가 사라진다. 오류와 진행 중 안내는 setMessage로 그대로 둔다.
const flashTimers = {};
function flash(id, message) {
  clearTimeout(flashTimers[id]);
  setMessage(id, message);
  flashTimers[id] = setTimeout(() => { if ($(id).textContent === message && !$(id).classList.contains('error')) setMessage(id, ''); }, 3000);
}

function getFocusedKey() {
  return document.activeElement?.dataset.focusKey;
}

function restoreFocus(focusKey) {
  if (!focusKey || document.activeElement !== document.body) return;
  const focus = [...document.querySelectorAll('[data-focus-key]')].find(node => node.dataset.focusKey === focusKey);
  focus?.focus({ preventScroll: true });
}

// index: 까지 날짜의 순번, null이면 날짜 없는 할 일.
async function toggleDone(task, index, done) {
  if (task.id === state.selected && state.dirty) {
    notice('변경을 저장한 뒤 끝냄을 표시할 수 있습니다.');
    return;
  }
  try {
    await api.setDone(task.id, done, index);
  } catch (error) {
    notice(error.message);
  }
}


// 같은 업무 묶기: 같은 회의 쪽지가 두 번 와도 달력·목록에는 한 줄만 보이게 한다(저장된 업무는 그대로).
// 같은 날(기간이면 같은 시작·끝), 같은 기호이고 이름이 같거나 한쪽이 다른 쪽을 품으면 같은 업무로 본다.
function workKey(text) {
  return displayTitle(String(text || ''))
    .replace(/\[[^\]]*\]|\([^)]*\)/g, '')
    .replace(/재?(?:안내|알림|공지|개최|일정|변경|협조|요청|드립니다|합니다|입니다)/g, '')
    .replace(/[^0-9a-z가-힣]/gi, '').toLowerCase();
}
function sameWork(a, b) {
  const x = workKey(a), y = workKey(b);
  if (!x || !y) return false;
  return x === y || (Math.min(x.length, y.length) >= 4 && (x.includes(y) || y.includes(x)));
}
function sameEntry(a, b) {
  return a.task.id !== b.task.id && a.entry.date === b.entry.date && (a.entry.end || '') === (b.entry.end || '') &&
    markType(a.task, a.entry) === markType(b.task, b.entry) && isCandidate(a.task) === isCandidate(b.task) && sameWork(a.entry.label, b.entry.label);
}
// items: [{ task, entry, index }]. 묶음마다 가장 늦게 받은 쪽지를 대표로 두고 나머지는 dupes에 넣는다.
function mergeSame(items, today) {
  const groups = [];
  for (const item of items) {
    const past = today && entryPastSchedule(item.task, item.entry, today);
    const group = groups.find(list => list.every(other => sameEntry(other, item) &&
      (!today || entryPastSchedule(other.task, other.entry, today) === past)));
    if (group) group.push(item); else groups.push([item]);
  }
  return groups.map(list => {
    const [first, ...rest] = list.slice().sort((a, b) => (b.task.datetime || '').localeCompare(a.task.datetime || ''));
    return { ...first, dupes: rest };
  });
}
const groupTasks = item => [item.task, ...(item.dupes || []).map(dupe => dupe.task)];
const groupSelected = item => groupTasks(item).some(task => task.id === state.selected);
// 자세히에서 보여 줄, 같은 업무로 묶인 다른 업무들.
function sameWorkTasks(task) {
  const others = new Map();
  for (const entry of task.dates || []) {
    for (const other of state.snapshot.tasks) {
      if (other.id === task.id || other.type === '없음' || other.candidate?.discarded) continue;
      if ((other.dates || []).some(item => sameEntry({ task, entry }, { task: other, entry: item }))) others.set(other.id, other);
    }
  }
  return [...others.values()].sort((a, b) => (b.datetime || '').localeCompare(a.datetime || ''));
}
function sameCountBadge(count) {
  const badge = element('span', 'same-count', `${count}건`);
  badge.title = `같은 업무 쪽지 ${count}건을 한 줄로 묶었습니다`;
  return badge;
}

// 그날 안의 순서: 시간·교시를 적은 항목이 먼저, 이른 순서대로. 교시는 초등 보통 시정의 시작 시각으로 어림한다
// (1교시 9:00, 40분 수업·10분 쉬는 시간, 점심 뒤 5교시). 읽을 수 없는 글은 적은 항목 맨 뒤, 안 적은 항목은 그 뒤.
const PERIOD_START = [0, 540, 590, 640, 690, 790, 840, 890];
function timeOrder(time) {
  if (!time) return 100000;
  const text = time.replace(/\s/g, '');
  const clock = text.match(/^(오전|오후)?(\d{1,2})(?::|시)(\d{2})?/);
  if (clock) {
    let hour = Number(clock[2]);
    if (clock[1] === '오후' && hour < 12) hour += 12;
    // "3:30"처럼 오전·오후 없이 1~7시를 적으면 학교 일과로 보아 오후로 읽는다.
    if (!clock[1] && hour >= 1 && hour <= 7) hour += 12;
    return hour * 60 + Number(clock[3] || 0);
  }
  // "3~4교시"는 앞 교시로 읽는다.
  const period = text.match(/^(\d)(?:[~-]\d)?교시/);
  if (period) return PERIOD_START[Number(period[1])] ?? 50000;
  if (/아침|조회/.test(text)) return 500;
  if (/점심/.test(text)) return 740;
  if (/방과\s*후|방과후|종례/.test(text)) return 900;
  return 50000;
}

// 시간·교시 꼬리표: 선생님이 적은 그대로 제목 앞에 붙인다. 칸이 좁아도 줄지 않고 제목만 줄어든다.
function timeTag(time) {
  return element('span', 'item-time', time);
}

function calendarLabel(task, entry) {
  const brief = entry.shortLabel;
  if (!brief) return entry.label;
  // 같은 날 서로 다른 일을 같은 이름으로 줄였으면 각각의 전체 이름으로 구별한다.
  const ambiguous = task.dates?.some(other => other.date === entry.date && other.kind === entry.kind &&
    other.label !== entry.label && (other.shortLabel || other.label) === brief);
  return ambiguous ? entry.label : brief;
}

function priorityMark(level) {
  const mark = element('span', 'priority-mark', '★'.repeat(level));
  mark.dataset.level = String(level);
  mark.title = level === 2 ? '매우 중요' : '중요';
  mark.setAttribute('role', 'img');
  mark.setAttribute('aria-label', mark.title);
  return mark;
}

function drawPriority(picker, level, disabled = false) {
  picker.dataset.level = String(level);
  for (const star of picker.children) {
    const value = Number(star.dataset.stars);
    const filled = value <= level;
    star.classList.toggle('filled', filled);
    star.textContent = filled ? '★' : '☆';
    star.setAttribute('aria-pressed', String(value === level));
    star.disabled = disabled;
  }
}

function nextPriority(picker, star) {
  const value = Number(star.dataset.stars);
  return Number(picker.dataset.level) === value ? 0 : value;
}

function markCalendarPriority(node, level) {
  if (!level) return;
  const label = level === 2 ? '매우 중요' : '중요';
  node.dataset.priority = String(level);
  node.setAttribute('aria-description', label);
  node.title += ' · ' + label;
}

function calendarItem(task, entry, index, today, dupes = [], expanded = false) {
  const type = markType(task, entry);
  const all = [{ task, entry }, ...dupes];
  const done = task.type === '할 일' && checkable(entry) && all.every(item => item.entry.done === true);
  const past = entryPastSchedule(task, entry, today);
  // 다 본 알아 둘 것도 끝낸 것처럼 ✓·줄 긋기로 확실히 표시한다(2026-11-20 사용자 "흐림으로만 하면 애매한데").
  const seen = type === 'ref' && all.every(item => item.task.referenceSeen === true);
  const selected = all.some(item => item.task.id === state.selected);
  const level = Math.max(...all.map(item => priorityLevel(item.task)));
  const item = button(`item type-${type}`);
  const overdue = all.some(one => entryLate(one.task, one.entry, today));
  item.classList.toggle('late', overdue);
  item.classList.toggle('done', done || seen);
  item.classList.toggle('past', entry.kind !== '까지' && !looseEntry(task, entry) && lastDay(entry) < today);
  item.classList.toggle('selected', selected);
  // 후보는 흐리게(점선 테두리) 미리 보인다. 분류할 것 탭을 안 열어도 놓치지 않게.
  item.classList.toggle('candidate', isCandidate(task));
  item.title = [entry.label, task.title !== entry.label ? task.title : null,
    entry.kind === '까지' ? `${shortDate(entry.date)}${entry.time ? ` ${entry.time}` : ''}까지` : entry.time, task.chatSource?.time,
    isCandidate(task) ? `${candidateBadge(task)} · 분류할 것에서 정하기` : chatLabels[task.chatSource?.action], done ? '끝냄' : seen ? '확인함' : past ? '지난 일정' : '',
    type === 'loose' ? `기한 없음 · ${shortDate(entry.date)} ${taskModel.manualLoose(task, entry) ? '등록' : '받음'}` : '',
    dupes.length ? `같은 업무 쪽지 ${all.length}건` : ''].filter(Boolean).join(' · ');
  // 받은 날이 지나 오늘 칸에 따라온 기한 없는 할 일은 받은 지 며칠째인지 붙인다.
  const age = type === 'loose' && !done && entry.date < today ? looseAge(entry, today) : 0;
  item.setAttribute('aria-pressed', String(selected));
  item.dataset.focusKey = `calendar-${task.id}-${index}`;
  item.append(seen ? element('span', 'seen-mark', '✓') : mark(type, done));
  markCalendarPriority(item, level);
  // 시간은 제목 글줄 맨 앞에 넣는다. 칸이 좁으면 제목이 시간 뒤에 이어지다 다음 줄로 넘어간다.
  const title = element('span', 'item-title');
  if (task.repeat) title.append(repeatMark(task));
  if (entry.time) title.append(timeTag(entry.time), ' ');
  if (age) title.append(element('span', 'item-time item-age', `${age}일째`), ' ');
  const label = expanded ? entry.label : calendarLabel(task, entry);
  if (!expanded && !entry.time && !age && entry.shortScope && label.startsWith(entry.shortScope + ' ')) {
    title.classList.add('scoped-label');
    const action = element('span', 'calendar-action');
    action.append(element('bdi', null, label.slice(entry.shortScope.length + 1)));
    title.append(element('span', 'calendar-scope', entry.shortScope), ' ', action);
  } else if (!expanded && label.includes(' ')) {
    // 좁아도 마지막 행동은 남긴다. 충분한 폭에서는 원래 어순과 줄바꿈을 쓴다.
    const split = label.lastIndexOf(' ');
    const words = element('span', 'calendar-words');
    words.append(element('span', 'calendar-context', label.slice(0, split)), ' ',
      element('span', 'calendar-verb', label.slice(split + 1)));
    title.append(words);
  } else {
    title.append(label);
  }
  item.append(title);
  if (dupes.length) item.append(sameCountBadge(all.length));
  if (overdue) {
    const elapsed = daysBetween(entry.date, today) + '일 지남';
    item.title += ' · ' + elapsed;
    item.append(element('span', 'sr-only', elapsed));
  }
  if (past) item.append(element('span', 'sr-only', '지난 일정'));
  item.addEventListener('click', () => { if (selectTask(task.id, item.dataset.focusKey) !== false) revealInList(task.id, past ? index : null); });
  return item;
}

// 기간 선의 한 칸 조각. 시작일과 주의 첫 칸(일요일)에만 이름을 적는다. 끝난 기간은 흐리게.
// 기간 색은 여섯 가지 흐린 색. 달력에서 정한 색을 목록·자세히의 표시에도 같게 쓴다.
const SPAN_COLORS = 6;
function spanHash(id, index) {
  let value = index;
  for (const char of id) value = (value * 31 + char.charCodeAt(0)) >>> 0;
  return value % SPAN_COLORS;
}
function spanColor(task, index) {
  return state.spanColors.get(`${task.id}-${index}`) ?? spanHash(task.id, index);
}
function spanMark(task, index) {
  const node = mark('span');
  node.classList.add(`span-c${spanColor(task, index ?? 0)}`);
  return node;
}

function spanPiece(span, dateKey, weekFirst, today) {
  const { task, entry, index, dupes = [] } = span;
  const selected = groupSelected(span);
  const level = Math.max(...groupTasks(span).map(priorityLevel));
  const piece = button(`span-piece type-${markType(task, entry)} span-c${spanColor(task, index)}`);
  piece.classList.toggle('start', entry.date === dateKey);
  piece.classList.toggle('end', entry.end === dateKey);
  piece.classList.toggle('past', entry.end < today);
  piece.classList.toggle('selected', selected);
  piece.classList.toggle('candidate', isCandidate(task));
  piece.title = [entry.label, `${shortDate(entry.date)}~${shortDate(entry.end)}`, task.title !== entry.label ? task.title : null,
    isCandidate(task) ? `${candidateBadge(task)} · 분류할 것에서 정하기` : null,
    dupes.length ? `같은 업무 쪽지 ${dupes.length + 1}건` : null].filter(Boolean).join(' · ');
  piece.setAttribute('aria-label', `${entry.label} ${shortDate(entry.date)}부터 ${shortDate(entry.end)}까지`);
  markCalendarPriority(piece, level);
  piece.setAttribute('aria-pressed', String(selected));
  piece.dataset.focusKey = `span-${task.id}-${index}-${dateKey}`;
  if (entry.date === dateKey || weekFirst) {
    // 시간·교시는 기간의 첫날에만(그다음 주의 이어지는 칸에는 이름만).
    if (entry.time && entry.date === dateKey) piece.append(timeTag(entry.time));
    piece.append(element('span', 'span-label', calendarLabel(task, entry)));
    if (dupes.length) piece.append(sameCountBadge(dupes.length + 1));
  }
  piece.addEventListener('click', () => { if (selectTask(task.id, piece.dataset.focusKey) !== false) revealInList(task.id); });
  return piece;
}

// 그날 칸에서 끝낸 마감과 다 본 알아 둘 것은 뒤로 보낸다.
function closedEntry({ task, entry }) {
  return entry.done === true || (task.type === '알아 둘 것' && task.referenceSeen === true);
}

function selectedReceived(today = key(new Date())) {
  const task = state.snapshot.tasks.find(item => item.id === state.selected);
  if (!task?.noteId || task.type === '없음' || !task.dates?.length) return null;
  const start = receivedDay(task.datetime || '');
  return start && task.dates.some(entry => start < rolledDay(task, entry, today)) ? start : null;
}

// 학사일정을 날짜별로 묶는다. 담임 학년을 적어 두면 다른 학년만의 행사는 뺀다.
// continued: 바로 앞날에도 같은 이름이 있었음(방학·재량휴업 이어짐) → 첫날과 월요일에만 이름을 쓴다.
function schoolCalendar(events, profile) {
  const grade = Number(profile?.grade);
  const mine = Number.isInteger(grade) && grade >= 1 && grade <= 6 && profile?.workplace !== '교육청'
    ? events.filter(event => !event.grades?.length || event.grades.length === 6 || event.grades.includes(grade)) : events;
  const names = new Set(mine.map(event => `${event.date}|${event.name}`));
  const days = new Map();
  for (const event of mine) {
    const continued = names.has(`${key(shift(fromKey(event.date), -1))}|${event.name}`);
    if (!days.has(event.date)) days.set(event.date, { off: false, events: [] });
    const day = days.get(event.date);
    day.off ||= !!event.off;
    day.events.push({ ...event, continued });
  }
  return days;
}

function agendaSection(heading, note) {
  const section = element('section', 'agenda-section');
  const title = element('h3', null, heading);
  if (note) title.append(element('small', null, note));
  section.append(title);
  return section;
}

function agendaRow(task, entry, index, caption) {
  const row = button('agenda-row');
  row.dataset.focusKey = 'agenda-' + task.id + '-' + index;
  row.setAttribute('aria-pressed', String(state.selected === task.id));
  row.append(element('span', 'agenda-caption', caption),
    element('span', 'agenda-action', entry?.label || task.title));
  const level = priorityLevel(task);
  if (level) row.insertBefore(priorityMark(level), row.querySelector('.agenda-action'));
  row.addEventListener('click', () => selectTask(task.id, row.dataset.focusKey));
  return row;
}

function renderAgenda(today) {
  const groups = new Map();
  const late = agendaSection('지난 마감');
  late.classList.add('agenda-overdue');
  const loose = agendaSection('○ 기한 없음');
  const notices = agendaSection('날짜 없는 공지');
  const rows = [];
  for (const task of state.snapshot.tasks) {
    if (task.type === '없음' || isCandidate(task) || task.referenceSeen) continue;
    if (!task.dates?.length) {
      if (!finished(task)) rows.push({task, entry: null, index: -1, day: ''});
      continue;
    }
    task.dates.forEach((entry, index) => {
      if (entry.done || (lastDay(entry) < today && !looseEntry(task, entry) && !entryLate(task, entry, today))) return;
      rows.push({task, entry, index, day: activeDay(entry, today)});
    });
  }
  rows.sort((a,b) => a.day.localeCompare(b.day) || timeOrder(a.entry?.time) - timeOrder(b.entry?.time) ||
    priorityLevel(b.task) - priorityLevel(a.task) || a.task.title.localeCompare(b.task.title,'ko'));
  for (const {task,entry,index,day} of rows) {
    if (!entry || looseEntry(task, entry)) {
      const reference = task.type === '알아 둘 것';
      const since = entry?.date || receivedDay(task.datetime || '');
      const age = since && since <= today ? daysBetween(since, today) : null;
      const origin = entry && taskModel.manualLoose(task, entry) ? '등록' : '받음';
      const caption = age == null ? (reference ? '확인할 것' : '기한 없음') : (age ? age + '일 전 ' : '오늘 ') + origin;
      (reference ? notices : loose).append(agendaRow(task,entry,index,caption));
      continue;
    }
    if (entryLate(task,entry,today)) {
      late.append(agendaRow(task,entry,index,'□ '+shortDate(entry.date)+'까지'));
      continue;
    }
    if (!groups.has(day)) {
      const when = (day.slice(0,4) === today.slice(0,4) ? '' : day.slice(0,4)+'년 ') + shortDate(day);
      groups.set(day,agendaSection(day === today ? '오늘' : when,day === today ? when : ''));
    }
    const kind = task.type === '알아 둘 것' ? '확인할 것' : entry.kind === '까지' ? '□ 마감' : entry.kind === '기간' ? '기간' : '● 일정';
    const caption = entry.kind === '기간' ? kind+' '+spanText(entry,today) : kind+(entry.time ? ' '+entry.time : '');
    groups.get(day).append(agendaRow(task,entry,index,caption));
  }
  const content = element('div','agenda-content');
  const now = element('div','agenda-now');
  if (late.childElementCount > 1) now.append(late);
  if (groups.has(today)) now.append(groups.get(today));
  if (!now.childElementCount) now.append(agendaSection('오늘'),element('p','agenda-empty','오늘 날짜로 남은 업무가 없습니다.'));
  const later = element('div','agenda-later');
  for (const [day,section] of groups) if (day !== today) later.append(section);
  const side = element('div','agenda-side');
  if (loose.childElementCount > 1) side.append(loose);
  if (notices.childElementCount > 1) side.append(notices);
  content.append(now,side,later);
  $('agenda').replaceChildren(element('h2','agenda-heading','모아보기'),content);
}

function setCalendarMode(agenda) {
  $('calendar-workspace').classList.toggle('agenda-mode',agenda);
  $('agenda').hidden = !agenda;
  $('mode-month').setAttribute('aria-pressed',String(!agenda));
  $('mode-agenda').setAttribute('aria-pressed',String(agenda));
  document.querySelector('.calendar').setAttribute('aria-labelledby',agenda ? 'mode-agenda' : 'month-title');
  renderMonth();
  fitWidth();
}
$('mode-month').addEventListener('click', () => setCalendarMode(false));
$('mode-agenda').addEventListener('click', () => setCalendarMode(true));

const weekLayout = $('week-layout');
try {
  if (localStorage.getItem('calendar-week-layout') === 'fit') weekLayout.value = 'fit';
} catch {}
weekLayout.addEventListener('change', () => {
  try { localStorage.setItem('calendar-week-layout', weekLayout.value); } catch {}
  renderMonth();
});

// 접힌 단추도 같은 폭으로 측정해 제목이 두 줄이거나 스킨이 바뀔 때의 높이를 반영한다.
function fitDayItems(list) {
  const items = Array.from(list.querySelectorAll('.item'));
  const more = list.lastElementChild;
  const style = getComputedStyle(list);
  const available = parseFloat(style.height);
  const gap = parseFloat(style.rowGap);
  const heights = items.map(item => parseFloat(getComputedStyle(item).height));
  const full = heights.reduce((sum, height) => sum + height, 0) + gap * (items.length - 1);
  const day = list.parentElement;
  const dayStyle = getComputedStyle(day);
  const spans = list.previousElementSibling;
  const frame = parseFloat(dayStyle.paddingTop) + parseFloat(dayStyle.paddingBottom) +
    parseFloat(dayStyle.borderTopWidth) + parseFloat(dayStyle.borderBottomWidth) +
    (spans.offsetHeight ? spans.offsetHeight + parseFloat(getComputedStyle(spans).marginBottom) : 0);
  day.dataset.fullHeight = Math.ceil(frame + full);
  if (day.parentElement.classList.contains('week-fit')) {
    // 처음에는 여섯 제목까지 펼치고, 더 있으면 +N 단추 한 줄을 둔다.
    const preview = items.length <= 6 ? full : heights.slice(0, 6).reduce((sum, h) => sum + h, 0) +
      6 * gap + parseFloat(getComputedStyle(more).height);
    day.dataset.previewHeight = Math.ceil(frame + preview);
  }
  const fitsAll = full <= available + 0.01;
  const selected = items.findIndex(item => item.classList.contains('selected'));
  const visible = new Set();
  if (!fitsAll) {
    let space = available - parseFloat(getComputedStyle(more).height);
    if (selected >= 0 && heights[selected] + gap <= space) {
      visible.add(selected);
      space -= heights[selected] + gap;
    }
    for (let i = 0; i < items.length; i++) {
      if (visible.has(i)) continue;
      if (heights[i] + gap > space + 0.01) break;
      visible.add(i);
      space -= heights[i] + gap;
    }
  }
  items.forEach((item, i) => item.classList.toggle('folded', !fitsAll && !visible.has(i)));
  more.classList.toggle('folded', fitsAll);
  if (!fitsAll) {
    const label = '+' + (items.length - visible.size);
    if (more.textContent !== label) more.textContent = label;
  }
}

function updateAutoWeeks(grid) {
  if (!grid.classList.contains('week-fit')) return;
  const days = grid.querySelectorAll('.day');
  for (let start = 0; start < days.length; start += 7) {
    let preview = 0;
    let full = 0;
    for (let i = start; i < start + 7; i++) {
      preview = Math.max(preview, Number(days[i].dataset.previewHeight) || 0);
      full = Math.max(full, Number(days[i].dataset.fullHeight) || 0);
    }
    for (const [prefix, size] of [['--preview-week-', preview], ['--full-week-', full]]) {
      const prop = prefix + start / 7;
      if (grid.style.getPropertyValue(prop) !== size + 'px') grid.style.setProperty(prop, size + 'px');
    }
  }
}

const daySizeObserver = new ResizeObserver(entries => {
  const lists = new Set(entries.map(entry => entry.target.closest('.day-items')));
  for (const list of lists) if (list?.isConnected && list.offsetWidth) fitDayItems(list);
  updateAutoWeeks($('month'));
});

function weekDivider(monday, row, cells, autoTrack) {
  const cell = cells[0];
  const grid = $('month');
  const storageKey = 'calendar-week-height-' + monday;
  const property = '--week-' + row;
  const min = 48;
  const maxHeight = () => Math.max(720, ...cells.map(day => Number(day.dataset.fullHeight) || 0));
  let height = null;
  function apply(value, save) {
    height = value === null ? null : Math.max(min, Math.round(value));
    grid.style.setProperty(property, height === null ? autoTrack : height + 'px');
    for (const day of cells) day.style.minHeight = height === null
      ? 'max(clamp(58px, 8vh, 80px), var(--preview-week-' + row + ', 0px))' : '';
    if (save) {
      try {
        if (height === null) localStorage.removeItem(storageKey);
        else localStorage.setItem(storageKey, String(height));
      } catch {}
    }
  }
  let saved;
  try { saved = Number(localStorage.getItem(storageKey)); } catch {}
  apply(Number.isSafeInteger(saved) && saved >= min ? saved : null, false);
  const handle = element('div', 'week-divider');
  handle.style.gridRow = String(row + 1) + ' / span 1';
  handle.tabIndex = 0;
  handle.setAttribute('role', 'separator');
  handle.setAttribute('aria-orientation', 'horizontal');
  handle.setAttribute('aria-label', monday + ' 시작 주 높이');
  handle.setAttribute('aria-valuemin', String(min));
  handle.setAttribute('aria-valuemax', String(maxHeight()));
  handle.title = '끌어서 주 높이 조절 · 두 번 누르면 업무량에 맞춤';
  const sync = () => {
    handle.setAttribute('aria-valuenow', String(cell.offsetHeight));
    handle.setAttribute('aria-valuemax', String(Math.max(maxHeight(), cell.offsetHeight)));
  };
  handle.addEventListener('focus', sync);
  handle.addEventListener('keydown', event => {
    if (!['ArrowUp', 'ArrowDown', 'Home'].includes(event.key)) return;
    event.preventDefault();
    apply(event.key === 'Home' ? null : Math.min(Math.max(maxHeight(), cell.offsetHeight), cell.offsetHeight + (event.key === 'ArrowDown' ? 16 : -16)), true);
    sync();
  });
  handle.addEventListener('dblclick', () => { apply(null, true); sync(); });
  let drag;
  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0 || drag) return;
    handle.setPointerCapture(event.pointerId);
    drag = { id: event.pointerId, y: event.clientY, start: cell.offsetHeight, original: height,
      max: Math.max(maxHeight(), cell.offsetHeight), scale: cell.getBoundingClientRect().height / cell.offsetHeight };
  });
  handle.addEventListener('pointermove', event => {
    if (event.pointerId !== drag?.id || event.clientY === drag.y && height === drag.original) return;
    apply(Math.min(drag.max, drag.start + (event.clientY - drag.y) / drag.scale), false);
    sync();
  });
  function finish(event) {
    if (event.pointerId !== drag?.id) return;
    if (event.type === 'pointerup') apply(height, true);
    else apply(drag.original, false);
    drag = null;
    sync();
  }
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) handle.addEventListener(type, finish);
  return handle;
}

function renderMonth() {
  const today = key(new Date());
  if (!$('agenda').hidden) {
    renderAgenda(today);
    return;
  }
  const current = monthOf(state.month);
  const year = current.getFullYear();
  const month = current.getMonth();
  $('year-label').textContent = `${year}년`;
  $('month-value').textContent = String(month + 1);
  const first = shift(current, -weekday(current));
  const next = new Date(current);
  next.setMonth(month + 1);
  const weeks = Math.max(5, Math.ceil((weekday(current) + shift(next, -1).getDate()) / 7));
  const received = selectedReceived(today);
  const items = new Map();
  const spans = [];
  for (const task of state.snapshot.tasks) {
    if (task.type === '없음') continue;
    (task.dates || []).forEach((entry, index) => {
      if (entry.kind === '기간' && entry.end) { spans.push({ task, entry, index }); return; }
      // 끝내지 않은 기한 없는 할 일은 받은 날이 아니라 오늘 칸에 뜬다.
      const day = rolledDay(task, entry, today);
      if (!items.has(day)) items.set(day, []);
      items.get(day).push({ task, entry, index, rolled: day !== entry.date });
    });
  }
  // 기간은 시작일~끝일 칸을 가로지르는 선. 겹치면 줄(lane)을 나누고, 같은 기간은 그 달 내내 같은 줄에 둔다.
  const gridStart = key(first);
  const gridEnd = key(shift(first, weeks * 7 - 1));
  const visible = mergeSame(spans.filter(({ entry }) => entry.date <= gridEnd && entry.end >= gridStart))
    .sort((a, b) => a.entry.date.localeCompare(b.entry.date) || b.entry.end.localeCompare(a.entry.end) || a.task.id.localeCompare(b.task.id));
  const laneEnds = [];
  for (const span of visible) {
    const free = laneEnds.findIndex(end => end < span.entry.date);
    span.lane = free < 0 ? laneEnds.length : free;
    laneEnds[span.lane] = span.entry.end;
  }
  for (const span of visible) {
    const taken = new Set(visible.filter(other => other !== span && other.color !== undefined && other.entry.date <= span.entry.end && other.entry.end >= span.entry.date).map(other => other.color));
    let color = spanHash(span.task.id, span.index);
    for (let step = 0; step < SPAN_COLORS && taken.has(color); step++) color = (color + 1) % SPAN_COLORS;
    span.color = color;
    state.spanColors.set(`${span.task.id}-${span.index}`, color);
  }
  if (!state.dayKey.startsWith(`${String(year).padStart(4, '0')}-${String(month + 1).padStart(2, '0')}`)) {
    state.dayKey = today.startsWith(key(current).slice(0, 7)) ? today : key(current);
  }
  const schoolDays = schoolCalendar(state.snapshot.schoolEvents || [], state.snapshot.profile);
  const fit = weekLayout.value === 'fit';
  const days = [];
  daySizeObserver.disconnect();
  for (let index = 0; index < weeks * 7; index++) {
    const date = shift(first, index);
    const dateKey = key(date);
    const day = element('div', 'day');
    day.classList.toggle('sunday', date.getDay() === 0);
    day.classList.toggle('saturday', date.getDay() === 6);
    day.classList.toggle('adjacent', date.getMonth() !== month);
    day.classList.toggle('is-today', dateKey === today);
    const hit = button('day-hit');
    hit.setAttribute('aria-label', `${dateLabel.format(date)} · Enter로 업무 추가`);
    if (dateKey === today) hit.setAttribute('aria-current', 'date');
    hit.dataset.focusKey = `date-${dateKey}`;
    hit.tabIndex = dateKey === state.dayKey ? 0 : -1;
    hit.append(element('span', 'day-number', date.getDate()));
    if (received && dateKey === received) hit.append(element('span', 'received', '받음'));
    // 학사일정(나이스): 날짜 옆 흐린 글자. 쉬는 날은 칸을 흐리게. 방학처럼 며칠 이어지면 첫날과 월요일에만 이름.
    const schoolDay = schoolDays.get(dateKey);
    if (schoolDay) {
      day.classList.toggle('school-off', schoolDay.off);
      const names = schoolDay.events.filter(event => !event.continued || weekday(date) === 0).map(event => event.name);
      if (names.length) {
        const label = element('span', 'school-event', names.join(' · '));
        label.title = schoolDay.events.map(event => `${event.name}${event.off ? ` (${event.off})` : ''}`).join('\n');
        hit.append(label);
        hit.setAttribute('aria-label', `${dateLabel.format(date)} · ${schoolDay.events.map(event => event.name).join(', ')} · Enter로 업무 추가`);
      }
    }
    // 날짜 칸의 빈 곳을 마우스로 누르면 열린 자세히만 닫는다(업무 추가 창은 열지 않음, 2026-11-15 사용자).
    // 업무 추가는 칸의 + 단추와 위쪽 '업무 추가'로 한다. 키보드로 칸을 고르고 Enter를 누르면 그 날짜에 추가한다.
    hit.addEventListener('click', event => {
      if (event.detail === 0) { showCreate(dateKey); return; }
      if ($('detail-panel').classList.contains('open')) closeDetail();
    });
    const plus = button('day-plus', '+');
    plus.tabIndex = -1;
    plus.setAttribute('aria-label', `${dateLabel.format(date)} 업무 추가`);
    plus.title = '이 날짜에 업무 추가';
    plus.addEventListener('click', event => { event.stopPropagation(); showCreate(dateKey); });
    hit.addEventListener('keydown', event => {
      const move = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[event.key];
      if (move === undefined) return;
      event.preventDefault();
      const destination = shift(date, move);
      state.dayKey = key(destination);
      state.month = destination;
      renderMonth();
      const target = [...$('month').querySelectorAll('.day-hit')].find(node => node.dataset.focusKey === `date-${state.dayKey}`);
      target?.focus();
    });
    // 이 주에 걸친 기간의 줄 수만큼 자리를 두고, 이날에 걸린 기간은 선 조각을 그린다.
    const weekStart = key(shift(first, index - weekday(date)));
    const weekEnd = key(shift(first, index - weekday(date) + 6));
    const weekLanes = visible.filter(({ entry }) => entry.date <= weekEnd && entry.end >= weekStart)
      .reduce((most, span) => Math.max(most, span.lane + 1), 0);
    const lanes = element('div', 'day-spans');
    for (let lane = 0; lane < weekLanes; lane++) {
      const span = visible.find(item => item.lane === lane && item.entry.date <= dateKey && item.entry.end >= dateKey);
      lanes.append(span ? spanPiece(span, dateKey, weekday(date) === 0, today) : element('span', 'span-gap'));
    }
    const list = element('div', 'day-items');
    // 끝낸 것은 시간과 상관없이 그날 칸 맨 뒤로(2026-11-20). 오늘 칸에 따라온 기한 없는 할 일은 오늘 원래 항목 뒤로
    // (쌓여도 오늘 일정이 가려지지 않고 +N으로 접힌다).
    const dayTasks = mergeSame(items.get(dateKey) || [], today).sort((a, b) => Number(closedEntry(a)) - Number(closedEntry(b)) ||
      Number(!!a.rolled) - Number(!!b.rolled) ||
      Number(isCandidate(a.task)) - Number(isCandidate(b.task)) ||
      timeOrder(a.entry.time) - timeOrder(b.entry.time) ||
      TYPE_ORDER[markType(a.task, a.entry)] - TYPE_ORDER[markType(b.task, b.entry)]);
    for (const { task, entry, index, dupes } of dayTasks) list.append(calendarItem(task, entry, index, today, dupes));
    if (dayTasks.length) {
      // 넘친 날: +N을 누르면 그날 항목 전체를 작은 창으로 보여 준다(2026-11-12 사용자).
      const more = button('more folded', '+' + dayTasks.length);
      more.setAttribute('aria-label', `${dateLabel.format(date)} 항목 ${dayTasks.length}개 모두 보기`);
      more.dataset.focusKey = `more-${dateKey}`;
      more.addEventListener('click', () => showDayItems(date, dayTasks, today));
      list.append(more);
    }
    day.append(hit, plus, lanes, list);
    days.push(day);
  }
  const grid = $('month');
  grid.classList.toggle('week-fit', fit);
  const handles = [];
  for (let row = 0; fit && row < weeks; row++) {
    const auto = 'max(clamp(58px, 8vh, 80px), var(--full-week-' + row + ', 0px))';
    handles.push(weekDivider(key(shift(first, row * 7)), row, days.slice(row * 7, row * 7 + 7), auto));
  }
  grid.style.gridTemplateRows = handles.map((_, row) => 'minmax(max-content, var(--week-' + row + '))').join(' ');
  grid.replaceChildren(...days, ...handles);
  for (const list of grid.querySelectorAll('.day-items:not(:empty)')) {
    fitDayItems(list);
    daySizeObserver.observe(list);
    for (const child of list.children) daySizeObserver.observe(child);
  }
  updateAutoWeeks(grid);
  if (fit) handles.forEach((handle, row) => handle.setAttribute('aria-valuenow', String(days[row * 7].offsetHeight)));
}

// 하루 전체 보기 창. 항목을 누르면 자세히가 열리고 창은 닫힌다.
function showDayItems(date, dayTasks, today) {
  $('day-heading').textContent = dateLabel.format(date);
  const list = element('div', 'day-dialog-items');
  for (const { task, entry, index, dupes } of dayTasks) {
    const item = calendarItem(task, entry, index, today, dupes, true);
    item.addEventListener('click', () => $('day-dialog').close());
    list.append(item);
  }
  $('day-items-list').replaceChildren(list);
  $('day-dialog').showModal();
}

// 왼쪽 목록은 고르는 곳이라 날짜도 짧게(11/13). 자세한 날짜·요일은 오른쪽 자세히에서 본다.
function monthDay(value) {
  const date = fromKey(value);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

// 기간이 이미 시작했으면 오늘 묶음에 둔다(오늘도 그 기간 안이므로). 끝내지 않은 기한 없는 할 일도 오늘 묶음.
// (목록의 할 일 줄에서만 부르므로 유형은 할 일이다.)
function activeDay(entry, today) {
  if (entry.kind === '그날' && entry.received === true && entry.done !== true && entry.date < today) return today;
  return entry.kind === '기간' && entry.date < today && lastDay(entry) >= today ? today : entry.date;
}

// 기간: 11/16~20, 달이 바뀌면 11/28~12/2, 이미 시작했으면 ~11/20.
function spanText(entry, today) {
  const end = entry.end.slice(0, 7) === entry.date.slice(0, 7) ? String(Number(entry.end.slice(8))) : monthDay(entry.end);
  return entry.date <= today ? `~${monthDay(entry.end)}` : `${monthDay(entry.date)}~${end}`;
}

function entryWhen(task, entry, today) {
  if (entry.kind === '기간' && entry.end) return spanText(entry, today);
  if (entryLate(task, entry, today)) return `${daysBetween(entry.date, today)}일 지남`;
  // 기한 없는 할 일: 마감처럼 "지남"이 아니라 받은 지 며칠째인지(2026-11-20 사용자).
  if (looseEntry(task, entry) && entry.done !== true && entry.date < today) return `${looseAge(entry, today)}일째`;
  return entry.date === today ? '오늘' : monthDay(entry.date);
}



function whenText(task, today) {
  const late = (task.dates || []).find(entry => entryLate(task, entry, today));
  if (late) return entryWhen(task, late, today);
  const next = (task.dates || []).find(entry => lastDay(entry) >= today || (looseEntry(task, entry) && entry.done !== true)) || task.dates?.[0];
  if (next) return entryWhen(task, next, today);
  if (task.chatSource) return '';
  const received = receivedDay(task.datetime || '');
  // 날짜 없는 업무는 받은 날을 보인다. 마감일과 헷갈리지 않게 "받음"을 붙인다(2026-11-18 사용자 평가).
  return received ? `${monthDay(received)} 받음` : '';
}

// 목록에는 업무 제목을 쓰고, 여러 날짜 중 하나를 끝내는 줄에는 해당 행동을 덧붙인다.
// option.box: 'auto'(□가 있으면 체크), 'none'
// 상시 줄의 남은 날: D-23, 오늘이면 D-day, 지났으면 "N일 지남".
function pinnedWhen(task, today) {
  const entry = pinnedDue(task, today);
  if (!entry) return '';
  if (entryLate(task, entry, today)) return `${daysBetween(entry.date, today)}일 지남`;
  return entry.date === today ? 'D-day' : `D-${daysBetween(today, entry.date)}`;
}

function listRow(task, list, today, { entry = null, index = null, unread = false, pinned = false, dupes = [] } = {}) {
  if (pinned) {
    // 상시 줄은 업무 제목 한 줄. □는 가장 이른 남은 까지 하나를 끝낸다.
    const due = pinnedDue(task, today);
    const dueIndex = due?.kind === '까지' ? task.dates.indexOf(due) : -1;
    const row = listRow(task, list, today, dueIndex >= 0 ? { entry: due, index: dueIndex, unread } : { unread });
    row.classList.add('pinned');
    const pick = row.querySelector('.pick');
    pick.querySelector('.row-text').textContent = displayTitle(task.title);
    pick.title = due && due.label !== task.title ? `${task.title}\n${due.label}` : task.title;
    pick.querySelector('.row-when').textContent = pinnedWhen(task, today);
    pick.dataset.focusKey = `${list}-pinned-${task.id}`;
    return row;
  }
  // 업무 전체 줄: 마감이 있으면 □, 날짜가 없거나 기한 없는 할 일만 있으면 ○, 일정만 있으면 ●(끝내면 칠한 체크).
  const type = entry ? markType(task, entry) : task.type !== '할 일' ? 'ref'
    : task.dates?.some(item => item.kind === '까지') ? 'task'
    : !task.dates?.length || task.dates.every(item => looseEntry(task, item)) ? 'loose' : 'event';
  const row = element('li', `row type-${type}`);
  const rowKey = entry ? `${task.id}-${index}` : task.id;
  const doneNow = entry ? entry.done === true : finished(task);
  const selected = task.id === state.selected || dupes.some(dupe => dupe.task.id === state.selected);
  row.classList.toggle('selected', selected);
  row.classList.toggle('late', entry ? entryLate(task, entry, today) : isLate(task, today));
  row.classList.toggle('done', doneNow);
  const canCheck = !task.candidate && task.type === '할 일' && (entry ? checkable(entry) : boxes(task).length > 0);
  if (canCheck) {
    const check = button('check');
    check.setAttribute('aria-label', `${doneNow ? '끝냄 취소' : '끝냄'}: ${entry?.label || task.title}`);
    check.dataset.focusKey = `${list}-check-${rowKey}`;
    check.append(mark(type, doneNow));
    check.addEventListener('click', () => {
      if (entry) {
        void toggleDone(task, index, !doneNow);
        // 묶인 같은 업무도 함께 끝낸다(따로 남아 다시 뜨지 않게).
        for (const dupe of dupes) if (checkable(dupe.entry) && dupe.entry.done !== !doneNow) void toggleDone(dupe.task, dupe.index, !doneNow);
      } else void toggleDone(task, 'all', !doneNow);
    });
    row.append(check);
  } else {
    const holder = element('span', 'check');
    holder.append(type === 'span' ? spanMark(task, entry ? index : task.dates.findIndex(item => item.kind === '기간')) : mark(type));
    row.append(holder);
  }
  const pick = button('pick');
  pick.dataset.focusKey = `${list}-${rowKey}`;
  pick.setAttribute('aria-pressed', String(selected));
  // 한 줄: 제목(넘치면 …) + 짧은 날짜. 전체 제목·쪽지 제목은 마우스를 올리면, 자세한 내용은 오른쪽에서 본다.
  // 표시는 확인이 필요한 것만 붙인다(빨강).
  pick.title = [task.title, entry && entry.label !== task.title ? entry.label : '', dupes.length ? `같은 업무 쪽지 ${dupes.length + 1}건` : ''].filter(Boolean).join('\n');
  const heading = rowTitle(task.title);
  if (entry && task.dates.length > 1 && calendarLabel(task, entry) !== task.title) {
    heading.append(element('span', 'row-action', calendarLabel(task, entry)));
  }
  pick.append(heading);
  if (task.repeat) pick.querySelector('.row-text')?.prepend(repeatMark(task));
  if (unread) markUnreadRow(row, pick);
  const level = Math.max(priorityLevel(task), ...dupes.map(dupe => priorityLevel(dupe.task)));
  if (level) pick.insertBefore(priorityMark(level), heading);
  if (dupes.length) pick.append(sameCountBadge(dupes.length + 1));
  if (needsCheck(task)) pick.append(element('span', 'flag', checkLabel(task)));
  // AI가 아직 정리하지 않은 쪽지: 제목이 쪽지 제목 그대로인 까닭을 보인다.
  if (task.refining) pick.append(element('span', 'flag soft', '분류 중'));
  else if (task.queued && state.snapshot.aiProvider !== 'none') pick.append(element('span', 'flag soft', '분류 대기'));
  pick.append(element('span', 'row-when', entry ? entryWhen(task, entry, today) : whenText(task, today)));
  pick.addEventListener('click', () => { if (selectTask(task.id, pick.dataset.focusKey) !== false) showTaskMonth(task, entry); });
  row.append(pick);
  return row;
}

// 목록 제목: 말머리([안내]·RE: 등)는 남기고 앞의 인사말은 빼서 두 줄 안에 용건이 보이게 한다. 원래 제목은 마우스를 올리면 보인다.
const GREETING = /^(?:(?:[가-힣]{1,6}\s*)?(?:선생님|샘|쌤)(?:들)?[,~!\s]*)?(?:안녕하(?:세요|십니까)|안녕하신가요)[!?.~,\s]*/;
const OPENERS = [
  GREETING,
  /^(?:[가-힣]{1,8}\s*){0,3}(?:고생\s*많으셨(?:습니다|어요)|수고\s*많으십니다|수고하십니다|감사합니다)[!?.~,\s]*/,
  // 자기소개("○○부 담당 ○○○입니다.")는 역할 말이 있을 때만 뺀다.
  /^[가-힣\s]{0,16}(?:사서|교사|선생님|부장|담당|담당자|교감|교장|실무사|주무관|행정실|교무실)[가-힣\s]{0,8}입니다[.!]\s*/,
  /^[^.?!]{0,16}(?:보내셨|지내셨)(?:지요|나요|어요|죠)[?.!~\s]*/,
  /^(?:다름이\s*아니라|다름\s*아니오라|다름이\s*아니고)[,\s]*/
];

function displayTitle(text) {
  let rest = String(text).replace(/\s+/g, ' ').trim();
  const tag = rest.match(/^(?:\[[^\]]{1,10}\]\s*|(?:RE|FW|FWD)\s*:\s*)+/i)?.[0] || '';
  rest = rest.slice(tag.length);
  for (let changed = true; changed;) {
    changed = false;
    for (const pattern of OPENERS) {
      const next = rest.replace(pattern, '');
      if (next !== rest && next.length >= 4) { rest = next; changed = true; }
    }
  }
  return `${tag}${rest}`.trim() || String(text).trim();
}

// 반복 표시 ↻: 마우스를 올리면 "매주 목 · 2/28까지".
function repeatLine(task) {
  const repeat = task.repeat;
  return repeat ? `${taskModel.repeatLabel(repeat.every, repeat.start)} · ${shortDate(repeat.until)}까지` : '';
}
function repeatMark(task) {
  const node = element('span', 'repeat-mark', '↻ ');
  node.title = repeatLine(task);
  node.setAttribute('aria-label', `반복 ${repeatLine(task)}`);
  return node;
}

function rowTitle(text) {
  const title = element('span', 'row-title');
  title.append(element('span', 'row-text', displayTitle(text)));
  return title;
}

function markUnreadRow(row, pick) {
  row.classList.add('unread');
  const dot = element('span', 'unread-dot');
  dot.setAttribute('aria-hidden', 'true');
  pick.prepend(dot, element('span', 'sr-only', '안 읽음 '));
}

function updateTab(view, total, unread) {
  $(`${view}-count`).textContent = total;
  const count = $(`${view}-unread`);
  if (!count) return;
  count.textContent = unread;
  count.parentElement.hidden = !unread;
}

function taskMessageKey(task) {
  return task.noteId ? `note:${task.id}` : task.chatSource ? `chat:${task.chatSource.batchId}` : '';
}

function messageTime(value) {
  const at = Date.parse(value);
  return Number.isFinite(at) ? messageDate.format(at) : value;
}

function hiddenMessageRow(message) {
  const { kind, id, unread, title, source, at, count, recipients } = message;
  const selected = id === (kind === 'note' ? state.selected : state.selectedChat);
  const row = element('li', 'row type-ref');
  row.classList.toggle('selected', selected);
  const pick = button('pick');
  pick.dataset.focusKey = `message-${kind}-${id}`;
  pick.setAttribute('aria-pressed', String(selected));
  const details = kind === 'chat' ? [`대화 ${count}건`, `수집 ${messageTime(at)}`]
    : [recipients === 1 ? '나에게만' : '', source, messageTime(at)];
  pick.title = [title, details.filter(Boolean).join(' · ')].join('\n');
  pick.append(rowTitle(kind === 'chat' ? `${title} · 대화 ${count}건` : title));
  if (unread) markUnreadRow(row, pick);
  const day = receivedDay(at || '') || (Number.isFinite(Date.parse(at)) ? key(new Date(Date.parse(at))) : '');
  pick.append(element('span', 'row-when', day ? monthDay(day) : ''));
  pick.addEventListener('click', () => {
    if (kind === 'note') selectTask(id, pick.dataset.focusKey);
    else void selectChat(id, pick.dataset.focusKey);
  });
  row.append(pick);
  return row;
}

function candidateRow(task, today, unread, existing) {
  const row = listRow(task, 'candidate', today, { unread });
  row.classList.add('with-actions', 'candidate-row');
  const pick = row.querySelector('.pick');
  if (task.candidate.change) pick.insertBefore(element('span', 'flag', task.chatSource?.action === 'cancelled' ? '취소' : '변경'), pick.querySelector('.row-when'));
  const bar = element('div', 'candidate-actions');
  bar.setAttribute('role', 'group');
  bar.setAttribute('aria-label', `${task.title} 정하기`);
  if (task.candidate.change) {
    const open = button('button primary small', '기존 업무 고치기');
    open.dataset.focusKey = `candidate-${task.id}-open`;
    open.addEventListener('click', () => selectTask(task.id, open.dataset.focusKey));
    bar.append(open);
  } else {
    const recommended = task.candidate.suggestedType === '알아 둘 것' ? '알아 둘 것' : '할 일';
    const other = recommended === '할 일' ? '알아 둘 것' : '할 일';
    for (const [index, type] of [recommended, other].entries()) {
      const action = type === '할 일' ? '할 일로' : '확인할 것으로';
      const choice = button(index === 0 ? 'button primary small' : 'button text-button small candidate-alternative',
        index === 0 ? action + ' 올리기' : typeLabels[type]);
      choice.setAttribute('aria-label', `${action} 올리기${index === 0 ? ' (추천)' : ''}`);
      choice.dataset.focusKey = `candidate-${task.id}-${type}`;
      choice.addEventListener('click', () => void acceptCandidate(task, type));
      bar.append(choice);
    }
  }
  // ×만으로는 결과가 안 보여 글자로 쓴다(2026-11-18 사용자 평가). 제외한 후보는 숨긴 것에서 되살릴 수 있다.
  const drop = button('button text-button small candidate-drop', '후보 제외');
  drop.setAttribute('aria-label', `${task.title} 후보 제외`);
  drop.title = '이 후보를 올리지 않습니다. 숨긴 것에서 되살릴 수 있습니다.';
  drop.dataset.focusKey = `candidate-${task.id}-drop`;
  drop.addEventListener('click', () => void discardCandidates({ id: task.id }));
  bar.append(drop);
  row.append(bar);
  if (task.candidate.change && existing && existing.chatSource?.roomKey === task.chatSource?.roomKey) {
    const target = element('p', 'candidate-target-name', '대상: ' + existing.title);
    target.title = existing.title;
    row.append(target);
  }
  return row;
}

async function acceptCandidate(task, type) {
  if (task.id === state.selected && state.dirty) { notice('자세히에서 고친 내용은 자세히의 ‘올리기’로 올려 주세요.'); return; }
  try {
    await api.acceptCandidate(task.id, { type, revision: task.revision });
    notice(type === '할 일' ? '할 일로 올렸습니다.' : '확인할 것으로 올렸습니다.');
  } catch (error) {
    notice(error.message);
  }
}

async function discardCandidates(input) {
  try {
    await api.discardCandidates(input);
    notice(input.batchId ? '남은 후보를 버렸습니다. 숨긴 것에서 되살릴 수 있습니다.' : '버렸습니다. 숨긴 것에서 되살릴 수 있습니다.');
  } catch (error) {
    notice(error.message);
  }
}

// 묶음 머리줄의 시각: 오늘이면 "오늘 오전 10:43", 아니면 "11/11 오전 10:43".
const clockTime = new Intl.DateTimeFormat('ko-KR', { hour: 'numeric', minute: '2-digit' });
function batchTime(value, today) {
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return '';
  const day = key(new Date(at));
  return `${day === today ? '오늘' : monthDay(day)} ${clockTime.format(at)}`;
}

function forwardedSection(message) {
  if (!message?.forwarded?.length) return null;
  const section = element('section', 'forwarded-review');
  const heading = element('h4', 'forwarded-review-title', '전달 글 원문');
  heading.id = `detail-forwarded-title-${message.id}`;
  section.setAttribute('aria-labelledby', heading.id);
  section.append(heading);
  const lists = message.forwarded.map(({ messageIndex, lead, lines }, index) => {
    const details = element('details', 'forwarded-lines');
    const listKey = `detail-forwarded-${message.id}-${messageIndex}`;
    const summary = element('summary');
    const title = element('span', 'forwarded-heading-text', lead || `전달 글 ${index + 1}`);
    if (lead) title.title = lead;
    const registered = lines.filter(line => line.taskId).length;
    summary.append(title, element('span', 'forwarded-count',
      `${lines.length}줄${registered ? ` · ${registered}줄 올림` : ''}`));
    summary.dataset.focusKey = listKey;
    details.open = state.expandedForwarded.has(listKey);
    summary.addEventListener('click', () => {
      if (details.open) state.expandedForwarded.delete(listKey);
      else state.expandedForwarded.add(listKey);
    });
    const list = element('ul');
    for (const line of lines) {
      const row = element('li');
      const pick = button('forwarded-line');
      pick.dataset.focusKey = `${listKey}-${line.lineIndex}`;
      pick.append(element('span', 'forwarded-text', line.text));
      if (line.taskId) pick.append(element('span', 'forwarded-registered', '올림'));
      pick.title = line.taskId ? '올린 업무 열기' : '이 줄로 업무 만들기';
      pick.addEventListener('click', () => {
        if (line.taskId) selectTask(line.taskId, pick.dataset.focusKey);
        else void selectForwardedLine(message, messageIndex, line, pick.dataset.focusKey);
      });
      row.append(pick);
      list.append(row);
    }
    details.append(summary, list);
    return details;
  });
  section.append(...lists);
  return section;
}

let pendingBatchFinish;
const finishingBatches = new Set();
async function finishCandidateBatch(id, candidateIds) {
  if (finishingBatches.has(id)) return;
  finishingBatches.add(id);
  renderLists();
  try {
    sync(await api.finishChatBatch(id, candidateIds));
    if (!state.dirty && (state.selectedChat === id ||
        state.detail?.task?.candidate && state.detail.task.chatSource?.batchId === id)) closeDetail();
    notice('이 묶음 정리를 마쳤습니다.');
  } catch (error) {
    try { sync(await api.load()); } catch {}
    notice(error.message);
  } finally {
    finishingBatches.delete(id);
    renderLists();
    if (document.activeElement === document.body) $('tab-candidate').focus();
  }
}

function requestBatchFinish(id, list) {
  if (state.dirty && state.detail?.task?.chatSource?.batchId === id) {
    notice('자세히에서 고친 내용을 먼저 저장하거나 닫아 주세요.');
    return;
  }
  if (!list.length) return void finishCandidateBatch(id, []);
  pendingBatchFinish = { id, candidates: list.map(task => task.id) };
  $('finish-chat-copy').textContent = `남은 후보 ${list.length}개는 버립니다. 숨긴 것에서 되살릴 수 있습니다.`;
  $('finish-chat-dialog').showModal();
  $('finish-chat-cancel').focus();
}
$('finish-chat-cancel').addEventListener('click', () => $('finish-chat-dialog').close());
$('finish-chat-confirm').addEventListener('click', () => {
  const pending = pendingBatchFinish;
  $('finish-chat-dialog').close();
  if (pending) void finishCandidateBatch(pending.id, pending.candidates);
});
$('finish-chat-dialog').addEventListener('close', () => { pendingBatchFinish = null; });

function candidateFooter(batchId, message, room, list) {
  const footer = element('div', 'candidate-footer');
  const lineCount = message?.forwarded?.reduce((sum, item) => sum + item.lines.length, 0) || 0;
  if (lineCount) {
    const copy = `${list.length ? '' : '후보 없음 · '}원문 ${lineCount}줄 보기 ›`;
    const open = button('button text-button small candidate-original-link', copy);
    open.title = copy;
    open.dataset.focusKey = `forwarded-batch-${batchId}`;
    open.addEventListener('click', () => void selectChat(batchId, open.dataset.focusKey, { forwarded: true }));
    footer.append(open);
  }
  // "이 묶음": 정리하는 단위가 방이 아니라 한 번에 가져온 대화 묶음이다(2026-11-18 사용자 평가 "정리 끝"이 모호).
  const done = button('button small candidate-finish', '이 묶음 정리 끝');
  done.setAttribute('aria-label', `${room} 이 묶음 정리 끝`);
  done.dataset.focusKey = `candidate-batch-${batchId}`;
  done.disabled = finishingBatches.has(batchId);
  done.addEventListener('click', () => requestBatchFinish(batchId, list));
  footer.append(done);
  return footer;
}

function renderReviewQueue(unread, notes) {
  const today = key(new Date());
  const live = state.snapshot.tasks.filter(isCandidate);
  const existing = new Map(state.snapshot.tasks.filter(task => !task.candidate && task.type !== '없음')
    .map(task => [task.id, task]));
  const batches = new Map();
  for (const task of live) {
    const id = task.chatSource?.batchId || '';
    if (!batches.has(id)) batches.set(id, []);
    batches.get(id).push(task);
  }
  const chats = new Map(state.snapshot.messages.filter(message => message.kind === 'chat').map(message => [message.id, message]));
  const waiting = [...chats.values()].filter(message => message.forwarded?.length && !message.forwardedReviewed);
  for (const { id } of waiting) if (!batches.has(id)) batches.set(id, []);
  const at = (id, list) => chats.get(id)?.at || list[0]?.datetime || '';
  const rooms = new Set([...batches.entries()].map(([id, list]) => chats.get(id)?.roomKey || list[0]?.chatSource?.roomKey || id));
  const ordered = [...batches.entries()].sort(([a, aList], [b, bList]) => at(b, bList).localeCompare(at(a, aList)));
  const sections = ordered.map(([batchId, list]) => {
    const message = chats.get(batchId);
    const section = element('section', 'group candidate-group');
    const head = element('div', 'candidate-head');
    const room = message?.title || list[0]?.chatSource?.roomTitle || '대화방';
    const receivedAt = at(batchId, list);
    const receivedDate = new Date(receivedAt);
    const day = Number.isNaN(receivedDate.valueOf()) ? '' : key(receivedDate);
    const heading = element('h3');
    heading.title = [room, batchTime(receivedAt, today), message ? `대화 ${message.count}건` : ''].filter(Boolean).join(' · ');
    heading.append(element('span', 'candidate-room', room));
    if (day) heading.append(element('span', 'group-meta', day === today ? '오늘' : monthDay(day)));
    head.append(heading);
    section.append(head);
    if (list.length) {
      const rows = element('ul', 'rows');
      const sorted = list.slice().sort((a, b) => (a.dates?.[0]?.date || '9999').localeCompare(b.dates?.[0]?.date || '9999'));
      rows.append(...sorted.map(task => candidateRow(task, today, unread.has(`chat:${batchId}`), existing.get(task.candidate.targetId))));
      section.append(rows);
    }
    section.append(candidateFooter(batchId, message, room, list));
    return section;
  });
  if (notes.length) {
    const section = element('section', 'group candidate-group note-review-group');
    const heading = element('h3', null, '쪽지');
    heading.append(element('span', 'group-count', `${notes.length}건`));
    const list = element('ul', 'rows');
    list.append(...notes.map(task => {
      const row = listRow(task, 'candidate-note', today, { unread: unread.has(taskMessageKey(task)) });
      row.classList.add('with-actions');
      row.append(checkActions(task));
      return row;
    }));
    section.append(heading, list);
    sections.unshift(section);
  }
  const guide = notes.length
    ? rooms.size ? '쪽지를 확인하고 올릴 후보를 고르세요.' : '쪽지를 열어 확인하세요.'
    : '올릴 후보를 고르세요.';
  const breakdown = [notes.length ? `쪽지 ${notes.length}건` : '', rooms.size ? `대화방 ${rooms.size}개` : ''].filter(Boolean).join(' · ') || '대기 항목 없음';
  const intro = element('p', 'candidate-guide');
  intro.append(element('strong', 'candidate-breakdown', breakdown), document.createTextNode(guide));
  $('candidate-list').replaceChildren(...(sections.length
    ? [intro, ...sections]
    : [element('p', 'empty-row', '확인하거나 분류할 항목이 없습니다.')]));
  const keys = new Set([...batches.keys()].map(id => `chat:${id}`));
  $('candidate-count-label').textContent = !state.messenger.supportsChats ? '쪽지' : notes.length ? rooms.size ? '대기' : '쪽지' : '방';
  $('candidate-count-detail').textContent = breakdown;
  $('candidate-count').parentElement.title = breakdown;
  updateTab('candidate', notes.length + rooms.size);
  return keys;
}

function renderLists() {
  const today = key(new Date());
  const todayDate = fromKey(today);
  // 토·일에도 다가오는 월~일은 다음 주다(2026-11-15 사용자).
  const weekEnd = key(shift(todayDate, 6 - weekday(todayDate)));
  const nextWeekEnd = key(shift(todayDate, 13 - weekday(todayDate)));
  $('today-label').textContent = `${todayDate.getMonth() + 1}월 ${todayDate.getDate()}일 ${WEEKDAYS[todayDate.getDay()]}요일`;
  // 대화방 후보(버린 것 포함)는 해야 할 것·알아 둘 것·끝낸 것에 넣지 않는다.
  const tasks = state.snapshot.tasks.filter(task => !task.candidate);
  const messages = state.snapshot.messages;
  const unread = new Set(messages.filter(message => message.unread).map(({ kind, id }) => `${kind}:${id}`));
  const byReceived = (a, b) => (b.datetime || '').localeCompare(a.datetime || '');
  const notesForReview = tasks.filter(needsNoteReview).sort(byReceived);
  const noteReviewIds = new Set(notesForReview.map(task => task.id));
  const candidateBatches = renderReviewQueue(unread, notesForReview);
  const checked = new Set(noteReviewIds);
  // 상시: 직접 켠 할 일. 날짜 묶음에는 다시 넣지 않는다(달력에는 그대로 뜬다).
  const pinnedTasks = tasks.filter(task => isPinned(task) && !checked.has(task.id))
    .sort((a, b) => (pinnedDue(a, today)?.date || '9999').localeCompare(pinnedDue(b, today)?.date || '9999') || a.title.localeCompare(b.title, 'ko'));
  for (const task of pinnedTasks) checked.add(task.id);
  // 반복: 같은 반복에서 오늘 이후 가장 가까운 남은 회차 하나만 목록에 둔다(지난 안 끝낸 회차는 "지남"에 그대로).
  const nextRepeat = new Map();
  for (const task of tasks) {
    const entry = task.repeat && task.dates?.[0];
    if (!entry || entry.done || entry.date < today) continue;
    const best = nextRepeat.get(task.repeat.seriesId);
    if (!best || entry.date < best.dates[0].date) nextRepeat.set(task.repeat.seriesId, task);
  }
  const laterRepeat = task => !!task.repeat && task.dates?.[0]?.date >= today && nextRepeat.get(task.repeat.seriesId) !== task;
  // 날짜 하나가 한 줄이다. 완료 표시가 없는 지난 일정은 마감이나 다른 날짜와 별도로 찾을 수 있다.
  const rows = [];
  const pastRows = [];
  for (const task of tasks) {
    if (task.type !== '할 일' || noteReviewIds.has(task.id) || laterRepeat(task)) continue;
    (task.dates || []).forEach((entry, index) => {
      if (entryPastSchedule(task, entry, today)) {
        pastRows.push({ task, entry, index });
      } else if (!checked.has(task.id) && !entry.done && (entry.kind === '까지' || looseEntry(task, entry) || lastDay(entry) >= today)) {
        rows.push({ task, entry, index });
      }
    });
  }
  const byDate = (a, b) => priorityLevel(b.task) - priorityLevel(a.task) ||
    activeDay(a.entry, today).localeCompare(activeDay(b.entry, today)) || TYPE_ORDER[markType(a.task, a.entry)] - TYPE_ORDER[markType(b.task, b.entry)] ||
    a.entry.label.localeCompare(b.entry.label, 'ko');
  const dateless = tasks.filter(task => task.type === '할 일' && !checked.has(task.id) && !task.dates?.length && !task.done).sort(byReceived);
  const dateGroup = test => mergeSame(rows.filter(test)).sort(byDate);
  const groups = [
    ['상시', pinnedTasks.map(task => ({ task, pinned: true })), 'pinned-group'],
    ['지남', dateGroup(({ task, entry }) => entryLate(task, entry, today)), 'late-group'],
    ['오늘', dateGroup(({ entry }) => activeDay(entry, today) === today)],
    ['이번 주', dateGroup(({ entry }) => activeDay(entry, today) > today && entry.date <= weekEnd)],
    ['다음 주', dateGroup(({ entry }) => entry.date > weekEnd && entry.date <= nextWeekEnd)],
    ['그 뒤', dateGroup(({ entry }) => entry.date > nextWeekEnd)],
    ['날짜 없음', dateless.map(task => ({ task }))],
  ];
  const todoCount = groups.reduce((sum, [, items]) => sum + items.length, 0);
  const todoTasks = new Set(groups.flatMap(([, items]) => items.flatMap(groupTasks)));
  const todoMessages = new Set([...todoTasks].map(taskMessageKey));
  const todoUnread = [...todoMessages].filter(message => unread.has(message)).length;
  const sections = [];
  for (const [name, items, className] of groups) {
    if (!items.length) continue;
    const section = element('section', `group${className ? ` ${className}` : ''}`);
    const heading = element('h3', null, name);
    if (items.length > 1) heading.append(element('span', 'group-count', String(items.length)));
    const list = element('ul', 'rows');
    list.append(...items.map(({ task, entry, index, pinned, dupes }) =>
      listRow(task, 'todo', today, { entry, index, pinned, dupes, unread: [task, ...(dupes || []).map(dupe => dupe.task)].some(one => unread.has(taskMessageKey(one))) })));
    section.append(heading, list);
    sections.push(section);
  }
  $('todo-list').replaceChildren(...(sections.length ? sections : [element('p', 'empty-row', '할 일이 없습니다.')]));

  updateTab('todo', todoCount, todoUnread);

  const past = mergeSame(pastRows).sort((a, b) => b.entry.date.localeCompare(a.entry.date) || byDate(a, b));
  const pastTasks = new Set(past.flatMap(groupTasks));
  const pastMessages = new Set([...pastTasks].map(taskMessageKey));
  const unreadInPast = message => unread.has(message) && !todoMessages.has(message);
  updateTab('past', past.length, [...pastMessages].filter(unreadInPast).length);
  $('past-list').replaceChildren(...(past.length
    ? past.map(({ task, entry, index, dupes }) => listRow(task, 'past', today, {
      entry, index, dupes, unread: [task, ...dupes.map(dupe => dupe.task)].some(one => unreadInPast(taskMessageKey(one)))
    }))
    : [element('li', 'empty-row', '지난 일정이 없습니다.')]));

  const references = tasks.filter(task => task.type === '알아 둘 것' && !task.referenceSeen && !checked.has(task.id)).sort(byReceived);
  updateTab('reference', references.length, references.filter(task => unread.has(taskMessageKey(task))).length);
  $('reference-list').replaceChildren(...(references.length
    ? references.map(task => listRow(task, 'reference', today, { unread: unread.has(taskMessageKey(task)) }))
    : [element('li', 'empty-row', '확인할 것이 없습니다.')]));

  // 목록에서 내려간 쪽지도 다시 열 수 있게 한다. 여러 날짜 중 남은 일이 있으면 해야 할 것에 둔다.
  const done = tasks.filter(task => {
    if (noteReviewIds.has(task.id)) return false;
    if (task.type === '알아 둘 것') return task.referenceSeen;
    if (task.type !== '할 일' || todoTasks.has(task) || pastTasks.has(task)) return false;
    return finished(task) || ((task.noteId || task.chatSource) && task.dates?.length);
  }).sort(byReceived);
  const doneMessages = new Set(done.map(taskMessageKey));
  const unreadInDone = message => unread.has(message) && !todoMessages.has(message);
  updateTab('done', done.length, [...doneMessages].filter(unreadInDone).length);
  $('done-list').replaceChildren(...(done.length
    ? done.map(task => listRow(task, 'done', today, { unread: unreadInDone(taskMessageKey(task)) }))
    : [element('li', 'empty-row', '끝낸 항목이 없습니다.')]));

  const referenceMessages = new Set(references.map(taskMessageKey));
  const hidden = messages.filter(message => message.kind === 'note' ? message.type === '없음' && !noteReviewIds.has(message.id)
    : ![todoMessages, pastMessages, doneMessages, referenceMessages, candidateBatches].some(set => set.has(`chat:${message.id}`)));
  // 버린 후보: 숨긴 것에서 다시 열어 되살릴 수 있다.
  const discarded = state.snapshot.tasks.filter(task => task.candidate?.discarded).sort(byReceived);
  updateTab('hidden', hidden.length + discarded.length, hidden.filter(message => message.unread).length);
  const discardedRows = discarded.map(task => {
    const row = listRow(task, 'hidden', today);
    const pick = row.querySelector('.pick');
    pick.insertBefore(element('span', 'flag soft', '버린 후보'), pick.querySelector('.row-when'));
    return row;
  });
  $('hidden-list').replaceChildren(...(hidden.length || discarded.length
    ? [...discardedRows, ...hidden.map(hiddenMessageRow)]
    : [element('li', 'empty-row', '숨긴 항목이 없습니다.')]));

  // 달력에서 업무를 누르면 왼쪽을 그 업무가 있는 탭으로 바꾼다. 앞선 탭이 우선.
  const views = new Map();
  const put = (view, list) => { for (const task of list) if (!views.has(task.id)) views.set(task.id, view); };
  put('candidate', [...notesForReview, ...state.snapshot.tasks.filter(isCandidate)]);
  put('todo', todoTasks);
  put('reference', references);
  put('past', pastTasks);
  put('done', done);
  put('hidden', discarded);
  for (const message of hidden) if (message.kind === 'note' && !views.has(message.id)) views.set(message.id, 'hidden');
  state.taskViews = views;

  const { status, pending } = state.snapshot.inbox;
  // 처음 쓰는 사람: 브리티를 아직 연결하지 않았으면 오류 대신 할 일을 알려 준다.
  const notConnectedYet = !!state.snapshot.collectorAvailable && !state.snapshot.collectorConnected;
  const aiMissing = aiNotConnected();
  const { name } = state.messenger;
  $('inbox-note').textContent = status === 'unavailable' && notConnectedYet ? (aiMissing ? '' : `${name}에 로그인한 뒤 위의 ‘${name} 연결’을 누르면 쪽지를 가져옵니다.`)
    : status === 'unavailable' ? '쪽지 수집 폴더를 읽지 못했습니다. 연결 상태를 확인해 주세요.'
    : status === 'loading' ? '쪽지를 확인하고 있습니다.' : pending ? `아직 읽지 못한 쪽지 ${pending}건은 다음에 다시 확인합니다.` : '';
  // AI를 아직 연결하지 않았으면 정리하려면 무엇을 해야 하는지 알려 준다(샘플 제외).
  $('ai-setup-note').hidden = !aiMissing;
  // AI 연결 전에 가져와 정리되지 않은 쪽지: 연결한 뒤에는 누르면 한꺼번에 정리한다.
  const backlog = state.snapshot.backlogPending || 0;
  $('backlog-note').hidden = aiMissing || !backlog || !!state.demo;
  $('backlog-text').textContent = `AI 연결 전에 가져온 쪽지 ${backlog}건이 아직 정리되지 않았습니다.`;
  $('backlog-classify').disabled = !!state.backlogBusy;
  renderSearch();
}

function aiNotConnected() {
  return !state.demo && (state.snapshot.aiProvider ?? 'none') === 'none';
}

function redraw() {
  const focused = getFocusedKey();
  renderMonth();
  renderLists();
  restoreFocus(focused);
}

// 편집 중인 유형과 날짜는 저장 전까지 화면에만 있다.
function editingDates() {
  return state.editDates || [];
}

function showCompletion(control, done, label) {
  control.textContent = done ? '✓ 완료됨' : '완료';
  control.setAttribute('aria-pressed', String(done));
  control.setAttribute('aria-label', (done ? '완료 취소: ' : '완료: ') + label);
  control.disabled = state.saving || state.dirty;
}

function readOnlyDateRow(task, entry, index, today, heading) {
  const row = element('li', 'date-view');
  const canCheck = task.type === '할 일' && checkable(entry);
  const done = canCheck && entry.done === true;
  row.classList.toggle('late', entryLate(task, entry, today));
  row.classList.toggle('done', done);
  const name = heading || element('span', 'date-name', entry.label);
  if (entryPastSchedule(task, entry, today)) name.append(' ', element('span', 'date-state', '지난 일정'));
  if (entryLate(task, entry, today)) name.append(' ', element('span', 'date-state', daysBetween(entry.date, today) + '일 지남'));
  row.append(name);
  if (canCheck && !task.candidate) {
    const check = button('detail-action complete-action');
    showCompletion(check, done, entry.label);
    check.addEventListener('click', () => void toggleDone(task, index, !done));
    row.append(check);
  }
  return row;
}

function detailDateGroups(task, dates) {
  const today = key(new Date());
  const groups = new Map();
  dates.forEach((entry, index) => {
    const loose = looseEntry(task, entry);
    const groupKey = JSON.stringify([loose, entry.kind, entry.date, entry.end, entry.time]);
    if (!groups.has(groupKey)) {
      const day = shortDate(entry.date);
      const when = loose ? '기한 없음'
        : entry.kind === '기간' && entry.end ? day + '~' + shortDate(entry.end)
        : day + (entry.time ? ' ' + entry.time : '') + (entry.kind === '까지' ? '까지' : '');
      const group = element('li', 'detail-date-group');
      const rows = element('ul', 'detail-date-actions');
      const heading = element('p', 'detail-date-heading', when);
      const type = markType(task, entry);
      if (type !== 'ref') {
        const symbol = type === 'span' ? spanMark(task, index) : mark(type);
        symbol.setAttribute('aria-hidden', 'true');
        heading.prepend(symbol);
      }
      group.append(heading, rows);
      groups.set(groupKey, group);
    }
    const group = groups.get(groupKey);
    // 행 이름이 제목과 같은 반복 회차와 기한 없는 일은 한 줄로 표시한다.
    const compact = (task.repeat || loose) && dates.length === 1 && entry.label === task.title;
    const rows = group.lastElementChild;
    const row = readOnlyDateRow(task, entry, index, today, compact ? group.firstElementChild : null);
    rows.classList.toggle('single-occurrence', !!compact);
    rows.append(row);
  });
  return [...groups.values()];
}


// 같은 반복에서 이 회차 뒤에 함께 바뀔 회차(끝냄·따로 고침·상시·쪽지 회차 빼고). 저장 쪽 repeatFollower와 같은 기준.
function repeatFollowers(task) {
  if (!task?.repeat) return [];
  const date = task.dates?.[0]?.date || '';
  return state.snapshot.tasks.filter(item => item.id !== task.id && item.repeat?.seriesId === task.repeat.seriesId &&
    !item.repeat.edited && !item.noteId && !item.chatSource && !item.pinned && item.dates?.length === 1 &&
    item.dates[0].done !== true && item.dates[0].date > date);
}

// 반복 주기와 남은 횟수를 먼저 보여 주고, 펼치면 종료일과 회차 관리가 나온다.
function renderRepeat(task, dates) {
  const repeat = task?.repeat;
  const editing = !!state.editingDates;
  if (state.repeatFor !== task?.id) {
    $('repeat-line').open = false;
    state.repeatFor = task?.id;
    state.editRepeat = repeat?.every ?? 'none';
  }
  $('repeat-line').hidden = editing || !repeat;
  if (repeat && !editing) {
    const today = key(new Date());
    const left = state.snapshot.tasks.filter(item => item.repeat?.seriesId === repeat.seriesId && item.dates?.[0]?.date >= today &&
      item.dates[0].done !== true).length;
    $('repeat-text').textContent = `${taskModel.repeatLabel(repeat.every, repeat.start)} 반복 · 남은 ${left}회`;
    $('repeat-until').textContent = `${shortDate(repeat.until)}까지 반복`;
    $('repeat-skip').hidden = !!task.noteId || !!task.chatSource;
  }
  const canEdit = editing && !!task && taskModel.canRepeat({ ...task, type: state.editType, dates });
  $('repeat-edit').hidden = !canEdit;
  $('repeat-select').value = state.editRepeat;
  $('repeat-select').disabled = state.saving;
}
$('repeat-select').addEventListener('input', () => {
  state.editRepeat = $('repeat-select').value;
  markDirty();
});
$('repeat-skip').addEventListener('click', async () => {
  const task = state.detail?.task;
  if (!task?.repeat || state.saving || state.dirty) return;
  if (!window.confirm(`${shortDate(task.dates[0].date)} 회차를 건너뛸까요? 이 회차만 지우고 다른 회차는 그대로 둡니다.`)) return;
  try {
    const next = await api.skipOccurrence(task.id);
    state.dirty = false;
    closeDetail();
    sync(next);
    notice('이번 회차를 건너뛰었습니다.');
  } catch (error) {
    if (task.id === state.selected) setMessage('detail-message', error.message, true);
  }
});
$('repeat-stop').addEventListener('click', async () => {
  const task = state.detail?.task;
  if (!task?.repeat || state.saving || state.dirty) return;
  // 이 회차는 남기고 뒤 회차만 지운다(저장 쪽 stopSeries와 같은 기준).
  const left = repeatFollowers(task).length;
  if (!window.confirm(`반복을 이 회차(${shortDate(task.dates[0].date)})까지만 할까요? 뒤 회차 ${left}개를 지웁니다. 끝낸 회차와 따로 고친 회차는 남습니다.`)) return;
  try {
    const next = await api.stopRepeat(task.id);
    state.dirty = false;
    if (!next.tasks.some(item => item.id === task.id)) closeDetail();
    sync(next);
    notice(`반복을 그만했습니다. 남은 회차 ${next.repeatRemoved}개를 지웠습니다.`);
  } catch (error) {
    if (task.id === state.selected) setMessage('detail-message', error.message, true);
  }
});

function renderDateRows() {
  const task = state.detail?.task;
  const dates = editingDates();
  const disabled = state.saving;
  state.rowsDrawn = true;
  $('dates-field').hidden = state.editType === '없음';
  $('edit-dates').textContent = state.editingDates ? '날짜 편집 취소' : dates.length ? '날짜 고치기' : '날짜 넣기';
  $('edit-dates').hidden = state.editType === '없음';
  $('edit-dates').setAttribute('aria-label', $('edit-dates').textContent);
  $('edit-dates').setAttribute('aria-expanded', String(!!state.editingDates));
  $('edit-dates').disabled = disabled;
  $('add-date').hidden = !state.editingDates || dates.length >= taskModel.MAX_DATES;
  $('add-date').disabled = disabled;
  renderRepeat(task, dates);
  // 확인은 쪽지당 하나다. 날짜 항목이 하나면 그 옆에, 그 밖에는 제목 아래 처리 줄에 둔다.
  const reference = $('reference-seen');
  $('task-status-row').append(reference);
  $('reference-label').hidden = reference.hidden || (!state.editingDates && dates.length === 1);
  if (!state.editingDates) {
    $('date-rows').replaceChildren(...detailDateGroups(task, dates));
    if (!reference.hidden && dates.length === 1) $('date-rows').querySelector('.date-view').append(reference);
    return;
  }
  $('date-rows').replaceChildren(...dates.map((entry, index) => {
    const row = element('li', 'date-row');
    const field = (name, control) => {
      const label = element('label', 'date-field');
      label.append(element('span', null, name), control);
      control.setAttribute('aria-label', `날짜 ${index + 1} ${name}`);
      return label;
    };
    const date = element('input');
    date.type = 'date';
    date.min = '0001-01-01';
    date.max = '9999-12-31';
    date.required = true;
    date.value = entry.date;
    date.disabled = disabled;
    const kind = element('select');
    for (const name of ['까지', '그날', '기간']) {
      // 저장 값은 '까지'·'그날' 그대로, 화면 이름은 범례와 같은 마감·일정·기간(2026-11-12 사용자).
      const option = element('option', null, KIND_NAMES[name]);
      option.value = name;
      kind.append(option);
    }
    kind.value = entry.kind;
    kind.disabled = disabled;
    const end = element('input');
    end.type = 'date';
    end.required = true;
    end.max = date.max;
    const endField = field('끝 날짜', end);
    const updateEnd = () => {
      endField.hidden = entry.kind !== '기간';
      end.disabled = disabled || endField.hidden;
      end.min = nextDay(entry.date);
      end.value = entry.end || '';
    };
    updateEnd();
    date.addEventListener('input', () => {
      entry.date = date.value;
      // 선생님이 날짜를 정하면 기한 없는 할 일(받은 날)이 아니라 보통 날짜가 된다.
      delete entry.received;
      end.min = nextDay(entry.date);
    });
    end.addEventListener('input', () => { entry.end = end.value; });
    kind.addEventListener('input', () => {
      entry.kind = kind.value;
      delete entry.received;
      if (entry.kind === '까지') entry.done = false;
      else delete entry.done;
      if (entry.kind === '기간') entry.end = nextDay(entry.date);
      else delete entry.end;
      updateEnd();
    });
    const label = element('input');
    label.required = true;
    label.maxLength = taskModel.LABEL_MAX;
    label.autocomplete = 'off';
    label.value = entry.label;
    label.disabled = disabled;
    label.addEventListener('input', () => { entry.label = label.value; });
    const remove = button('button text-button small', '지우기');
    remove.disabled = disabled;
    remove.setAttribute('aria-label', `날짜 ${index + 1} 지우기`);
    remove.addEventListener('click', () => {
      dates.splice(index, 1);
      markDirty();
      renderDateRows();
      const next = $('date-rows').children[index] || $('date-rows').lastElementChild;
      (next?.querySelector('input') || $('add-date')).focus();
    });
    // 시간·교시(선택): 고르거나(1~6교시 등) 직접 적는다(15:30). 비우면 달력에 이름만 보인다.
    const time = element('input');
    time.maxLength = taskModel.TIME_MAX;
    time.autocomplete = 'off';
    time.placeholder = '선택';
    time.setAttribute('list', 'time-presets');
    time.value = entry.time || '';
    time.disabled = disabled;
    time.addEventListener('input', () => {
      const value = time.value.trim();
      if (value) entry.time = value;
      else delete entry.time;
    });
    const nameRow = element('div', 'date-name-row');
    nameRow.append(field('시간·교시', time), field('달력에 표시할 이름', label), remove);
    row.append(field('날짜', date), field('날짜 지정', kind), endField, nameRow);
    return row;
  }));
}

function markDirty() {
  state.dirty = true;
  enableForm();
}

function refreshDraftState(task) {
  const savedType = isCandidate(task) ? task.candidate.suggestedType : task.type;
  state.dirty = state.editType !== savedType || $('edit-title').value !== task.title ||
    $('edit-memo').value !== (task.memo || '') || JSON.stringify(editingDates()) !== JSON.stringify(task.dates || []) ||
    (state.repeatFor === task.id && state.editRepeat !== (task.repeat?.every ?? 'none'));
  enableForm();
}

function enableForm() {
  const task = state.detail?.task;
  const type = state.editType;
  $('edit-title').disabled = state.saving;
  $('note-title-edit').disabled = state.saving;
  $('edit-memo').disabled = state.saving;
  const selector = $('detail-type');
  selector.value = type;
  selector.disabled = state.saving || !!task?.candidate?.discarded;
  // 대화방 후보: 고친 내용은 '올리기'로 한 번에 올린다(변경 저장 대신).
  const candidate = isCandidate(task);
  $('candidate-accept').hidden = !candidate;
  $('candidate-accept').disabled = state.saving;
  $('candidate-accept').textContent = candidate && task.candidate.change ? '새 업무로 올리기' : type === '할 일' ? '할 일로 올리기' : '확인할 것으로 올리기';
  $('candidate-accept').classList.toggle('primary', candidate && !task.candidate.change);
  $('candidate-discard').hidden = !candidate || !!state.forwardedDraft;
  $('candidate-discard').disabled = state.saving;
  $('candidate-restore').hidden = !task?.candidate?.discarded;
  $('candidate-restore').disabled = state.saving;
  $('to-greeting').hidden = !task?.noteId || type === '없음';
  $('to-greeting').disabled = state.saving;
  $('important').hidden = !task || !!task.candidate || task.type === '없음';
  drawPriority($('important'), priorityLevel(task), state.saving || state.dirty || pendingPriority === task?.id);
  $('pin').hidden = task?.type !== '할 일' || type !== '할 일' || !!task?.candidate;
  $('pin').disabled = state.saving || state.dirty;
  $('pin').setAttribute('aria-pressed', String(task?.pinned === true));
  $('remove-task').hidden = !task || !!task.repeat || !!task.noteId || !!task.chatSource;
  $('remove-task').disabled = state.saving;
  $('open-messenger-note').hidden = !state.messenger.noteAction || state.demo || state.detail?.note?.verified !== true;
  $('save').disabled = !state.dirty || state.saving;
  $('save').hidden = !state.dirty || !!task?.candidate;
  const seen = task?.referenceSeen === true;
  $('reference-seen').hidden = task?.type !== '알아 둘 것' || !!task.candidate;
  $('reference-seen').disabled = seen || state.dirty || state.saving;
  $('reference-seen').textContent = seen ? '✓ 확인함' : '확인';
  $('reference-seen').setAttribute('aria-pressed', String(seen));
  $('reference-seen').title = seen ? '처리한 것에 있습니다' : '쪽지를 확인하고 ‘처리한 것’으로 옮깁니다';
  const check = $('loose-complete');
  check.hidden = !task || !!task.candidate || !boxes(task).some(box => box.index === null);
  $('loose-label').hidden = check.hidden;
  if (!check.hidden) showCompletion(check, task.done === true, task.title);
  $('refine').disabled = state.demo || !state.detail?.note || task?.refining || state.dirty;
  $('work-copy').disabled = state.dirty || state.saving;
  $('reply-polish-open').disabled = state.dirty || state.saving;
  $('project-start-open').disabled = state.dirty || state.saving;
  $('mcp-share-open').disabled = state.dirty || state.saving;
  $('codex-work-open').disabled = state.dirty || state.saving || agentWork?.job?.status === 'running';
  $('work-edit-note').hidden = !state.dirty;
  $('repeat-skip').disabled = $('repeat-stop').disabled = state.saving || state.dirty;
  // 날짜 줄은 입력 중 다시 그리지 않는다(글자 입력이 끊기지 않게). 저장 상태가 바뀔 때만 다시 그린다.
  if (state.rowsSaving !== state.saving || !state.rowsDrawn) {
    state.rowsSaving = state.saving;
    renderDateRows();
  } else {
    $('date-rows').querySelectorAll('.complete-action').forEach(node => { node.disabled = state.dirty || state.saving; });
  }
}

function renderWhen(task, note) {
  // 날짜는 바로 아래 날짜 목록에 있으므로 여기에는 받은 날·보낸 사람·받은 사람만 쓴다.
  const parts = [];
  if (task.chatSource) {
    const { roomTitle, time, detail, previousDue, previousTime } = task.chatSource;
    if (time) parts.push(time);
    if (detail) parts.push(detail);
    if (previousDue && (previousDue !== task.dates?.[0]?.date || previousTime !== time)) {
      parts.push(`이전 ${[shortDate(previousDue), previousTime].filter(Boolean).join(' ')}`);
    }
    if (roomTitle) parts.push(roomTitle);
  } else {
    const received = receivedDay(task.datetime || '');
    if (received) parts.push(`${fromKey(received).getMonth() + 1}/${fromKey(received).getDate()}에 받음`);
  }
  if (task.sender) parts.push(task.sender);
  if (task.noteId && audience(task.recipients)) parts.push(audience(task.recipients));
  const when = $('when-line');
  when.textContent = parts.join(' · ');
  when.hidden = !!note || !parts.length;
}

function renderNote(note, reset) {
  const parts = note ? splitReply(note.body) : null;
  const raw = $('raw-note');
  if (reset || !parts) raw.open = false;
  raw.hidden = !parts;
  const meta = note ? [note.sender, note.datetime && friendlyDates(note.datetime.replace(/(\d\d:\d\d):\d\d$/, '$1')) + ' 받음'].filter(Boolean).join(' · ') : '';
  const recipients = note?.recipients?.trim() || '';
  const suffix = /\s*외\s*\d+\s*명?\s*$/u;
  const count = taskModel.recipientCount(recipients);
  // 브리티가 첫 사람 이름과 "외 N명"만 줄 때는 한 줄로: "수신인 47명 · 이영덕 외 46명 · 전체 명단은 브리티에서 확인".
  // "외 N명"을 떼면 첫 사람만 특별한 사람처럼 보인다(2026-11-12 사용자 "이름이 복잡하게 나온다").
  const limited = suffix.test(recipients);
  $('note-recipient-summary').textContent = count ? `수신인 ${count}명` : '';
  $('note-recipient-summary').hidden = !count || limited;
  $('note-recipients').hidden = !recipients;
  $('note-recipient-list').textContent = limited
    ? [count ? `수신인 ${count}명` : '', recipients.replace(/\s*외\s*(\d+)\s*명?\s*$/u, ' 외 $1명')].filter(Boolean).join(' · ')
    : recipients;
  $('note-recipient-limited').hidden = !limited;
  $('original-meta').textContent = meta;
  $('original-meta').hidden = !meta;
  $('original-meta-row').hidden = !meta && !recipients;
  $('original-title').textContent = note?.title || '';
  $('original-title').hidden = !note?.title || note.title.trim() === state.detail?.task.title?.trim();
  const review = $('original-review');
  review.hidden = note?.verified !== false;
  if (!review.hidden) {
    const observed = note.observedHeader ? `화면에서 읽은 글 · ${note.observedHeader}. 목록의 쪽지와 맞는지 확인해 주세요.` : '브리티에서 원문을 확인해 주세요.';
    review.textContent = note.readAttempts >= 3 ? `${observed} 세 차례 시도해 자동 열기를 멈췄습니다. 지난 쪽지 가져오기로 다시 시도할 수 있습니다.` : observed;
  }
  $('reply-section').hidden = !parts?.reply;
  setLinkedText($('reply-body'), parts?.reply || '');
  $('previous-note').hidden = !parts;
  $('previous-subject').hidden = !parts?.subject;
  $('previous-subject').textContent = parts?.subject || '';
  setLinkedText($('previous-body'), parts?.message || '');
  $('original-body').hidden = !!parts;
  setLinkedText($('original-body'), parts ? '' : note?.body ?? '쪽지 원문을 불러오지 못했습니다.');
  setLinkedText($('raw-note-body'), parts ? note.body : '');
  $('copy-note').hidden = !note?.body;
}

function agentResultRow(result, open) {
  const row = element('li', 'codex-work-result');
  row.dataset.resultId = result.id;
  const details = element('details');
  details.open = open;
  const agent = { 'codex-app': workAgents.codex, 'claude-app': workAgents.claude }[result.source];
  const source = agent ? `캘린더에서 맡김 · ${agent}` : '외부 AI에서 보냄';
  const date = new Date(result.completedAt);
  const meta = Number.isFinite(date.getTime()) ? `${source} · ${messageDate.format(date)}` : source;
  const content = element('pre', 'formatted codex-work-content', result.content);
  content.tabIndex = 0;
  const copy = button('button text-button small', '결과 복사');
  copy.setAttribute('aria-label', `${result.title} 복사`);
  copy.addEventListener('click', async () => {
    try {
      await api.copyText(result.content);
      notice('작업 결과를 복사했습니다.');
    } catch (error) {
      notice(error.message);
    }
  });
  details.append(element('summary', null, result.title), content, copy);
  row.append(details, element('p', 'small-note', meta));
  return row;
}

async function refreshAgentWork(watch) {
  if (agentWork !== watch || watch.pending) return;
  clearTimeout(watch.timer);
  watch.pending = true;
  try {
    const { job, results } = await api.noteAgentWork(watch.taskId);
    if (agentWork !== watch) return;
    watch.job = job;
    const running = job?.status === 'running';
    const failed = job?.status === 'failed';
    const agent = workAgents[job?.agent] || 'AI';
    const message = running ? `${agent}에서 작업 중입니다.` : failed ? job.error || `${agent} 작업을 완료하지 못했습니다.` : '';
    const status = $('codex-work-status');
    if (status.textContent !== message || status.classList.contains('error') !== failed) setMessage('codex-work-status', message, failed);
    $('codex-work-open').disabled = state.dirty || state.saving || running;
    $('codex-work-section').hidden = !message && !results.length;
    const list = $('codex-work-results');
    const ids = new Set(results.map(result => result.id));
    const rows = new Map();
    for (const row of [...list.children]) {
      if (ids.has(row.dataset.resultId)) rows.set(row.dataset.resultId, row);
      else row.remove();
    }
    results.forEach((result, index) => {
      const row = rows.get(result.id) ?? agentResultRow(result, index === 0);
      const slot = list.children[index] ?? null;
      if (row !== slot) list.insertBefore(row, slot);
    });
  } catch {
    if (agentWork === watch) {
      const message = '작업 결과를 불러오지 못했습니다.';
      if ($('codex-work-status').textContent !== message) setMessage('codex-work-status', message, true);
      $('codex-work-section').hidden = false;
    }
  } finally {
    watch.pending = false;
    if (agentWork === watch) watch.timer = setTimeout(() => void refreshAgentWork(watch), 2000);
  }
}

function watchAgentWork(taskId) {
  if ((agentWork?.taskId ?? null) === taskId) return;
  clearTimeout(agentWork?.timer);
  $('codex-work-results').replaceChildren();
  $('codex-work-section').hidden = true;
  setMessage('codex-work-status', '');
  agentWork = taskId ? { taskId, job: null, pending: false, timer: null } : null;
  if (agentWork) void refreshAgentWork(agentWork);
}

function renderExternalAiWork(detail) {
  const visible = state.snapshot.showExternalAiWork !== false;
  const verifiedNote = detail?.note?.verified === true;
  const canUseNote = visible && verifiedNote;
  $('show-external-ai-work').checked = visible;
  $('mcp-settings-actions').hidden = !visible;
  $('reply-polish-open').hidden = !verifiedNote;
  $('project-start-open').hidden = !canUseNote;
  $('mcp-share-open').hidden = !canUseNote;
  $('codex-work-open').hidden = !canUseNote;
  $('work-section').hidden = !visible || !detail?.task || !!detail.task.chatSource;
  const activeTask = noteAi?.taskId || projectSession?.taskId;
  if (activeTask && (!verifiedNote || detail.task.id !== activeTask || state.selected !== activeTask)) closeNoteAi();
  else {
    if (!visible && projectSession) closeProject();
    renderNoteAi();
  }
  watchAgentWork(canUseNote ? detail.task.id : null);
}

function renderNoteActions(actions) {
  const contacts = actions?.contacts ?? [];
  const showRequester = actions?.forwarded && !actions.referenceOnly;
  const rows = [
    ['원래 요청자', showRequester && (actions.sourceRequester || '확인 필요')],
    ['확인 대상', actions?.target || (actions?.targetReview ? '원문 확인 필요' : '')],
  ].flatMap(([label, value]) => value ? [element('dt', null, label), element('dd', null, value)] : []);
  $('note-people').replaceChildren(...rows);
  $('note-requester-check').hidden = !showRequester || !!actions.sourceRequester;
  $('note-target-check').hidden = !actions?.targetReview;
  $('note-target-check').textContent = actions?.targetReview === 'previous' ? '이전 쪽지에서 대상 확인 ↑' : '원문에서 대상 확인 ↑';
  const items = contacts.map(({ label, value, source, context }) => {
    const row = element('li', 'note-contact');
    const name = [source === '이번 쪽지' ? '' : source, context, label].filter(Boolean).join(' · ');
    const copy = button('button text-button small', '복사');
    copy.setAttribute('aria-label', name + ' ' + value + ' 복사');
    copy.addEventListener('click', async () => {
      try {
        await api.copyText(value);
        notice('연락처를 복사했습니다.');
      } catch (error) {
        notice(error.message);
      }
    });
    row.append(element('span', 'note-contact-label', name), element('span', 'note-contact-value', value), copy);
    return row;
  });
  $('note-contacts').replaceChildren(...items);
  $('note-contacts').hidden = contacts.length === 0;
  const owners = contacts.map(contact => [contact.source, contact.label, contact.context].join(' '));
  $('note-contact-check').hidden = contacts.length < 2 ||
    contacts.every(contact => contact.context) && new Set(owners).size === contacts.length;
  const links = (actions?.links ?? []).map(({ value, source }) => {
    const row = element('li', 'note-contact');
    const { host, pathname } = new URL(value);
    const label = host + (pathname === '/' ? '' : pathname);
    const open = button('button text-button small', '열기');
    open.setAttribute('aria-label', source + ' 링크 ' + label + ' 열기');
    open.addEventListener('click', async () => {
      try {
        await api.openLink(value);
      } catch (error) {
        notice(error.message);
      }
    });
    row.append(element('span', 'note-contact-label', source + ' 링크'), element('span', 'note-contact-value', label), open);
    return row;
  });
  $('note-links').replaceChildren(...links);
  $('note-links').hidden = links.length === 0;
  // 보낸 사람은 원문 머리에 이미 있다. 따로 보여 줄 대상·연락처·링크가 있을 때만 칸을 띄운다(2026-11-20 사용자 "자세히가 너무 복잡해졌어").
  $('note-actions').hidden = !actions || (rows.length === 0 && contacts.length === 0 && links.length === 0
    && $('note-requester-check').hidden && $('note-target-check').hidden);
}

function focusNoteSource(previous) {
  const target = previous && !$('previous-note').hidden ? $('previous-note-heading') : $('original-heading');
  target.focus();
  target.scrollIntoView({ block: 'start' });
}

$('note-requester-check').addEventListener('click', () => focusNoteSource(true));
$('note-target-check').addEventListener('click', () => focusNoteSource(state.detail?.noteActions?.targetReview === 'previous'));

// evidence: 후보의 근거가 된 글 번호. 묶음 전체를 보이고 근거 글만 강조한다.
function renderChatOriginal(batch, evidence = [], source, sourceBatch = batch) {
  const focused = getFocusedKey();
  $('chat-original').hidden = !batch;
  $('chat-forwarded-lists').replaceChildren();
  $('forwarded-source').hidden = true;
  if (!batch) return;
  $('chat-room').textContent = batch.title;
  const message = state.snapshot.messages.find(item => item.kind === 'chat' && item.id === sourceBatch.id);
  const sourceLine = source && sourceBatch.forwarded?.find(item => item.messageIndex === source.messageIndex)
    ?.lines.find(line => line.lineIndex === source.lineIndex);
  if (sourceLine && sourceBatch.id !== batch.id) {
    $('forwarded-source').hidden = false;
    $('forwarded-source').replaceChildren(element('p', 'small-note', `${sourceBatch.title} · 등록한 원문 줄`),
      element('p', 'formatted original', sourceLine.text));
  }
  const marked = new Set(evidence);
  $('chat-lines').replaceChildren(...batch.messages.map(({ observedAt, text }, index) => {
    const row = element('li');
    const meta = element('p', 'small-note', `수집 ${messageTime(observedAt)}`);
    if (marked.has(index)) {
      row.classList.add('evidence');
      meta.prepend(element('span', 'evidence-tag', '근거'), ' ');
    }
    const body = element('p', 'formatted original');
    if (sourceLine && sourceBatch.id === batch.id && index === source.messageIndex) {
      const lines = text.split(/\r\n?|\n/u);
      const before = lines.slice(0, sourceLine.lineIndex);
      const after = lines.slice(sourceLine.endLineIndex);
      body.append(before.length ? `${before.join('\n')}\n` : '',
        element('mark', 'forwarded-source-line', lines.slice(sourceLine.lineIndex, sourceLine.endLineIndex).join('\n')),
        after.length ? `\n${after.join('\n')}` : '');
    } else setLinkedText(body, text);
    row.append(meta, body);
    return row;
  }));
  const forwarded = !state.forwardedDraft && forwardedSection(message);
  if (forwarded) $('chat-forwarded-lists').append(forwarded);
  restoreFocus(focused);
  if (marked.size) requestAnimationFrame(() => $('chat-lines').querySelector('.evidence')?.scrollIntoView({ block: 'nearest' }));
}

// 변경·취소 후보: 같은 방에서 올린 업무 가운데 고칠 것을 고른다. 짐작한 업무를 맨 위에 "추천"으로.
function renderCandidateTargets(task, roomTasks) {
  const show = isCandidate(task) && task.candidate.change;
  $('candidate-box').hidden = !show;
  if (!show) return;
  const cancelled = task.chatSource?.action === 'cancelled';
  $('candidate-heading').textContent = cancelled ? '취소할 업무 고르기' : '기존 업무 고치기';
  const list = (roomTasks || []).slice().sort((a, b) => Number(b.suggested) - Number(a.suggested));
  const today = key(new Date());
  $('candidate-targets').replaceChildren(...(list.length ? list.map(item => {
    const row = element('li', 'candidate-target');
    const first = item.dates[0];
    const text = element('span', 'target-text', item.title);
    const when = element('span', 'small-note', first ? (first.end ? `${shortDate(first.date)}~${shortDate(first.end)}` : `${first.date === today ? '오늘' : shortDate(first.date)}${first.kind === '까지' ? '까지' : ''}`) : '날짜 없음');
    const apply = button(`button small${item.suggested ? ' primary' : ''}`, cancelled ? '이 업무 취소' : '이 업무에 반영');
    apply.disabled = state.saving || state.dirty;
    apply.addEventListener('click', () => void applyCandidateChange(task, item));
    if (item.suggested) row.append(element('span', 'badge', '추천'));
    row.append(text, when, apply);
    return row;
  }) : [element('li', 'small-note', '같은 방에서 올린 업무가 없습니다. 새 업무로 올리거나 버려 주세요.')]));
}

async function applyCandidateChange(task, target) {
  if (state.saving) return;
  state.saving = true;
  enableForm();
  try {
    await api.applyCandidateChange(task.id, target.id);
    // 후보는 반영과 함께 없어지므로 고친 업무를 연다.
    state.saving = false;
    state.dirty = false;
    selectTask(target.id);
    notice(task.chatSource?.action === 'cancelled' ? `‘${target.title}’을 취소로 표시했습니다.` : `‘${target.title}’에 반영했습니다.`);
  } catch (error) {
    if (task.id === state.selected) setMessage('detail-message', error.message, true);
  } finally {
    if (task.id === state.selected) {
      state.saving = false;
      enableForm();
    }
  }
}

function arrangeForwardedDraft(active) {
  const editor = $('detail-content');
  const original = $('chat-original');
  if (active && editor.nextElementSibling !== original) editor.after(original);
  if (!active && editor.previousElementSibling !== original) editor.before(original);
  $('detail-panel').classList.toggle('forwarded-editor', active);
}

$('add-memo').addEventListener('click', () => {
  $('memo-field').hidden = false;
  $('add-memo').hidden = true;
  $('edit-memo').focus();
});

function renderTitleEditor(task, note) {
  const input = $('edit-title');
  const directEdit = !!task.candidate;
  const editing = directEdit || !!state.editingTitle;
  const preview = $('task-title-view');
  $('task-title-text').textContent = input.value;
  preview.hidden = editing;
  input.hidden = !editing;
  const toggle = $('note-title-edit');
  toggle.hidden = directEdit;
  toggle.textContent = editing ? '제목 편집 취소' : '제목 고치기';
  toggle.setAttribute('aria-label', editing ? '업무 제목 편집 취소' : '업무 제목 고치기');
  toggle.setAttribute('aria-expanded', String(editing));
}

$('note-title-edit').addEventListener('click', () => {
  if (!state.detail || state.saving) return;
  const { task, note } = state.detail;
  state.editingTitle = !state.editingTitle;
  if (!state.editingTitle) {
    $('edit-title').value = task.title;
    refreshDraftState(task);
  }
  renderTitleEditor(task, note);
  if (state.editingTitle) {
    $('edit-title').focus();
    $('edit-title').select();
  }
});

function renderDetail(detail, reset = false) {
  const { task, note, batch } = detail;
  state.detail = detail;
  if (!state.dirty || reset) {
    state.dirty = false;
    state.revision = task.revision;
    $('edit-title').value = task.title;
    $('edit-memo').value = task.memo || '';
    state.editType = isCandidate(task) ? task.candidate.suggestedType : task.type;
    state.editDates = (task.dates || []).map(entry => ({ ...entry }));
    if (reset) {
      state.editingDates = false;
      state.editingTitle = false;
    }
    state.rowsDrawn = false;
  }
  $('detail-content').hidden = false;
  $('detail-toolbar').hidden = false;
  $('source-badge').textContent = task.forwardedSource ? '전달 글 원문' : task.candidate ? candidateBadge(task) : task.chatSource ? chatLabels[task.chatSource.action] : '';
  $('source-badge').hidden = !!task.noteId || !!state.forwardedDraft || !$('source-badge').textContent;
  arrangeForwardedDraft(!!state.forwardedDraft);
  $('forwarded-draft-source').hidden = !state.forwardedDraft;
  $('forwarded-draft-text').textContent = detail.forwardedText || '';
  renderWhen(task, note);
  renderTitleEditor(task, note);
  $('verify-badge').hidden = task.noteState !== 'unverified';
  $('refine').hidden = !task.noteId;
  const optionalMemo = !!(task.noteId || task.chatSource);
  $('memo-label').textContent = optionalMemo ? '메모' : '내용';
  if ($('memo-field').dataset.task !== task.id || reset || !optionalMemo || $('edit-memo').value) {
    $('memo-field').dataset.task = task.id;
    $('memo-field').hidden = optionalMemo && !$('edit-memo').value;
  }
  $('add-memo').hidden = !$('memo-field').hidden;
  $('refine').textContent = task.refining ? '정리 중…' : state.snapshot.aiProvider === 'none' ? 'AI 연결' : task.refined === 'none' ? '다듬기' : '다시 다듬기';
  const failure = task.refined === 'failed' && !task.refining
    ? `마지막 다듬기에 실패했습니다${task.refineFailure?.message ? `: ${task.refineFailure.message}` : '.'}` : '';
  setMessage('refine-note', task.noteId ? failure : '');
  $('original-section').hidden = !task.noteId;
  renderNote(note, reset);
  renderNoteActions(detail.noteActions);
  renderExternalAiWork(detail);
  renderChatOriginal(batch ?? detail.forwardedBatch, task.candidate && !task.candidate.discarded ? task.candidate.evidence : [],
    task.forwardedSource, detail.forwardedBatch ?? batch);
  renderCandidateTargets(task, detail.roomTasks);
  renderSameWork(task);
  renderAttachments(task.id, note);
  renderMessengerButtons();
  enableForm();
}

const attachmentFolderHelp = '첨부는 GOE 메신저에 설정된 저장 폴더로 받고, 그 파일은 그대로 둡니다.';
const goeAttachmentMessages = {
  'already-saved': '첨부가 이미 저장되어 있습니다.',
  'folder-not-configured': 'GOE 메신저의 첨부 저장 폴더를 읽지 못했습니다. GOE 환경설정 창이 열려 있으면 닫고 다시 시도해 주세요.',
  review: '첨부를 확인하지 못했습니다. GOE 메신저의 저장 폴더에서 파일을 열거나 다시 시도해 주세요.',
  failed: '첨부를 받지 못했습니다. GOE 메신저에서 첨부 보관 기간이 지났을 수 있습니다. 다시 시도해도 안 되면 GOE 메신저에서 직접 확인해 주세요.',
  expired: '첨부 보관 기간이 지나 GOE 메신저에서 더 받을 수 없습니다.',
  'not-found': 'GOE 메신저 수신함에서 이 쪽지를 찾지 못했습니다.',
  none: 'GOE 메신저에서 받을 수 있는 첨부를 찾지 못했습니다.',
  partial: '일부 첨부만 저장됐습니다.'
};

// 공문 첨부 이름 "(서룡초등학교-15217 (첨부) 경기도…과) [붙임1] 제목.xlsx"은 앞 괄호 묶음이 모두 같아
// 줄이면 줄마다 똑같이 보인다(2026-11-17). 화면에는 괄호 묶음을 빼고 "[붙임1] 제목", 본문은 "본문 · 제목"으로 보인다.
function shortAttachmentName(name) {
  const match = name.match(/^\((?:[^()]|\([^()]*\))*\)\s*/u);
  const rest = match ? name.slice(match[0].length) : '';
  if (!match || !/\d/.test(match[0]) || rest.replace(/\.[^.]+$/, '').trim().length < 2) return name;
  return /\(\s*본문\s*\)/u.test(match[0]) ? `본문 · ${rest}` : rest;
}

// 줄일 때도 확장자(.hwpx·.pdf)는 남긴다: 앞부분만 …으로 줄인다.
function attachmentName(className, fullName) {
  const node = element('span', className);
  const name = shortAttachmentName(fullName);
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 && name.length - dot <= 6 ? name.slice(dot) : '';
  node.append(element('span', 'attachment-base', ext ? name.slice(0, dot) : name));
  if (ext) node.append(element('span', 'attachment-ext', ext));
  return node;
}

// GOE 첨부 안내(2026-11-17 사용자 "안내메시지는 적절한지"): 오류처럼 보이지 않게, 무엇을 누르면 되는지 말한다.
function goeAttachmentMessage(goe, available) {
  const retry = goe.canRetry ? ' ‘첨부만 다시 받기’를 누르면 GOE 저장 폴더에서 찾아 붙입니다.' : '';
  if (goe.status === 'shared') {
    const from = goe.sharedFrom?.datetime?.match(/^\d{4}-(\d{2})-(\d{2})(?:\s+(\d{2}:\d{2}))?/);
    const when = from ? `${Number(from[1])}/${Number(from[2])}${from[3] ? ` ${from[3]}` : ''}` : '앞';
    const who = goe.sharedFrom?.sender ? `(${goe.sharedFrom.sender})` : '';
    return { message: `${when} 쪽지${who}와 같은 첨부입니다.`, error: false };
  }
  if (['expired', 'none', 'already-saved', 'folder-not-configured', 'not-found'].includes(goe.status)) {
    return { message: goeAttachmentMessages[goe.status], error: goe.status === 'folder-not-configured' };
  }
  if (goe.canRetry && !goe.count) return { message: '첨부가 있는지 확인하지 못했습니다. 첨부가 있는 쪽지라면 ‘첨부만 다시 받기’를 눌러 주세요.', error: false };
  if (!goe.canRetry || goe.count - available <= 0) return { message: '', error: false };
  if (available) return { message: `첨부 ${goe.count}개 가운데 ${available}개만 붙었습니다.${retry}`, error: false };
  if (goe.status === 'failed') return { message: `첨부 ${goe.count}개를 받지 못했습니다.${retry} 그래도 안 되면 GOE 메신저에서 직접 받아 주세요.`, error: true };
  return { message: `첨부 ${goe.count}개를 아직 붙이지 못했습니다.${retry}`, error: false };
}

function renderAttachments(id, note) {
  const goe = note?.goeAttachments;
  // GOE에서 받지 못한 첨부의 이름은 화면에서 읽은 글자라 틀릴 수 있어 목록에 보이지 않는다(개수와 안내만).
  const attachments = (note?.attachments || []).filter(item => !goe || item.available);
  const count = goe?.count || attachments.length;
  const current = state.attachmentRetry?.id === id ? state.attachmentRetry : null;
  const first = attachments.find(item => item.available);
  const latest = note?.verified === true ? splitReply(note.body ?? '')?.reply ?? note.body ?? '' : '';
  const mentioned = attachments.filter(item => item.name && latest.includes(item.name));
  $('attachments-section').hidden = !count && !attachments.length && !goe?.canRetry;
  $('attachment-count').textContent = count;
  const retry = $('goe-attachment-retry');
  retry.hidden = !goe?.canRetry;
  retry.disabled = messengerBusy();
  retry.textContent = current?.pending ? '첨부 받는 중…' : '첨부만 다시 받기';
  $('attachment-folder').hidden = !first;
  $('attachment-folder').onclick = first ? () => openAttachment(id, first.index, true) : null;
  const rows = attachments.map(item => {
    const row = element('li', 'attachment-item');
    // 이름은 한 줄로 줄이고 마우스를 올리면 전체 이름을 보인다(2026-11-17 사용자 "미관상").
    if (!item.available) {
      const name = attachmentName('attachment-name', item.name);
      name.title = item.name;
      row.append(name, element('span', 'small-note', '저장 파일 없음'));
    } else {
      const open = button('button text-button small');
      open.append(attachmentName('attachment-label', item.name));
      open.title = `${item.name}
${item.direct ? '누르면 첨부를 엽니다' : '누르면 폴더에서 보여 줍니다'}`;
      open.addEventListener('click', () => openAttachment(id, item.index, false));
      row.append(open);
      const folder = button('button text-button small attachment-folder', '폴더 열기');
      folder.setAttribute('aria-label', item.name + ' 저장 폴더 열기');
      folder.addEventListener('click', () => openAttachment(id, item.index, true));
      row.append(folder);
    }
    if (attachments.length > 1 && mentioned.length === 1 && mentioned[0] === item) {
      row.append(element('span', 'small-note', '본문에 나온 파일'));
    }
    return row;
  });
  $('attachments').replaceChildren(...rows);
  $('attachments').hidden = !rows.length;
  const told = goe ? goeAttachmentMessage(goe, attachments.length) : { message: '', error: false };
  const message = current?.message ?? told.message ?? '';
  const error = current?.error ?? told.error;
  const status = $('attachment-status');
  if (status.textContent !== message || status.classList.contains('error') !== error) {
    setMessage('attachment-status', message, error);
  }
}

$('goe-attachment-retry').addEventListener('click', async () => {
  const { selected: id, detail } = state;
  if (!id || detail?.task.id !== id || !detail.note?.goeAttachments?.canRetry || messengerBusy()) return;
  const retry = { id, pending: true, message: 'GOE 메신저에서 첨부를 받고 있습니다.', error: false };
  state.attachmentRetry = retry;
  renderAttachments(id, detail.note);
  renderBusy();
  try {
    const result = await api.retryGoeAttachments(id);
    retry.error = !['saved', 'already-saved'].includes(result.attachStatus);
    retry.message = result.message || (result.attachStatus === 'saved' ? `첨부 ${result.attached}개를 받았습니다.`
      : goeAttachmentMessages[result.attachStatus] || goeAttachmentMessages.failed);
  } catch (error) {
    retry.error = true;
    retry.message = error.message;
  } finally {
    retry.pending = false;
    renderBusy();
    if (state.selected === id) await refreshDetail();
    if (state.detail?.task.id === state.selected) renderAttachments(state.selected, state.detail.note);
  }
});

async function openAttachment(id, index, reveal) {
  try {
    const result = await api.openAttachment(id, index, reveal);
    if (result.revealed) notice('탐색기에서 첨부를 표시했습니다.');
  } catch (error) {
    if (state.selected === id) setMessage('detail-message', error.message, true);
  }
}

async function markOpened(kind, id) {
  if (!state.snapshot.messages.some(message => message.kind === kind && message.id === id && message.unread) || markingOpened.has(id)) return;
  markingOpened.add(id);
  try {
    await api.markMessageSeen(kind, id);
  } catch (error) {
    if (id === state.selected || id === state.selectedChat || id === state.detail?.batch?.id) setMessage('detail-message', error.message, true);
  } finally {
    markingOpened.delete(id);
  }
}

function markTaskOriginalsOpened(detail) {
  if (detail.note && detail.note.verified !== false) void markOpened('note', detail.task.id);
  if (detail.batch) void markOpened('chat', detail.batch.id);
}

async function refreshDetail(reset = false) {
  if (!state.selected) return;
  const request = ++state.detailToken;
  try {
    const detail = await api.detail(state.selected);
    if (request === state.detailToken) {
      renderDetail(detail, reset);
      // 검토할 쪽지의 "날짜" 버튼: 자세히를 열면서 날짜 고치기를 바로 연다.
      if (state.pendingDateEdit === detail.task.id) {
        state.pendingDateEdit = null;
        if (!state.editingDates) $('edit-dates').click();
      }
      if (state.readingSelection) {
        state.readingSelection = false;
        markTaskOriginalsOpened(detail);
      }
    }
  } catch (error) {
    if (request === state.detailToken) {
      state.readingSelection = false;
      setMessage('detail-message', error.message, true);
    }
  }
}

let lastFocus;

function openDetail(taskId, chatId, focusKey) {
  if (state.dirty && !window.confirm('저장하지 않은 변경을 버리시겠어요?')) return false;
  closeNoteAi();
  $('work-other').open = false;
  watchAgentWork(null);
  if (!state.attachmentRetry?.pending) state.attachmentRetry = null;
  state.selected = taskId;
  state.selectedChat = chatId;
  state.forwardedDraft = null;
  state.editingTitle = false;
  arrangeForwardedDraft(false);
  state.chatLoaded = false;
  state.readingSelection = !!taskId;
  state.rangeFocus = null;
  state.detail = null;
  state.dirty = false;
  state.saving = false;
  lastFocus = focusKey;
  const panel = $('detail-panel');
  panel.classList.add('open');
  fitWidth();
  panel.scrollTop = 0;
  $('detail-content').hidden = true;
  $('detail-toolbar').hidden = true;
  $('detail-more').open = false;
  $('chat-original').hidden = true;
  $('same-work').hidden = true;
  $('detail-heading').textContent = chatId ? '대화 묶음' : '자세히';
  setMessage('detail-message', '');
  setMessage('work-message', '');
  redraw();
  $('detail-heading').focus({ preventScroll: true });
  return true;
}

function selectTask(id, focusKey) {
  if (id === state.selected && state.detail) {
    markTaskOriginalsOpened(state.detail);
    return true;
  }
  if (!openDetail(id, null, focusKey)) return false;
  void refreshDetail(true);
  return true;
}

// 왼쪽 목록에서 고르면 달력을 그 업무의 달로 옮긴다. 이미 보이는 달에 걸려 있으면 그대로 둔다.
function showTaskMonth(task, entry) {
  const shown = key(monthOf(state.month)).slice(0, 7);
  const inShown = item => item.date.slice(0, 7) <= shown && lastDay(item).slice(0, 7) >= shown;
  const today = key(new Date());
  const dates = entry ? [entry] : (task.dates || []);
  if (!dates.length || dates.some(inShown)) return;
  const target = entry || dates.find(item => lastDay(item) >= today) || dates[0];
  state.month = fromKey(target.date);
  state.dayKey = target.date;
  renderMonth();
}

// 달력에서 고르면 왼쪽을 그 업무가 있는 탭으로 바꾸고 그 줄이 보이게 한다.
function revealInList(id, pastIndex = null) {
  const pastRow = pastIndex === null ? null :
    $('past-list').querySelector(`[data-focus-key="${CSS.escape(`past-${id}-${pastIndex}`)}"]`)?.closest('.row');
  const view = pastRow ? 'past' : state.taskViews.get(id);
  if (!view) return;
  showView(view);
  const row = pastRow || $(`view-${view}`).querySelector('.row.selected');
  row?.scrollIntoView({ block: 'nearest' });
}

function renderSameWork(task) {
  const box = $('same-work');
  const others = task?.id && !task.forwardedSource ? sameWorkTasks(task) : [];
  box.hidden = !others.length;
  if (!others.length) { box.replaceChildren(); return; }
  const lead = element('p', 'same-work-lead', `같은 업무로 보이는 쪽지 ${others.length + 1}건을 달력과 목록에 한 줄로 묶었습니다.`);
  const list = element('ul', 'same-work-list');
  for (const other of others) {
    const item = element('li');
    const open = button('text-button', displayTitle(other.title));
    const day = receivedDay(other.datetime || '');
    open.title = other.title;
    open.addEventListener('click', () => selectTask(other.id));
    item.append(open);
    if (day) item.append(element('span', 'small-note', ` ${monthDay(day)} 받음`));
    list.append(item);
  }
  box.replaceChildren(lead, list);
}

async function selectForwardedLine(message, messageIndex, line, focusKey) {
  if (!openDetail(null, null, focusKey)) return;
  const source = { batchId: message.id, messageIndex, lineIndex: line.lineIndex };
  state.forwardedDraft = source;
  $('detail-heading').textContent = '전달 글에서 올리기';
  const request = ++state.detailToken;
  setMessage('detail-message', '대화 원문을 불러오고 있습니다.');
  try {
    const batch = await api.chatBatch(message.id);
    if (request !== state.detailToken) return;
    const title = line.text.split(/\r\n?|\n/u)[0].trim().slice(0, $('edit-title').maxLength);
    const task = { title, type: '할 일', dates: [], candidate: { suggestedType: '할 일', evidence: [] },
      chatSource: { roomTitle: batch.title }, forwardedSource: source };
    setMessage('detail-message', '');
    renderDetail({ task, batch, forwardedText: line.text }, true);
    $('edit-title').focus({ preventScroll: true });
    void markOpened('chat', message.id);
  } catch (error) {
    if (request === state.detailToken) setMessage('detail-message', error.message, true);
  }
}

function revealForwarded(batch) {
  for (const { messageIndex } of batch.forwarded || []) {
    state.expandedForwarded.add(`detail-forwarded-${batch.id}-${messageIndex}`);
  }
}

async function selectChat(id, focusKey, { forwarded = false } = {}) {
  if (id === state.selectedChat && state.chatLoaded) {
    if (forwarded) {
      revealForwarded(state.chatLoaded);
      renderChatOriginal(state.chatLoaded);
      $('chat-forwarded-lists').querySelector('summary')?.focus();
    }
    void markOpened('chat', id);
    return;
  }
  if (!openDetail(null, id, focusKey)) return;
  const request = ++state.detailToken;
  setMessage('detail-message', '대화 원문을 불러오고 있습니다.');
  try {
    const batch = await api.chatBatch(id);
    if (request !== state.detailToken) return;
    setMessage('detail-message', '');
    if (forwarded) revealForwarded(batch);
    renderChatOriginal(batch);
    if (forwarded) $('chat-forwarded-lists').querySelector('summary')?.focus();
    state.chatLoaded = batch;
    void markOpened('chat', id);
  } catch (error) {
    if (request === state.detailToken) setMessage('detail-message', error.message, true);
  }
}

function closeDetail() {
  if (state.dirty && !window.confirm('저장하지 않은 변경을 버리시겠어요?')) return;
  $('repeat-line').open = false;
  watchAgentWork(null);
  if (!state.attachmentRetry?.pending) state.attachmentRetry = null;
  state.detailToken++;
  state.selected = null;
  closeNoteAi();
  state.selectedChat = null;
  state.forwardedDraft = null;
  arrangeForwardedDraft(false);
  state.chatLoaded = false;
  state.readingSelection = false;
  state.rangeFocus = null;
  state.detail = null;
  state.dirty = false;
  $('detail-content').hidden = true;
  $('detail-toolbar').hidden = true;
  $('detail-more').open = false;
  $('chat-original').hidden = true;
  $('same-work').hidden = true;
  $('detail-heading').textContent = '자세히';
  $('detail-panel').classList.remove('open');
  fitWidth();
  setMessage('detail-message', '');
  redraw();
  restoreFocus(lastFocus);
}

function renderMessenger() {
  const { name, appName, supportsChats } = state.messenger;
  const goe = name === 'GOE 메신저';
  document.title = state.demo ? `${appName} · 샘플` : appName;
  $('app-name').textContent = appName;
  $('demo-badge').hidden = !state.demo;
  $('collector-bar').setAttribute('aria-label', `${name} 연결`);
  $('note-recipient-limited').textContent = `· 전체 명단은 ${name}에서 확인`;
  $('fetch-legend').textContent = `${name}에서 가져오기`;
  $('fetch-reread-help').textContent = `${name}는 건드리지 않고, 이미 받아 둔 쪽지${supportsChats ? '와 대화' : ''}만 다시 읽습니다. 평소에는 누를 일이 없습니다.`;
  $('chat-fetch').hidden = $('chat-candidate-legend').hidden = $('backup-chat-copy').hidden = !supportsChats;
  $('range-brity-help').hidden = goe;
  $('range-goe-help').hidden = !goe;
  $('downloads-help').textContent = goe ? `${attachmentFolderHelp} 아래 폴더에는 새 쪽지 첨부의 사본을 저장합니다.` : '새로 받은 쪽지의 첨부를 여기에 복사합니다.';
  $('first-import-retry').textContent = `${name} 연결 다시 확인`;
}

function sync(snapshot) {
  // 새 대화방 후보가 생기면 한 번 알린다(처음 열 때와 되살린 후보는 알리지 않음).
  const seen = state.seenCandidates;
  const fresh = snapshot.tasks.filter(task => task.candidate && !seen?.has(task.id));
  state.seenCandidates = new Set([...(seen || []), ...snapshot.tasks.filter(task => task.candidate).map(task => task.id)]);
  if (seen && fresh.length) setTimeout(() => notice(`대화방 후보 ${fresh.length}개가 분류할 것에 들어왔습니다.`), 0);
  const searchChanged = snapshot.searchRevision !== state.snapshot.searchRevision;
  state.snapshot = snapshot;
  if (searchChanged && search.query) scheduleSearch();
  state.messenger = snapshot.messenger ?? state.messenger;
  state.demo = snapshot.demo ?? state.demo;
  renderMessenger();
  $('automatic').disabled = !!state.demo || snapshot.aiProvider === 'none' || !!state.savingAutomatic || !!state.testingAi;
  $('automatic').checked = snapshot.automatic;
  renderExternalAiWork(state.detail);
  renderAiConnected();
  renderCollector();
  renderAutoRefresh();
  renderRange();
  renderGoogle();
  renderUpdate();
  renderSchool();
  $('deadline-alerts').checked = snapshot.deadlineAlerts !== false;
  $('show-meal').checked = snapshot.showMeal !== false;
  redraw();
  if (state.selectedChat && state.chatLoaded) renderChatOriginal(state.chatLoaded);
  void refreshDetail();
  void loadMeal();
}

// 설정 "브리티에서 가져오기"의 쪽지 줄: 지금 가져오기 버튼과 마지막 확인.
function renderNotesFetch() {
  const { collector, collectorAvailable, collectorConnected, collectorFirstImportPending } = state.snapshot;
  const { name } = state.messenger;
  const linked = !!collectorAvailable && !!collectorConnected && !collectorFirstImportPending;
  const button = $('notes-collect-now');
  const fetching = state.connectingCollector || state.snapshot.activity === 'notes';
  button.textContent = fetching ? '가져오는 중…' : '지금 가져오기';
  button.disabled = !linked || messengerBusy();
  const status = state.snapshot.demo ? '' : !linked ? `위쪽 머리줄에서 ${name}를 먼저 연결해 주세요.`
    : fetching ? `${name}에서 쪽지를 확인하는 중…`
      : messengerBusy() ? `${name}에서 다른 일을 하는 중입니다. 끝나면 누를 수 있습니다.`
      : collector?.status === 'in-use' ? `${name}를 쓰는 중이라 가져오지 않았습니다. 지금 가져오기를 누르면 확인한 뒤 가져옵니다.`
      : collector?.status === 'list-unreadable' ? 'GOE 메신저 연결됨 · 이번 쪽지 목록을 확인하지 못했습니다.'
        : collector?.checkedAt ? `마지막 확인 ${new Date(collector.checkedAt).toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' })}` : '';
  if ($('notes-collection-status').textContent !== status) setMessage('notes-collection-status', status);
}

// 메신저를 쓰는 일(쪽지·첨부·대화방·답장·지난 쪽지)이 하나라도 돌고 있으면 참. 자동으로 돌 때도 포함한다.
// 그동안 같은 메신저를 쓰는 버튼은 모두 막는다(2026-11-17 “쪽지가져올때 가져오기 버튼이 활성화돼있으면 또 헷갈리잖아”).
function messengerBusy() {
  const snap = state.snapshot;
  return !!(state.connectingCollector || state.rangeBusy || state.rangeCounting || state.chatCollecting
    || state.attachmentRetry?.pending || state.messengerNoteOpening || state.firstImportConnecting
    || snap.rangeImport?.running || snap.collector?.status === 'connecting'
    || ['notes', 'attachments', 'chats', 'open-note'].includes(snap.activity));
}

// 지금 하고 있는 일 한 줄(머리줄). 없으면 빈 글자. 순서: 지난 쪽지 불러오기 → 브리티 읽기 → AI 분류.
function activityText() {
  const snap = state.snapshot;
  if (snap.rangeImport?.running) {
    return '지난 쪽지 불러오는 중…';
  }
  if (state.connectingCollector || snap.activity === 'notes') return `${state.messenger.name}에서 쪽지 확인 중…`;
  if (snap.activity === 'attachments') return 'GOE 메신저에서 첨부 확인 중…';
  if (snap.activity === 'chats') return '브리티에서 대화방 읽는 중…';
  if (snap.activity === 'chat-deciding') return '대화방 새 글에서 후보 찾는 중…';
  if (snap.activity === 'open-note' || state.messengerNoteOpening) return `${state.messenger.name}에서 ${messengerNoteTarget()} 여는 중…`;
  if (state.rangeCounting) return '지난 쪽지 세는 중…';
  const waiting = snap.aiProvider === 'none' ? 0 : snap.tasks.filter(task => task.refining || task.queued).length;
  if (snap.aiBlocked && snap.aiProvider !== 'none') return `AI 분류 멈춤 · ${snap.aiBlocked}${waiting ? ` · 기다리는 쪽지 ${waiting}건` : ''}`;
  if (waiting) return `AI가 쪽지 분류 중 · 남은 ${waiting}건`;
  const failed = snap.tasks.filter(classifyFailed).length;
  return failed ? `AI 분류 실패 ${failed}건 · 분류할 것에서 정해 주세요` : '';
}

function renderCollector() {
  renderNotesFetch();
  const { collector, collectorAvailable, collectorConnected, collectorFirstImportPending } = state.snapshot;
  const { name, fullName } = state.messenger;
  $('collector-bar').hidden = !collectorAvailable;
  if (!collectorAvailable) return;
  $('collector-connect').hidden = false;
  const status = collector?.status || 'idle';
  const auto = state.snapshot.autoRefresh?.notes;
  const checked = collector?.checkedAt ? `마지막 확인 ${new Date(collector.checkedAt).toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' })}` : '';
  const schedule = collectorFirstImportPending ? '첫 가져오기 설정 중' : auto?.enabled ? `${minutesLabel(auto.minutes)}마다 자동으로 가져옴` : '자동 꺼짐 · 누를 때만 가져옴';
  let received = '';
  if (checked && collector.imported != null) {
    received = collector.imported || collector.unverified ? `쪽지 ${collector.imported}건 받음` : '새 쪽지 없음';
    if (collector.unverified) received += ` · 이번에 원문 미확인 ${collector.unverified}건`;
  }
  const messages = {
    // 2026-11-19: 클래식 뷰는 다른 PC에서 0.5.12로도 실패했다. 연결 전에 원 뷰로 쓰라고 알린다.
    idle: name === 'GOE 메신저' ? `${name}에 로그인한 뒤 연결하세요. 가져온 쪽지는 ${name}에서 읽음 처리됩니다.`
      : `${name}에 로그인한 뒤 연결하세요. ${name}는 원 뷰로 써 주세요(환경설정 › 일반 › 뷰 모드). 가져온 쪽지는 ${name}에서 읽음 처리됩니다.`,
    connecting: `${name}의 쪽지 목록을 확인하고 있습니다.`,
    ready: collector?.managed ? [schedule, checked, received].filter(Boolean).join(' · ')
      : `이미 실행 중인 ${name} 수집기의 결과를 읽습니다.`,
    // 2026-11-16 “자동 불러오기 … 그런 거에 대한 안내 메시지가 필요할 것 같은데”: 건너뛴 이유와 다음 확인 시각을 보인다.
    'in-use': collector?.busyReason === 'note-open'
      ? `${name}에 쪽지 창이 열려 있어 이번에는 쪽지를 가져오지 않았습니다. ${nextCheckText(collector, auto) ? `쪽지 창을 닫아 두면 ${nextCheckText(collector, auto)} 가져옵니다.` : '쪽지 창을 닫은 뒤 쪽지 가져오기를 눌러 주세요.'}`
      : `${name}를 쓰는 중이라 이번에는 쪽지를 가져오지 않았습니다. ${nextCheckText(collector, auto) ? `${nextCheckText(collector, auto)} 다시 확인하고, ` : ''}쪽지 가져오기를 누르면 확인한 뒤 바로 가져옵니다.`,
    offline: collectorConnected && auto?.enabled && !collectorFirstImportPending
      ? `${fullName}가 닫혀 있습니다. 다시 열고 로그인하면 자동으로 연결합니다.`
      : `${fullName}를 열고 로그인한 뒤 연결해 주세요.`,
    // 실제 시험: 브리티 메뉴(오른쪽 클릭 메뉴 등)가 열려 있을 때도 이렇게 된다.
    unverified: collectorConnected && auto?.enabled && !collectorFirstImportPending
      ? `${name} 쪽지 화면을 읽지 못했습니다. ${name} 창에 열린 메뉴가 있으면 Esc로 닫아 주세요. 창이 보이면 자동으로 다시 연결합니다.`
      : `${name} 쪽지 화면을 읽지 못했습니다. 로그인돼 있는지 보고, 열린 메뉴가 있으면 Esc로 닫은 뒤 다시 연결해 주세요.`,
    conflict: '수집기를 자동으로 연결할 수 없습니다. 현재 설정된 저장 폴더에서만 쪽지를 읽습니다.',
    unavailable: '쪽지 수집기를 연결하지 못했습니다. ZIP 전체를 푼 폴더에서 앱을 다시 열어 주세요.',
  };
  // GOE판: 켜져 있는데 못 찾은 까닭을 그대로 보인다(2026-11-17 “메신저가 켜져있어도 못찾았단 거야”).
  const [goeReason, errorLine] = (collector?.goeReason || '').split(':');
  const goeWhy = {
    'main-window-not-found': `${fullName}는 켜져 있지만 메인 창을 찾지 못했습니다(까닭: GOE 창 찾기 실패). GOE 판이 다를 수 있으니 이 문구를 알려 주세요.`,
    'control-not-found': `${fullName} 창은 찾았지만 쪽지함 단추를 읽지 못했습니다(까닭: 쪽지함 읽기 실패). GOE를 관리자 권한으로 켰다면 보통으로 다시 켜 주세요.`,
    'inbox-not-confirmed': 'GOE 수신함 표시를 판독하지 못해 쪽지를 열지 않았습니다.',
    'inbox-lost-while-paging': 'GOE 쪽지 목록을 넘기던 중 수신함 표시를 확인할 수 없어 가져오기를 멈췄습니다.',
    'collection-failed': `GOE 쪽지 가져오기 오류 (수집기 ${errorLine}행). 반복되면 이 번호를 알려 주세요.`,
    'restore-failed': '쪽지 확인 후 GOE 창을 원래 상태로 되돌리지 못했습니다.',
    'no-korean-ocr': `이 PC에 한국어 글자 인식(OCR)이 없어 쪽지를 읽지 못합니다. Windows 설정 › 시간 및 언어 › 언어 › 한국어 › 언어 옵션에서 ‘광학 문자 인식’을 설치해 주세요.`,
    'script-error': `${name} 수집기가 실행 중 멈췄습니다(까닭: 수집기 오류). 앱을 다시 열고, 그래도 같으면 이 문구를 알려 주세요.`
  }[goeReason];
  if (name === 'GOE 메신저') messages.unverified = 'GOE 쪽지 목록을 확인하지 못했습니다.';
  if (goeWhy) for (const key of ['offline', 'unverified', 'unavailable']) messages[key] = goeWhy;
  // 브리티판: 못 읽은 까닭과 할 일(2026-11-18, 제보 PC는 검색칸이 열려 있었는데 "읽지 못했습니다"만 보였다).
  const brityWhy = {
    'window-not-found': `${fullName} 창을 찾지 못했습니다. 브리티에 로그인돼 있는지 확인해 주세요.`,
    'note-menu-not-found': `${name} 화면에서 쪽지 메뉴를 찾지 못했습니다. 브리티에 열린 창이나 메뉴가 있으면 닫아 주세요. 브리티가 새로 업데이트됐다면 캘린더도 새 판이 필요할 수 있으니 이 문구를 알려 주세요.`,
    'note-list-not-found': `${name}의 쪽지 목록이 보이지 않습니다. 브리티에 검색칸이나 메뉴, 설정 창이 열려 있으면 닫아 주세요.`,
    'classic-unreadable': `클래식 뷰에서 쪽지를 열지 못했습니다. 브리티 환경설정 › 일반 › 뷰 모드에서 원 뷰로 바꿔 주세요.`
  }[name === 'GOE 메신저' ? '' : collector?.brityReason];
  if (brityWhy && status === 'unverified') messages.unverified = brityWhy;
  // 클래식 뷰로 읽혔으면 읽기에 성공해도 원 뷰로 바꾸라고 알리고, 원 뷰로 읽힐 때까지 남긴다(2026-11-19).
  const classicNotice = name !== 'GOE 메신저' && collectorConnected && state.snapshot.brityView === 'classic' && collector?.brityReason !== 'classic-unreadable'
    ? `${name}가 클래식 뷰라 쪽지를 놓칠 수 있습니다. 환경설정 › 일반 › 뷰 모드에서 원 뷰로 바꿔 주세요.` : '';
  const classicShown = classicNotice || (brityWhy && collector.brityReason === 'classic-unreadable');
  if (classicNotice && status === 'ready') messages.ready = [classicNotice, messages.ready].join(' · ');
  if (brityWhy && status === 'ready' && collector.brityReason === 'classic-unreadable') messages.ready = [brityWhy, messages.ready].join(' · ');
  messages['list-unreadable'] = [goeWhy || '이번 쪽지 목록을 읽지 못했습니다.', collector?.imported ? `중단 전 ${collector.imported}건 받음` : ''].filter(Boolean).join(' · ');
  const running = status === 'ready' || status === 'in-use';
  // 처음 시작: 브리티를 아직 연결하지 않았으면 1단계 AI 연결 → 2단계 브리티 연결 순서로 보인다.
  const setup = !collectorConnected && !running;
  const aiFirst = setup && aiNotConnected();
  $('collector-title').textContent = running || status === 'list-unreadable' ? `${name} 연결됨` : aiFirst ? '1단계 · AI 연결' : setup && !state.demo ? `2단계 · ${name} 연결` : `${name} 쪽지 연결`;
  $('collector-ai').hidden = !aiFirst;
  $('start-guide').hidden = !setup;
  $('collector-connect').classList.toggle('text-button', aiFirst);
  $('collector-connect').classList.toggle('small', aiFirst);
  // 연결된 동안에는 지금 하는 일(읽는 중·분류 중)을 먼저 보이고, 한가할 때 주기와 마지막 결과를 보인다.
  const doing = running || state.connectingCollector ? activityText() : '';
  const aiFirstText = `쪽지에서 날짜와 할 일을 뽑으려면 AI가 필요합니다. AI를 연결한 뒤 ${name}를 연결하세요.`;
  // 2단계: 1단계(AI)가 끝났다는 것을 먼저 보인다.
  const aiDone = setup && !aiNotConnected() && !state.demo ? `✓ AI 연결됨(${aiNames[state.snapshot.aiProvider] || 'AI'}) · ` : '';
  $('collector-status').textContent = doing || (aiFirst && (status === 'idle' || status === 'offline') ? aiFirstText : '') || aiDone + (messages[status] || messages.unavailable);
  // 일하는 중이면 머리줄 연결 칸을 색 띠로 바꾸고 아래에 움직이는 줄을 보인다(2026-11-17 “시각적으로 눈에 띄게”).
  // AI 분류가 멈춘 것은 일하는 중이 아니라 알림이라 움직이지 않는다.
  const stopped = !!doing && !!state.snapshot.aiBlocked && doing.startsWith('AI 분류 멈춤');
  const working = !!doing && !stopped;
  $('collector-status').classList.toggle('busy', working);
  $('collector-bar').classList.toggle('working', working);
  $('collector-bar').classList.toggle('stopped', stopped || (!doing && !!classicShown && ['ready', 'unverified'].includes(status)));
  document.querySelector('.app-header').classList.toggle('working', working);
  // 연결한 뒤에는 이 버튼이 "지금 가져오기"다. 자동 분류가 꺼져 있어도 이렇게 가져온 쪽지는 분류한다.
  const fetching = state.connectingCollector || state.snapshot.activity === 'notes';
  $('collector-connect').textContent = fetching ? '가져오는 중…' : status === 'connecting' ? '연결 중…'
    : collectorFirstImportPending ? '첫 가져오기 계속' : collectorConnected ? '쪽지 가져오기' : aiFirst ? `AI 없이 ${name} 연결` : `${name} 연결`;
  $('collector-connect').disabled = messengerBusy();
  renderMessengerButtons();
}

// 열려 있는 자세히 칸의 메신저 버튼(첨부 다시 받기·답장)도 같은 기준으로 막는다. 자동 가져오기가 시작·끝날 때도 바로 바뀐다.
function messengerNoteTarget() {
  return state.messenger.noteAction === 'original' ? '원문' : '답장창';
}

function renderMessengerButtons() {
  const busy = messengerBusy();
  const retry = $('goe-attachment-retry');
  retry.disabled = busy;
  retry.title = busy && !state.attachmentRetry?.pending ? `${state.messenger.name}에서 다른 일을 하는 중입니다. 끝나면 누를 수 있습니다.` : '';
  const button = $('open-messenger-note');
  button.disabled = busy;
  const original = state.messenger.noteAction === 'original';
  const label = original ? 'GOE에서 원문 보기'
    : state.detail?.noteActions?.forwarded ? '보낸 사람에게 답장' : `${state.messenger.name}에서 답장`;
  button.setAttribute('aria-label', state.messengerNoteOpening ? `${messengerNoteTarget()} 여는 중…` : label);
  button.querySelector('use').setAttribute('href', original ? '#i-note-open' : '#i-reply');
  button.title = busy && !state.messengerNoteOpening ? `${state.messenger.name}에서 다른 일을 하는 중입니다. 끝나면 누를 수 있습니다.` : '';
  if (noteAi?.mode === 'reply') renderNoteAi();
}

// 자동 가져오기가 켜져 있으면 다음 확인 시각("오후 3:40에"), 아니면 빈 글.
function nextCheckText(collector, auto) {
  if (!auto?.enabled || !collector?.checkedAt || !(auto.minutes > 0)) return '';
  const next = new Date(collector.checkedAt + auto.minutes * 60_000);
  return `${next.toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' })}에`;
}

function minutesLabel(minutes) {
  return minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60}시간` : `${minutes}분`;
}

function chatCollectionText(snapshot) {
  const { autoRefresh, chatRooms, chatCollection, chatRefreshFailed, collectorFirstImportPending } = snapshot;
  if (snapshot.demo) return '';
  if (chatRefreshFailed) return '저장된 대화를 읽지 못했습니다. 다음 확인 때 다시 시도합니다.';
  if (!chatRooms?.length) return '가져올 방을 아직 고르지 않았습니다. ‘가져올 대화방’을 펼쳐 방을 고르고 저장해 주세요.';
  const automatic = !!autoRefresh?.chats.enabled;
  if (automatic && collectorFirstImportPending) return '첫 쪽지 가져오기 설정이 끝나면 자동으로 확인합니다.';
  if (!chatCollection) return automatic ? `아직 확인 전입니다. ${minutesLabel(autoRefresh.chats.minutes)} 안에 처음 확인합니다. 바로 받으려면 지금 가져오기를 누르세요.`
    : '자동이 꺼져 있습니다. 지금 가져오기를 누를 때만 가져옵니다.';
  const { checkedAt, status, added, retry, needsReview, baselines = 0, candidates = 0, holds = [] } = chatCollection;
  const time = new Date(checkedAt);
  const day = key(time);
  const clock = time.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
  const checked = day === key(new Date()) ? clock : `${shortDate(day)} ${clock}`;
  const reasons = {
    'in-use': '브리티 창 최소화 대기',
    offline: '브리티 로그인 대기',
    conflict: '브리티 사용 중'
  };
  const result = status === 'ready' ? `새 글 ${added}건` : chatCollection.guide || reasons[status] || '대화방을 읽지 못했습니다';
  // 방 이름과 함께 무엇이 왜 보류됐는지 보인다. 끊김(gap)은 가져왔지만 그 앞 글이 빠졌을 수 있다는 뜻이다.
  const names = new Map((chatRooms || []).map(room => [room.key, room.label]));
  const holdText = {
    missing: '브리티 목록에서 방을 못 찾음(이름이 바뀌었으면 방을 다시 골라 주세요)',
    unstable: '글을 다 읽지 못함(다음 확인 때 다시 읽음)',
    mismatch: '다른 방이 열림(다음 확인 때 다시 읽음)',
    error: '읽는 중 오류(다음 확인 때 다시 읽음)',
    gap: '지난번 글을 못 찾아 그 사이 글이 빠졌을 수 있음(브리티에서 확인해 주세요)'
  };
  const roomName = key => (names.get(key) || '방').replace(/\s+\d+$/, '');
  const holdLines = holds.map(({ key, reason }) => `${roomName(key)}: ${holdText[reason] || '확인 보류'}`);
  const skipped = Math.max(0, retry + needsReview - holds.filter(hold => hold.reason !== 'gap').length);
  const summary = [`마지막 확인 ${checked}`, result, status !== 'ready' && added ? `새 글 ${added}건` : '',
    status === 'ready' ? `후보 ${candidates}개` : '',
    baselines ? `처음 확인한 방 ${baselines}개는 지금부터 새 글을 모읍니다` : '',
    skipped ? `확인 보류 ${skipped}개 방` : ''].filter(Boolean).join(' · ');
  return [summary, ...holdLines].join('\n');
}

function renderAutoRefresh() {
  const auto = state.snapshot.autoRefresh;
  if (!auto) return;
  for (const kind of ['notes', 'chats']) {
    const select = $(`auto-${kind}-minutes`);
    if (select.options.length !== auto.choices.length) {
      select.replaceChildren(...auto.choices.map(minutes => { const option = element('option', null, minutesLabel(minutes)); option.value = String(minutes); return option; }));
    }
    $(`auto-${kind}`).checked = auto[kind].enabled;
    select.value = String(auto[kind].minutes);
    select.disabled = !auto[kind].enabled || !!state.savingAuto;
    $(`auto-${kind}`).disabled = !!state.savingAuto;
  }
  renderNotesFetch();
  const collecting = !!state.chatCollecting;
  $('chats-collect-now').textContent = collecting ? '가져오는 중…' : '지금 가져오기';
  $('chats-collect-now').disabled = messengerBusy() || !!state.snapshot.demo || !state.snapshot.chatRooms?.length;
  const status = collecting ? '브리티에서 대화방을 읽는 중…' : state.chatCollectError || chatCollectionText(state.snapshot);
  if ($('chat-collection-status').textContent !== status) setMessage('chat-collection-status', status, !collecting && !!state.chatCollectError);
}

// 대화방 지금 가져오기: 자동이 꺼져 있어도 저장한 방을 한 번 읽는다.
$('notes-collect-now').addEventListener('click', () => void collectNow());
$('chats-collect-now').addEventListener('click', async () => {
  state.chatCollecting = true;
  state.chatCollectError = '';
  renderBusy();
  try { sync(await api.collectChatsNow()); }
  catch (error) { state.chatCollectError = error.message; }
  finally { state.chatCollecting = false; renderBusy(); }
});

async function saveAutoRefresh() {
  // 고른 값을 먼저 읽는다(다시 그리면 저장된 값으로 돌아간다).
  const value = kind => ({ enabled: $(`auto-${kind}`).checked, minutes: Number($(`auto-${kind}-minutes`).value) });
  const input = { notes: value('notes'), chats: value('chats') };
  state.savingAuto = true;
  renderAutoRefresh();
  try {
    sync(await api.setAutoRefresh(input));
    setMessage('auto-status', '저장했습니다.');
  } catch (error) {
    setMessage('auto-status', error.message, true);
  } finally {
    state.savingAuto = false;
    renderAutoRefresh();
  }
}
for (const id of ['auto-notes', 'auto-notes-minutes', 'auto-chats', 'auto-chats-minutes']) $(id).addEventListener('change', () => void saveAutoRefresh());

function updateChatRoomSelection() {
  const saved = state.snapshot.chatRooms || [];
  const draft = state.chatRoomDraft;
  const dirty = draft.size !== saved.length || saved.some(({ key }) => !draft.has(key));
  $('chat-room-count').textContent = `선택 ${draft.size}개`;
  $('chat-rooms-load').disabled = !!state.chatRoomBusy;
  $('chat-rooms-save').disabled = !!state.chatRoomBusy || !dirty;
  for (const box of $('chat-room-options').querySelectorAll('input')) box.disabled = !!state.chatRoomBusy;
}

function renderChatRooms() {
  const available = new Map((state.chatRoomChoices || []).map(room => [room.key, room]));
  const rooms = new Map([...available, ...state.chatRoomDraft]);
  const search = $('chat-room-search');
  const searchable = rooms.size > 7;
  $('chat-room-search-field').hidden = !searchable;
  if (!searchable) search.value = '';
  const query = search.value.trim().toLocaleLowerCase();
  const matches = [...rooms.values()].filter(room => room.label.toLocaleLowerCase().includes(query));
  const rows = matches.map(room => {
    const item = element('li');
    const label = element('label', 'chat-room-option');
    const box = element('input');
    box.type = 'checkbox';
    box.checked = state.chatRoomDraft.has(room.key);
    box.addEventListener('change', () => {
      if (box.checked) state.chatRoomDraft.set(room.key, room);
      else state.chatRoomDraft.delete(room.key);
      updateChatRoomSelection();
    });
    label.append(box, element('span', null, room.label));
    if (state.chatRoomChoices && !available.has(room.key)) label.append(element('span', 'small-note', '현재 목록에 없음'));
    item.append(label);
    return item;
  });
  $('chat-room-options').replaceChildren(...rows);
  $('chat-room-options').hidden = !rows.length;
  $('chat-room-selection').hidden = !rooms.size;
  $('chat-room-no-matches').hidden = !query || !!rows.length;
  updateChatRoomSelection();
}

$('chat-room-search').addEventListener('input', renderChatRooms);
$('chat-rooms-load').addEventListener('click', async () => {
  state.chatRoomBusy = true;
  updateChatRoomSelection();
  setMessage('chat-rooms-status', '브리티에서 방 목록을 읽는 중…');
  try {
    const result = await api.listChatRooms();
    state.chatRoomChoices = result.roomChoices;
    renderChatRooms();
    const message = result.needsReview ? '같은 이름으로 표시된 방은 구별할 수 없어 목록에서 뺐습니다.'
      : !result.roomChoices.length ? '브리티에 표시된 대화방이 없습니다.' : '';
    setMessage('chat-rooms-status', message);
  } catch (error) {
    setMessage('chat-rooms-status', error.message, true);
  } finally {
    state.chatRoomBusy = false;
    updateChatRoomSelection();
  }
});

$('chat-rooms-save').addEventListener('click', async () => {
  state.chatRoomBusy = true;
  updateChatRoomSelection();
  try {
    sync(await api.setChatRooms([...state.chatRoomDraft.values()]));
    renderChatRooms();
    setMessage('chat-rooms-status', '선택을 저장했습니다.');
  } catch (error) {
    setMessage('chat-rooms-status', error.message, true);
  } finally {
    state.chatRoomBusy = false;
    updateChatRoomSelection();
  }
});

// 쪽지 가져오기: 브리티를 쓰는 중이면 확인을 받고 다시 가져온다.
async function collectNow() {
  if (!state.snapshot.collectorConnected || state.snapshot.collectorFirstImportPending) {
    openFirstImport();
    return;
  }
  await changeCollector(async () => {
    const { name } = state.messenger;
    let next = await api.collectNow(false);
    // 쪽지 창이 열려 있으면 묻고 다시 해도 막힌다: 머리줄 안내(창을 닫으라는 말)만 보인다.
    if (next.collector?.status === 'in-use' && next.collector.busyReason !== 'note-open' && window.confirm(`${name}를 쓰는 중입니다. 지금 쪽지를 가져올까요?\n가져오는 동안 ${name} 화면이 잠깐 쪽지 목록으로 바뀔 수 있습니다.`)) {
      next = await api.collectNow(true);
    }
    return next;
  });
}

// 서룡 판이 아니면 팩트챗을 목록에서 빼고 개인 OpenAI API를 권장으로 둔다.
function fillAiChoices() {
  const offered = state.snapshot.factchatOffered !== false;
  const select = $('ai-provider');
  const factchat = select.querySelector('option[value="factchat"]');
  factchat.hidden = factchat.disabled = !offered;
  factchat.textContent = '서룡 팩트챗 API · Luna (권장)';
  select.querySelector('option[value="openai"]').textContent = `개인 OpenAI API 키 · Luna${offered ? '' : ' (권장)'}`;
  return offered;
}

function renderAiSettings() {
  const provider = $('ai-provider').value;
  const factchat = provider === 'factchat';
  const anthropic = provider === 'anthropic';
  const isApi = factchat || anthropic || provider === 'openai';
  const hasStoredKey = isApi && state.snapshot.aiProvider === provider;
  $('ai-settings').hidden = !!state.demo;
  renderAiConnected();
  $('ai-key-options').hidden = !isApi;
  $('ai-key-label').textContent = factchat ? '팩트챗 API 키' : anthropic ? 'Claude API 키' : 'OpenAI API 키';
  $('ai-key').placeholder = hasStoredKey ? '비워 두면 저장된 키 사용' : factchat ? 'baze_…' : anthropic ? 'sk-ant-…' : 'sk-…';
  $('ai-key-guide').dataset.aiGuide = factchat ? 'factchat' : anthropic ? 'anthropic-key' : 'key';
  $('ai-key-guide').textContent = factchat ? '서룡 팩트챗 개발자 화면 ↗' : 'API 키 발급 ↗';
  $('ai-key-guide').hidden = factchat && !state.snapshot.factchatGuideAvailable;
  // API 키 방식: 가입·결제·키 만들기 안내서를 첫 링크로 둔다(작은 글 한 줄, 2026-11-15 “안내서 부분 너무 크지 않나”).
  $('ai-guide-open').hidden = factchat;
  $('ai-guide-open').dataset.page = anthropic ? 'anthropic-guide' : 'openai-guide';
  // Claude 결제 화면 주소는 확인하지 못해 안내서에서 따라가게 하고, OpenAI만 결제 화면을 바로 연다.
  $('ai-billing-guide').hidden = factchat || anthropic;
  // 구독 방식(Claude Code·Codex): 연결 단추가 설치·로그인까지 이끈다. 막힐 때 볼 안내서만 단추 옆에 작게 둔다.
  const cli = provider === 'claude' || provider === 'codex';
  $('ai-help').hidden = !cli;
  $('ai-help').dataset.page = provider;
  $('ai-provider').disabled = !!state.testingAi;
  $('ai-connect').disabled = !!state.testingAi || (provider === 'none' && state.snapshot.aiProvider === 'none');
  $('ai-connect').textContent = state.testingAi ? '연결 시험 중…' : provider === 'none' ? 'AI 연결 끄기'
    : provider === state.snapshot.aiProvider ? '연결 다시 시험' : '연결 시험 및 저장';
  $('ai-hint').textContent = anthropic ? 'Anthropic 콘솔에서 만든 키(sk-ant-로 시작)를 붙여 넣으세요. Haiku 모델을 쓰고, 쓴 만큼 그 계정에 청구됩니다. 비용은 쪽지 100건에 약 100원입니다. 연결 시험에는 가짜 쪽지를 사용합니다.'
    // 비용 어림(2026-11-17 사용자 “쪽지 1건에 1원정도 … 대충 표시해두면 좋을것”): Luna에서 본 값을 어림으로 Haiku에도 같이 쓴다(사용자 “하이쿠도 그렇게 해놔”).
    : isApi ? 'API 키를 붙여 넣으세요. 비용은 쪽지 100건에 약 100원입니다. 연결 시험에는 가짜 쪽지를 사용합니다.' : provider === 'none' ? 'AI 연결 없이도 쪽지를 가져오고 달력에 기록할 수 있습니다.'
    : provider === 'claude' ? 'Claude Pro 이상 계정으로 이용합니다. 연결할 때 필요한 설치와 로그인을 안내합니다.'
    : 'ChatGPT Plus 이상 계정으로 이용합니다. 연결할 때 필요한 설치와 로그인을 안내합니다.';
}

// AI 연결 상태 줄(설정 AI 탭 맨 위). 연결 시험을 통과해 저장된 방식만 “연결됨”이다.
function renderAiConnected() {
  const box = $('ai-connected');
  box.hidden = !!state.demo;
  const provider = state.snapshot.aiProvider ?? 'none';
  const connected = provider !== 'none' && !!aiNames[provider];
  // 연결된 방식을 다시 시험했는데 실패하면 “연결됨” 대신 실패로 보인다(다음 성공·방식 바꿈까지).
  const failed = connected && state.aiCheckFailed === provider;
  box.classList.toggle('off', !connected || failed);
  const mark = element('span', 'mark', connected && !failed ? '✓' : '!');
  mark.setAttribute('aria-hidden', 'true');
  const detail = failed ? '방금 연결 시험이 실패했습니다. 아래 안내를 확인해 주세요.'
    : connected ? (state.snapshot.automatic ? '새 쪽지는 자동으로 정리합니다.' : '새 쪽지 자동 분류가 꺼져 있습니다.')
      : '아래에서 방식을 고르고 ‘연결 시험 및 저장’을 누르세요.';
  const label = failed ? `연결 확인 실패 · ${aiNames[provider]}` : connected ? `AI 연결됨 · ${aiNames[provider]}` : '아직 AI 연결 전입니다';
  box.replaceChildren(mark, document.createTextNode(label), element('span', 'detail', detail));
}


// 설정 묶음 탭(2026-11-15 사용자 "설정에 정보가 좀 많아졌는데"): AI · 가져오기 · 화면 · 백업·정보.
// 연결 전에는 AI부터 열고, 그 뒤에는 이 PC에서 마지막에 본 묶음으로 연다. 다른 코드가 구역을 숨기기도 하므로(샘플의 백업 등)
// 탭은 hidden 대신 off-tab 클래스로 가린다.
const SETTINGS_TABS = ['ai', 'agents', 'fetch', 'look', 'google', 'about'];
let settingsTab = 'ai';
try { const saved = localStorage.getItem('calendar-settings-tab'); if (SETTINGS_TABS.includes(saved)) settingsTab = saved; } catch {}

function showSettingsTab(tab, { focus = false } = {}) {
  settingsTab = SETTINGS_TABS.includes(tab) ? tab : 'ai';
  for (const button of document.querySelectorAll('.settings-tabs [data-tab-target]')) {
    const on = button.dataset.tabTarget === settingsTab;
    button.setAttribute('aria-selected', String(on));
    button.tabIndex = on ? 0 : -1;
    if (on && focus) button.focus();
  }
  for (const section of document.querySelectorAll('#settings-body > [data-settings-tab]')) {
    section.classList.toggle('off-tab', section.dataset.settingsTab !== settingsTab);
  }
  $('settings-body').setAttribute('aria-labelledby', `settings-tab-${settingsTab}`);
  $('settings-body').scrollTop = 0;
  if (settingsTab === 'agents') void refreshProjectAgents();
  try { localStorage.setItem('calendar-settings-tab', settingsTab); } catch {}
}

for (const button of document.querySelectorAll('.settings-tabs [data-tab-target]')) {
  button.addEventListener('click', () => showSettingsTab(button.dataset.tabTarget));
}
document.querySelector('.settings-tabs').addEventListener('keydown', event => {
  const at = SETTINGS_TABS.indexOf(settingsTab);
  const next = { ArrowLeft: at - 1, ArrowRight: at + 1, Home: 0, End: SETTINGS_TABS.length - 1 }[event.key];
  if (next === undefined) return;
  event.preventDefault();
  showSettingsTab(SETTINGS_TABS[(next + SETTINGS_TABS.length) % SETTINGS_TABS.length], { focus: true });
});

const installGuides = { codex: $('guide-codex-desktop'), claude: $('guide-claude-setup') };
let agentCheckVersion = 0;
async function refreshProjectAgents() {
  const version = ++agentCheckVersion;
  for (const [agent, guide] of Object.entries(installGuides)) {
    $('agent-' + agent + '-status').textContent = '확인 중…';
    guide.hidden = true;
  }
  let status;
  try { status = await api.projectAgentStatus(); } catch { status = {}; }
  if (version !== agentCheckVersion) return;
  for (const [agent, guide] of Object.entries(installGuides)) {
    guide.hidden = status[agent] !== false;
    $('agent-' + agent + '-status').textContent = status[agent] === true ? '설치됨'
      : status[agent] === false ? '앱을 찾지 못했습니다' : '확인하지 못함';
  }
  if (currentNoteAi(projectSession)) {
    projectSession.installed = status[$('project-agent').value];
    renderNoteAi();
  }
}
$('agent-refresh').addEventListener('click', () => void refreshProjectAgents());
for (const page of ['codex-desktop', 'claude-setup']) {
  $('guide-' + page).addEventListener('click', () => void api.openAiGuide(page)
    .catch(error => setMessage('agent-guide-status', error.message, true)));
}
const connectionCopied = '연결 요청을 복사했습니다. Codex나 Claude Code 채팅에 붙여넣고 보내세요.';
$('mcp-copy-connect').addEventListener('click', async () => {
  $('mcp-copy-connect').disabled = true;
  setMessage('mcp-copy-connect-status', '연결 요청을 준비하고 있습니다.');
  try {
    await api.mcpCopySetup('ai-request');
    setMessage('mcp-copy-connect-status', connectionCopied);
  } catch (error) { setMessage('mcp-copy-connect-status', error.message, true); }
  finally { $('mcp-copy-connect').disabled = false; }
});
$('mcp-check').addEventListener('click', async () => {
  $('mcp-check').disabled = true;
  setMessage('mcp-check-status', '연결 프로그램을 확인하고 있습니다.');
  try {
    await api.checkMcpBridge();
    setMessage('mcp-check-status', '캘린더 쪽 연결 프로그램이 준비됐습니다.');
  } catch (error) { setMessage('mcp-check-status', error.message, true); }
  finally { $('mcp-check').disabled = false; }
});
$('project-agent-guide').addEventListener('click', () => openSettings('agents'));

function openSettings(tab) {
  setMessage('settings-error', '');
  const notConnected = !state.demo && (state.snapshot.aiProvider ?? 'none') === 'none';
  $('settings-ai-dot').hidden = !notConnected;
  showSettingsTab(typeof tab === 'string' ? tab : notConnected ? 'ai' : settingsTab);
  setMessage('ai-status', '');
  // 아직 연결 전이면 권장 방식(서룡 판은 팩트챗, 다른 판은 개인 OpenAI API)을 먼저 고른다.
  const offered = fillAiChoices();
  const provider = state.snapshot.aiProvider;
  $('ai-provider').value = !provider || provider === 'none' ? (offered ? 'factchat' : 'openai') : provider;
  $('ai-key').value = '';
  const profile = state.snapshot.profile || {};
  // 예전 설정(근무처·학교급 없음)은 초등 학교로 연다.
  $('profile-workplace').value = profile.workplace === '교육청' ? '교육청' : '학교';
  $('profile-school-level').value = ['중학교', '고등학교'].includes(profile.schoolLevel) ? profile.schoolLevel : '초등';
  fillProfileRoles(profile.role ?? (profile.homeroomTeacher === true ? '담임' : ''));
  $('profile-grade').value = profile.grade ?? '';
  $('profile-classroom').value = profile.classroom ?? '';
  $('profile-subjects').value = (profile.subjects || []).join(', ');
  $('profile-subject-grades').value = (profile.subjectGrades || []).join(', ');
  $('profile-office-type').value = profile.officeType ?? '';
  $('profile-department').value = profile.department ?? '';
  $('profile-position').value = profile.position ?? '';
  document.querySelectorAll('[data-covered]').forEach(box => { box.checked = (profile.coveredLevels || []).includes(box.dataset.covered); });
  updateProfileFields();
  $('profile-duties').value = (profile.duties || []).join(', ');
  $('profile-memberships').value = (profile.memberships || []).join(', ');
  $('profile-status').textContent = '';
  setMessage('downloads-status', '');
  setMessage('backup-status', '');
  setMessage('auto-status', '');
  if (!state.chatRoomBusy) {
    state.chatRoomDraft = new Map((state.snapshot.chatRooms || []).map(room => [room.key, room]));
    setMessage('chat-rooms-status', '');
  }
  $('chat-room-settings').open = false;
  $('chat-room-search').value = '';
  renderChatRooms();
  setMessage('refresh-status', '');
  state.rangeMessage = false;
  setMessage('range-status', '');
  renderDownloads();
  renderBackup();
  renderRange();
  setMessage('google-status', '');
  renderGoogle();
  renderAiSettings();
  $('settings-dialog').showModal();
}

// 의견 보내기: 머리줄 단추를 누르면 바로 아래 작은 칸. 닫아도 쓴 글은 남고, 보내면 비운다.
function renderFeedback() {
  const feedback = state.snapshot.feedback || {};
  $('feedback').hidden = !feedback.available;
  $('feedback-info').textContent = `쪽지와 업무 내용은 보내지 않습니다. 함께 가는 정보: ${feedback.info || ''}`;
}
function feedbackStatus(text, error = false) {
  $('feedback-status').hidden = !text;
  $('feedback-status').textContent = text || '';
  $('feedback-status').classList.toggle('error', error);
}
function toggleFeedback(open, returnFocus = false) {
  $('feedback-pop').hidden = !open;
  $('feedback-open').setAttribute('aria-expanded', String(open));
  if (open) { feedbackStatus(''); $('feedback-text').focus(); }
  else if (returnFocus) $('feedback-open').focus();
}
$('feedback-open').addEventListener('click', () => toggleFeedback($('feedback-pop').hidden));
$('feedback-cancel').addEventListener('click', () => toggleFeedback(false, true));
$('feedback-pop').addEventListener('keydown', event => {
  if (event.key === 'Escape') { event.stopPropagation(); toggleFeedback(false, true); }
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); $('feedback-pop').requestSubmit(); }
});
// 바깥을 누르면 닫는다. 다른 창(다른 프로그램)을 눌러 캘린더가 뒤로 가도 닫는다(2026-11-15 “다른 영역 누르면 닫히게”). 쓴 글은 남는다.
document.addEventListener('pointerdown', event => {
  if (!$('feedback-pop').hidden && !$('feedback').contains(event.target)) toggleFeedback(false);
}, true);
window.addEventListener('blur', () => { if (!$('feedback-pop').hidden) toggleFeedback(false); });
$('feedback-pop').addEventListener('submit', async event => {
  event.preventDefault();
  const text = $('feedback-text').value.trim();
  if (!text) { feedbackStatus('보낼 내용을 적어 주세요.', true); $('feedback-text').focus(); return; }
  $('feedback-send').disabled = true;
  feedbackStatus('보내는 중…');
  try {
    await api.sendFeedback(text);
    $('feedback-text').value = '';
    toggleFeedback(false, true);
    notice('의견을 보냈습니다. 고맙습니다.');
  } catch (error) {
    feedbackStatus(error.message, true);
  } finally {
    $('feedback-send').disabled = false;
  }
});

// 새 판 알림(머리줄)과 바뀐 점 창.
function renderUpdate() {
  renderFeedback();
  const update = state.snapshot.update || {};
  const status = update.status || 'idle';
  const shown = update.enabled && ['available', 'full', 'downloading', 'installing'].includes(status);
  $('update-bar').hidden = !shown;
  $('update-check').hidden = !update.enabled;
  $('update-check').disabled = status === 'checking' || status === 'downloading' || status === 'installing';
  if (shown) {
    $('update-title').textContent = `새 판 ${update.version}이 나왔습니다`;
    const text = {
      available: update.error || '업데이트를 누르면 캘린더가 잠깐 꺼졌다 다시 켜집니다. 업무와 쪽지는 그대로 남습니다.',
      full: '이번 판은 바탕 프로그램이 바뀌어 전체 ZIP을 새로 받아야 합니다.',
      downloading: '새 판을 받고 있습니다…',
      installing: '업데이트를 마치면 캘린더가 다시 켜집니다.'
    }[status];
    $('update-status').textContent = text;
    $('update-status').classList.toggle('error', status === 'available' && !!update.error);
    $('update-apply').textContent = status === 'full' ? '받는 곳 열기' : status === 'downloading' ? '받는 중…' : status === 'installing' ? '다시 켜는 중…' : '업데이트';
    $('update-apply').disabled = status === 'downloading' || status === 'installing';
  }
  if (state.updateChecking && status !== 'checking') {
    state.updateChecking = false;
    setMessage('update-check-status', status === 'latest' ? `지금 쓰는 ${state.snapshot.appVersion}판이 최신입니다.`
      : status === 'unavailable' ? '접근할 수 있는 업데이트가 없습니다. 새 ZIP은 배포한 곳에서 확인해 주세요.'
      : status === 'failed' ? update.error : status === 'available' || status === 'full' ? `새 판 ${update.version}이 있습니다. 머리줄의 업데이트를 눌러 주세요.` : '', status === 'failed');
  }
  // 업데이트한 뒤 처음 켰을 때 한 번 보여 준다.
  if (state.snapshot.whatsNew && !state.whatsNewShown && !document.querySelector('dialog[open]')) {
    state.whatsNewShown = true;
    const { version, changes } = state.snapshot.whatsNew;
    showChanges(`${version}판으로 업데이트했습니다`, '이번에 바뀐 점입니다. 설정 아래쪽 "바뀐 점"에서 다시 볼 수 있습니다.', changes, false);
    void api.dismissWhatsNew().catch(() => {});
  }
}

function showChanges(heading, lead, changes, offerUpdate) {
  $('changes-heading').textContent = heading;
  $('changes-lead').textContent = lead;
  const blocks = (changes || []).map(({ version, date, items }) => {
    const block = element('section', 'changes-version');
    block.append(element('h3', null, `${version}판${date ? ` · ${date}` : ''}`));
    const list = element('ul');
    list.append(...items.map(item => element('li', null, item)));
    block.append(list);
    return block;
  });
  $('changes-list').replaceChildren(...(blocks.length ? blocks : [element('p', 'small-note', '적어 둔 바뀐 점이 없습니다.')]));
  $('changes-update').hidden = !offerUpdate;
  $('changes-dialog').showModal();
  (offerUpdate ? $('changes-update') : $('changes-close')).focus();
}

async function startUpdate() {
  const update = state.snapshot.update || {};
  try {
    if (update.status === 'full') { await api.openUpdatePage(); return; }
    if (state.dirty && !window.confirm('저장하지 않은 변경이 있습니다. 버리고 업데이트할까요?')) return;
    sync(await api.applyUpdate());
  } catch (error) {
    $('update-status').textContent = error.message;
    $('update-status').classList.add('error');
  }
}

$('update-apply').addEventListener('click', () => void startUpdate());
$('shortcut-create').addEventListener('click', async () => {
  try {
    await api.createShortcut();
    $('shortcut-status').textContent = `바탕 화면에 "${state.messenger.appName}" 바로 가기를 만들었습니다.`;
  } catch (error) {
    $('shortcut-status').textContent = error.message;
  }
});
// 컴퓨터를 켜면 자동 실행: Windows 시작 프로그램에 실행기를 등록하거나 뺀다(main.js login-start).
$('login-start').addEventListener('change', async () => {
  const wanted = $('login-start').checked;
  state.loginStartBusy = true;
  $('login-start').disabled = true;
  try {
    sync(await api.setLoginStart(wanted));
    $('login-start-status').textContent = wanted ? '켰습니다. 다음에 Windows에 로그인하면 캘린더가 저절로 켜집니다.' : '껐습니다. 컴퓨터를 켜도 캘린더가 저절로 켜지지 않습니다.';
  } catch (error) {
    $('login-start').checked = !wanted;
    $('login-start-status').textContent = error.message;
  } finally {
    state.loginStartBusy = false;
    $('login-start').disabled = false;
  }
});
$('update-notes').addEventListener('click', () => {
  const update = state.snapshot.update || {};
  showChanges(`새 판 ${update.version}에서 바뀌는 점`, `지금 쓰는 판은 ${state.snapshot.appVersion}입니다.`, update.changes, update.status === 'available');
});
$('changes-close').addEventListener('click', () => $('changes-dialog').close());
$('changes-update').addEventListener('click', () => { $('changes-dialog').close(); void startUpdate(); });
$('changes-open').addEventListener('click', async () => {
  try {
    const { version, changes } = await api.changes();
    showChanges('바뀐 점', `지금 쓰는 판은 ${version}입니다.`, changes, false);
  } catch (error) {
    setMessage('update-check-status', error.message, true);
  }
});
$('update-check').addEventListener('click', async () => {
  state.updateChecking = true;
  setMessage('update-check-status', '새 판을 확인하고 있습니다.');
  try { sync(await api.checkUpdate()); }
  catch (error) { state.updateChecking = false; setMessage('update-check-status', error.message, true); }
});

// 지난 쪽지 불러오기(3단계).
const firstImportDialog = $('first-import-dialog');
const rangeSettings = $('range-settings');
const rangeHome = document.createComment('range settings home');
rangeSettings.before(rangeHome);

function renderFirstImport() {
  if (!firstImportDialog.open) return;
  const { collector, collectorConnected, collectorFirstImportPending, autoRefresh, rangeImport } = state.snapshot;
  const { name } = state.messenger;
  const connecting = !!state.firstImportConnecting;
  const saving = !!state.firstImportSaving;
  const ready = collectorConnected && collectorFirstImportPending && collector?.status === 'ready';
  const busy = connecting || saving || !!state.rangeBusy || !!rangeImport?.running;
  const message = state.firstImportError || (connecting ? `${name} 쪽지 목록에 연결하고 있습니다.`
    : ready && !collector.managed ? '다른 수집기가 실행 중이라 이 창에서 기간을 정해 가져올 수 없습니다.'
      : ready ? '기간을 고르고 ‘불러오기’를 누르세요. 기간이 길면 먼저 몇 건인지 볼 수 있습니다.'
        : `${name}에 로그인하고 창을 띄운 뒤 연결을 다시 확인해 주세요.`);
  setMessage('first-import-connection', message, !!state.firstImportError);
  $('first-import-ai').hidden = !aiNotConnected();
  $('first-import-retry').hidden = ready || connecting;
  $('first-import-retry').disabled = busy;
  $('first-import-auto-label').textContent = autoRefresh?.notes?.minutes
    ? `캘린더가 켜져 있을 때 ${minutesLabel(autoRefresh.notes.minutes)}마다` : '';
  $('first-import-auto').disabled = $('first-import-manual').disabled = busy;
  $('first-import-close').disabled = busy;
  $('first-import-finish').disabled = !ready || busy;
  $('first-import-finish').textContent = state.firstImportImported ? '설정 마치기' : '기간 가져오기 건너뛰기';
}

async function prepareFirstImport() {
  state.firstImportConnecting = true;
  state.firstImportError = '';
  renderBusy();
  try { sync(await api.connectCollector()); }
  catch (error) { state.firstImportError = error.message; }
  finally {
    state.firstImportConnecting = false;
    renderBusy();
    if (!$('range-from').disabled) $('range-from').focus();
    else if (!$('first-import-retry').hidden) $('first-import-retry').focus();
  }
}

function openFirstImport() {
  if (firstImportDialog.open) return;
  $('first-import-range').append(rangeSettings);
  const today = new Date();
  if (!$('range-from').value) $('range-from').value = key(shift(today, -6));
  if (!$('range-to').value) $('range-to').value = key(today);
  $('first-import-auto').checked = state.snapshot.autoRefresh?.notes?.enabled !== false;
  $('first-import-manual').checked = !$('first-import-auto').checked;
  state.rangePreview = null;
  state.rangeMessage = false;
  state.firstImportImported = !!state.snapshot.rangePending;
  setMessage('range-status', '');
  firstImportDialog.showModal();
  void prepareFirstImport();
}

$('first-import-retry').addEventListener('click', () => void prepareFirstImport());
$('first-import-ai-open').addEventListener('click', () => {
  if ($('first-import-close').disabled) return;
  firstImportDialog.close();
  openSettings('ai');
});
$('first-import-close').addEventListener('click', () => firstImportDialog.close());
firstImportDialog.addEventListener('cancel', event => {
  if ($('first-import-close').disabled) event.preventDefault();
});
firstImportDialog.addEventListener('close', () => {
  rangeHome.after(rangeSettings);
  state.rangePreview = null;
  state.rangeMessage = false;
  setMessage('range-status', '');
  renderRange();
  $('collector-connect').focus();
});
$('first-import-finish').addEventListener('click', async () => {
  state.firstImportSaving = true;
  state.firstImportError = '';
  renderRange();
  try {
    const automatic = $('first-import-auto').checked;
    sync(await api.finishCollectorFirstImport(automatic));
    firstImportDialog.close();
    notice(automatic ? '쪽지를 자동으로 가져옵니다.' : '수동으로 설정했습니다. 위쪽에서 ‘쪽지 가져오기’를 누르세요.');
  } catch (error) {
    state.firstImportError = error.message;
  } finally {
    state.firstImportSaving = false;
    renderRange();
  }
});

function renderRange() {
  const snap = state.snapshot;
  const { name } = state.messenger;
  const first = firstImportDialog.open;
  const available = !!snap.collectorAvailable && !!snap.collectorConnected &&
    (!first || (snap.collector?.status === 'ready' && snap.collector.managed && !state.firstImportConnecting));
  const running = !!snap.rangeImport?.running;
  // 자동 가져오기·첨부·답장이 도는 동안에도 막는다(머리줄에 지금 하는 일이 보인다).
  const busy = running || !!state.firstImportSaving || messengerBusy();
  $('range-preview').disabled = !available || busy;
  // 몇 건인지 보지 않아도 바로 불러올 수 있다. 세어 보았는데 새로 받을 쪽지가 없을 때만 막는다.
  $('range-import').disabled = !available || busy || (!!state.rangePreview && !state.rangePreview.fresh);
  $('range-from').disabled = $('range-to').disabled = !available || busy;
  $('range-stop').hidden = !running;
  $('range-stop').disabled = !!snap.rangeImport?.stopping;
  // 건수는 묶음(20건)이 끝나야 바뀌어 멈춘 것처럼 보였다. 하는 일만 알린다(2026-11-12 사용자).
  $('range-status').classList.toggle('busy', running || !!state.rangeCounting);
  if (running) {
    setMessage('range-status', snap.rangeImport.stopping ? '지금 여는 쪽지들을 마치고 멈춥니다…'
      : `${name}에서 쪽지를 하나씩 열어 불러오는 중입니다. 쪽지가 많으면 몇 분 걸립니다. 끝날 때까지 ${name} 창은 건드리지 마세요.`);
  } else if (!available && !first && !state.rangeMessage) {
    setMessage('range-status', snap.demo ? '샘플에서는 불러올 수 없습니다.' : `머리줄에서 ${name}를 먼저 연결해 주세요.`);
  }
  // 불러온 뒤 AI로 분류할지: 몇 건인지 센 뒤에 건수만 보인다. 비용은 알리지 않는다(2026-11-12 사용자).
  const fresh = state.rangePreview?.fresh || 0;
  $('range-auto-classify-field').hidden = snap.aiProvider === 'none' || running;
  $('range-auto-classify').disabled = busy;
  $('range-auto-classify-note').textContent = fresh ? `${fresh}건 · 지난 마감은 완료로 표시합니다` : '';
  const pending = snap.rangePending || 0;
  $('range-classify-row').hidden = !pending || running;
  $('range-classify').disabled = snap.aiProvider === 'none' || !!state.rangeBusy;
  $('range-classify-note').textContent = snap.aiProvider === 'none' ? `정리 전 ${pending}건 · AI를 연결하면 분류할 수 있습니다.`
    : `정리 전 ${pending}건`;
  renderFirstImport();
}

function rangeInput() {
  return [$('range-from').value, $('range-to').value];
}

async function rangeAction(run) {
  state.rangeBusy = true;
  renderBusy();
  try { await run(); }
  catch (error) { state.rangeMessage = true; setMessage('range-status', error.message, true); }
  finally { state.rangeBusy = false; renderBusy(); }
}

// 이 창에서만 아는 '하는 중'(누른 버튼)이 바뀔 때: 머리줄과 메신저를 쓰는 버튼을 모두 다시 그린다.
function renderBusy() {
  if (!state.snapshot) return;
  renderCollector();
  renderAutoRefresh();
  renderRange();
}

$('range-from').addEventListener('change', () => { state.rangePreview = null; renderRange(); });
$('range-to').addEventListener('change', () => { state.rangePreview = null; renderRange(); });
$('range-preview').addEventListener('click', () => void rangeAction(async () => {
  const { name } = state.messenger;
  state.rangeMessage = true;
  state.rangeCounting = true;
  setMessage('range-status', `${name} 쪽지 목록을 내려 가며 세고 있습니다(쪽지는 열지 않습니다).`);
  state.rangePreview = null;
  renderBusy();
  let preview;
  try { preview = await api.previewRange(...rangeInput()); }
  finally { state.rangeCounting = false; }
  state.rangePreview = preview;
  const already = preview.matched - preview.fresh;
  setMessage('range-status', `${name} 목록에서 살펴본 쪽지 ${preview.visible}건 가운데 이 기간 ${preview.matched}건${already ? `(이미 받은 ${already}건 빼면 ${preview.fresh}건)` : ''}을 불러올 수 있습니다.` +
    (preview.oldest ? ` 목록에서 가장 오래된 날은 ${preview.oldest}입니다.` : '') + (preview.unknown ? ` 날짜를 못 읽은 ${preview.unknown}건은 뺐습니다.` : ''));
}));
$('range-import').addEventListener('click', () => void rangeAction(async () => {
  const { name } = state.messenger;
  const count = state.rangePreview?.fresh || 0;
  // 확인은 시작 전에 한 번만 한다. AI 분류 여부는 버튼 위 체크 칸에 미리 보이고, 끝난 뒤에는 다시 묻지 않는다.
  const classify = state.snapshot.aiProvider !== 'none' && $('range-auto-classify').checked;
  const ai = classify ? '\n불러온 뒤 AI로 분류합니다.' : '';
  if (!window.confirm(`${count ? `쪽지 ${count}건을` : '이 기간 쪽지를'} ${name}에서 열어 불러옵니다. 안 읽은 쪽지는 읽음 처리됩니다. 불러오는 동안 ${name} 화면이 쪽지 목록으로 바뀝니다.${ai}\n계속할까요?`)) return;
  state.rangeMessage = true;
  const result = await api.importRange(...rangeInput());
  if (firstImportDialog.open && result.imported) state.firstImportImported = true;
  state.rangePreview = null;
  const detailWarning = result.unreadableNotes ? ` 목록에서 쪽지 ${result.unreadableNotes}건을 찾았지만 본문을 확인할 수 없어 가져오기를 멈췄습니다.` : '';
  const summary = `${result.imported}건을 불러왔습니다.${result.stopped ? ' 중간에 멈췄습니다.' : ''}${result.failed ? ` ${name} 목록을 읽지 못해 끝까지 불러오지 못했습니다.` : ''}${detailWarning}`;
  setMessage('range-status', summary, result.failed || !!detailWarning);
  if (result.pending && classify) {
    const queued = await api.classifyRange();
    setMessage('range-status', `${summary} ${queued}건을 분류하고 있습니다.`, result.failed || !!detailWarning);
  }
}));
$('range-stop').addEventListener('click', () => void api.stopRange().then(sync, () => {}));
$('range-classify').addEventListener('click', () => void rangeAction(async () => {
  // 건수는 버튼 옆에 이미 보인다. 누르면 바로 분류한다.
  const queued = await api.classifyRange();
  state.rangeMessage = true;
  setMessage('range-status', `${queued}건을 분류하고 있습니다.`);
}));

// 구글 캘린더에 보이기(한 방향). 연결·보내기는 main의 google-calendar.js가 하고 여기서는 상태만 그린다.
function renderGoogle() {
  const google = state.snapshot.google || {};
  const available = !!google.available && !state.demo;
  $('google-settings').hidden = !available;
  if (!available) return;
  const busy = !!google.busy || !!state.googleBusy;
  let text;
  if (google.connected) {
    const when = google.lastSync ? new Date(google.lastSync).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : null;
    text = (google.email ? google.email + '에 ' : '') + '연결됨 · 일정 ' + (google.counts?.events ?? 0) + '개' + (google.busy ? ' · 보내는 중…' : when ? ' · 마지막으로 보냄 ' + when : '');
  } else text = google.busy ? '브라우저에서 구글 계정을 고르고 허용해 주세요.' : '아직 연결하지 않았습니다.';
  $('google-state').textContent = google.error ? text + ' · ' + google.error : text;
  $('google-state').classList.toggle('error', !!google.error);
  $('google-connect').hidden = !!google.connected;
  $('google-connect').disabled = busy;
  $('google-sync').hidden = !google.connected;
  $('google-sync').disabled = busy;
  $('google-disconnect').hidden = !google.connected;
  $('google-disconnect').disabled = busy;
}
async function googleAction(run) {
  state.googleBusy = true;
  renderGoogle();
  try { await run(); }
  catch (error) { setMessage('google-status', error.message, true); }
  finally { state.googleBusy = false; renderGoogle(); }
}
$('google-connect').addEventListener('click', () => void googleAction(async () => {
  setMessage('google-status', '브라우저에서 구글 계정을 고르고 허용해 주세요.');
  sync(await api.connectGoogle());
  setMessage('google-status', '연결했습니다. 할 일과 확인할 것을 구글 캘린더로 보내고 있습니다.');
}));
$('google-sync').addEventListener('click', () => void googleAction(async () => {
  setMessage('google-status', '보내는 중…');
  sync(await api.syncGoogle());
  setMessage('google-status', '구글 캘린더에 맞춰 두었습니다.');
}));
$('google-disconnect').addEventListener('click', () => void googleAction(async () => {
  const remove = window.confirm('구글 캘린더의 “학교 할 일”·“학교 알림” 캘린더도 지울까요?\n\n확인: 캘린더까지 지우고 연결 끊기\n취소: 캘린더는 남겨 두고 연결만 끊기');
  sync(await api.disconnectGoogle(remove));
  setMessage('google-status', remove ? '연결을 끊고 구글의 학교 캘린더를 지웠습니다.' : '연결을 끊었습니다. 구글에 넣은 일정은 남아 있습니다.');
}));

function renderBackup() {
  const busy = !!state.backingUp;
  $('backup-settings').hidden = !!state.demo;
  $('backup-create').disabled = busy;
  $('backup-restore').disabled = busy;
  $('rules-update').hidden = !state.snapshot.rulesUpdate?.pending;
  $('shortcut-row').hidden = !state.snapshot.shortcutAvailable;
  $('login-start-row').hidden = !state.snapshot.loginStart?.available;
  if (!state.loginStartBusy) $('login-start').checked = state.snapshot.loginStart?.enabled === true;
  $('app-version').textContent = state.snapshot.appVersion ? `${state.messenger.appName} ${state.snapshot.appVersion}판` : '';
}

async function backupAction(run) {
  state.backingUp = true;
  renderBackup();
  try {
    await run();
  } catch (error) {
    setMessage('backup-status', error.message, true);
  } finally {
    state.backingUp = false;
    renderBackup();
  }
}

$('backup-create').addEventListener('click', () => void backupAction(async () => {
  setMessage('backup-status', '백업을 만들고 있습니다.');
  const result = await api.createBackup();
  setMessage('backup-status', result.saved ? `백업을 저장했습니다. 업무 ${result.tasks}건, 쪽지 ${result.notes}건 · ${result.file}` : '');
}));
$('backup-restore').addEventListener('click', () => void backupAction(async () => {
  if (state.dirty) throw new Error('자세히에서 저장하지 않은 변경을 먼저 저장해 주세요.');
  if (!window.confirm('지금 자료를 먼저 따로 저장한 뒤 백업 내용으로 바꿉니다. 그 뒤에 생긴 업무와 쪽지는 이 화면에서 사라집니다(따로 저장한 파일에는 남습니다). 계속할까요?')) return;
  setMessage('backup-status', '백업에서 되돌리고 있습니다.');
  const result = await api.restoreBackup();
  if (!result.restored) { setMessage('backup-status', ''); return; }
  if (state.selected || state.selectedChat) closeDetail();
  sync(result.snapshot);
  setMessage('backup-status', `되돌렸습니다. 되돌리기 전 자료는 ${result.safety}에 있습니다.${result.aiReset ? ' AI 연결이 꺼졌으니 위에서 다시 연결해 주세요.' : ''}`);
}));
async function resolveRules(choice) {
  try {
    sync(await api.resolveRules(choice));
    setMessage('settings-error', choice === 'replace' ? '새 정리 기준으로 바꿨습니다.' : '지금 정리 기준을 계속 씁니다.');
  } catch (error) {
    setMessage('settings-error', error.message, true);
  }
  renderBackup();
}
$('rules-replace').addEventListener('click', () => void resolveRules('replace'));
$('rules-keep').addEventListener('click', () => void resolveRules('keep'));

function renderDownloads() {
  const downloads = state.snapshot.downloads || {};
  const enabled = downloads.enabled === true;
  $('downloads-folder').textContent = !enabled ? '이 실행(샘플·시험 폴더)에서는 첨부를 따로 복사하지 않습니다.'
    : `${downloads.folder}${downloads.custom ? '' : ' (기본 다운로드 폴더)'}`;
  $('downloads-choose').disabled = !enabled || !!state.choosingDownloads;
  $('downloads-reset').hidden = !downloads.custom;
  $('downloads-reset').disabled = !!state.choosingDownloads;
  $('downloads-open').hidden = !enabled;
  if (downloads.warning) setMessage('downloads-status', downloads.warning, true);
}

async function changeDownloads(action, done) {
  state.choosingDownloads = true;
  renderDownloads();
  try {
    sync(await action());
    if (done) setMessage('downloads-status', done);
  } catch (error) {
    setMessage('downloads-status', error.message, true);
  } finally {
    state.choosingDownloads = false;
    renderDownloads();
  }
}
$('downloads-choose').addEventListener('click', () => {
  const before = state.snapshot.downloads?.folder;
  void changeDownloads(async () => {
    const next = await api.chooseDownloads();
    if (next.downloads?.folder !== before) setTimeout(() => setMessage('downloads-status', '저장했습니다. 다음에 받는 첨부부터 이 폴더에 복사합니다.'));
    return next;
  }, '');
});
$('downloads-reset').addEventListener('click', () => void changeDownloads(api.resetDownloads, '기본 다운로드 폴더로 되돌렸습니다. 이미 복사한 첨부는 원래 자리에 남습니다.'));

// 우리 학교(나이스): 설정에서 학교를 찾아 고른다. 고르면 학사일정은 main이 받아 snapshot.schoolEvents로 온다.
function renderSchool() {
  const school = state.snapshot.school;
  const choosing = !school || !!state.changingSchool;
  $('school-chosen').hidden = !school;
  $('school-search-form').hidden = !choosing;
  if (!choosing) $('school-results').hidden = true;
  $('school-change').hidden = choosing;
  if (!school) return;
  $('school-name').textContent = school.name;
  $('school-office').textContent = [school.officeName, school.level].filter(Boolean).join(' · ');
  const when = school.fetchedAt ? messageDate.format(new Date(school.fetchedAt)) : '';
  const status = state.schoolBusy ? '학사일정을 받는 중…'
    : school.error ? school.error
    : school.fetchedAt ? `학사일정 ${school.count}개 · ${when}에 받음`
    : '학사일정을 받는 중…';
  setMessage('school-state', status, !!school.error && !state.schoolBusy);
  $('school-refresh').disabled = !!state.schoolBusy;
}

function schoolResultRow(item) {
  const row = element('li', 'school-result');
  const text = element('span', 'school-result-text');
  text.append(element('strong', null, item.name), element('span', 'small-note', ` ${item.officeName} · ${item.address || item.level}`));
  const pick = button('button small', '이 학교로');
  pick.addEventListener('click', async () => {
    pick.disabled = true;
    try {
      state.changingSchool = false;
      sync(await api.setSchool(item));
      $('school-results').hidden = true;
      $('school-query').value = '';
      setMessage('school-message', '');
    } catch (error) {
      pick.disabled = false;
      setMessage('school-message', error.message, true);
    }
  });
  row.append(text, pick);
  return row;
}

$('school-search-form').addEventListener('submit', async event => {
  event.preventDefault();
  const query = $('school-query').value.trim();
  $('school-search').disabled = true;
  setMessage('school-message', '찾는 중…');
  try {
    const { schools, more } = await api.searchSchools(query);
    $('school-results').replaceChildren(...schools.map(schoolResultRow));
    $('school-results').hidden = !schools.length;
    setMessage('school-message', !schools.length ? '찾은 학교가 없습니다. 이름을 다르게 적어 보세요(예: 가곡초).'
      : more ? '앞의 몇 곳만 보입니다. 우리 학교가 없으면 이름을 더 길게 적어 주세요(예: 가곡초등학교).' : '');
  } catch (error) {
    setMessage('school-message', error.message, true);
  } finally {
    $('school-search').disabled = false;
  }
});
$('school-change').addEventListener('click', () => {
  state.changingSchool = true;
  renderSchool();
  $('school-query').focus();
});
$('school-clear').addEventListener('click', async () => {
  if (!window.confirm('우리 학교를 지울까요? 달력의 학사일정과 급식이 사라집니다.')) return;
  try {
    state.changingSchool = false;
    sync(await api.setSchool(null));
  } catch (error) {
    setMessage('school-message', error.message, true);
  }
});
$('school-refresh').addEventListener('click', async () => {
  state.schoolBusy = true;
  renderSchool();
  try {
    sync(await api.refreshSchool());
  } catch (error) {
    setMessage('school-state', error.message, true);
  } finally {
    state.schoolBusy = false;
    renderSchool();
  }
});

// 오늘 급식 칸: 누르면 메뉴를 한 줄에 하나씩 보이는 작은 창. 바깥을 누르거나 Esc면 닫힌다.
function setMealOpen(open) {
  $('today-meal').setAttribute('aria-expanded', String(open));
  $('meal-pop').hidden = !open;
}
$('today-meal').addEventListener('click', () => setMealOpen($('meal-pop').hidden));
document.addEventListener('click', event => { if (!$('meal-box').contains(event.target)) setMealOpen(false); });
document.addEventListener('keydown', event => { if (event.key === 'Escape' && !$('meal-pop').hidden) setMealOpen(false); });
$('show-meal').addEventListener('change', async event => {
  const enabled = event.target.checked;
  try {
    sync(await api.setShowMeal(enabled));
  } catch (error) {
    event.target.checked = !enabled;
    setMessage('school-message', error.message, true);
  }
});

// 오늘 급식: 달력 위 달 이름 옆 한 줄(2026-11-20 왼쪽 목록에서 옮김). 학교가 없거나 설정에서 껐거나
// 급식이 없는 날(주말·방학)은 숨긴다. 끄면 나이스에 묻지도 않는다.
async function loadMeal() {
  const school = state.snapshot.school;
  const enabled = !!school && state.snapshot.showMeal !== false;
  const today = key(new Date());
  const box = $('meal-box');
  const wanted = enabled ? `${school.office}-${school.code}-${today}` : '';
  if (state.mealKey === wanted) return;
  state.mealKey = wanted;
  if (!enabled) { box.hidden = true; setMealOpen(false); return; }
  try {
    const result = await api.meal(today);
    if (state.mealKey !== wanted) return;
    const meal = result?.meals?.find(item => item.kind === '중식') || result?.meals?.[0];
    box.hidden = !meal;
    if (!meal) return;
    $('today-meal').replaceChildren(element('span', 'meal-label', '오늘 급식'), ' ', element('span', 'meal-items', meal.items.join(' · ')));
    $('today-meal').title = '누르면 메뉴 전체';
    const list = element('ul', 'meal-list');
    list.append(...meal.items.map(item => element('li', null, item)));
    $('meal-pop').replaceChildren(element('p', 'meal-pop-title', `${meal.kind === '중식' ? '오늘 급식' : meal.kind} · ${shortDate(today)}`), list,
      ...(meal.kcal ? [element('p', 'meal-kcal', meal.kcal)] : []), element('p', 'meal-source', `${school.name} · 나이스`));
  } catch {
    // 못 받았으면 숨기고 10분 뒤 다음 새로 고침 때 다시 묻는다(30초마다 묻지 않게).
    box.hidden = true;
    setTimeout(() => { if (state.mealKey === wanted) state.mealKey = ''; }, 600_000);
  }
}
$('downloads-open').addEventListener('click', async () => {
  try { await api.openDownloads(); }
  catch (error) { setMessage('downloads-status', error.message, true); }
});

// 내 역할: 근무처(학교·교육청)에 따라 칸을 바꾼다. 역할 목록은 학교급마다 다르다(초등은 전담, 중·고는 비담임).
const PROFILE_ROLES = { 초등: ['담임', '전담', '그 밖'], 중학교: ['담임', '비담임', '그 밖'], 고등학교: ['담임', '비담임', '그 밖'] };
function fillProfileRoles(selected) {
  const roles = PROFILE_ROLES[$('profile-school-level').value] || PROFILE_ROLES.초등;
  const select = $('profile-role');
  select.replaceChildren(new Option('고르지 않음', ''), ...roles.map(role => new Option(role, role)));
  select.value = roles.includes(selected) ? selected : '';
}
function updateProfileFields() {
  const office = $('profile-workplace').value === '교육청';
  $('profile-school').hidden = office;
  $('profile-office').hidden = !office;
  const elementary = $('profile-school-level').value === '초등';
  $('profile-grade').max = elementary ? '6' : '3';
  // 초등은 전담일 때만, 중·고는 늘 가르치는 과목과 맡은 학년을 적는다.
  $('profile-specialist').hidden = elementary && $('profile-role').value !== '전담';
  $('profile-subjects-label').textContent = elementary ? '전담 과목' : '가르치는 과목';
  $('profile-subject-grades').placeholder = elementary ? '예: 3, 4' : '예: 1, 2';
  $('profile-school-note').textContent = '교감·교장·행정실은 역할에서 "그 밖"을 고르고 담당 업무에 적습니다.';
}
$('profile-workplace').addEventListener('change', updateProfileFields);
$('profile-school-level').addEventListener('change', () => { fillProfileRoles($('profile-role').value); updateProfileFields(); });
$('profile-role').addEventListener('change', updateProfileFields);
$('profile-save').addEventListener('click', async () => {
  $('profile-save').disabled = true;
  try {
    const office = $('profile-workplace').value === '교육청';
    const common = { workplace: office ? '교육청' : '학교', duties: $('profile-duties').value, memberships: $('profile-memberships').value };
    sync(await api.setProfile(office ? {
      ...common, officeType: $('profile-office-type').value || null, department: $('profile-department').value,
      position: $('profile-position').value || null,
      coveredLevels: [...document.querySelectorAll('[data-covered]:checked')].map(box => box.dataset.covered)
    } : {
      ...common, schoolLevel: $('profile-school-level').value,
      grade: $('profile-grade').value, classroom: $('profile-classroom').value, role: $('profile-role').value || null,
      subjects: $('profile-subjects').value, subjectGrades: $('profile-subject-grades').value
    }));
    $('profile-status').textContent = '저장했습니다. 다음 정리부터 씁니다.';
  } catch (error) {
    $('profile-status').textContent = error.message;
  } finally {
    $('profile-save').disabled = false;
  }
});

// 종류의 화면 이름. 달력 범례(□ 마감 · ● 일정 · ━ 기간)와 같게 쓴다.
const KIND_NAMES = { 까지: '마감', 그날: '일정', 기간: '기간' };

// 업무 추가 창: 날짜 고치기와 같은 칸(날짜·종류·끝 날짜·시간·교시)을 쓴다.
function showCreate(date) {
  $('create-form').reset();
  drawPriority($('create-important'), 0);
  $('create-due').value = date;
  $('create-kind').value = '까지';
  $('create-extra-dates').replaceChildren();
  updateCreateEnd();
  updateCreateOptions();
  setMessage('create-error', '');
  $('create-dialog').showModal();
}

// 업무 추가 창의 더 넣는 날짜 한 줄: 날짜 | 마감·일정 | 이름(비우면 제목) | 지우기.
function createExtraRow() {
  const row = element('li', 'create-extra');
  const date = element('input');
  date.type = 'date';
  date.required = true;
  date.min = '0001-01-01';
  date.max = '9999-12-31';
  date.value = $('create-due').value;
  date.setAttribute('aria-label', '더 넣는 날짜');
  const kind = element('select');
  for (const [value, name] of [['까지', '마감'], ['그날', '일정']]) {
    const option = element('option', null, name);
    option.value = value;
    kind.append(option);
  }
  kind.setAttribute('aria-label', '날짜 지정');
  const label = element('input');
  label.maxLength = taskModel.LABEL_MAX;
  label.autocomplete = 'off';
  label.placeholder = '달력에 표시할 이름 (비우면 제목)';
  label.setAttribute('aria-label', '달력에 표시할 이름');
  const remove = button('button text-button small', '지우기');
  remove.addEventListener('click', () => { row.remove(); updateCreateOptions(); $('create-add-date').focus(); });
  row.append(date, kind, label, remove);
  return row;
}
function createExtraDates() {
  return [...$('create-extra-dates').children].map(row => {
    const [date, kind, label] = row.querySelectorAll('input, select');
    return { date: date.value, kind: kind.value, label: label.value.trim() };
  });
}
// 날짜는 모두 합쳐 셋까지. 상시는 할 일만.
// 반복은 날짜 하나인 할 일(마감·일정)에만: 날짜를 더하거나 기간·확인할 것이면 반복 칸을 숨긴다.
// 반복을 고르면 날짜 더하기·상시는 숨긴다(회차마다 따로 걸 수 있음).
function updateCreateOptions() {
  const reference = document.querySelector('input[name="create-type"]:checked')?.value === '알아 둘 것';
  const extra = $('create-extra-dates').children.length;
  const kind = $('create-kind');
  const option = $('create-loose-option');
  option.hidden = option.disabled = reference || extra > 0;
  if (kind.value === '기한 없음' && option.disabled) kind.value = '그날';
  const loose = kind.value === '기한 없음';
  for (const input of [$('create-due'), $('create-time')]) {
    input.disabled = loose;
    input.closest('label').hidden = loose;
  }
  const repeatable = !reference && !extra && !loose && kind.value !== '기간';
  $('create-repeat-field').hidden = !repeatable;
  if (!repeatable) $('create-repeat').value = 'none';
  const repeating = $('create-repeat').value !== 'none';
  $('create-add-date').hidden = loose || repeating || extra >= taskModel.MAX_DATES - 1;
  $('create-pinned-field').hidden = reference || repeating;
  if (reference || repeating) $('create-pinned').checked = false;
  updateRepeatHint();
}
// "매주 목 · 2/28까지 · 15회", 학사일정이 있으면 "학교 쉬는 날 3회 빼기".
function updateRepeatHint() {
  const every = $('create-repeat').value;
  const due = $('create-due').value;
  const show = every !== 'none' && taskModel.validDate(due);
  $('create-repeat-hint').hidden = !show;
  if (!show) return;
  const until = taskModel.semesterEnd(due);
  const dates = taskModel.repeatDates(every, due, until);
  const off = new Set((state.snapshot.schoolEvents || []).filter(event => event.off).map(event => event.date));
  // 직접 고른 첫 회차는 저장할 때도 쉬는 날에서 제외한다.
  const offCount = dates.filter(date => date !== due && off.has(date)).length;
  const skipping = offCount > 0 && $('create-skip-off').checked;
  const count = dates.length - (skipping ? offCount : 0);
  $('create-repeat-summary').textContent = `↻ ${taskModel.repeatLabel(every, due)} · ${shortDate(until)}까지 · ${count}회${dates.length >= taskModel.REPEAT_MAX ? ' (최대)' : ''}`;
  $('create-skip-off-field').hidden = !offCount;
  $('create-skip-off-label').textContent = `학교 쉬는 날 ${offCount}회 빼기`;
}
$('create-repeat').addEventListener('input', updateCreateOptions);
$('create-skip-off').addEventListener('change', updateRepeatHint);
$('create-due').addEventListener('input', updateRepeatHint);
$('create-kind').addEventListener('input', updateCreateOptions);
$('create-add-date').addEventListener('click', () => {
  const row = createExtraRow();
  $('create-extra-dates').append(row);
  updateCreateOptions();
  row.querySelector('input').focus();
});
document.querySelectorAll('input[name="create-type"]').forEach(input => input.addEventListener('change', updateCreateOptions));
function updateCreateEnd() {
  const span = $('create-kind').value === '기간';
  $('create-end-field').hidden = !span;
  $('create-end').disabled = !span;
  $('create-end').min = $('create-due').value ? nextDay($('create-due').value) : '';
  if (span && (!$('create-end').value || $('create-end').value <= $('create-due').value)) $('create-end').value = $('create-end').min;
}
$('create-kind').addEventListener('input', updateCreateEnd);
$('create-due').addEventListener('input', updateCreateEnd);

async function saveDetail(type = state.editType) {
  const id = state.selected;
  if (!id || state.saving) return;
  const previousType = state.detail?.task.type;
  state.editType = type;
  if (type !== '없음' && !$('edit-form').reportValidity()) return;
  state.saving = true;
  enableForm();
  const dates = type === '없음' ? undefined : editingDates().map(({ date, end, label, kind, done, time, received }) => ({ date, label, kind, ...(time && { time }), ...(kind === '까지' && { done: done === true }), ...(kind === '그날' && done === true && { done: true }), ...(kind === '그날' && received === true && { received: true }), ...(kind === '기간' && { end }) }));
  const input = { title: $('edit-title').value, type, dates, memo: $('edit-memo').value, revision: state.revision };
  // 반복 회차의 제목·날짜를 바꾸면 뒤 회차도 같이 바꿀지 묻는다(뒤에 함께 바뀔 회차가 있을 때만).
  const saved = state.detail?.task;
  const repeatWanted = state.repeatFor === id ? state.editRepeat : (saved?.repeat?.every ?? 'none');
  if (saved?.repeat && dates?.length === 1 && repeatWanted === saved.repeat.every) {
    const before = saved.dates[0];
    const after = dates[0];
    const changed = input.title !== saved.title || before.date !== after.date || before.kind !== after.kind ||
      (before.time || '') !== (after.time || '') || before.label !== after.label;
    const followers = repeatFollowers(saved).length;
    if (changed && followers && window.confirm(`뒤 회차 ${followers}개도 같이 바꿀까요?\n\n확인: 이 회차와 뒤 회차 모두\n취소: 이 회차만`)) input.repeatScope = 'following';
  }
  try {
    await api.update(id, input);
    // 반복 고르기를 바꿨으면 이 회차부터 새로 건다(안 함이면 뒤 회차를 지우고 반복에서 뺀다).
    if (type === '할 일' && dates?.length === 1 && dates[0].kind !== '기간' && repeatWanted !== (saved?.repeat?.every ?? 'none')) {
      await api.setRepeat(id, repeatWanted);
    }
    state.repeatFor = null;
    if (id !== state.selected) return;
    state.dirty = false;
    const first = dates?.[0]?.date;
    if (first && !dates.some(entry => entry.date.slice(0, 7) === key(monthOf(state.month)).slice(0, 7))) {
      state.month = fromKey(first);
      state.dayKey = first;
      redraw();
    }
    await refreshDetail(true);
    if (id !== state.selected) return;
    const message = type === previousType ? '변경을 저장했습니다.'
      : type === '할 일' ? '할 일로 옮겼습니다.' : `‘${type === '없음' ? '숨긴 것' : typeLabels[type]}’으로 옮겼습니다.`;
    flash('detail-message', message);
  } catch (error) {
    if (id === state.selected) setMessage('detail-message', error.message, true);
  } finally {
    if (id === state.selected) {
      state.saving = false;
      enableForm();
    }
  }
}

async function refine() {
  const id = state.selected;
  if (!id) return;
  $('refine').disabled = true;
  setMessage('detail-message', '');
  try {
    const result = await api.refine(id);
    if (id !== state.selected) return;
    if (result.status === 'done') {
      const first = result.task.type !== '없음' && result.task.dates?.[0]?.date;
      if (first) {
        state.month = fromKey(first);
        state.dayKey = first;
        redraw();
      }
      flash('detail-message', '쪽지 정리를 완료했습니다.');
    } else if (result.status === 'failed') setMessage('detail-message', result.message, true);
    else if (result.status === 'edited') flash('detail-message', '편집한 내용이 있어 AI 결과를 적용하지 않았습니다.');
  } catch (error) {
    if (id === state.selected) setMessage('detail-message', error.message, true);
  } finally {
    if (id === state.selected) await refreshDetail();
  }
}

function stepMonth(step) {
  const date = monthOf(state.month);
  date.setMonth(date.getMonth() + step);
  if (date.getFullYear() < 1 || date.getFullYear() > 9999) return;
  state.month = date;
  renderMonth();
}

$('previous').addEventListener('click', () => stepMonth(-1));
$('next').addEventListener('click', () => stepMonth(1));
$('today').addEventListener('click', () => { state.month = new Date(); state.dayKey = key(state.month); renderMonth(); });
$('add-today').addEventListener('click', () => showCreate(key(new Date())));
$('detail-close').addEventListener('click', closeDetail);
const detailMore = $('detail-more');
detailMore.addEventListener('click', event => {
  if (event.target.closest('button')) detailMore.open = false;
});
document.addEventListener('click', event => {
  if (detailMore.open && !detailMore.contains(event.target)) detailMore.open = false;
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && detailMore.open) {
    detailMore.open = false;
    detailMore.querySelector('summary').focus();
    return;
  }
  if (event.key === 'Escape' && $('detail-panel').classList.contains('open') && !document.querySelector('dialog[open]')) closeDetail();
});
$('create-cancel').addEventListener('click', () => $('create-dialog').close());
$('create-form').addEventListener('submit', async event => {
  event.preventDefault();
  $('create-save').disabled = true;
  try {
    const kind = $('create-kind').value;
    const task = await api.create({
      title: $('create-title').value, due: $('create-due').disabled ? undefined : $('create-due').value, memo: $('create-memo').value,
      kind, end: kind === '기간' ? $('create-end').value : undefined, time: $('create-time').disabled ? undefined : $('create-time').value,
      extraDates: createExtraDates(), type: document.querySelector('input[name="create-type"]:checked')?.value,
      importance: Number($('create-important').dataset.level), pinned: $('create-pinned').checked,
      repeat: $('create-repeat-field').hidden ? 'none' : $('create-repeat').value,
      skipSchoolOff: !$('create-skip-off-field').hidden && $('create-skip-off').checked
    });
    $('create-dialog').close();
    state.month = fromKey(task.dates[0].date);
    state.dayKey = task.dates[0].date;
    renderMonth();
    selectTask(task.id, `calendar-${task.id}-0`);
  } catch (error) {
    setMessage('create-error', error.message, true);
  } finally {
    $('create-save').disabled = false;
  }
});
$('settings-open').addEventListener('click', () => openSettings());
$('settings-close').addEventListener('click', () => $('settings-dialog').close());
$('day-close').addEventListener('click', () => $('day-dialog').close());
$('settings-dialog').addEventListener('close', () => { $('ai-key').value = ''; });
// 설정·바뀐 점·업무 추가 창은 창 바깥(어두운 곳)을 누르면 닫힌다. 창 안에서 끌다가 밖에서 놓은 것은 닫지 않는다.
for (const id of ['settings-dialog', 'changes-dialog', 'create-dialog', 'day-dialog']) {
  const dialog = $(id);
  let downOutside = false;
  const outside = event => {
    const box = dialog.getBoundingClientRect();
    return event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom;
  };
  dialog.addEventListener('pointerdown', event => { downOutside = event.target === dialog && outside(event); });
  dialog.addEventListener('click', event => {
    if (downOutside && event.target === dialog && outside(event)) dialog.close();
    downOutside = false;
  });
}
$('ai-provider').addEventListener('change', () => { $('ai-key').value = ''; renderAiSettings(); });
$('ai-connect').addEventListener('click', async () => {
  const provider = $('ai-provider').value;
  state.testingAi = true;
  $('automatic').disabled = true;
  renderAiSettings();
  setMessage('ai-status', provider === 'none' ? '' : '가짜 쪽지로 연결을 시험하고 있습니다.');
  try {
    if (provider === 'claude' && !(await prepareClaude())) return;
    if (provider === 'codex' && !(await prepareCodex())) return;
    try {
      sync(await api.connectAi(provider, $('ai-key').value));
    } catch (error) {
      // Claude: 로그인이 안 되어 있으면 로그인 창을 띄우고, 창을 닫으면 한 번 더 시험한다.
      if (provider !== 'claude' || !String(error.message).startsWith('Claude Code에 로그인')) throw error;
      setMessage('ai-status', '로그인 창을 열었습니다. 브라우저가 열리면 Claude 구독 계정으로 로그인하고 승인을 누르세요. 끝나면 창이 저절로 닫히고 바로 다시 시험합니다.');
      const login = await api.claudeLogin();
      if (!login?.loggedIn) throw new Error('Claude 로그인이 확인되지 않았습니다. 로그인을 마친 뒤 ‘연결 시험 및 저장’을 다시 눌러 주세요.');
      setMessage('ai-status', '로그인을 확인하고 있습니다.');
      sync(await api.connectAi(provider, ''));
    }
    $('ai-key').value = '';
    state.aiCheckFailed = null;
    renderAiConnected();
    const backlog = state.snapshot.backlogPending || 0;
    setMessage('ai-status', provider === 'none' ? 'AI 연결을 껐습니다.'
      : `${aiNames[provider]} 연결 시험을 통과했습니다. 앞으로 오는 쪽지는 자동으로 정리합니다.${backlog ? ` 이미 가져온 쪽지 ${backlog}건은 목록 위 ‘AI로 정리’를 누르면 정리합니다.` : state.snapshot.collectorConnected ? '' : ` 이제 설정을 닫고 위쪽 ‘${state.messenger.name} 연결’을 누르세요.`}`);
  } catch (error) {
    // 이미 연결된 방식을 다시 시험하다 실패하면 맨 위 상태 줄도 실패로 바꾼다.
    if (provider !== 'none' && provider === state.snapshot.aiProvider) state.aiCheckFailed = provider;
    renderAiConnected();
    setMessage('ai-status', error.message, true);
  } finally {
    state.testingAi = false;
    $('automatic').disabled = state.snapshot.aiProvider === 'none';
    renderAiSettings();
  }
});
async function openAiGuide(page) {
  try { await api.openAiGuide(page); }
  catch (error) { setMessage('ai-status', error.message, true); }
}
// Claude Code(Claude 구독): Codex와 같은 순서. 없으면 묻고 설치하고, 로그인이 안 됐으면 로그인만 하는 창을 연다.
// 설치를 취소하면 false, 로그인을 마치지 못하면 오류.
async function prepareClaude() {
  setMessage('ai-status', 'Claude Code가 설치·로그인돼 있는지 확인하고 있습니다.');
  let { executable, loggedIn } = await api.claudeStatus();
  if (!executable) {
    setMessage('ai-status', 'Claude Code가 없습니다. 설치할지 묻는 창을 확인해 주세요.');
    const timer = setTimeout(() => setMessage('ai-status', 'Claude Code를 설치하고 있습니다. 1~2분 걸립니다. 창을 닫지 마세요.'), 1500);
    try {
      const result = await api.claudeInstall();
      if (result?.cancelled) { setMessage('ai-status', '설치를 취소했습니다. 직접 설치하려면 ‘막히면 안내서’를 보세요.'); return false; }
      loggedIn = false;
    } finally {
      clearTimeout(timer);
    }
  }
  if (!loggedIn) {
    setMessage('ai-status', '로그인 창을 열었습니다. 브라우저가 열리면 Claude 구독 계정으로 로그인하고 승인을 누르세요. 끝나면 창이 저절로 닫히고 바로 다시 시험합니다.');
    const login = await api.claudeLogin();
    if (!login?.loggedIn) {
      throw new Error(login?.closed ? 'Claude 로그인이 확인되지 않았습니다. 로그인을 마친 뒤 ‘연결 시험 및 저장’을 다시 눌러 주세요.'
        : '로그인 창이 닫히지 않았습니다. 로그인을 마친 뒤 ‘연결 시험 및 저장’을 다시 눌러 주세요.');
    }
  }
  setMessage('ai-status', '가짜 쪽지로 연결을 시험하고 있습니다.');
  return true;
}
// Codex(ChatGPT 구독): 없으면 묻고 설치하고, 로그인이 안 됐으면 로그인 창을 연다. 구독은 있다고 보고 진행한다.
// 설치를 취소하거나 로그인을 마치지 못하면 false/오류.
async function prepareCodex() {
  setMessage('ai-status', 'Codex가 설치·로그인돼 있는지 확인하고 있습니다.');
  let { executable, loggedIn } = await api.codexStatus();
  if (!executable) {
    setMessage('ai-status', 'Codex가 없습니다. 설치할지 묻는 창을 확인해 주세요.');
    const timer = setTimeout(() => setMessage('ai-status', 'Codex를 설치하고 있습니다. 1~2분 걸립니다. 창을 닫지 마세요.'), 1500);
    try {
      const result = await api.codexInstall();
      if (result?.cancelled) { setMessage('ai-status', '설치를 취소했습니다. 직접 설치하려면 ‘막히면 안내서’를 보세요.'); return false; }
      executable = result?.executable;
      loggedIn = false;
    } finally {
      clearTimeout(timer);
    }
  }
  if (!loggedIn) {
    setMessage('ai-status', '로그인 창을 열었습니다. 브라우저가 열리면 ChatGPT 계정으로 로그인하고 허용을 누르세요. 끝나면 창이 저절로 닫히고 바로 다시 시험합니다.');
    const login = await api.codexLogin();
    if (!login?.loggedIn) {
      throw new Error(login?.closed ? 'ChatGPT 로그인이 확인되지 않았습니다. 로그인을 마친 뒤 ‘연결 시험 및 저장’을 다시 눌러 주세요.'
        : '로그인 창이 닫히지 않았습니다. 로그인을 마친 뒤 ‘연결 시험 및 저장’을 다시 눌러 주세요.');
    }
  }
  setMessage('ai-status', '가짜 쪽지로 연결을 시험하고 있습니다.');
  return true;
}
document.querySelectorAll('[data-ai-guide]').forEach(button => button.addEventListener('click', () => void openAiGuide(button.dataset.aiGuide)));
$('ai-guide-open').addEventListener('click', () => void openAiGuide($('ai-guide-open').dataset.page));
$('ai-help').addEventListener('click', () => void openAiGuide($('ai-help').dataset.page));
async function changeCollector(action) {
  if (messengerBusy()) return;
  state.connectingCollector = true;
  renderBusy();
  let failure;
  try { sync(await action()); }
  catch (error) { failure = error.message; }
  finally {
    state.connectingCollector = false;
    renderBusy();
    if (failure) $('collector-status').textContent = failure;
  }
}
$('collector-connect').addEventListener('click', () => void collectNow());
$('ai-setup-open').addEventListener('click', () => openSettings('ai'));
$('collector-ai').addEventListener('click', () => openSettings('ai'));
$('start-guide').addEventListener('click', async () => {
  try { await api.openAiGuide('start'); }
  catch (error) { $('collector-status').textContent = error.message; }
});
$('backlog-classify').addEventListener('click', async () => {
  state.backlogBusy = true;
  $('backlog-classify').disabled = true;
  try {
    const queued = await api.classifyBacklog();
    notice(queued ? `쪽지 ${queued}건을 AI로 정리하고 있습니다. 하나씩 끝나는 대로 목록과 달력에 들어갑니다.` : '정리할 쪽지가 없습니다.');
  } catch (error) {
    notice(error.message);
  } finally {
    state.backlogBusy = false;
    $('backlog-classify').disabled = false;
  }
});
$('automatic').addEventListener('change', async event => {
  const checkbox = event.currentTarget;
  state.savingAutomatic = true;
  checkbox.disabled = true;
  setMessage('settings-error', '');
  try {
    sync(await api.setAutomatic(checkbox.checked));
  } catch (error) {
    checkbox.checked = state.snapshot.automatic;
    setMessage('settings-error', error.message, true);
  } finally {
    state.savingAutomatic = false;
    checkbox.disabled = !!state.demo || state.snapshot.aiProvider === 'none' || !!state.testingAi;
  }
});
$('show-external-ai-work').addEventListener('change', async event => {
  const checkbox = event.currentTarget;
  checkbox.disabled = true;
  setMessage('settings-error', '');
  try {
    sync(await api.setShowExternalAiWork(checkbox.checked));
  } catch (error) {
    checkbox.checked = state.snapshot.showExternalAiWork !== false;
    setMessage('settings-error', error.message, true);
  } finally {
    checkbox.disabled = false;
  }
});
$('rules').addEventListener('click', async () => {
  try { await api.openRules(); }
  catch (error) { setMessage('settings-error', error.message, true); }
});
$('refresh').addEventListener('click', async () => {
  $('refresh').disabled = true;
  setMessage('refresh-status', '읽는 중…');
  try {
    const snapshot = await api.refresh();
    sync(snapshot);
    const message = snapshot.chatRefreshFailed ? '쪽지를 다시 읽었습니다. 저장된 대화는 읽지 못했습니다.' : '저장된 자료를 다시 읽었습니다.';
    setMessage('refresh-status', message, !!snapshot.chatRefreshFailed);
  } catch (error) {
    setMessage('refresh-status', error.message, true);
  } finally {
    $('refresh').disabled = false;
  }
});
$('edit-form').addEventListener('input', event => {
  if (event.target.dataset?.instant) return;
  markDirty();
});
$('edit-form').addEventListener('submit', event => {
  event.preventDefault();
  if (isCandidate(state.detail?.task)) $('candidate-accept').click();
  else void saveDetail();
});
function changeDetailType(type) {
  if (!state.detail || state.saving || type === state.editType) return;
  if (isCandidate(state.detail.task)) {
    // 후보는 유형만 바꿔 두고 '올리기'로 한 번에 올린다.
    state.editType = type;
    markDirty();
    return;
  }
  state.dirty = true;
  void saveDetail(type).finally(() => { $('detail-type').value = state.editType; });
}
$('detail-type').addEventListener('change', event => changeDetailType(event.target.value));
$('to-greeting').addEventListener('click', () => changeDetailType('없음'));
$('candidate-accept').addEventListener('click', async () => {
  const id = state.selected;
  const source = state.forwardedDraft;
  const task = state.detail?.task;
  if (!isCandidate(task) || state.saving || !$('edit-form').reportValidity()) return;
  state.saving = true;
  enableForm();
  const type = state.editType;
  const dates = editingDates().map(({ date, end, label, kind, time }) => ({ date, label, kind, ...(time && { time }), ...(kind === '까지' && { done: false }), ...(kind === '기간' && { end }) }));
  const input = { type, title: $('edit-title').value, dates, memo: $('edit-memo').value, revision: state.revision };
  const current = () => source ? state.forwardedDraft === source : id === state.selected;
  try {
    const saved = source ? await api.acceptForwardedLine(source.batchId, source.messageIndex, source.lineIndex, input)
      : await api.acceptCandidate(id, input);
    if (!current()) return;
    state.dirty = false;
    const savedId = source ? saved.id : id;
    if (source) openDetail(savedId, null, lastFocus);
    await refreshDetail(true);
    if (savedId === state.selected) flash('detail-message', type === '할 일' ? '할 일로 올렸습니다.' : '확인할 것으로 올렸습니다.');
  } catch (error) {
    if (current()) setMessage('detail-message', error.message, true);
  } finally {
    if (current()) {
      state.saving = false;
      enableForm();
    }
  }
});
$('candidate-discard').addEventListener('click', async () => {
  const task = state.detail?.task;
  if (!isCandidate(task) || state.saving) return;
  state.dirty = false;
  await discardCandidates({ id: task.id });
  if (task.id === state.selected) await refreshDetail(true);
});
$('candidate-restore').addEventListener('click', async () => {
  const task = state.detail?.task;
  if (!task?.candidate?.discarded || state.saving) return;
  try {
    await api.restoreCandidate(task.id);
    if (task.id === state.selected) {
      await refreshDetail(true);
      flash('detail-message', '분류할 것으로 되돌렸습니다.');
    }
  } catch (error) {
    if (task.id === state.selected) setMessage('detail-message', error.message, true);
  }
});
$('create-important').addEventListener('click', event => {
  const star = event.target.closest('button[data-stars]');
  if (star) drawPriority(event.currentTarget, nextPriority(event.currentTarget, star));
});
$('important').addEventListener('click', async event => {
  const star = event.target.closest('button[data-stars]');
  const task = state.detail?.task;
  if (!star || !task || state.dirty || state.saving || pendingPriority === task.id) return;
  const level = nextPriority(event.currentTarget, star);
  pendingPriority = task.id;
  drawPriority(event.currentTarget, level, true);
  try {
    const updated = await api.setImportant(task.id, level);
    if (state.detail?.task.id === task.id && state.detail.task.revision <= updated.revision) state.detail.task = updated;
  } catch (error) {
    if (task.id === state.selected) setMessage('detail-message', error.message, true);
  } finally {
    if (pendingPriority === task.id) pendingPriority = null;
    enableForm();
  }
});
$('pin').addEventListener('click', async () => {
  const task = state.detail?.task;
  if (!task || state.dirty || state.saving) return;
  $('pin').disabled = true;
  try {
    await api.setPinned(task.id, !task.pinned);
    if (task.id === state.selected) flash('detail-message', task.pinned ? '상시에서 내렸습니다. 날짜 묶음에 다시 보입니다.' : '목록 맨 위 상시 묶음에 띄웠습니다.');
  } catch (error) {
    if (task.id === state.selected) setMessage('detail-message', error.message, true);
  } finally {
    enableForm();
  }
});
// 업무 지우기: 직접 추가한 업무만. 되돌릴 수 없어 한 번 묻는다.
$('remove-task').addEventListener('click', async () => {
  const task = state.detail?.task;
  if (!task || state.saving || task.noteId || task.chatSource) return;
  if (!window.confirm(`‘${task.title}’ 업무를 지울까요? 되돌릴 수 없습니다.`)) return;
  $('remove-task').disabled = true;
  try {
    const next = await api.remove(task.id);
    state.dirty = false;
    closeDetail();
    sync(next);
    notice('업무를 지웠습니다.');
  } catch (error) {
    if (task.id === state.selected) setMessage('detail-message', error.message, true);
    $('remove-task').disabled = false;
  }
});

// 마감 알림 설정: 켜고 끄기와 시험 알림.
$('deadline-alerts').addEventListener('change', async event => {
  const enabled = event.target.checked;
  try {
    sync(await api.setDeadlineAlerts(enabled));
    setMessage('deadline-alert-status', enabled ? '켰습니다.' : '껐습니다.');
  } catch (error) {
    event.target.checked = !enabled;
    setMessage('deadline-alert-status', error.message, true);
  }
});
$('deadline-alert-test').addEventListener('click', async () => {
  try {
    await api.testDeadlineAlert();
    setMessage('deadline-alert-status', 'Windows 알림을 보냈습니다. 화면 오른쪽 아래를 확인해 주세요.');
  } catch (error) {
    setMessage('deadline-alert-status', error.message, true);
  }
});

$('add-date').addEventListener('click', () => {
  const dates = editingDates();
  if (dates.length >= taskModel.MAX_DATES) return;
  const last = dates.at(-1)?.date || key(new Date());
  dates.push({ date: last, label: $('edit-title').value.slice(0, taskModel.LABEL_MAX), kind: '까지', done: false });
  markDirty();
  renderDateRows();
  $('date-rows').querySelector('li:last-child input')?.focus();
});
// 날짜 고치기: 누르면 편집 칸이 열리고, 다시 누르면(고치기 취소) 고친 것을 버리고 닫는다. 날짜가 없으면 한 줄을 바로 넣는다.
$('edit-dates').addEventListener('click', () => {
  const task = state.detail?.task;
  if (!task || state.saving) return;
  if (state.editingDates) {
    state.editingDates = false;
    state.editDates = (task.dates || []).map(entry => ({ ...entry }));
    state.rowsDrawn = false;
    state.repeatFor = null;
    refreshDraftState(task);
    return;
  }
  state.editingDates = true;
  if (!editingDates().length) {
    state.editDates = [{ date: key(new Date()), label: $('edit-title').value.slice(0, taskModel.LABEL_MAX), kind: '까지', done: false }];
    markDirty();
  }
  renderDateRows();
  $('date-rows').querySelector('input')?.focus();
});

// 왼쪽 목록 탭: 한 번에 하나만 보이고, 탭의 건수는 늘 보인다. 고른 탭은 이 PC에 기억한다.
function showView(view) {
  const tabs = [...document.querySelectorAll('.list-tabs [role="tab"]')];
  const current = tabs.some(tab => tab.dataset.view === view) ? view : 'todo';
  for (const tab of tabs) {
    const on = tab.dataset.view === current;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
  }
  for (const panel of document.querySelectorAll('.list-view')) panel.hidden = panel.dataset.view !== current;
  try { localStorage.setItem('calendar-list-view', current); } catch {}
}
document.querySelectorAll('.list-tabs [role="tab"]').forEach((tab, index, tabs) => {
  tab.addEventListener('click', () => showView(tab.dataset.view));
  tab.addEventListener('keydown', event => {
    const move = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -1, ArrowDown: 1 }[event.key];
    if (!move) return;
    event.preventDefault();
    const next = tabs[(index + move + tabs.length) % tabs.length];
    showView(next.dataset.view);
    next.focus();
  });
});
// 업무·쪽지 검색(2026-11-18 사용자 "대화방 검색보다 중요한게 쪽지 검색"): 탭과 상관없이 전체에서 찾고,
// 결과마다 지금 어느 목록에 있는지(할 일·끝낸 것·숨김 등)와 받은 날을 붙인다. 찾기는 앱 안쪽(store.search)에서 한다.
const SEARCH_VIEWS = { todo: '할 일', candidate: '분류할 것', reference: '확인할 것', done: '처리한 것', past: '지난 일정', hidden: '숨긴 것' };
const search = { query: '', result: null, timer: null, token: 0 };

// 찾은 말에 형광펜(mark). 찾기는 띄어쓰기·대소문자를 무시하므로(store.searchFold) 글자 사이 공백을 허용해 맞춘다.
function searchPattern(query) {
  const chars = [...query.replace(/\s+/gu, '')].map(char => char.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'));
  return chars.length ? new RegExp(chars.join('\\s*'), 'giu') : null;
}

function appendMarked(node, text, pattern) {
  let last = 0;
  if (pattern) {
    pattern.lastIndex = 0;
    for (const found of text.matchAll(pattern)) {
      if (!found[0]) continue;
      node.append(text.slice(last, found.index), element('mark', '', found[0]));
      last = found.index + found[0].length;
    }
  }
  node.append(text.slice(last));
  return node;
}

// 2026-11-19 사용자 “검색했을 때 나오는 정보도 깔끔한지”: 1줄 제목만(좁은 칸에서 제목이 가장 잘리던 문제),
// 2줄 목록·받은 날·보낸 사람, 3줄은 본문·첨부·쪽지 제목에서 찾았을 때만 찾은 말이 앞쪽에 오게 두 줄까지.
function searchRow(hit, today, pattern) {
  const task = state.snapshot.tasks.find(item => item.id === hit.id);
  const row = element('li', 'row search-row');
  row.classList.toggle('selected', hit.id === state.selected);
  const pick = button('pick search-pick');
  pick.dataset.focusKey = `search-${hit.id}`;
  pick.setAttribute('aria-pressed', String(hit.id === state.selected));
  pick.title = [hit.title, hit.noteTitle && hit.noteTitle !== hit.title ? `쪽지 제목: ${hit.noteTitle}` : ''].filter(Boolean).join('\n');
  const head = element('span', 'search-head');
  const title = element('span', 'row-title');
  title.append(appendMarked(element('span', 'row-text'), displayTitle(hit.title), pattern));
  head.append(title);
  const meta = element('span', 'search-meta');
  const view = state.taskViews.get(hit.id);
  const day = receivedDay(hit.datetime || '');
  const parts = [
    view ? element('span', `search-state state-${view}`, SEARCH_VIEWS[view]) : null,
    day ? (day === today ? '오늘' : monthDay(day)) : '',
    hit.sender || '',
  ].filter(Boolean);
  parts.forEach((part, index) => meta.append(...(index ? [' · ', part] : [part])));
  const match = element('span', 'search-match');
  if (hit.field === 'body') appendMarked(match, hit.snippet || '', pattern);
  else if (hit.field === 'attachment') appendMarked(match, `첨부 ${hit.attachment}`, pattern);
  else if (hit.field === 'noteTitle') appendMarked(match, `쪽지 제목 ${hit.noteTitle}`, pattern);
  pick.append(head, meta, match);
  pick.addEventListener('click', () => {
    if (selectTask(hit.id, pick.dataset.focusKey) !== false && task) showTaskMonth(task);
  });
  row.append(pick);
  return row;
}

function renderSearch() {
  const on = !!search.query;
  $('calendar-list-pane').classList.toggle('searching', on);
  $('view-search').hidden = !on;
  if (!on) return;
  const result = search.result;
  const known = new Set(state.snapshot.tasks.map(task => task.id));
  const hits = result ? result.results.filter(hit => known.has(hit.id)) : [];
  const folded = search.query.replace(/\s+/gu, '');
  // 결과 없음은 조사 없이(‘체험학습’와 처럼 받침에 어긋나던 문제), 무엇으로 찾을 수 있는지 한 줄 덧붙인다.
  const status = $('search-status');
  status.replaceChildren([...folded].length < 2 ? '두 글자 이상 넣어 주세요.'
    : !result ? '찾는 중입니다.'
    : result.error ? '검색을 마치지 못했습니다. 검색어를 다시 입력해 주세요.'
    : !hits.length ? '맞는 업무·쪽지가 없습니다.'
    : `${hits.length}건 찾음${result.more ? ' · 최근 50건만 보입니다. 더 자세히 넣어 보세요.' : ''}`);
  if (result && !result.error && !hits.length) status.append(element('span', 'search-hint', '보낸 사람 이름이나 첨부 파일 이름으로도 찾을 수 있습니다.'));
  const today = key(new Date());
  const pattern = searchPattern(search.query);
  $('search-list').replaceChildren(...hits.map(hit => searchRow(hit, today, pattern)));
}

async function runSearch(query, request) {
  try {
    const result = await api.search(query);
    if (request !== search.token) return;
    search.result = result;
  } catch {
    if (request !== search.token) return;
    search.result = { results: [], error: true };
  }
  renderSearch();
}

function scheduleSearch() {
  const request = ++search.token;
  const query = search.query;
  clearTimeout(search.timer);
  search.result = null;
  if ([...query.replace(/\s+/gu, '')].length >= 2) {
    search.timer = setTimeout(() => void runSearch(query, request), 150);
  }
}

$('list-search').addEventListener('input', event => {
  search.query = event.target.value.trim();
  scheduleSearch();
  renderSearch();
});
$('list-search').addEventListener('keydown', event => {
  if (event.key !== 'Escape' || !event.target.value) return;
  event.preventDefault();
  event.stopPropagation();
  event.target.value = '';
  search.query = '';
  scheduleSearch();
  renderSearch();
});
// Ctrl+F: 검색칸으로. 대화 상자가 열려 있으면 그대로 둔다.
document.addEventListener('keydown', event => {
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== 'f' || document.querySelector('dialog[open]')) return;
  event.preventDefault();
  if (!$('agenda').hidden) setCalendarMode(false);
  $('list-search').focus();
  $('list-search').select();
});

let savedView = 'todo';
try { savedView = localStorage.getItem('calendar-list-view') || 'todo'; } catch {}
showView(savedView);
$('loose-complete').addEventListener('click', () => {
  const task = state.detail?.task;
  if (task) void toggleDone(task, null, !task.done);
});
$('reference-seen').addEventListener('click', async () => {
  const id = state.selected;
  if (!id) return;
  try {
    await api.markReferenceSeen(id);
    if (id === state.selected) flash('detail-message', '처리한 것에서 다시 볼 수 있습니다.');
  } catch (error) {
    if (id === state.selected) setMessage('detail-message', error.message, true);
  }
});
async function showMessengerNote(id, messageId = 'detail-message', current = () => state.selected === id) {
  if (!current() || !state.messenger.noteAction || state.demo || !id || state.detail?.note?.verified !== true || messengerBusy()) return;
  state.messengerNoteOpening = true;
  renderBusy();
  const { name } = state.messenger;
  const copiedGoe = messageId === 'reply-inline-status' && state.messenger.noteAction === 'original';
  setMessage(messageId, `${name}에서 쪽지를 찾고 있습니다.`);
  try {
    const { foreground, notice } = await api.openMessengerNote(id);
    if (current()) {
      if (notice) setMessage(messageId, notice);
      else {
        const opened = foreground ? `${name}에서 ${messengerNoteTarget()}을 열었습니다.` : `${messengerNoteTarget()}을 열었습니다. 작업 표시줄에서 ${name} 창을 선택해 주세요.`;
        if (messageId === 'detail-message') flash(messageId, opened);
        else setMessage(messageId, copiedGoe ? opened + ' GOE 원문에서 답장을 누르고 Ctrl+V로 붙여넣으세요.' : opened);
      }
    }
  } catch (error) {
    if (current()) setMessage(messageId, copiedGoe ? '답장은 복사했습니다. ' + error.message : error.message, true);
  } finally {
    state.messengerNoteOpening = false;
    renderBusy();
  }
}
$('open-messenger-note').addEventListener('click', () => void showMessengerNote(state.selected));
// 손으로 다듬을 때도 보낼 내용을 먼저 보여 주고 확인을 받는다.
async function previewRefine() {
  const id = state.selected;
  if (!id) return;
  try {
    const preview = await api.refinePreview(id);
    if (id !== state.selected) return;
    const box = $('send-preview');
    box.replaceChildren();
    const part = (label, text) => { if (text) box.append(element('b', null, label), document.createTextNode(text)); };
    part('제목', preview.title);
    part('본문', preview.body);
    if (preview.attachmentNames.length) part('첨부 이름', preview.attachmentNames.join('\n'));
    $('send-provider').textContent = `보내는 곳: ${preview.provider}`;
    // OpenAI·Claude API 키 방식은 학습에 쓰이지 않는다(두 회사 공식 안내, 2026-11 확인). 구독 방식·팩트챗은 확인하지 않았으므로 말하지 않는다.
    const viaApi = ['openai', 'anthropic'].includes(state.snapshot.aiProvider);
    $('send-note').textContent = viaApi
      ? '가리기 처리한 내용을 보냅니다. API로 보낸 내용은 AI 학습에 쓰이지 않습니다. 첨부 파일은 보내지 않습니다.'
      : '가리기 처리한 내용을 보냅니다. 첨부 파일은 보내지 않습니다.';
    $('send-dialog').showModal();
    $('send-cancel').focus();
  } catch (error) {
    setMessage('detail-message', error.message, true);
  }
}
$('refine').addEventListener('click', () => {
  if (state.snapshot.aiProvider === 'none') openSettings('ai');
  else if (state.demo) void refine();
  else void previewRefine();
});
$('send-cancel').addEventListener('click', () => $('send-dialog').close());
$('send-confirm').addEventListener('click', () => { $('send-dialog').close(); void refine(); });
$('work-copy').addEventListener('click', async () => {
  const id = state.selected;
  if (!id) return;
  try {
    await api.copyWorkPrompt(id);
    if (id === state.selected) flash('work-message', '지시문을 복사했습니다. 원하는 채팅에 붙여 넣으세요.');
  } catch (error) {
    if (id === state.selected) setMessage('work-message', error.message, true);
  }
});

function closeProject() {
  projectSession = null;
  $('project-fields').hidden = true;
  $('project-start-open').setAttribute('aria-expanded', 'false');
  $('project-intent').value = '';
}

function closeNoteAi() {
  if (noteAi?.mode === 'reply') {
    $('reply-fields').hidden = true;
    $('reply-polish-open').setAttribute('aria-expanded', 'false');
    $('reply-intent').value = '';
    noteAi = null;
  }
  closeProject();
}

function currentNoteAi(session) {
  return !!session && (session === noteAi || session === projectSession) && state.selected === session.taskId &&
    state.detail?.task?.id === session.taskId && state.detail.note?.verified === true &&
    (session.mode === 'reply' || state.snapshot.showExternalAiWork !== false);
}

function renderNoteAi() {
  if (currentNoteAi(projectSession)) {
    const { busy, folder, loading, voicePending } = projectSession;
    $('project-mic').disabled = busy || !!voicePending;
    $('project-intent').readOnly = busy;
    $('project-start').textContent = $('project-agent').value === 'claude' ? 'Claude Code에서 시작' : 'Codex 새 채팅 열기';
    $('project-agent').disabled = $('project-files').disabled = busy;
    $('project-folder').disabled = busy || loading;
    const missing = projectSession.installed === false;
    $('project-start').disabled = busy || loading || !folder || !!voicePending || missing;
    $('project-agent-guide').hidden = !missing;
    setMessage('project-missing-agent', missing ? ($('project-agent').value === 'claude' ? 'Claude Code' : 'Codex 데스크톱') + ' 실행 앱을 찾지 못했습니다. 설치한 뒤 ‘에이전트 설정 열기’를 눌러 다시 찾아보세요.' : '');
    $('project-start-open').disabled = busy || state.dirty || state.saving;
  }
  if (currentNoteAi(noteAi)) {
    const { busy } = noteAi;
    const provider = aiNames[state.snapshot.aiProvider];
    const draft = $('reply-intent').value.trim();
    $('reply-demo-hint').hidden = !state.demo;
    $('reply-mic').disabled = busy || !!noteAi.voicePending;
    $('reply-generate').hidden = !provider && !state.demo;
    $('reply-ai-settings').hidden = !!provider || !!state.demo;
    $('reply-intent').readOnly = busy;
    $('reply-generate').disabled = busy || !!state.demo || !provider || !draft;
    $('reply-generate').textContent = noteAi.polished ? '다시 다듬기' : '다듬기';
    $('reply-generate').classList.toggle('primary', !noteAi.polished);
    const canOpenMessenger = !!state.messenger.noteAction && !state.demo;
    $('reply-copy').hidden = !noteAi.polished || canOpenMessenger;
    $('reply-copy').disabled = busy || !draft;
    $('reply-open-messenger').hidden = !noteAi.polished || !canOpenMessenger;
    $('reply-open-messenger').disabled = busy || !draft || messengerBusy();
    $('reply-open-messenger').title = state.messenger.noteAction === 'original' ? '문구를 복사하고 GOE 원문을 엽니다. 원문에서 답장을 눌러 붙여넣으세요.' : '답장 문구를 복사하고 메신저를 엽니다';
    $('reply-open-messenger').textContent = state.messenger.noteAction === 'original' ? '복사하고 원문 보기'
      : state.detail.noteActions?.forwarded ? '보낸 사람에게 답장' : '브리티에서 답장';
  }
}

function openNoteAi(mode) {
  const { task, note } = state.detail || {};
  if (!task || state.selected !== task.id || !note?.verified || state.dirty || state.saving) return;
  const project = mode === 'project';
  if (project && state.snapshot.showExternalAiWork === false) return;
  const fields = $(project ? 'project-fields' : 'reply-fields');
  const input = $(project ? 'project-intent' : 'reply-intent');
  const toggle = $(project ? 'project-start-open' : 'reply-polish-open');
  const existing = project ? projectSession : noteAi;
  const expanded = fields.hidden;
  fields.hidden = !expanded;
  toggle.setAttribute('aria-expanded', String(expanded));
  if (!expanded) return;
  if (existing?.taskId === task.id) {
    renderNoteAi();
    input.focus();
    return;
  }
  const session = { taskId: task.id, mode, busy: false };
  input.value = '';
  if (project) {
    projectSession = session;
    session.folders = {};
    try { $('project-agent').value = localStorage.getItem('calendar-project-agent') === 'claude' ? 'claude' : 'codex'; } catch {}
    void loadProjectChoices(session, state.snapshot.workProjectFolder || '');
    const files = note.attachments || [];
    $('project-files').hidden = !files.length;
    $('project-attachments').replaceChildren(...files.map(file => {
      const label = element('label', 'check-field small mcp-file');
      const input = element('input');
      input.type = 'checkbox';
      input.value = String(file.index);
      input.dataset.name = file.name;
      input.disabled = !file.available;
      label.append(input, element('span', null, file.name));
      if (!file.available) label.append(element('span', 'small-note', '저장 파일 없음'));
      return label;
    }));
  } else {
    noteAi = session;
    input.maxLength = 2000;
  }
  setMessage(project ? 'note-ai-status' : 'reply-inline-status', '');
  renderNoteAi();
  input.focus();
}

async function runNoteAi(mode, message, action) {
  const session = mode === 'project' ? projectSession : noteAi;
  if (!currentNoteAi(session) || session.mode !== mode || session.busy) return;
  session.busy = true;
  renderNoteAi();
  const statusId = mode === 'reply' ? 'reply-inline-status' : 'note-ai-status';
  setMessage(statusId, message);
  try {
    await action(session);
  } catch (error) {
    if (currentNoteAi(session)) setMessage(statusId, error.message, true);
  } finally {
    session.busy = false;
    if (currentNoteAi(session)) renderNoteAi();
  }
}

$('reply-polish-open').addEventListener('click', () => openNoteAi('reply'));
$('project-start-open').addEventListener('click', () => openNoteAi('project'));
async function startNoteVoice(mode) {
  const project = mode === 'project';
  const session = project ? projectSession : noteAi;
  const status = project ? 'note-ai-status' : 'reply-inline-status';
  if (!currentNoteAi(session) || session.busy || session.voicePending) return;
  $(project ? 'project-intent' : 'reply-intent').focus();
  session.voicePending = true;
  renderNoteAi();
  setMessage(status, '');
  try { await api.startReplyVoice(session.taskId, mode); }
  catch (error) { if (currentNoteAi(session)) setMessage(status, error.message, true); }
  finally {
    session.voicePending = false;
    if (currentNoteAi(session)) renderNoteAi();
  }
}
$('reply-mic').addEventListener('click', () => void startNoteVoice('reply'));
$('project-mic').addEventListener('click', () => void startNoteVoice('project'));
$('reply-intent').addEventListener('input', renderNoteAi);
$('reply-ai-settings').addEventListener('click', () => openSettings('ai'));
$('reply-generate').addEventListener('click', () => void runNoteAi('reply', '답장 문장을 다듬고 있습니다.', async session => {
  const result = await api.polishReply(session.taskId, $('reply-intent').value.trim());
  if (!currentNoteAi(session)) return;
  const input = $('reply-intent');
  session.polished = true;
  input.removeAttribute('maxlength');
  input.readOnly = false;
  // Keep the replacement in Chromium's editing history so Ctrl+Z restores the draft.
  if (!$('reply-fields').hidden && !document.querySelector('dialog[open]')) {
    input.focus();
    input.select();
    if (!document.execCommand('insertText', false, result)) input.value = result;
  } else {
    input.value = result;
  }
  setMessage('reply-inline-status', '');
}));
async function copyPolishedReply(openMessenger) {
  await runNoteAi('reply', '', async session => {
    const text = $('reply-intent').value.trim();
    if (!text) return;
    await api.copyText(text);
    if (!currentNoteAi(session)) return;
    setMessage('reply-inline-status', '답장을 복사했습니다.');
    if (openMessenger) await showMessengerNote(session.taskId, 'reply-inline-status', () => currentNoteAi(session));
  });
}
$('reply-copy').addEventListener('click', () => void copyPolishedReply(false));
$('reply-open-messenger').addEventListener('click', () => void copyPolishedReply(true));
async function loadProjectChoices(session, remembered = '') {
  const agent = $('project-agent').value;
  const token = Symbol();
  session.lookup = token;
  session.loading = true;
  session.folder = '';
  const select = $('project-folder');
  select.replaceChildren(new Option('프로젝트 선택', ''));
  renderNoteAi();
  let projects = [];
  const [list, status] = await Promise.allSettled([api.listWorkProjects(agent), api.projectAgentStatus()]);
  if (list.status === 'fulfilled') projects = list.value;
  if (!currentNoteAi(session) || session.lookup !== token) return;
  session.installed = status.status === 'fulfilled' ? status.value[agent] : undefined;
  const previous = session.folders[agent] || remembered;
  if (previous && !projects.some(item => item.folder === previous)) {
    projects.push({ name: previous.split(/[\\/]/).filter(Boolean).pop() || '선택한 프로젝트', folder: previous });
  }
  const names = new Map();
  for (const { name, folder } of projects) {
    const count = (names.get(name) || 0) + 1;
    names.set(name, count);
    select.add(new Option(count > 1 ? name + ' (' + count + ')' : name, folder));
  }
  select.add(new Option('다른 폴더 고르기…', 'browse'));
  select.value = previous;
  session.folder = select.value;
  session.loading = false;
  renderNoteAi();
}
$('project-agent').addEventListener('change', () => void loadProjectChoices(projectSession));
$('project-folder').addEventListener('change', () => {
  const session = projectSession;
  const select = $('project-folder');
  const agent = $('project-agent').value;
  if (select.value !== 'browse') {
    session.folder = session.folders[agent] = select.value;
    renderNoteAi();
    return;
  }
  select.value = session.folder;
  void runNoteAi('project', '', async () => {
    const folder = await api.pickWorkProject();
    if (!folder || !currentNoteAi(session)) return;
    session.folders[agent] = folder;
    await loadProjectChoices(session);
  });
});
$('project-start').addEventListener('click', () => void runNoteAi('project', '프로젝트에서 쪽지를 열고 있습니다.', async session => {
  const agent = $('project-agent').value;
  const attachments = Array.from($('project-attachments').querySelectorAll('input:checked'), input => ({
    index: Number(input.value), name: input.dataset.name
  }));
  const result = await api.startWorkProject(session.taskId, { agent, folder: session.folder, attachments, instruction: $('project-intent').value });
  try { localStorage.setItem('calendar-project-agent', agent); } catch {}
  if (!currentNoteAi(session)) return;
  closeProject();
  $('project-start-open').disabled = state.dirty || state.saving;
  $('project-start-open').focus();
  setMessage('work-message', result.message);
}));

const mcpDialog = $('mcp-dialog');
const mcpHelp = {
  claude: '프로젝트 폴더의 .mcp.json에 추가하고 Claude Code를 다시 여세요. 연결 승인을 요청하면 확인한 뒤 /mcp에서 calendar를 확인하세요.',
  json: 'Claude Desktop, Cursor, Antigravity 등은 MCP 설정의 mcpServers 안에 calendar 항목을 추가하세요. 새 설정 파일이라면 복사한 내용을 그대로 붙여 넣으세요.',
  codex: 'Codex의 MCP 설정 파일(~/.codex/config.toml)에 복사한 항목을 추가하세요.',
  grok: 'Grok Build의 MCP 설정 파일(~/.grok/config.toml)에 복사한 항목을 추가하세요.',
  vscode: '명령 팔레트에서 MCP: Open User Configuration을 열고 servers 안에 calendar 항목을 추가하세요.'
};
let mcpSession = null;

function renderMcpDialog(session) {
  const { draft, share, phase } = session;
  const delegating = draft?.mode === 'delegate';
  const agent = workAgents[$('work-agent-select').value];
  $('mcp-draft').hidden = !draft;
  $('mcp-current').hidden = !share;
  $('codex-work-field').hidden = !delegating;
  $('mcp-replace-note').hidden = delegating;
  $('mcp-setup').hidden = delegating;
  $('mcp-note-summary').textContent = delegating ? '보낼 원문 보기' : '공유할 원문 보기';
  $('mcp-draft-help').textContent = delegating
    ? `이 쪽지 원문과 고른 첨부를 ${agent}에 보냅니다. 결과는 이 쪽지의 AI 작업 결과에 표시됩니다.`
    : '쪽지 원문과 선택한 첨부를 공유합니다. 연결한 AI가 가져오면 내용이 해당 AI 서비스에 전달될 수 있습니다.';
  $('mcp-share-confirm').hidden = !draft;
  $('mcp-share-confirm').textContent = delegating ? `${agent}에 맡기기` : 'AI로 보내기';
  $('mcp-share-confirm').disabled = phase !== 'ready' || delegating && !$('codex-work-request').value.trim();
  $('mcp-copy-prompt').classList.toggle('primary', !draft);
  $('mcp-current-title').textContent = share?.title || '';
  const files = share?.attachments || [];
  const currentFiles = $('mcp-current-files');
  currentFiles.replaceChildren(...files.map(file => element('li', null, file.name)));
  currentFiles.hidden = !files.length;
  const working = phase === 'working';
  for (const id of ['mcp-copy-prompt', 'mcp-open-folder', 'mcp-revoke', 'mcp-client', 'mcp-files', 'mcp-close', 'codex-work-request', 'work-agent-select']) {
    $(id).disabled = working;
  }
  $('mcp-copy-connect-dialog').disabled = $('mcp-copy-setup').disabled = working || phase === 'loading';
}

async function openMcpDialog(draft = null) {
  if (state.snapshot.showExternalAiWork === false) return;
  const delegating = draft?.mode === 'delegate';
  const session = { draft, share: null, phase: delegating ? 'ready' : 'loading' };
  mcpSession = session;
  $('mcp-heading').textContent = delegating ? '업무 맡기기' : draft ? 'AI로 보내기' : '외부 AI에 쪽지 공유';
  $('codex-work-request').value = '';
  $('work-agent-select').value = 'codex';
  const setup = $('mcp-setup');
  setup.open = !draft;
  $('mcp-manual').open = !draft;
  $('mcp-client-help').textContent = mcpHelp[$('mcp-client').value];
  mcpDialog.querySelector('#mcp-draft details').open = false;
  $('mcp-note-title').textContent = draft?.title || '';
  $('mcp-note-body').textContent = draft?.body || '';
  const files = draft?.attachments || [];
  $('mcp-files').hidden = !files.length;
  $('mcp-attachments').replaceChildren(...files.map(file => {
    const label = element('label', 'check-field small mcp-file');
    const input = element('input');
    input.type = 'checkbox';
    input.value = String(file.index);
    input.disabled = !file.available;
    label.append(input, element('span', null, file.name));
    if (!file.available) label.append(element('span', 'small-note', '저장 파일 없음'));
    return label;
  }));
  setMessage('mcp-status', delegating ? '' : '공유 상태를 확인하고 있습니다.');
  renderMcpDialog(session);
  mcpDialog.showModal();
  if (delegating) {
    $('work-agent-select').focus();
    return;
  }
  try {
    const { share } = await api.mcpStatus();
    if (mcpSession !== session || !mcpDialog.open) return;
    session.share = share;
    session.phase = 'ready';
    setMessage('mcp-status', !draft && !share ? '현재 공유 중인 쪽지가 없습니다.' : '');
  } catch (error) {
    if (mcpSession !== session || !mcpDialog.open) return;
    session.phase = 'unavailable';
    setMessage('mcp-status', error.message, true);
  }
  renderMcpDialog(session);
}

async function runMcpAction(action, message, nextFocus) {
  const session = mcpSession;
  if (!session || session.phase === 'working' || session.phase === 'loading') return;
  const previous = session.phase;
  const focused = document.activeElement;
  session.phase = 'working';
  setMessage('mcp-status', '처리하고 있습니다.');
  renderMcpDialog(session);
  let succeeded = false;
  try {
    await action(session);
    setMessage('mcp-status', message);
    succeeded = true;
  } catch (error) {
    setMessage('mcp-status', error.message, true);
  } finally {
    session.phase = previous;
    renderMcpDialog(session);
    if (succeeded && nextFocus) $(nextFocus).focus();
    else if (mcpDialog.contains(focused)) focused.focus();
  }
}

function openMcpDraft(mode) {
  const { task, note } = state.detail || {};
  if (note?.verified !== true || task.id !== state.selected) return;
  void openMcpDialog({ taskId: task.id, title: note.title, body: note.body, attachments: note.attachments, mode });
}
$('mcp-share-open').addEventListener('click', () => openMcpDraft('share'));
$('codex-work-open').addEventListener('click', () => openMcpDraft('delegate'));
$('mcp-settings-open').addEventListener('click', () => void openMcpDialog());
function closeMcpDialog() {
  if (mcpSession?.phase === 'working') return;
  mcpDialog.close();
  mcpSession = null;
  $('mcp-note-title').textContent = '';
  $('mcp-note-body').textContent = '';
  $('codex-work-request').value = '';
  $('mcp-attachments').replaceChildren();
  $('mcp-current-title').textContent = '';
  $('mcp-current-files').replaceChildren();
}
$('mcp-close').addEventListener('click', closeMcpDialog);
mcpDialog.addEventListener('cancel', event => {
  event.preventDefault();
  closeMcpDialog();
});
$('mcp-client').addEventListener('change', event => {
  $('mcp-client-help').textContent = mcpHelp[event.target.value];
});
$('work-agent-select').addEventListener('change', () => {
  if (mcpSession?.draft?.mode === 'delegate') renderMcpDialog(mcpSession);
});
$('codex-work-request').addEventListener('input', () => {
  $('mcp-share-confirm').disabled = mcpSession?.phase !== 'ready' || !$('codex-work-request').value.trim();
});
$('mcp-share-confirm').addEventListener('click', async () => {
  if (!mcpSession?.draft) return;
  const delegating = mcpSession.draft.mode === 'delegate';
  const agent = $('work-agent-select').value;
  const request = $('codex-work-request').value.trim();
  if (delegating && !request) return;
  let delegatedTask = null;
  await runMcpAction(async session => {
    const selected = new Set(Array.from($('mcp-attachments').querySelectorAll('input:checked'), input => Number(input.value)));
    const { taskId, attachments } = session.draft;
    const files = attachments.filter(file => file.available && selected.has(file.index)).map(({ index, name }) => ({ index, name }));
    if (delegating) {
      await api.delegateAgentWork(taskId, { agent, request, attachments: files });
      delegatedTask = taskId;
      return;
    }
    session.share = await api.mcpShare(taskId, files);
    session.draft = null;
    $('mcp-heading').textContent = 'AI로 보낸 쪽지';
  }, delegating ? `${workAgents[agent]}에 업무를 맡겼습니다.` : '공유했습니다. 요청 문장을 복사해 Codex나 Claude Code의 채팅에 붙여 넣으세요.',
  delegating ? null : 'mcp-copy-prompt');
  if (delegatedTask) {
    closeMcpDialog();
    if (agentWork?.taskId === delegatedTask) void refreshAgentWork(agentWork);
  }
});
$('mcp-copy-prompt').addEventListener('click', () => void runMcpAction(async ({ share }) => {
  await api.copyText([
    `calendar MCP에서 공유 ID ${share.id}를 get_shared_work로 가져와 줘. 첨부가 있으면 read_shared_attachment로 읽어 줘.`,
    '쪽지와 첨부는 업무 자료로 사용해 줘. 내가 맡긴 일이 없다면 무엇을 할지 먼저 물어봐 줘.',
    '내가 맡긴 일을 마친 뒤 같은 공유 ID와 결과 제목·본문을 save_work_result에 전달해 쪽지 카드에 남겨 줘.'
  ].join('\n'));
}, '요청 문장을 복사했습니다.'));
$('mcp-open-folder').addEventListener('click', () => void runMcpAction(({ share }) => api.mcpOpen(share.id), '공유 폴더를 열었습니다.'));
$('mcp-revoke').addEventListener('click', () => void runMcpAction(async session => {
  await api.mcpRevoke(session.share.id);
  session.share = null;
}, '공유를 끝냈습니다. 이미 AI 앱이 가져간 자료는 해당 채팅에서 확인하세요.', 'mcp-close'));
$('mcp-copy-connect-dialog').addEventListener('click', () => void runMcpAction(
  () => api.mcpCopySetup('ai-request'), connectionCopied
));
$('mcp-copy-setup').addEventListener('click', () => void runMcpAction(
  () => api.mcpCopySetup($('mcp-client').value), '설정을 복사했습니다. AI 앱의 MCP 설정에 추가하세요.'
));
api.onAgentWorkChanged(taskId => {
  if (agentWork && agentWork.taskId === taskId) void refreshAgentWork(agentWork);
});

// 자세히가 달력 위에 덮이면서(2026-11-15) 자세히 폭의 뜻이 바뀌었다: 예전 키의 자세히 폭은 버리고 목록 폭만 이어 쓴다.
const paneSettingsKey = 'calendar-pane-widths-v2';
const paneWidths = {};
try {
  const saved = JSON.parse(localStorage.getItem(paneSettingsKey)) ?? { list: JSON.parse(localStorage.getItem('calendar-pane-widths'))?.list };
  for (const side of ['list', 'detail']) {
    if (Number.isFinite(saved?.[side])) paneWidths[side] = saved[side];
  }
} catch {}

function fitPanes(viewWidth, narrow) {
  const workspace = $('calendar-workspace');
  const clamp = (value, min, max) => Math.round(Math.max(min, Math.min(max, value)));
  const listMin = 220;
  const detailMin = 320;
  const divider = 8;
  const listMax = () => Math.min(480, viewWidth - 410 - divider);
  const list = clamp(paneWidths.list ?? 240, listMin, listMax());
  // 자세히는 달력 위에 덮는다. 기본 폭은 달력의 주말 두 칸(+오른쪽 여백), 넓혀도 달력의 절반까지만.
  const calendarWidth = viewWidth - list - divider;
  const weekend = (calendarWidth - 36) * 2 / 7 + 18;
  const detailMax = () => narrow ? Math.min(700, viewWidth - 72) : Math.max(detailMin, Math.min(700, calendarWidth * .5));
  const detail = clamp(paneWidths.detail ?? (narrow ? 440 : Math.max(360, weekend)), detailMin, detailMax());
  // 달력 머리(달·범례·‹ 오늘 ›)는 가리지 않는다: 자세히는 그 아래, 요일 줄부터 덮는다.
  const header = document.querySelector($('agenda').hidden ? '.calendar-header' : '.calendar-mode');
  workspace.style.setProperty('--detail-top', narrow || !header ? '0px' : `${header.offsetTop + header.offsetHeight}px`);
  for (const [side, value, min, max] of [
    ['list', list, listMin, listMax()], ['detail', detail, detailMin, detailMax()]
  ]) {
    workspace.style.setProperty(`--${side}-pane-width`, `${value}px`);
    const handle = $(`${side}-divider`);
    handle.setAttribute('aria-valuemin', min);
    handle.setAttribute('aria-valuemax', Math.max(min, Math.floor(max)));
    handle.setAttribute('aria-valuenow', value);
  }
}

function rememberPaneWidths() {
  try { localStorage.setItem(paneSettingsKey, JSON.stringify(paneWidths)); } catch {}
}

function bindPaneDivider(side) {
  const handle = $(`${side}-divider`);
  const pane = $(side === 'list' ? 'calendar-list-pane' : 'detail-panel');
  const direction = side === 'list' ? 1 : -1;
  const get = name => Number(handle.getAttribute(`aria-value${name}`));
  const resize = value => {
    paneWidths[side] = Math.round(Math.max(get('min'), Math.min(get('max'), value)));
    fitWidth();
  };
  let drag;
  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0 || drag) return;
    const scale = pane.getBoundingClientRect().width / pane.offsetWidth;
    if (!Number.isFinite(scale) || !scale) return;
    drag = { id: event.pointerId, x: event.clientX, width: get('now'), scale };
    handle.setPointerCapture(event.pointerId);
    handle.classList.add('dragging');
    document.documentElement.classList.add('resizing-panes');
    handle.focus({ preventScroll: true });
    event.preventDefault();
  });
  handle.addEventListener('pointermove', event => {
    if (drag?.id !== event.pointerId) return;
    resize(drag.width + direction * (event.clientX - drag.x) / drag.scale);
  });
  const finish = event => {
    if (drag?.id !== event.pointerId) return;
    drag = null;
    handle.classList.remove('dragging');
    document.documentElement.classList.remove('resizing-panes');
    rememberPaneWidths();
  };
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) handle.addEventListener(type, finish);
  handle.addEventListener('dblclick', () => {
    delete paneWidths[side];
    fitWidth();
    rememberPaneWidths();
  });
  handle.addEventListener('keydown', event => {
    const step = event.shiftKey ? 64 : 24;
    if (event.key === 'ArrowLeft') resize(get('now') - direction * step);
    else if (event.key === 'ArrowRight') resize(get('now') + direction * step);
    else if (event.key === 'Home') resize(get('min'));
    else if (event.key === 'End') resize(get('max'));
    else return;
    event.preventDefault();
    rememberPaneWidths();
  });
}

// 글자 크기: 화면 전체를 비율로 키운다. 이 PC에만 기억한다.
const ZOOMS = [0.9, 1, 1.1, 1.2, 1.35, 1.5];
function fitWidth() {
  const width = window.innerWidth / (Number(document.documentElement.style.zoom) || 1);
  document.documentElement.classList.toggle('narrow', width < 1180);
  document.documentElement.classList.toggle('tiny', width < 760);
  if (width >= 760) fitPanes(Math.floor(width), width < 1180);
}
for (const side of ['list', 'detail']) bindPaneDivider(side);
window.addEventListener('resize', fitWidth);
function applyZoom(step) {
  const index = Math.min(ZOOMS.length - 1, Math.max(0, step));
  document.documentElement.style.zoom = String(ZOOMS[index]);
  // 글자를 키우면 vh도 함께 커져 창이 화면 밖으로 넘친다. 창 높이 계산에서 배율을 되돌린다.
  document.documentElement.style.setProperty('--zoom', String(ZOOMS[index]));
  fitWidth();
  $('zoom-value').textContent = `${Math.round(ZOOMS[index] * 100)}%`;
  $('zoom-out').disabled = index === 0;
  $('zoom-in').disabled = index === ZOOMS.length - 1;
  try { localStorage.setItem('calendar-zoom', String(index)); } catch {}
  return index;
}
let zoomStep = 1;
try { const saved = localStorage.getItem('calendar-zoom'); if (saved !== null && Number.isInteger(Number(saved))) zoomStep = Number(saved); } catch {}
zoomStep = applyZoom(zoomStep);
$('zoom-in').addEventListener('click', () => { zoomStep = applyZoom(zoomStep + 1); });
$('zoom-out').addEventListener('click', () => { zoomStep = applyZoom(zoomStep - 1); });

// 화면 꾸미기(스킨): 자리는 그대로 두고 색·질감·글꼴·그림만 바꾼다(skins.css). 이 PC에만 기억하고,
// 첫 화면 전에 skin-boot.js가 먼저 입힌다.
const SKINS = ['diary', 'cute', 'evening', 'minimal', 'contrast', 'brutal', 'retro', 'news', 'woodland', 'nacre', 'linen', 'glass', 'chalk'];
const skinInputs = [...document.querySelectorAll('input[name="skin"]')];
function applySkin(skin) {
  const value = SKINS.includes(skin) ? skin : 'minimal';
  document.documentElement.dataset.skin = value;
  for (const input of skinInputs) input.checked = input.value === value;
  try { localStorage.setItem('calendar-skin', value); } catch {}
}
applySkin(document.documentElement.dataset.skin);
for (const input of skinInputs) input.addEventListener('change', () => { if (input.checked) applySkin(input.value); });

// 글꼴(2026-11-15): 고르면 앱 이름·큰 달 숫자 말고 화면 글자 전체를 바꾼다(skins.css). 'skin'이면 스킨 기본(data-font 없음).
// 첫 화면 전에 skin-boot.js가 먼저 입힌다.
const FONTS = ['skin', 'pretendard', 'dodum', 'nanumsquare', 'plex', 'maruburi', 'batang'];
const fontInputs = [...document.querySelectorAll('input[name="font"]')];
function applyFont(font) {
  const value = FONTS.includes(font) ? font : 'skin';
  if (value === 'skin') delete document.documentElement.dataset.font;
  else document.documentElement.dataset.font = value;
  for (const input of fontInputs) input.checked = input.value === value;
  try { localStorage.setItem('calendar-font', value); } catch {}
}
applyFont(document.documentElement.dataset.font || 'skin');
for (const input of fontInputs) input.addEventListener('change', () => { if (input.checked) applyFont(input.value); });

redraw();
api.onChange(sync);
api.load().then(sync, error => { $('inbox-note').textContent = error.message; });

// 원문 링크: 창 안에서 이동하지 않고 기본 브라우저로 연다. 주소 확인은 main.js에서 다시 한다.
document.addEventListener('click', async event => {
  const link = event.target.closest?.('a.note-link');
  if (!link) return;
  event.preventDefault();
  try {
    await api.openLink(link.href);
  } catch (error) {
    notice(error.message);
  }
});

$('copy-note').addEventListener('click', async () => {
  const note = state.detail?.note;
  if (!note?.body) return;
  try {
    await api.copyText([note.title, note.body].filter(Boolean).join('\n\n'));
    notice('쪽지 원문을 복사했습니다.');
  } catch (error) {
    notice(error.message);
  }
});
