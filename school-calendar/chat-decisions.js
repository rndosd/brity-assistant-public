'use strict';

const DAY = 86_400_000;
const KOREA_OFFSET = 9 * 60 * 60 * 1000;
const WEEKDAYS = '일월화수목금토';
const CLOCK = /(?<!\d)(?:(오전|오후)\s*)?(\d{1,2})(?::([0-5]\d)|\s*시(?:\s*([0-5]?\d)\s*분)?)(?!\d|간)/gu;
const DATES = /(?<![\d./-])(?:(?:(?<year>\d{4})\s*년\s*)?(?<month>\d{1,2})\s*월\s*(?<day>\d{1,2})\s*일|(?:(?<numericYear>\d{4})[./-]\s*)?(?<numericMonth>\d{1,2})[./-]\s*(?<numericDay>\d{1,2})(?!\d|[./-]\s*\d)|(?<relative>오늘|내일|모레|글피)|(?:(?<week>이번|다음|다다음)\s*주\s*)?(?<weekday>[월화수목금토일])요일)/gu;
const TASK_VERBS = [
  ['제출', '제출|내|보내'], ['회신', '회신|답장|응답'], ['신청', '신청'], ['작성', '작성'],
  ['확인', '확인|검토'], ['공유', '공유|전달'], ['제출', '송부'], ['등록', '등록|입력'],
  ['정리', '정리'], ['준비', '준비|챙겨'], ['제출', '업로드'], ['예약', '예약'],
  ['수정', '수정|고쳐'], ['작성', '적어'], ['회수', '회수'], ['배부', '배부'], ['제출', '올려']
];
const VERBS = new Map(TASK_VERBS.flatMap(([label, variants]) => variants.split('|').map(variant => [variant, label])));
const VERB_PATTERN = [...VERBS.keys()].sort((a, b) => b.length - a.length).join('|');
const TASK_WORD = new RegExp(`(?<verb>${VERB_PATTERN})(?=$|\\s|[.,!?]|해|하|한|할|을|를|은|는|이|가|주|면|야|드립니다)`, 'gu');
const REQUEST_END = /(?:부탁(?:드려요|드립니다|드릴게요|해요|합니다)?|(?:해|하여|해\s*서|어|아|고)?\s*(?:주\s*(?:세요|십시오|시기\s*바랍니다|시면\s*(?:됩니다|감사합니다))|바랍니다)|(?:해|어|아|해야)\s*야?\s*(?:합니다|해요|됩니다))\s*[.!~…]*$/u;
const EVENT_WORD = /(?:설명회|협의회|간담회|연수회|회의|연수|워크숍|행사|면담|상담|체험학습|현장학습|수업|발표회|공연|대회|모임|면접|집합|점검|총회|교육|훈련)(?=$|\s|[은는이가을를에·,]|입니다|합니다)/gu;
const FINAL_FORM = '(?:됐(?:습니다|어요)|되었(?:습니다|어요)|됩니다|합니다|했(?:습니다|어요)|하겠습니다|할게요|하기로\\s*했(?:습니다|어요)|입니다|이에요|드립니다)?';
const final = pattern => new RegExp(`(?:${pattern})\\s*[.!~…]*$`, 'u');
const CHANGE = final(`(?:변경|연기|조정)\\s*${FINAL_FORM}|로\\s*(?:바뀌었|미뤄졌|옮겨졌|바꿨)(?:습니다|어요)|(?:옮기겠습니다|미루겠습니다|앞당깁니다)|변경으로\\s*(?:확정|결정)${FINAL_FORM}`);
const CANCEL = final(`(?:취소|철회|폐지)\\s*${FINAL_FORM}|(?:취소로|취소하기로)\\s*(?:확정|결정)${FINAL_FORM}|(?:진행|실시)하지\\s*않(?:습니다|기로\\s*했습니다)`);
const CONFIRM = final(`(?:확정|결정)\\s*${FINAL_FORM}|(?:진행|실시|개최|시작|집합)(?:합니다|됩니다|하겠습니다|할게요|하기로\\s*했(?:습니다|어요)|하기로\\s*결정)|열립니다|(?:하기로\\s*했(?:습니다|어요)|로\\s*정했(?:습니다|어요))`);
const PROPOSAL = /[?？]|어떨까요|어때요|가능할까요|(?:할|될|일)\s*까요|제안(?:합니다|드립니다|드려요)|예정(?:입니다|이에요|이고|으로|중|입니)?\s*[.!~…]*$|(?:검토|논의|고려)\s*(?:중|하겠|할\s*예정)|가안|미정|(?:일|될)\s*수\s*있|(?:할|될)\s*것\s*같|면\s*좋겠/u;
const REJECTION = /(?:미정|잠정|가안|변동\s*가능|정해지면)|(?:확정|결정|변경|연기|취소|진행)\s*(?:되지\s*않|안\s*(?:됐|되)|하지\s*않(?:겠|았))|(?:취소|변경)하지\s*않|(?:취소|변경|연기)\s*없(?:습니다|어요)|취소가\s*아니/u;
const OLD_TEXT = /(?:라고|다고)\s*(?:했|하시|전했|하셨|들었)|기존\s*안내|이전\s*내용/u;
const SIMPLE_CONFIRM = /(?:^|\s)(?:네|예|넵|그럼|그러면|그렇게|말씀하신|그날|그때|그\s*날|해당\s*일정)(?:\s|[,.]|$)|(?:그대로|그\s*일정)\s*(?:진행|확정|변경)/u;
const SHORT_ACCEPTANCE = final('(?:으로|로)\\s*(?:할게요|하죠|하겠습니다)|그렇게\\s*(?:할게요|하죠|하겠습니다)');
const PLAIN_DECLARATION = /(?:입니다|이에요|예요|있습니다|있어요|합니다|합니다\s*참고|합니다\s*확인)\s*[.!~…]*$/u;
const trimPunctuation = text => text.replace(/^[\s,.:;·!~…()[\]<>"'‘’“”]+|[\s,.:;·!~…()[\]<>"'‘’“”]+$/gu, '');

function canonicalDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

function wallTime({ 1: meridiem, 2: hourText, 3: colonMinute, 4: minuteText, 0: token }) {
  let hour = Number(hourText);
  const minute = Number(colonMinute ?? minuteText ?? 0);
  if (hour > 23 || (meridiem && (hour < 1 || hour > 12))) return null;
  if (meridiem) hour = hour % 12 + (meridiem === '오후' ? 12 : 0);
  if (!meridiem && !token.includes(':') && hour >= 1 && hour <= 12) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function findDate(text, observedAt) {
  const timestamp = Date.parse(observedAt);
  if (!Number.isFinite(timestamp)) return { due: null, time: null };
  const local = new Date(timestamp + KOREA_OFFSET);
  const midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  const weekday = local.getUTCDay();
  const matches = [...text.matchAll(DATES)];
  const suffix = match => text.slice(match.index + match[0].length)
    .replace(/^\s*\([월화수목금토일](?:요일)?\)\s*/u, '')
    .replace(/^\s*(?:(?:오전|오후)\s*)?\d{1,2}(?:\s*시(?:\s*\d{1,2}\s*분)?|:\d{2})/u, '');
  const sources = matches.filter(match => /^\s*(?:에서|(?:이|였|예정이)던)/u.test(suffix(match)) || /(?:기존|당초)\s*$/u.test(text.slice(0, match.index)));
  const targets = matches.filter(match => !sources.includes(match));
  const marked = targets.filter(match => /^\s*(?:까지|로|으로)/u.test(suffix(match)));
  const alternatives = matches.length > 1 && /(?:또는|혹은|아니면|중\s*(?:하나|에서|으로)|\s나\s)/u.test(text);
  const target = alternatives ? null : marked.length === 1 ? marked[0] : targets.length === 1 ? targets[0] : null;
  const clocks = [...text.matchAll(CLOCK)];
  const end = target && (matches[matches.indexOf(target) + 1]?.index ?? text.length);
  const nearby = target && matches.length > 1 ? clocks.filter(clock => clock.index >= target.index + target[0].length && clock.index < end) : clocks;
  const markedClock = nearby.filter(clock => /^\s*(?:까지|로|으로)/u.test(text.slice(clock.index + clock[0].length)));
  const time = markedClock.length === 1 ? wallTime(markedClock[0]) : nearby.length === 1 && (target || !matches.length) ? wallTime(nearby[0]) : null;

  function dateKey(match) {
    if (!match) return null;
    const { year, month, day, numericYear, numericMonth, numericDay, relative, week, weekday: name } = match.groups;
    if (relative) return new Date(midnight + ['오늘', '내일', '모레', '글피'].indexOf(relative) * DAY).toISOString().slice(0, 10);
    if (name) {
      const namedDay = WEEKDAYS.indexOf(name);
      const mondayOffset = (weekday + 6) % 7;
      const offset = week ? (namedDay + 6) % 7 - mondayOffset + ['이번', '다음', '다다음'].indexOf(week) * 7 : (namedDay - weekday + 7) % 7;
      return new Date(midnight + offset * DAY).toISOString().slice(0, 10);
    }
    return canonicalDate(Number(year || numericYear || local.getUTCFullYear()), Number(month || numericMonth), Number(day || numericDay));
  }

  const due = dateKey(target);
  return { due, time, previousDue: sources.length === 1 ? dateKey(sources[0]) : null, unresolvedDate: matches.length > 0 && !due && !time };
}

function withoutDate(text) {
  return text.replace(DATES, '\u0001').replace(CLOCK, '\u0001')
    .replace(/\u0001(?:\s*\([월화수목금토일](?:요일)?\))?\s*(?:까지(?:는|로)?|부터|에서|에는|으로|로|에|은|는)?/gu, ' ')
    .replace(/\s+/gu, ' ').trim();
}

function topicText(text) {
  return trimPunctuation(text
    .replace(/^(?:(?:안녕하세요|선생님들|여러분|네|넵|예|그럼|그러면|그리고|참고로)[\s,.!~]+)+/u, '')
    .replace(/(?:에서|에게|한테|께|으로|로)\s*$/u, '')
    .replace(/\s+(?:좀|꼭|먼저|모두|미리|다시|한번|한\s*번|함께|바로|늦어도|정리해서|첨부해서|확인해서|각자|이제|곧)(?:\s+(?:좀|꼭|먼저|모두|미리|다시|한번|한\s*번|함께|바로|늦어도|정리해서|첨부해서|확인해서|각자|이제|곧))*$/u, ''));
}

function taskTopic(text) {
  const verbs = [...text.matchAll(TASK_WORD)];
  const word = verbs.at(-1);
  if (!word) return null;
  const object = topicText(text.slice(0, word.index)).replace(/(?:은|는|을|를)$/u, '').trim();
  if (!object || /^(?:그것|이것|저것|이거|그거|그대로|그날|그때|말씀하신|해당|이렇게|그렇게)$/u.test(object)) return null;
  if (object.length > 60) return null;
  return `${object} ${VERBS.get(word.groups.verb)}`;
}

function eventTopic(text) {
  const word = [...text.matchAll(EVENT_WORD)].at(-1);
  if (!word) return null;
  const subject = topicText(text.slice(0, word.index + word[0].length))
    .replace(/^(?:해당|이번|다음|그|이|지난)\s+/u, '');
  const tail = text.slice(word.index + word[0].length);
  return subject.length > 60 ? null : { title: subject, declarative: /^(?:은|는|이|가|을|를)?\s*(?:(?:일정|날짜|시간)(?:은|는|이|가)?\s*)?(?:입니다|이에요|예요|있습니다|있어요|합니다)\s*[.!~…]*$/u.test(tail) };
}

function classify(text, observedAt) {
  if (REJECTION.test(text) || OLD_TEXT.test(text)) return null;
  const date = findDate(text, observedAt);
  const withoutTiming = withoutDate(text);
  const change = CHANGE.test(text);
  const cancel = CANCEL.test(text);
  const confirmation = CONFIRM.test(text);
  const explicitTask = REQUEST_END.test(text) || /(?:제출|회신|신청|등록)\s*(?:마감|기한)(?:은|는|이|가)?/u.test(text);
  const task = taskTopic(withoutTiming);
  const event = eventTopic(withoutTiming);
  const taskFirst = !!task && (explicitTask || /(?:마감|기한)/u.test(text) || !event);
  const title = taskFirst ? task : event?.title || null;
  const kind = title ? (taskFirst ? 'task' : 'event') : null;
  const base = { title, kind, ...date };
  if (PROPOSAL.test(text)) {
    return title || date.due || date.time ? { ...base, action: 'proposal' } : null;
  }
  if (cancel) return { ...base, action: 'cancelled', previousDue: date.previousDue || date.due, due: null, time: null };
  if (change) {
    const detail = /(?:^|\s)(장소|진행\s*방식|방식)(?:은|는|이|가|를|을|만)?\s+([^.!?\r\n]{1,36}?)\s*(?:으로|로)\s*(?=변경|조정|옮기|바뀌|바꿨)/u.exec(text);
    const description = detail && `${detail[1].replace(/^진행\s*/u, '')}: ${detail[2].trim()}`;
    return date.due || date.time || description ? { ...base, action: 'changed', detail: description } : null;
  }
  if (explicitTask && !confirmation && (task || [...withoutTiming.matchAll(TASK_WORD)].length)) {
    const indirectDate = /(?:됐|되었|되|했|하)는지/u.test(text) && !/까지|기한|마감/u.test(text);
    return { ...base, title: task, kind: 'task', action: 'task', ...(indirectDate && { due: null, time: null, unresolvedDate: false }) };
  }
  const acceptingProposal = !title && (date.due || SIMPLE_CONFIRM.test(text)) && SHORT_ACCEPTANCE.test(text);
  if (confirmation || acceptingProposal || (date.due && event?.declarative) || (!title && date.due && SIMPLE_CONFIRM.test(text) && PLAIN_DECLARATION.test(text))) {
    return { ...base, action: kind === 'task' ? 'task' : 'confirmed' };
  }
  if (title && date.due && SIMPLE_CONFIRM.test(text)) return { ...base, action: 'proposal' };
  return null;
}

function sentences(text) {
  // Brity's accessibility label can concatenate the repeated display name and clock with the body.
  const body = text.replace(/^\s*(?<sender>[가-힣]{2,6})[ \t]+\k<sender>[ \t]*(?:(?:오전|오후)\s*)?\d{1,2}:[0-5]\d\s*/u, '')
    .replace(/^\s*\[[^\]\r\n]{1,40}\]\s*\[(?:(?:오전|오후)\s*)?\d{1,2}:\d{2}\]\s*/u, '')
    .replace(/\s*\[(?:(?:오전|오후)\s*)?\d{1,2}:\d{2}\]\s*$/u, '');
  const dates = [...body.matchAll(DATES)];
  const parts = [];
  let start = 0;
  for (const separator of body.matchAll(/\r?\n+|(?<=[.!?。！？])[ \t]+(?=\S)/gu)) {
    if (dates.some(date => separator.index > date.index && separator.index <= date.index + date[0].length + 1)) continue;
    parts.push(body.slice(start, separator.index));
    start = separator.index + separator[0].length;
  }
  parts.push(body.slice(start));
  return parts.map(line => line.trim()).filter(line => line && !/^(?:>|[-–]+\s*(?:원문|인용))/u.test(line));
}

const topicKey = title => title.replace(/[\s\p{P}]/gu, '').toLowerCase();

function resolveTopic(decision, recent, items) {
  const mutation = decision.action === 'changed' || decision.action === 'cancelled';
  const candidates = recent.filter(item =>
    (!decision.kind || item.kind === decision.kind) &&
    (!decision.title || topicKey(item.title) === topicKey(decision.title) || item.title.endsWith(` ${decision.title}`)) &&
    (mutation ? item.action !== 'cancelled' : item.action === 'proposal') &&
    (!decision.previousDue || item.due === decision.previousDue));
  const named = new Set(candidates.map(item => topicKey(item.title)));
  if (!decision.title && named.size > 1) {
    const sameDate = candidates.filter(item => item.due && item.due === decision.due);
    if (mutation || new Set(sameDate.map(item => topicKey(item.title))).size !== 1) return null;
    candidates.splice(0, candidates.length, ...sameDate);
  }

  const contextual = named.size > 1 && decision.title ? null : candidates.at(-1);
  const title = contextual?.title || decision.title;
  if (!title) return null;
  if (!mutation) return { title, prior: contextual };

  const exact = items.filter(item => item.action !== 'cancelled' && topicKey(item.title) === topicKey(title));
  const resolved = candidates.filter(item => item.action !== 'proposal');
  const recentDates = new Set(resolved.map(item => item.due).filter(Boolean));
  const staged = resolved.findLast(item => item.currentBatch && item.due && !exact.some(entry => entry.due === item.due));
  if (staged && !decision.previousDue) {
    if (recentDates.size !== 1) return null;
    return { title, prior: staged, previousDue: staged.due };
  }
  if (!exact.length) return { title, prior: contextual };
  const contextDate = recentDates.size === 1 ? [...recentDates][0] : null;
  const priorDate = decision.previousDue || (exact.length > 1 ? contextDate : null);
  const targets = priorDate ? exact.filter(item => item.due === priorDate) : exact;
  if (!targets.length && decision.previousDue && contextual?.currentBatch && contextual.action !== 'proposal') {
    return { title, prior: contextual };
  }
  if (targets.length !== 1) return null;
  return { title, prior: targets[0], matchId: targets[0].id };
}

function extractChatDecisions({ context = [], messages = [], existing = [] }) {
  const history = [];
  const decisions = [];
  const items = [...existing];

  function read(message, messageIndex) {
    for (const text of sentences(message.text)) {
      const decision = classify(text, message.observedAt);
      if (!decision) {
        if (REJECTION.test(text)) history.length = 0;
        continue;
      }
      if (decision.unresolvedDate && decision.action !== 'cancelled') continue;

      const topic = resolveTopic(decision, history.slice(-6), items);
      if (!topic) continue;
      const { title, prior, matchId, previousDue } = topic;
      const kind = decision.kind || prior?.kind || (prior?.action === 'task' ? 'task' : 'event');
      if (decision.action === 'proposal') {
        history.push({ ...decision, title, kind });
        continue;
      }

      const action = decision.action === 'confirmed' && kind === 'task' ? 'task' : decision.action;
      const due = action === 'cancelled' ? null : decision.due || prior?.due || null;
      const time = action === 'cancelled' ? null : decision.time || (!decision.due || decision.due === prior?.due ? prior?.time : null) || null;
      if (action === 'confirmed' && !due) continue;
      if (action === 'changed' && !due && !time && !decision.detail) continue;
      const result = { action, kind, title, due, time, observedAt: message.observedAt };
      if (matchId) result.matchId = matchId;
      if (decision.previousDue || previousDue) result.previousDue = decision.previousDue || previousDue;
      if (decision.detail) result.detail = decision.detail;
      for (let index = history.length - 1; index >= 0; index--) {
        if (history[index].action === 'proposal' && topicKey(history[index].title) === topicKey(title)) history.splice(index, 1);
      }
      history.push({ ...result, currentBatch: messageIndex !== undefined });
      if (messageIndex !== undefined) {
        decisions.push({ ...result, messageIndex });
        const index = items.findIndex(item => item.id && item.id === result.matchId);
        if (index !== -1) items[index] = { ...result, id: result.matchId };
      }
    }
  }

  context.forEach(message => read(message));
  messages.forEach(read);
  return decisions;
}

module.exports = { extractChatDecisions };
