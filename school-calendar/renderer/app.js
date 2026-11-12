'use strict';

const $ = id => document.getElementById(id);
const api = window.calendar;
const dateLabel = new Intl.DateTimeFormat('ko-KR', { dateStyle: 'full' });
const messageDate = new Intl.DateTimeFormat('ko-KR', { dateStyle: 'short', timeStyle: 'short' });
const { daysBetween, receivedDay } = calendarPeriods;
const WEEKDAYS = '일월화수목금토';
const TYPE_ORDER = { span: 0, event: 0, task: 1, ref: 2 };
const typeLabels = { '할 일': '할 일', '알아 둘 것': '확인할 것', '없음': '숨기기' };
const aiNames = { claude: 'Claude Code CLI · Haiku', codex: 'Codex CLI', openai: 'OpenAI API · Luna', factchat: '서룡 팩트챗 API · Luna' };
const state = {
  snapshot: { tasks: [], messages: [], inbox: { status: 'loading', pending: 0 } },
  month: new Date(), dayKey: '', selected: null, detailToken: 0, detail: null,
  spanColors: new Map(), expandedForwarded: new Set(), selectedChat: null, forwardedDraft: null,
  chatLoaded: false, readingSelection: false, dirty: false, revision: null, saving: false
};
const markingOpened = new Set();
let noticeTimer;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
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
const { boxes, finished, isPinned, pinnedDue, lastDay } = taskModel;
const chatLabels = { task: '대화방', confirmed: '대화방 확정', changed: '대화방 변경', cancelled: '대화방 취소' };

// 대화방 후보(분류할 것 탭). 아직 정하지 않은 것만 후보이고, 버린 후보는 숨긴 것에 둔다.
function isCandidate(task) {
  return !!task?.candidate && !task.candidate.discarded;
}

function candidateBadge(task) {
  if (task.candidate?.discarded) return '버린 후보';
  return task.candidate?.change ? (task.chatSource?.action === 'cancelled' ? '대화방 취소 후보' : '대화방 변경 후보') : '대화방 후보';
}

// 달력·목록에 뜨는 한 줄 = 업무의 날짜 하나.
function markType(task, entry) {
  if (task.type !== '할 일') return 'ref';
  if (!entry) return 'task';
  return entry.kind === '까지' ? 'task' : entry.kind === '기간' ? 'span' : 'event';
}

function mark(type, done = false) {
  if (type === 'task') return element('span', `box${done ? ' on' : ''}`);
  if (type === 'event') return element('span', 'disc');
  if (type === 'span') return element('span', 'bar');
  return element('span', 'nomark');
}

function shortDate(value) {
  const date = fromKey(value);
  return `${date.getMonth() + 1}/${date.getDate()}(${WEEKDAYS[date.getDay()]})`;
}

function entryLate(task, entry, today = key(new Date())) {
  return task.type === '할 일' && entry?.kind === '까지' && !entry.done && entry.date < today;
}

function isLate(task, today = key(new Date())) {
  return (task.dates || []).some(entry => entryLate(task, entry, today));
}

function needsCheck(task) {
  return !!task.noteId && (task.noteState === 'unverified' || task.noteState === 'missing' || !!task.uncertain);
}

function checkLabel(task) {
  if (task.noteState === 'missing') return '원문 없음';
  if (task.uncertain) return task.type === '할 일' ? '확인 필요' : `${typeLabels[task.type]}?`;
  return '확인';
}

// 미완료 할 일과 분류가 애매한 쪽지 가운데 확인이 필요한 것.
function needsNoteReview(task) {
  if (!task.noteId || !needsCheck(task)) return false;
  if (task.type === '할 일') return !finished(task);
  return task.uncertain === true && !(task.type === '알아 둘 것' && task.referenceSeen);
}

// 쪽지의 현재 유형을 누르면 그대로 맞다고 확인한다.
function checkActions(task) {
  const bar = element('div', 'check-actions');
  bar.setAttribute('role', 'group');
  bar.setAttribute('aria-label', `${task.title} 바로 고르기`);
  const quick = task.uncertain && task.noteState === 'available';
  const choices = quick ? Object.entries(typeLabels) : [];
  for (const [type, label] of choices) {
    const choice = button(`chip${task.type === type ? ' current' : ''}`, task.type === type ? `${label} 맞음` : label);
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
    notice(type === task.type ? '확인했습니다.' : type === '할 일' ? '할 일로 옮겼습니다.' : `‘${typeLabels[type]}’으로 옮겼습니다.`);
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


function calendarItem(task, entry, index, today) {
  const type = markType(task, entry);
  const done = type === 'task' && entry.done === true;
  const item = button(`item type-${type}`);
  item.classList.toggle('late', entryLate(task, entry, today));
  item.classList.toggle('done', done);
  item.classList.toggle('past', entry.kind !== '까지' && lastDay(entry) < today);
  item.classList.toggle('selected', task.id === state.selected);
  // 후보는 흐리게(점선 테두리) 미리 보인다. 분류할 것 탭을 안 열어도 놓치지 않게.
  item.classList.toggle('candidate', isCandidate(task));
  item.title = [task.title, entry.kind === '까지' ? `${shortDate(entry.date)}까지` : null, task.chatSource?.time,
    isCandidate(task) ? `${candidateBadge(task)} · 분류할 것에서 정하기` : chatLabels[task.chatSource?.action], done ? '끝냄' : ''].filter(Boolean).join(' · ');
  item.setAttribute('aria-pressed', String(task.id === state.selected));
  item.dataset.focusKey = `calendar-${task.id}-${index}`;
  item.classList.toggle('important', task.important === true);
  item.append(mark(type, done));
  if (task.important) item.append(element('span', 'imp', '!'));
  item.append(element('span', 'item-title', entry.label));
  item.addEventListener('click', () => selectTask(task.id, item.dataset.focusKey));
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

function spanPiece({ task, entry, index }, dateKey, weekFirst, today) {
  const piece = button(`span-piece type-${markType(task, entry)} span-c${spanColor(task, index)}`);
  piece.classList.toggle('start', entry.date === dateKey);
  piece.classList.toggle('end', entry.end === dateKey);
  piece.classList.toggle('past', entry.end < today);
  piece.classList.toggle('selected', task.id === state.selected);
  piece.classList.toggle('candidate', isCandidate(task));
  piece.classList.toggle('important', task.important === true);
  piece.title = [entry.label, `${shortDate(entry.date)}~${shortDate(entry.end)}`, task.title !== entry.label ? task.title : null,
    isCandidate(task) ? `${candidateBadge(task)} · 분류할 것에서 정하기` : null].filter(Boolean).join(' · ');
  piece.setAttribute('aria-label', `${entry.label} ${shortDate(entry.date)}부터 ${shortDate(entry.end)}까지`);
  piece.setAttribute('aria-pressed', String(task.id === state.selected));
  piece.dataset.focusKey = `span-${task.id}-${index}-${dateKey}`;
  if (entry.date === dateKey || weekFirst) piece.append(element('span', 'span-label', entry.label));
  piece.addEventListener('click', () => selectTask(task.id, piece.dataset.focusKey));
  return piece;
}

function selectedReceived() {
  const task = state.snapshot.tasks.find(item => item.id === state.selected);
  if (!task?.noteId || task.type === '없음' || !task.dates?.length) return null;
  const start = receivedDay(task.datetime || '');
  return start && task.dates.some(entry => start < entry.date) ? start : null;
}

function renderMonth() {
  const today = key(new Date());
  const current = monthOf(state.month);
  const year = current.getFullYear();
  const month = current.getMonth();
  $('year-label').textContent = `${year}년`;
  $('month-value').textContent = String(month + 1);
  const first = shift(current, -current.getDay());
  const next = new Date(current);
  next.setMonth(month + 1);
  const weeks = Math.max(5, Math.ceil((current.getDay() + shift(next, -1).getDate()) / 7));
  const received = selectedReceived();
  const items = new Map();
  const spans = [];
  for (const task of state.snapshot.tasks) {
    if (task.type === '없음') continue;
    (task.dates || []).forEach((entry, index) => {
      if (entry.kind === '기간' && entry.end) { spans.push({ task, entry, index }); return; }
      if (!items.has(entry.date)) items.set(entry.date, []);
      items.get(entry.date).push({ task, entry, index });
    });
  }
  // 기간은 시작일~끝일 칸을 가로지르는 선. 겹치면 줄(lane)을 나누고, 같은 기간은 그 달 내내 같은 줄에 둔다.
  const gridStart = key(first);
  const gridEnd = key(shift(first, weeks * 7 - 1));
  const visible = spans.filter(({ entry }) => entry.date <= gridEnd && entry.end >= gridStart)
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
  const days = [];
  for (let index = 0; index < weeks * 7; index++) {
    const date = shift(first, index);
    const dateKey = key(date);
    const day = element('div', 'day');
    day.classList.toggle('sunday', date.getDay() === 0);
    day.classList.toggle('saturday', date.getDay() === 6);
    day.classList.toggle('adjacent', date.getMonth() !== month);
    day.classList.toggle('is-today', dateKey === today);
    const hit = button('day-hit');
    hit.setAttribute('aria-label', `${dateLabel.format(date)} 업무 추가`);
    if (dateKey === today) hit.setAttribute('aria-current', 'date');
    hit.dataset.focusKey = `date-${dateKey}`;
    hit.tabIndex = dateKey === state.dayKey ? 0 : -1;
    hit.append(element('span', 'day-number', date.getDate()));
    if (received && dateKey === received) hit.append(element('span', 'received', '받음'));
    hit.append(element('span', 'day-plus', '+'));
    hit.addEventListener('click', () => showCreate(dateKey));
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
    const weekStart = key(shift(first, index - date.getDay()));
    const weekEnd = key(shift(first, index - date.getDay() + 6));
    const weekLanes = visible.filter(({ entry }) => entry.date <= weekEnd && entry.end >= weekStart)
      .reduce((most, span) => Math.max(most, span.lane + 1), 0);
    const lanes = element('div', 'day-spans');
    for (let lane = 0; lane < weekLanes; lane++) {
      const span = visible.find(item => item.lane === lane && item.entry.date <= dateKey && item.entry.end >= dateKey);
      lanes.append(span ? spanPiece(span, dateKey, date.getDay() === 0, today) : element('span', 'span-gap'));
    }
    const list = element('div', 'day-items');
    const dayTasks = (items.get(dateKey) || []).sort((a, b) => Number(isCandidate(a.task)) - Number(isCandidate(b.task)) ||
      TYPE_ORDER[markType(a.task, a.entry)] - TYPE_ORDER[markType(b.task, b.entry)] ||
      Number(a.entry.done === true) - Number(b.entry.done === true));
    const MAX = 3;
    const shown = dayTasks.slice(0, MAX);
    const chosen = dayTasks.findIndex(item => item.task.id === state.selected);
    if (chosen >= MAX) shown[MAX - 1] = dayTasks[chosen];
    for (const { task, entry, index } of shown) list.append(calendarItem(task, entry, index, today));
    if (dayTasks.length > MAX) list.append(element('span', 'more', `+${dayTasks.length - MAX}`));
    day.append(hit, lanes, list);
    days.push(day);
  }
  $('month').replaceChildren(...days);
}

// 왼쪽 목록은 고르는 곳이라 날짜도 짧게(11/13). 자세한 날짜·요일은 오른쪽 자세히에서 본다.
function monthDay(value) {
  const date = fromKey(value);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

// 기간이 이미 시작했으면 오늘 묶음에 둔다(오늘도 그 기간 안이므로).
function activeDay(entry, today) {
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
  return entry.date === today ? '오늘' : monthDay(entry.date);
}

function whenText(task, today) {
  const late = (task.dates || []).find(entry => entryLate(task, entry, today));
  if (late) return entryWhen(task, late, today);
  const next = (task.dates || []).find(entry => lastDay(entry) >= today) || task.dates?.[0];
  if (next) return entryWhen(task, next, today);
  if (task.chatSource) return '';
  const received = receivedDay(task.datetime || '');
  return received ? monthDay(received) : '';
}

// 목록 한 줄. entry가 있으면 그 날짜 하나를 보여 주고(이름이 제목), 없으면 업무 전체를 보여 준다.
// option.box: 'auto'(□가 있으면 체크), 'none'
// 상시 줄의 남은 날: D-23, 오늘이면 D-day, 지났으면 "N일 지남".
function pinnedWhen(task, today) {
  const entry = pinnedDue(task, today);
  if (!entry) return '';
  if (entryLate(task, entry, today)) return `${daysBetween(entry.date, today)}일 지남`;
  return entry.date === today ? 'D-day' : `D-${daysBetween(today, entry.date)}`;
}

function listRow(task, list, today, { entry = null, index = null, unread = false, pinned = false } = {}) {
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
  const type = entry ? markType(task, entry) : task.type !== '할 일' ? 'ref' : boxes(task).length ? 'task' : 'event';
  const row = element('li', `row type-${type}`);
  const rowKey = entry ? `${task.id}-${index}` : task.id;
  const doneNow = entry ? entry.done === true : finished(task);
  row.classList.toggle('selected', task.id === state.selected);
  row.classList.toggle('late', entry ? entryLate(task, entry, today) : isLate(task, today));
  row.classList.toggle('done', doneNow);
  const canCheck = !task.candidate && type === 'task' && (entry ? entry.kind === '까지' : boxes(task).length > 0);
  if (canCheck) {
    const check = button('check');
    check.setAttribute('aria-label', `${doneNow ? '끝냄 취소' : '끝냄'}: ${entry?.label || task.title}`);
    check.dataset.focusKey = `${list}-check-${rowKey}`;
    check.append(mark('task', doneNow));
    check.addEventListener('click', () => {
      if (entry) void toggleDone(task, index, !doneNow);
      else void toggleDone(task, 'all', !doneNow);
    });
    row.append(check);
  } else {
    const holder = element('span', 'check');
    holder.append(type === 'span' ? spanMark(task, entry ? index : task.dates.findIndex(item => item.kind === '기간')) : mark(type));
    row.append(holder);
  }
  const pick = button('pick');
  pick.dataset.focusKey = `${list}-${rowKey}`;
  pick.setAttribute('aria-pressed', String(task.id === state.selected));
  // 한 줄: 제목(넘치면 …) + 짧은 날짜. 전체 제목·쪽지 제목은 마우스를 올리면, 자세한 내용은 오른쪽에서 본다.
  // 표시는 확인이 필요한 것만 붙인다(빨강).
  const text = entry ? entry.label : task.title;
  pick.title = entry && entry.label !== task.title ? `${text}\n${task.title}` : text;
  pick.append(rowTitle(text));
  if (unread) markUnreadRow(row, pick);
  if (task.important) { row.classList.add('important'); pick.append(element('span', 'imp-flag', '중요')); }
  if (needsCheck(task)) pick.append(element('span', 'flag', checkLabel(task)));
  pick.append(element('span', 'row-when', entry ? entryWhen(task, entry, today) : whenText(task, today)));
  pick.addEventListener('click', () => selectTask(task.id, pick.dataset.focusKey));
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
  const drop = button('button text-button small candidate-drop', '×');
  drop.setAttribute('aria-label', `${task.title} 버리기`);
  drop.title = '후보 버리기';
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
    notice(input.batchId ? '남은 후보를 버렸습니다. 숨기기에서 되살릴 수 있습니다.' : '버렸습니다. 숨기기에서 되살릴 수 있습니다.');
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
  $('finish-chat-copy').textContent = `남은 후보 ${list.length}개는 버립니다. 숨기기에서 되살릴 수 있습니다.`;
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
  const done = button('button small candidate-finish', '정리 끝');
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
  $('candidate-count-label').textContent = notes.length ? rooms.size ? '대기' : '쪽지' : '방';
  $('candidate-count-detail').textContent = breakdown;
  $('candidate-count').parentElement.title = breakdown;
  updateTab('candidate', notes.length + rooms.size);
  return keys;
}

function renderLists() {
  const today = key(new Date());
  const todayDate = fromKey(today);
  const weekEnd = key(shift(todayDate, 6 - todayDate.getDay()));
  const nextWeekEnd = key(shift(todayDate, 13 - todayDate.getDay()));
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
  // 날짜 묶음은 할 일의 날짜 하나가 한 줄이다. 끝낸 까지와 지나간 그날은 빠진다.
  const rows = [];
  for (const task of tasks) {
    if (task.type !== '할 일' || checked.has(task.id)) continue;
    (task.dates || []).forEach((entry, index) => {
      if (entry.kind === '까지' ? entry.done : lastDay(entry) < today) return;
      rows.push({ task, entry, index });
    });
  }
  const byDate = (a, b) => Number(b.task.important === true) - Number(a.task.important === true) ||
    activeDay(a.entry, today).localeCompare(activeDay(b.entry, today)) || TYPE_ORDER[markType(a.task, a.entry)] - TYPE_ORDER[markType(b.task, b.entry)] ||
    a.entry.label.localeCompare(b.entry.label, 'ko');
  const dateless = tasks.filter(task => task.type === '할 일' && !checked.has(task.id) && !task.dates?.length && !task.done).sort(byReceived);
  const dateGroup = test => rows.filter(test).sort(byDate);
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
  const todoTasks = new Set(groups.flatMap(([, items]) => items.map(({ task }) => task)));
  const todoMessages = new Set([...todoTasks].map(taskMessageKey));
  const todoUnread = [...todoMessages].filter(message => unread.has(message)).length;
  const sections = [];
  for (const [name, items, className] of groups) {
    if (!items.length) continue;
    const section = element('section', `group${className ? ` ${className}` : ''}`);
    const heading = element('h3', null, name);
    if (items.length > 1) heading.append(element('span', 'group-count', String(items.length)));
    const list = element('ul', 'rows');
    list.append(...items.map(({ task, entry, index, pinned }) =>
      listRow(task, 'todo', today, { entry, index, pinned, unread: unread.has(taskMessageKey(task)) })));
    section.append(heading, list);
    sections.push(section);
  }
  $('todo-list').replaceChildren(...(sections.length ? sections : [element('p', 'empty-row', '할 일이 없습니다.')]));

  updateTab('todo', todoCount, todoUnread);

  const references = tasks.filter(task => task.type === '알아 둘 것' && !task.referenceSeen && !checked.has(task.id)).sort(byReceived);
  updateTab('reference', references.length, references.filter(task => unread.has(taskMessageKey(task))).length);
  $('reference-list').replaceChildren(...(references.length
    ? references.map(task => listRow(task, 'reference', today, { unread: unread.has(taskMessageKey(task)) }))
    : [element('li', 'empty-row', '확인할 것이 없습니다.')]));

  // 목록에서 내려간 쪽지도 다시 열 수 있게 한다. 여러 날짜 중 남은 일이 있으면 해야 할 것에 둔다.
  const done = tasks.filter(task => {
    if (noteReviewIds.has(task.id)) return false;
    if (task.type === '알아 둘 것') return task.referenceSeen;
    if (task.type !== '할 일' || todoTasks.has(task)) return false;
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
    : ![todoMessages, doneMessages, referenceMessages, candidateBatches].some(set => set.has(`chat:${message.id}`)));
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

  const { status, pending } = state.snapshot.inbox;
  // 처음 쓰는 사람: 브리티를 아직 연결하지 않았으면 오류 대신 할 일을 알려 준다.
  const notConnectedYet = !!state.snapshot.collectorAvailable && !state.snapshot.collectorConnected;
  $('inbox-note').textContent = status === 'unavailable' && notConnectedYet ? '브리티에 로그인한 뒤 위의 ‘브리티 연결’을 누르면 쪽지를 가져옵니다.'
    : status === 'unavailable' ? '쪽지 수집 폴더를 읽지 못했습니다. 연결 상태를 확인해 주세요.'
    : status === 'loading' ? '쪽지를 확인하고 있습니다.' : pending ? `아직 읽지 못한 쪽지 ${pending}건은 다음에 다시 확인합니다.` : '';
  // AI를 아직 연결하지 않았으면 정리하려면 무엇을 해야 하는지 알려 준다(샘플 제외).
  $('ai-setup-note').hidden = !!state.demo || (state.snapshot.aiProvider && state.snapshot.aiProvider !== 'none');
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

// 날짜를 보기만 할 때: □/● 날짜 이름 한 줄씩, 까지에는 끝냄 체크만. "날짜 고치기"를 눌러야 편집 칸이 열린다.
function readOnlyDateRow(task, entry, index, today) {
  const row = element('li', 'date-view');
  const type = markType(task, entry);
  const done = type === 'task' && entry.done === true;
  row.classList.toggle('late', entryLate(task, entry, today));
  row.classList.toggle('done', done);
  if (type === 'task' && !task.candidate) {
    const check = button('check');
    check.setAttribute('aria-label', `${done ? '끝냄 취소' : '끝냄'}: ${entry.label}`);
    check.disabled = state.saving || state.dirty;
    check.append(mark('task', done));
    check.addEventListener('click', () => void toggleDone(task, index, !done));
    row.append(check);
  } else {
    const holder = element('span', 'check');
    holder.append(type === 'span' ? spanMark(task, index) : mark(type));
    row.append(holder);
  }
  const when = entryLate(task, entry, today) ? `${shortDate(entry.date)}까지 · ${daysBetween(entry.date, today)}일 지남`
    : entry.kind === '기간' && entry.end ? `${shortDate(entry.date)}~${shortDate(entry.end)}`
    : `${entry.date === today ? '오늘' : shortDate(entry.date)}${entry.kind === '까지' ? '까지' : ''}`;
  row.append(element('span', 'date-when', when), element('span', 'date-name', entry.label));
  return row;
}

function renderDateRows() {
  const task = state.detail?.task;
  const dates = editingDates();
  const disabled = state.saving;
  state.rowsDrawn = true;
  $('dates-field').hidden = state.editType === '없음';
  const action = state.editingDates ? '취소' : dates.length ? '고치기' : '+ 날짜 넣기';
  $('edit-dates').textContent = action;
  $('edit-dates').setAttribute('aria-label', state.editingDates ? '날짜 편집 취소' : dates.length ? '날짜 고치기' : '날짜 넣기');
  $('edit-dates').setAttribute('aria-expanded', String(!!state.editingDates));
  $('edit-dates').disabled = disabled;
  $('add-date').hidden = !state.editingDates || dates.length >= taskModel.MAX_DATES;
  $('add-date').disabled = disabled;
  if (!state.editingDates) {
    const today = key(new Date());
    $('date-rows').replaceChildren(...dates.map((entry, index) => readOnlyDateRow(task, entry, index, today)));
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
      const option = element('option', null, name);
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
      end.min = nextDay(entry.date);
    });
    end.addEventListener('input', () => { entry.end = end.value; });
    kind.addEventListener('input', () => {
      entry.kind = kind.value;
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
    const nameRow = element('div', 'date-name-row');
    nameRow.append(field('달력에 표시할 이름', label), remove);
    row.append(field('날짜', date), field('종류', kind), endField, nameRow);
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
    $('edit-memo').value !== (task.memo || '') || JSON.stringify(editingDates()) !== JSON.stringify(task.dates || []);
  enableForm();
}

function enableForm() {
  const task = state.detail?.task;
  const type = state.editType;
  $('edit-title').disabled = state.saving;
  $('note-title-edit').disabled = state.saving;
  $('edit-memo').disabled = state.saving;
  for (const segment of $('type-seg').querySelectorAll('button')) {
    segment.setAttribute('aria-pressed', String(segment.dataset.type === type));
    segment.disabled = state.saving || !!task?.candidate?.discarded || (segment.dataset.type !== '할 일' && !task?.noteId && !task?.chatSource);
  }
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
  $('to-greeting').hidden = !task?.noteId;
  $('important').hidden = !task || !!task.candidate || task.type === '없음';
  $('important').disabled = state.saving || state.dirty;
  $('important').setAttribute('aria-pressed', String(task?.important === true));
  $('pin').hidden = task?.type !== '할 일' || type !== '할 일' || !!task?.candidate;
  $('pin').disabled = state.saving || state.dirty;
  $('pin').setAttribute('aria-pressed', String(task?.pinned === true));
  $('brity-reply').hidden = state.demo || state.detail?.note?.verified !== true;
  $('save').disabled = !state.dirty || state.saving;
  $('save').hidden = !state.dirty || !!task?.candidate;
  $('reference-seen').hidden = task?.type !== '알아 둘 것' || task.referenceSeen;
  $('reference-seen').disabled = state.dirty || state.saving;
  // 끝냄으로 표시: 남은 □를 한 번에 끝낸다. □가 없으면 숨긴다.
  const list = task && !task.candidate ? boxes(task) : [];
  const completed = !!task && finished(task);
  $('done').hidden = !list.length;
  $('done').disabled = state.dirty || state.saving;
  $('done').classList.toggle('marked', completed);
  $('done-label').textContent = completed ? '다시 열기' : '끝냄';
  $('done').title = completed ? '끝낸 마감을 다시 엽니다' : '남은 마감을 모두 끝냅니다';
  $('refine').disabled = state.demo || !state.detail?.note || task?.refining || state.dirty;
  $('work-copy').disabled = state.dirty || state.saving;
  $('work-edit-note').hidden = !state.dirty;
  // 날짜 줄은 입력 중 다시 그리지 않는다(글자 입력이 끊기지 않게). 저장 상태가 바뀔 때만 다시 그린다.
  if (state.rowsSaving !== state.saving || !state.rowsDrawn) {
    state.rowsSaving = state.saving;
    renderDateRows();
  } else {
    $('date-rows').querySelectorAll('.date-view .check').forEach(node => { node.disabled = state.dirty; });
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
  const meta = note ? [note.sender, note.datetime].filter(Boolean).join(' · ') : '';
  const recipients = note?.recipients?.trim() || '';
  const suffix = /\s*외\s*\d+\s*명?\s*$/u;
  const count = taskModel.recipientCount(recipients);
  $('note-recipient-summary').textContent = count ? `수신인 ${count}명` : '';
  $('note-recipient-summary').hidden = !count;
  $('note-recipients').hidden = !recipients;
  $('note-recipient-list').textContent = recipients.replace(suffix, '').trim();
  $('note-recipient-limited').hidden = !suffix.test(recipients);
  $('original-meta').textContent = meta;
  $('original-meta').hidden = !meta;
  $('original-meta-row').hidden = !meta && !recipients;
  $('original-title').textContent = note?.title || '';
  $('reply-section').hidden = !parts?.reply;
  $('reply-body').textContent = parts?.reply || '';
  $('previous-note').hidden = !parts;
  $('previous-subject').hidden = !parts?.subject;
  $('previous-subject').textContent = parts?.subject || '';
  $('previous-body').textContent = parts?.message || '';
  $('original-body').hidden = !!parts;
  $('original-body').textContent = parts ? '' : note?.body ?? '쪽지 원문을 불러오지 못했습니다.';
  $('raw-note-body').textContent = parts ? note.body : '';
}

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
    } else body.textContent = text;
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

function renderTitleEditor(task, note) {
  const tidy = value => String(value ?? '').replace(/\s+/gu, ' ').trim();
  const input = $('edit-title');
  const directEdit = !!task.candidate;
  const editing = directEdit || !!state.editingTitle;
  const preview = $('task-title-view');
  const repeat = !!note?.title && tidy(note.title) === tidy(input.value);
  preview.textContent = input.value;
  preview.hidden = editing || repeat;
  input.hidden = !editing;
  const toggle = $('note-title-edit');
  toggle.hidden = directEdit;
  toggle.textContent = editing ? '취소' : '고치기';
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
  $('detail-edit-jump').hidden = false;
  $('source-badge').textContent = task.forwardedSource ? '전달 글 원문' : task.candidate ? candidateBadge(task) : task.chatSource ? chatLabels[task.chatSource.action] : '직접 추가';
  $('source-badge').hidden = !!task.noteId || !!state.forwardedDraft;
  arrangeForwardedDraft(!!state.forwardedDraft);
  $('forwarded-draft-source').hidden = !state.forwardedDraft;
  $('forwarded-draft-text').textContent = detail.forwardedText || '';
  renderWhen(task, note);
  renderTitleEditor(task, note);
  $('verify-badge').hidden = task.noteState !== 'unverified';
  $('refine-section').hidden = !task.noteId;
  const optionalMemo = !!(task.noteId || task.chatSource);
  $('memo-label').textContent = optionalMemo ? '메모' : '내용';
  $('refine').textContent = task.refining ? '정리 중…' : state.snapshot.aiProvider === 'none' ? 'AI 연결' : task.refined === 'none' ? '다듬기' : '다시 다듬기';
  setMessage('refinement', task.refining ? '쪽지를 정리하고 있습니다.'
    : task.summary || '');
  // 안내 글은 할 일이 있을 때만(AI 연결 전, 원문 확인 필요). 평소에는 숨긴다.
  const aiName = aiNames[state.snapshot.aiProvider];
  const hint = state.demo ? '' : !aiName ? '설정에서 AI를 연결하면 제목과 날짜를 정리합니다.' : task.noteState === 'unverified' ? '원문을 확인한 뒤 다듬어 주세요.' : '';
  const failure = task.refined === 'failed' && !task.refining ? '마지막 다듬기에 실패했습니다.' : '';
  setMessage('refine-note', [failure, hint].filter(Boolean).join(' '));
  $('attachments-section').hidden = !note?.attachments.length;
  $('original-section').hidden = !task.noteId;
  $('work-section').hidden = !!task.chatSource;
  renderNote(note, reset);
  renderChatOriginal(batch ?? detail.forwardedBatch, task.candidate && !task.candidate.discarded ? task.candidate.evidence : [],
    task.forwardedSource, detail.forwardedBatch ?? batch);
  renderCandidateTargets(task, detail.roomTasks);
  renderAttachments(task.id, note?.attachments || []);
  enableForm();
}

function renderAttachments(id, attachments) {
  const first = attachments.find(item => item.available);
  $('attachment-count').textContent = attachments.length;
  $('attachment-folder').hidden = !first;
  $('attachment-folder').onclick = first ? () => openAttachment(id, first.index, true) : null;
  const rows = attachments.map(item => {
    const row = element('li', 'attachment-item');
    if (!item.available) row.append(element('span', 'attachment-name', item.name), element('span', 'small-note', '저장 파일 없음'));
    else {
      const open = button('button text-button small', item.name);
      open.title = item.direct ? '첨부 열기' : '폴더에서 보기';
      open.addEventListener('click', () => openAttachment(id, item.index, false));
      row.append(open);
      if (!item.direct) row.append(element('span', 'small-note', '폴더에서 보기'));
    }
    return row;
  });
  $('attachments').replaceChildren(...(rows.length ? rows : [element('li', 'small-note', '첨부가 없습니다.')]));
}

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
  $('chat-original').hidden = true;
  $('detail-edit-jump').hidden = true;
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
    return;
  }
  if (openDetail(id, null, focusKey)) void refreshDetail(true);
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
  state.detailToken++;
  state.selected = null;
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
  $('chat-original').hidden = true;
  $('detail-edit-jump').hidden = true;
  $('detail-heading').textContent = '자세히';
  $('detail-panel').classList.remove('open');
  fitWidth();
  setMessage('detail-message', '');
  redraw();
  restoreFocus(lastFocus);
}

function sync(snapshot) {
  // 새 대화방 후보가 생기면 한 번 알린다(처음 열 때와 되살린 후보는 알리지 않음).
  const seen = state.seenCandidates;
  const fresh = snapshot.tasks.filter(task => task.candidate && !seen?.has(task.id));
  state.seenCandidates = new Set([...(seen || []), ...snapshot.tasks.filter(task => task.candidate).map(task => task.id)]);
  if (seen && fresh.length) setTimeout(() => notice(`대화방 후보 ${fresh.length}개가 분류할 것에 들어왔습니다.`), 0);
  state.snapshot = snapshot;
  state.demo = snapshot.demo ?? state.demo;
  if (state.demo) document.title = '브리티 메신저 캘린더 · 샘플';
  $('demo-badge').hidden = !state.demo;
  $('automatic').disabled = !!state.demo || snapshot.aiProvider === 'none' || !!state.savingAutomatic || !!state.testingAi;
  $('automatic').checked = snapshot.automatic;
  renderCollector();
  renderAutoRefresh();
  renderRange();
  renderUpdate();
  redraw();
  if (state.selectedChat && state.chatLoaded) renderChatOriginal(state.chatLoaded);
  void refreshDetail();
}

function renderCollector() {
  const { collector, collectorAvailable, collectorConnected, collectorFirstImportPending } = state.snapshot;
  $('collector-bar').hidden = !collectorAvailable;
  if (!collectorAvailable) return;
  const status = collector?.status || 'idle';
  const auto = state.snapshot.autoRefresh?.notes;
  const checked = collector?.checkedAt ? `마지막 확인 ${new Date(collector.checkedAt).toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' })}` : '';
  const schedule = collectorFirstImportPending ? '첫 가져오기 설정 중' : auto?.enabled ? `자동 갱신 ${minutesLabel(auto.minutes)}마다` : '수동 가져오기';
  const messages = {
    idle: '브리티에 로그인한 뒤 연결하세요. 가져온 쪽지는 브리티에서 읽음 처리됩니다.',
    connecting: '브리티의 쪽지 목록을 확인하고 있습니다.',
    ready: collector?.managed ? [schedule, checked].filter(Boolean).join(' · ') : '이미 실행 중인 브리티 수집기의 결과를 읽습니다.',
    'in-use': '브리티를 쓰는 중이라 이번에는 쪽지를 가져오지 않았습니다. 쪽지 가져오기를 누르면 확인한 뒤 가져옵니다.',
    offline: collectorConnected && auto?.enabled && !collectorFirstImportPending
      ? '브리티 메신저가 닫혀 있습니다. 다시 열고 로그인하면 자동으로 연결합니다.'
      : '브리티 메신저를 열고 로그인한 뒤 연결해 주세요.',
    unverified: collectorConnected && auto?.enabled && !collectorFirstImportPending
      ? '브리티 창을 한 번 열어 주세요. 창이 화면에 보이면 자동으로 다시 연결합니다.'
      : '브리티에 로그인하고 창을 화면에 띄운 뒤 다시 연결해 주세요.',
    conflict: '수집기를 자동으로 연결할 수 없습니다. 현재 설정된 저장 폴더에서만 쪽지를 읽습니다.',
    unavailable: '쪽지 수집기를 연결하지 못했습니다. ZIP 전체를 푼 폴더에서 앱을 다시 열어 주세요.',
  };
  const running = status === 'ready' || status === 'in-use';
  $('collector-title').textContent = running ? '브리티 연결됨' : '브리티 쪽지 연결';
  $('collector-status').textContent = messages[status] || messages.unavailable;
  // 연결한 뒤에는 이 버튼이 "지금 가져오기"다. 자동 분류가 꺼져 있어도 이렇게 가져온 쪽지는 분류한다.
  $('collector-connect').textContent = state.connectingCollector ? '가져오는 중…' : status === 'connecting' ? '연결 중…'
    : collectorFirstImportPending ? '첫 가져오기 계속' : collectorConnected ? '쪽지 가져오기' : '브리티 연결';
  $('collector-connect').disabled = !!state.connectingCollector || status === 'connecting' || !!state.rangeBusy;
}

function minutesLabel(minutes) {
  return minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60}시간` : `${minutes}분`;
}

function chatCollectionText(snapshot) {
  const { autoRefresh, chatRooms, chatCollection, chatRefreshFailed, collectorFirstImportPending } = snapshot;
  if (snapshot.demo) return '';
  if (chatRefreshFailed) return '저장된 대화를 읽지 못했습니다. 다음 확인 때 다시 시도합니다.';
  if (!autoRefresh?.chats.enabled) return '대화방 자동 갱신이 꺼져 있습니다.';
  if (!chatRooms?.length) return '가져올 방을 선택해 주세요.';
  if (collectorFirstImportPending) return '첫 쪽지 가져오기 설정이 끝나면 자동으로 확인합니다.';
  if (!chatCollection) return '선택한 방의 첫 자동 확인을 기다리는 중입니다.';
  const { checkedAt, status, added, retry, needsReview } = chatCollection;
  const time = new Date(checkedAt);
  const day = key(time);
  const clock = time.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
  const checked = day === key(new Date()) ? clock : `${shortDate(day)} ${clock}`;
  const reasons = {
    'in-use': '브리티 창 최소화 대기',
    offline: '브리티 로그인 대기',
    conflict: '브리티 사용 중'
  };
  const result = status === 'ready' ? `새 글 ${added}건` : reasons[status] || '대화방을 읽지 못했습니다';
  const skipped = retry + needsReview;
  return [`마지막 확인 ${checked}`, result, status !== 'ready' && added ? `새 글 ${added}건` : '',
    skipped ? `확인 보류 ${skipped}개 방` : ''].filter(Boolean).join(' · ');
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
  const status = chatCollectionText(state.snapshot);
  if ($('chat-collection-status').textContent !== status) setMessage('chat-collection-status', status);
}

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
    let next = await api.collectNow(false);
    if (next.collector?.status === 'in-use' && window.confirm('브리티를 쓰는 중입니다. 지금 쪽지를 가져올까요?\n가져오는 동안 브리티 화면이 잠깐 쪽지 목록으로 바뀔 수 있습니다.')) {
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
  const isApi = factchat || provider === 'openai';
  const hasStoredKey = isApi && state.snapshot.aiProvider === provider;
  $('ai-settings').hidden = !!state.demo;
  $('ai-key-options').hidden = !isApi;
  $('ai-key-label').textContent = factchat ? '팩트챗 API 키' : 'OpenAI API 키';
  $('ai-key').placeholder = hasStoredKey ? '비워 두면 저장된 키 사용' : factchat ? 'baze_…' : 'sk-…';
  $('ai-key-guide').dataset.aiGuide = factchat ? 'factchat' : 'key';
  $('ai-key-guide').textContent = factchat ? '서룡 팩트챗 개발자 화면 ↗' : 'API 키 발급 ↗';
  $('ai-key-guide').hidden = factchat && !state.snapshot.factchatGuideAvailable;
  $('ai-billing-guide').hidden = factchat;
  $('cli-guide').hidden = provider !== 'codex' && provider !== 'claude';
  $('claude-steps').hidden = provider !== 'claude';
  $('cli-guide').textContent = provider === 'claude' ? '설치·로그인이 안 될 때 안내 ↗' : 'CLI 설치와 로그인 안내 ↗';
  $('ai-provider').disabled = !!state.testingAi;
  $('ai-connect').disabled = !!state.testingAi || (provider === 'none' && state.snapshot.aiProvider === 'none');
  $('ai-connect').textContent = state.testingAi ? '연결 시험 중…' : provider === 'none' ? 'AI 연결 끄기' : '연결 시험 및 저장';
  $('ai-hint').textContent = isApi ? 'API 키를 붙여 넣으세요. 연결 시험에는 가짜 쪽지를 사용합니다.' : provider === 'none' ? 'AI 연결 없이도 쪽지를 가져오고 달력에 기록할 수 있습니다.'
    : provider === 'claude' ? 'Claude 구독(Pro 이상)으로 Haiku 모델을 씁니다. ‘연결 시험 및 저장’을 누르면 Claude Code가 없을 때 설치할지 묻고, 로그인이 필요하면 로그인 창을 엽니다.'
    : '이 PC의 CLI 로그인으로 가짜 쪽지 한 건을 시험합니다.';
}

function openSettings() {
  setMessage('settings-error', '');
  setMessage('ai-status', aiNames[state.snapshot.aiProvider] ? `현재 연결 방식 · ${aiNames[state.snapshot.aiProvider]}` : '');
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
  renderAiSettings();
  $('settings-dialog').showModal();
}

// 새 판 알림(머리줄)과 바뀐 점 창.
function renderUpdate() {
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
    $('shortcut-status').textContent = '바탕 화면에 "브리티 메신저 캘린더" 바로 가기를 만들었습니다.';
  } catch (error) {
    $('shortcut-status').textContent = error.message;
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
const RANGE_COST = 0.00045; // 쪽지 1건에 호출 1번, 180건 약 0.08달러(분류 시험 추정)
const firstImportDialog = $('first-import-dialog');
const rangeSettings = $('range-settings');
const rangeHome = document.createComment('range settings home');
rangeSettings.before(rangeHome);

function renderFirstImport() {
  if (!firstImportDialog.open) return;
  const { collector, collectorConnected, collectorFirstImportPending, autoRefresh, rangeImport } = state.snapshot;
  const connecting = !!state.firstImportConnecting;
  const saving = !!state.firstImportSaving;
  const ready = collectorConnected && collectorFirstImportPending && collector?.status === 'ready';
  const busy = connecting || saving || !!state.rangeBusy || !!rangeImport?.running;
  const message = state.firstImportError || (connecting ? '브리티 쪽지 목록에 연결하고 있습니다.'
    : ready && !collector.managed ? '다른 수집기가 실행 중이라 이 창에서 기간을 정해 가져올 수 없습니다.'
      : ready ? '원하는 기간을 고르고 몇 건을 가져올 수 있는지 확인하세요.'
        : '브리티에 로그인하고 창을 띄운 뒤 연결을 다시 확인해 주세요.');
  setMessage('first-import-connection', message, !!state.firstImportError);
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
  renderRange();
  try { sync(await api.connectCollector()); }
  catch (error) { state.firstImportError = error.message; }
  finally {
    state.firstImportConnecting = false;
    renderRange();
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
    notice(automatic ? '쪽지 자동 갱신을 켰습니다.' : '수동으로 설정했습니다. 위쪽에서 ‘쪽지 가져오기’를 누르세요.');
  } catch (error) {
    state.firstImportError = error.message;
  } finally {
    state.firstImportSaving = false;
    renderRange();
  }
});

function renderRange() {
  const snap = state.snapshot;
  const first = firstImportDialog.open;
  const available = !!snap.collectorAvailable && !!snap.collectorConnected &&
    (!first || (snap.collector?.status === 'ready' && snap.collector.managed && !state.firstImportConnecting));
  const running = !!snap.rangeImport?.running;
  const busy = running || !!state.rangeBusy || !!state.firstImportSaving;
  $('range-preview').disabled = !available || busy;
  $('range-import').disabled = !available || busy || !state.rangePreview?.fresh;
  $('range-from').disabled = $('range-to').disabled = !available || busy;
  $('range-stop').hidden = !running;
  $('range-stop').disabled = !!snap.rangeImport?.stopping;
  if (running) {
    const { done, total, stopping } = snap.rangeImport;
    setMessage('range-status', stopping ? '이번 묶음을 마치고 멈춥니다…' : `불러오는 중 · ${total ? `${total}건 중 ` : ''}${done}건`);
  } else if (!available && !first && !state.rangeMessage) {
    setMessage('range-status', snap.demo ? '샘플에서는 불러올 수 없습니다.' : '머리줄에서 브리티를 먼저 연결해 주세요.');
  }
  const pending = snap.rangePending || 0;
  $('range-classify-row').hidden = !pending || running;
  $('range-classify').disabled = snap.aiProvider === 'none' || !!state.rangeBusy;
  $('range-classify-note').textContent = snap.aiProvider === 'none' ? `정리 전 ${pending}건 · AI를 연결하면 분류할 수 있습니다.`
    : `정리 전 ${pending}건 · AI 호출 ${pending}번, 약 ${(pending * RANGE_COST).toFixed(3)}달러`;
  renderFirstImport();
}

function rangeInput() {
  return [$('range-from').value, $('range-to').value];
}

async function rangeAction(run) {
  state.rangeBusy = true;
  renderRange();
  try { await run(); }
  catch (error) { state.rangeMessage = true; setMessage('range-status', error.message, true); }
  finally { state.rangeBusy = false; renderRange(); }
}

$('range-from').addEventListener('change', () => { state.rangePreview = null; renderRange(); });
$('range-to').addEventListener('change', () => { state.rangePreview = null; renderRange(); });
$('range-preview').addEventListener('click', () => void rangeAction(async () => {
  state.rangeMessage = true;
  setMessage('range-status', '브리티 쪽지 목록을 세고 있습니다(쪽지는 열지 않습니다).');
  const preview = await api.previewRange(...rangeInput());
  state.rangePreview = preview;
  const already = preview.matched - preview.fresh;
  setMessage('range-status', `목록에 보이는 쪽지 ${preview.visible}건 가운데 이 기간 ${preview.matched}건${already ? `(이미 받은 ${already}건 빼면 ${preview.fresh}건)` : ''}을 불러올 수 있습니다.` +
    (preview.oldest ? ` 목록에서 가장 오래된 날은 ${preview.oldest}입니다.` : '') + (preview.unknown ? ` 날짜를 못 읽은 ${preview.unknown}건은 뺐습니다.` : ''));
}));
$('range-import').addEventListener('click', () => void rangeAction(async () => {
  const count = state.rangePreview?.fresh || 0;
  if (!window.confirm(`쪽지 ${count}건을 브리티에서 열어 불러옵니다. 안 읽은 쪽지는 읽음 처리됩니다. 불러오는 동안 브리티 화면이 쪽지 목록으로 바뀝니다. 계속할까요?`)) return;
  state.rangeMessage = true;
  const result = await api.importRange(...rangeInput());
  if (firstImportDialog.open && result.imported) state.firstImportImported = true;
  state.rangePreview = null;
  setMessage('range-status', `${result.imported}건을 불러왔습니다.${result.stopped ? ' 중간에 멈췄습니다.' : ''}${result.failed ? ' 브리티 목록을 읽지 못해 끝까지 불러오지 못했습니다.' : ''}`, result.failed);
  if (result.pending && state.snapshot.aiProvider !== 'none' &&
      window.confirm(`불러온 쪽지 ${result.pending}건을 AI로 보내 분류할까요?\nAI 호출 ${result.pending}번, 약 ${(result.pending * RANGE_COST).toFixed(3)}달러입니다. 지난 마감은 끝낸 것으로 넣습니다.`)) {
    const queued = await api.classifyRange();
    setMessage('range-status', `${result.imported}건을 불러왔고 ${queued}건을 분류하고 있습니다.`);
  }
}));
$('range-stop').addEventListener('click', () => void api.stopRange().then(sync, () => {}));
$('range-classify').addEventListener('click', () => void rangeAction(async () => {
  const pending = state.snapshot.rangePending || 0;
  if (!window.confirm(`불러온 쪽지 ${pending}건을 AI로 보내 분류할까요?\nAI 호출 ${pending}번, 약 ${(pending * RANGE_COST).toFixed(3)}달러입니다. 지난 마감은 끝낸 것으로 넣습니다.`)) return;
  const queued = await api.classifyRange();
  state.rangeMessage = true;
  setMessage('range-status', `${queued}건을 분류하고 있습니다.`);
}));

function renderBackup() {
  const busy = !!state.backingUp;
  $('backup-settings').hidden = !!state.demo;
  $('backup-create').disabled = busy;
  $('backup-restore').disabled = busy;
  $('rules-update').hidden = !state.snapshot.rulesUpdate?.pending;
  $('shortcut-row').hidden = !state.snapshot.shortcutAvailable;
  $('app-version').textContent = state.snapshot.appVersion ? `브리티 메신저 캘린더 ${state.snapshot.appVersion}판` : '';
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

function showCreate(date) {
  $('create-form').reset();
  $('create-due').value = date;
  setMessage('create-error', '');
  $('create-dialog').showModal();
}

async function saveDetail(type = state.editType) {
  const id = state.selected;
  if (!id || state.saving) return;
  const previousType = state.detail?.task.type;
  state.editType = type;
  if (type !== '없음' && !$('edit-form').reportValidity()) return;
  state.saving = true;
  enableForm();
  const dates = type === '없음' ? undefined : editingDates().map(({ date, end, label, kind, done }) => ({ date, label, kind, ...(kind === '까지' && { done: done === true }), ...(kind === '기간' && { end }) }));
  const input = { title: $('edit-title').value, type, dates, memo: $('edit-memo').value, revision: state.revision };
  try {
    await api.update(id, input);
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
      : type === '할 일' ? '할 일로 옮겼습니다.' : `‘${typeLabels[type]}’으로 옮겼습니다.`;
    setMessage('detail-message', message);
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
      setMessage('detail-message', '쪽지 정리를 완료했습니다.');
    } else if (result.status === 'failed') setMessage('detail-message', result.message, true);
    else if (result.status === 'edited') setMessage('detail-message', '편집한 내용이 있어 AI 결과를 적용하지 않았습니다.');
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
$('detail-edit-jump').addEventListener('click', () => {
  const form = $('edit-form');
  form.focus({ preventScroll: true });
  form.scrollIntoView({ block: 'start' });
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && $('detail-panel').classList.contains('open') && !document.querySelector('dialog[open]')) closeDetail();
});
$('create-cancel').addEventListener('click', () => $('create-dialog').close());
$('create-form').addEventListener('submit', async event => {
  event.preventDefault();
  $('create-save').disabled = true;
  try {
    const task = await api.create({ title: $('create-title').value, due: $('create-due').value, memo: $('create-memo').value });
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
$('settings-open').addEventListener('click', openSettings);
$('settings-close').addEventListener('click', () => $('settings-dialog').close());
$('settings-dialog').addEventListener('close', () => { $('ai-key').value = ''; });
$('ai-provider').addEventListener('change', () => { $('ai-key').value = ''; renderAiSettings(); });
$('ai-connect').addEventListener('click', async () => {
  const provider = $('ai-provider').value;
  state.testingAi = true;
  $('automatic').disabled = true;
  renderAiSettings();
  setMessage('ai-status', provider === 'none' ? '' : '가짜 쪽지로 연결을 시험하고 있습니다.');
  try {
    if (provider === 'claude' && !(await prepareClaude())) return;
    try {
      sync(await api.connectAi(provider, $('ai-key').value));
    } catch (error) {
      // Claude: 로그인이 안 되어 있으면 로그인 창을 띄우고, 창을 닫으면 한 번 더 시험한다.
      if (provider !== 'claude' || !String(error.message).startsWith('Claude Code에 로그인')) throw error;
      setMessage('ai-status', '로그인 창을 열었습니다. 창의 안내대로 Claude 구독 계정으로 로그인하고, 끝나면 그 창을 닫으세요. 창을 닫으면 자동으로 다시 시험합니다.');
      const login = await api.claudeLogin();
      if (!login?.closed) throw new Error('로그인 창이 닫히지 않았습니다. 로그인을 마치고 창을 닫은 뒤 ‘연결 시험 및 저장’을 다시 눌러 주세요.');
      setMessage('ai-status', '로그인을 확인하고 있습니다.');
      sync(await api.connectAi(provider, ''));
    }
    $('ai-key').value = '';
    setMessage('ai-status', provider === 'none' ? 'AI 연결을 껐습니다.' : `${aiNames[provider]} 연결 시험을 통과했습니다.`);
  } catch (error) {
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
// Claude Code가 없으면 묻고 설치한다. 설치를 취소하면 false.
async function prepareClaude() {
  const { executable } = await api.claudeStatus();
  if (executable) return true;
  setMessage('ai-status', 'Claude Code가 없습니다. 설치할지 묻는 창을 확인해 주세요.');
  const timer = setTimeout(() => setMessage('ai-status', 'Claude Code를 설치하고 있습니다. 1~2분 걸립니다. 창을 닫지 마세요.'), 1500);
  try {
    const result = await api.claudeInstall();
    if (result?.cancelled) { setMessage('ai-status', '설치를 취소했습니다. ‘설치 명령 복사’로 직접 설치할 수도 있습니다.'); return false; }
    setMessage('ai-status', result?.installed ? 'Claude Code를 설치했습니다. 연결을 시험합니다.' : '가짜 쪽지로 연결을 시험하고 있습니다.');
    return true;
  } finally {
    clearTimeout(timer);
  }
}
$('claude-login').addEventListener('click', async () => {
  setMessage('ai-status', '로그인 창을 열었습니다. 로그인을 마치고 그 창을 닫은 뒤 ‘연결 시험 및 저장’을 누르세요.');
  try { await api.claudeLogin(); }
  catch (error) { setMessage('ai-status', error.message, true); }
});
$('claude-install-copy').addEventListener('click', async () => {
  try { const command = await api.claudeInstallCopy(); setMessage('ai-status', `설치 명령을 복사했습니다: ${command} — 시작 메뉴에서 PowerShell을 열어 붙여 넣고 Enter를 누르세요. 끝나면 ‘로그인 창 열기’를 누르세요.`); }
  catch (error) { setMessage('ai-status', error.message, true); }
});
document.querySelectorAll('[data-ai-guide]').forEach(button => button.addEventListener('click', () => void openAiGuide(button.dataset.aiGuide)));
$('cli-guide').addEventListener('click', () => void openAiGuide($('ai-provider').value));
async function changeCollector(action) {
  state.connectingCollector = true;
  renderCollector();
  let failure;
  try { sync(await action()); }
  catch (error) { failure = error.message; }
  finally {
    state.connectingCollector = false;
    renderCollector();
    if (failure) $('collector-status').textContent = failure;
  }
}
$('collector-connect').addEventListener('click', () => void collectNow());
$('ai-setup-open').addEventListener('click', () => $('settings-open').click());
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
document.querySelectorAll('#type-seg button').forEach(segment => segment.addEventListener('click', () => {
  const type = segment.dataset.type;
  if (!state.detail || state.saving || type === state.editType) return;
  if (isCandidate(state.detail.task)) {
    // 후보는 유형만 바꿔 두고 '올리기'로 한 번에 올린다.
    state.editType = type;
    markDirty();
    return;
  }
  state.dirty = true;
  void saveDetail(type);
}));
$('candidate-accept').addEventListener('click', async () => {
  const id = state.selected;
  const source = state.forwardedDraft;
  const task = state.detail?.task;
  if (!isCandidate(task) || state.saving || !$('edit-form').reportValidity()) return;
  state.saving = true;
  enableForm();
  const type = state.editType;
  const dates = editingDates().map(({ date, end, label, kind }) => ({ date, label, kind, ...(kind === '까지' && { done: false }), ...(kind === '기간' && { end }) }));
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
    if (savedId === state.selected) setMessage('detail-message', type === '할 일' ? '할 일로 올렸습니다.' : '확인할 것으로 올렸습니다.');
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
      setMessage('detail-message', '분류할 것으로 되돌렸습니다.');
    }
  } catch (error) {
    if (task.id === state.selected) setMessage('detail-message', error.message, true);
  }
});
$('important').addEventListener('click', async () => {
  const task = state.detail?.task;
  if (!task || state.dirty || state.saving) return;
  $('important').disabled = true;
  try {
    await api.setImportant(task.id, !task.important);
    if (task.id === state.selected) setMessage('detail-message', task.important ? '중요 표시를 뗐습니다.' : '중요로 표시했습니다. 목록 묶음 맨 위에 둡니다.');
  } catch (error) {
    if (task.id === state.selected) setMessage('detail-message', error.message, true);
  } finally {
    enableForm();
  }
});
$('pin').addEventListener('click', async () => {
  const task = state.detail?.task;
  if (!task || state.dirty || state.saving) return;
  $('pin').disabled = true;
  try {
    await api.setPinned(task.id, !task.pinned);
    if (task.id === state.selected) setMessage('detail-message', task.pinned ? '상시에서 내렸습니다. 날짜 묶음에 다시 보입니다.' : '목록 맨 위 상시 묶음에 띄웠습니다.');
  } catch (error) {
    if (task.id === state.selected) setMessage('detail-message', error.message, true);
  } finally {
    enableForm();
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
let savedView = 'todo';
try { savedView = localStorage.getItem('calendar-list-view') || 'todo'; } catch {}
showView(savedView);
$('done').addEventListener('click', async () => {
  const task = state.detail?.task;
  if (!task) return;
  const wasFinished = finished(task);
  $('done').disabled = true;
  try {
    await api.setDone(task.id, !wasFinished, 'all');
    if (task.id === state.selected) setMessage('detail-message', wasFinished ? '완료 표시를 취소했습니다.' : '남은 마감을 모두 끝냄으로 표시했습니다.');
  } catch (error) {
    if (task.id === state.selected) {
      setMessage('detail-message', error.message, true);
      enableForm();
    }
  }
});
$('reference-seen').addEventListener('click', async () => {
  const id = state.selected;
  if (!id) return;
  try {
    await api.markReferenceSeen(id);
    if (id === state.selected) setMessage('detail-message', '끝낸 것에서 다시 볼 수 있습니다.');
  } catch (error) {
    if (id === state.selected) setMessage('detail-message', error.message, true);
  }
});
$('brity-reply').addEventListener('click', async () => {
  const id = state.selected;
  if (!id || state.detail?.note?.verified !== true) return;
  $('brity-reply').disabled = true;
  setMessage('detail-message', '브리티에서 쪽지를 찾고 있습니다.');
  try {
    const { foreground } = await api.replyInBrity(id);
    if (id === state.selected) setMessage('detail-message', foreground ? '브리티 답장창을 열었습니다.' : '답장창을 열었습니다. 작업 표시줄에서 브리티 창을 선택해 주세요.');
  } catch (error) {
    if (id === state.selected) setMessage('detail-message', error.message, true);
  } finally {
    $('brity-reply').disabled = false;
  }
});
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
    $('send-dialog').showModal();
    $('send-cancel').focus();
  } catch (error) {
    setMessage('detail-message', error.message, true);
  }
}
$('refine').addEventListener('click', () => {
  if (state.snapshot.aiProvider === 'none') openSettings();
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
    if (id === state.selected) setMessage('work-message', '지시문을 복사했습니다. 원하는 채팅에 붙여 넣으세요.');
  } catch (error) {
    if (id === state.selected) setMessage('work-message', error.message, true);
  }
});

const paneSettingsKey = 'calendar-pane-widths';
const paneWidths = {};
try {
  const saved = JSON.parse(localStorage.getItem(paneSettingsKey));
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
  const sideBySide = !narrow && $('detail-panel').classList.contains('open');
  const available = viewWidth - 540 - 2 * divider;
  const listMax = other => Math.min(480, sideBySide ? available - other : viewWidth - 410 - divider);
  const detailMax = other => Math.min(700, narrow ? viewWidth - 72 : available - other);
  const list = clamp(paneWidths.list ?? 240, listMin, listMax(detailMin));
  const detail = clamp(paneWidths.detail ?? (narrow ? 440 : Math.max(360, viewWidth * .30)), detailMin, detailMax(list));
  for (const [side, value, min, max] of [
    ['list', list, listMin, listMax(detail)], ['detail', detail, detailMin, detailMax(list)]
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

redraw();
api.onChange(sync);
api.load().then(sync, error => { $('inbox-note').textContent = error.message; });
