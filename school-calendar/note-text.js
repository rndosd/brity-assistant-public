'use strict';

// AI로 보내는 쪽지 자료. 시험(.qa/model-trial/prepare-evaluation.mjs)과 같은 형식으로 만든다.
// 머리말(수신자 목록·메일 주소)은 빼고, 이번 글(latestBody)과 인용된 이전 쪽지(quotedNotes)를 나눈다.
const { splitReply, normalizeHeaders } = require('./renderer/note-view');
const { recipientCount } = require('./renderer/task-model');
const { notePeople, studentClasses, explicitStudentNames, scheduledStudentNames, noteContacts, noteLinks, makeNoteMask } = require('./privacy');

const KNOWN_STUDENTS = Symbol('known students for note masking');
const studentsByInbox = new WeakMap();

function withMaskingContext(note, inbox) {
  if (note?.verified !== true || !scheduledStudentNames([note.title, note.body].join('\n')).length) return note;
  let known = studentsByInbox.get(inbox);
  if (!known) {
    const texts = Array.from(inbox.values()).filter(item => item.verified === true)
      .map(item => [item.title, item.body].join('\n'));
    known = new Set(explicitStudentNames(texts));
    studentsByInbox.set(inbox, known);
  }
  return { ...note, [KNOWN_STUDENTS]: known };
}

function quotes(body) {
  const latest = [];
  const quoted = [];
  let remaining = normalizeHeaders(body);
  for (let part = splitReply(remaining, { includeHeaders: true }); part;
    part = splitReply(remaining, { includeHeaders: true })) {
    if (!quoted.length) latest.push(part.reply);
    const datetime = part.datetime.match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? null;
    const nested = splitReply(part.message);
    quoted.push({
      title: part.subject || null, datetime, body: nested ? nested.reply : part.message,
      sender: part.sender, recipients: part.recipients
    });
    remaining = part.message;
  }
  return { latestBody: quoted.length ? latest[0] : remaining.trim(), quotedNotes: quoted };
}

function replyHint(title) {
  if (/^\s*(?:\[전달\]|FW(?:D)?:)/i.test(title)) return '전달';
  if (/^\s*(?:\[답장\]|RE:)/i.test(title)) return '답장';
  return null;
}

function trialDatetime(value) {
  const match = String(value || '').match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (!match) return value || null;
  const [, day, hour = '00', minute = '00', second = '00'] = match;
  return `${day} ${hour.padStart(2, '0')}:${minute}:${second}`;
}

const GROUP_NAME = /^(?:가상|샘플|업무|학년|학급|전체|전교직원|교육청|행정실|교무실|보건실|도서실|도서관|교직원|교사|담임|선생님|담당자|학부모|보호자|교무부|자료|교무|학사|수신자|발신자)$/;
const MAIL = /[\w.+%-]+@[\w-]+(?:\.[\w-]+)+/;

function person(value) {
  const raw = String(value ?? '').trim().replace(/\s+외\s*\d+\s*명?$/, '');
  const email = raw.match(MAIL)?.[0]?.toLowerCase() || '';
  const display = raw.replace(/\s*<[^>]*>/g, '').replace(MAIL, '').replace(/^["']|["']$/g, '').trim();
  const korean = display.match(/^[가-힣]{2,7}(?=[ \t(]|$)/)?.[0]
    ?.replace(/^([가-힣]{2,5}?)(?:선생님|선생|교사|샘|님|씨)$/, '$1') || '';
  const leading = korean.length <= 5 && korean ||
    display.match(/^[A-Za-z][A-Za-z.'-]*(?: +[A-Za-z][A-Za-z.'-]*){1,3}$/)?.[0] || '';
  return { name: GROUP_NAME.test(leading) ? '' : leading, display, email };
}

function people(value) {
  const display = String(value ?? '');
  if (/^\s*수신자\s*\(\s*부서\s*:/u.test(display)) return [];
  return display.split(/[,;\r\n]/).map(person).filter(entry => entry.display || entry.email);
}

function noteRoles(note, thread) {
  const sender = person(note.sender);
  const recipients = people(note.recipients);
  const quoted = thread.quotedNotes.map(quote => ({ sender: person(quote.sender), recipients: people(quote.recipients) }));
  const actors = [sender, ...recipients, ...quoted.flatMap(quote => [quote.sender, ...quote.recipients])];
  const addresses = new Map();
  for (const actor of actors) {
    if (!actor.name || !actor.email) continue;
    if (!addresses.has(actor.name)) addresses.set(actor.name, new Set());
    addresses.get(actor.name).add(actor.email);
  }
  const ambiguous = name => !!name && (addresses.get(name)?.size || 0) > 1;
  const key = actor => ambiguous(actor.name) ? actor.email : actor.name || actor.email || actor.display;
  const roles = new Map();
  const recipient = recipientCount(note.recipients) === 1 ? recipients[0] : null;
  if (recipient && key(recipient)) roles.set(key(recipient), '나');
  let index = 1;
  function role(actor) {
    const id = key(actor);
    if (!id) return null;
    if (!roles.has(id)) roles.set(id, '상대 ' + index++);
    return roles.get(id);
  }
  const senderRole = role(sender) || '상대 ' + index++;
  const recipientRoles = recipients.map(role).filter(Boolean);
  const quoteRoles = quoted.map(quote => ({
    senderRole: role(quote.sender),
    recipientRoles: quote.recipients.map(role).filter(Boolean)
  }));
  const aliases = new Map();
  for (const actor of actors) {
    const identityRole = roles.get(key(actor));
    if (actor.name && identityRole) aliases.set(actor.name, ambiguous(actor.name) ? '[동명이인]' : '[' + identityRole + ']');
  }
  const parts = [[note.title, thread.latestBody], ...thread.quotedNotes.map(quote => [quote.title, quote.body])];
  const classes = studentClasses(parts.flat().join('\n'));
  const named = new Map();
  const authors = [sender, ...quoted.map(quote => quote.sender)];
  parts.forEach((part, i) => {
    const text = part.join('\n');
    for (const [name, type] of notePeople(text, authors[i].name).named) {
      if (!named.has(name) || type === 'student') named.set(name, type);
    }
    // 호칭 없는 수업 안내의 자유 문구는 같은 보관함에서 학생으로 확인된 이름만 가린다.
    if (note[KNOWN_STUDENTS]) {
      for (const name of scheduledStudentNames(text)) {
        if (note[KNOWN_STUDENTS].has(name)) named.set(name, 'student');
      }
    }
  });
  let student = 0;
  let targetIndex = 0;
  for (const [name, type] of named) {
    if (type === 'student') {
      const ambiguousStudent = aliases.has(name) || (classes.get(name)?.size ?? 0) > 1;
      aliases.set(name, ambiguousStudent ? '[동명이인]' : `[학생 ${++student}]`);
    } else if (!aliases.has(name)) {
      aliases.set(name, `[대상 ${++targetIndex}]`);
    }
  }
  return { senderRole, recipientRoles, quoteRoles, aliases, recipients, key };
}

function noteMask(note) {
  const item = note || {};
  const thread = quotes(item.body || '');
  return makeNoteMask(noteRoles(item, thread).aliases, attachmentNames(item));
}

function attachmentNames(note) {
  return Array.isArray(note.attachmentNames) ? note.attachmentNames :
    Array.isArray(note.attachments) ? note.attachments.map(file => file?.name) : [];
}

function restoreNoteAnswer(answer, note) {
  if (!answer || typeof answer !== 'object') return answer;
  const aliases = noteRoles(note, quotes(note.body || '')).aliases;
  const names = new Map([...aliases].filter(([, alias]) => alias !== '[동명이인]').map(([name, alias]) => [alias, name]));
  const restore = text => typeof text === 'string' ? text.replace(/\[나\]가/g, '내가').replace(/\[나\]/g, '나')
    .replace(/\[(?:상대|학생|대상) \d+\]/g, alias => names.get(alias) ?? '[대상 확인]') : text;
  return {
    ...answer, title: restore(answer.title), summary: restore(answer.summary),
    ...(Array.isArray(answer.dates) && { dates: answer.dates.map(date => date && typeof date === 'object' ?
      { ...date, label: restore(date.label), ...(typeof date.appliesTo === 'string' && { appliesTo: restore(date.appliesTo) }),
        ...(typeof date.shortLabel === 'string' && { shortLabel: restore(date.shortLabel) }),
        ...(typeof date.shortScope === 'string' && { shortScope: restore(date.shortScope) }) } : date) })
  };
}

const FORWARDED = /(?:아래|다음|원문|이전)\s*(?:쪽지|내용|요청|안내|공문)(?:을|를)?\s*(?:전달|공유)|전달\s*(?:드립니다|합니다|해\s*드립니다)/u;
const REQUEST = /(?:제출|회신|회답|답장|입력|참석|제공|처리|확인|안내|정리|신청|수정|보내|연락|작성|전달|반납|회수)[^\n.!?]{0,30}(?:주세요|주십시오|주시기|부탁(?:드립니다|합니다)?|바랍니다|바라며|요청|요망)|(?:제출|회신|신청|입력)\s*(?:기한|마감)\s*[:：]/u;
const REFERENCE_ONLY = /참고\s*(?:용|만)|(?:제출|처리|회신|신청)[ \t]*(?:을[ \t]*)?완료[ \t]*(?:했|하였|되었|된)|(?:요청|일정)[ \t]*(?:이[ \t]*)?취소[ \t]*(?:됐|되었|합니다)/u;
const ORIGINAL_DIVIDER = /^Original Message$/im;
const UNPARSED_PEOPLE_HEADER = /^[ \t]*(Sender|To|Cc|Bcc)[ \t]*(?:\n[ \t]*)?:[^\n]*(?:\n[ \t]*[^<>\n]{0,80}<[^<>\s]+@[^<>\s]+>[ ,;\t]*)*/gim;

function maskThreadText(text, mask) {
  if (!ORIGINAL_DIVIDER.test(text)) return mask(text);
  const [latest, ...unparsed] = text.split(ORIGINAL_DIVIDER);
  return [mask(latest), ...unparsed.map(quote => mask(quote.replace(UNPARSED_PEOPLE_HEADER, '$1: [인용 머리말 확인 필요]')))]
    .join('Original Message');
}

function noteActions(note) {
  const sender = person(note?.sender).display;
  const empty = { sender, forwarded: false, referenceOnly: false, sourceRequester: null, quoteSenders: [], contacts: [], links: [], target: null, targetReview: null };
  if (!note) return empty;
  const thread = quotes(note.body || '');
  const forwarded = replyHint(note.title || '') === '전달' || FORWARDED.test(thread.latestBody);
  const referenceOnly = forwarded && REFERENCE_ONLY.test(thread.latestBody) && !REQUEST.test(thread.latestBody);
  if (note.verified !== true) return { ...empty, forwarded };
  const { recipients, key } = noteRoles(note, thread);
  const quoteSenders = [...new Set(thread.quotedNotes.map(quote => person(quote.sender).display).filter(Boolean))];
  const requestedBy = thread.quotedNotes.filter(quote => REQUEST.test(quote.body)).map(quote => person(quote.sender));
  const sourceSenders = new Map(requestedBy.map(author => [key(author), author.display]));
  const [source] = sourceSenders.entries();
  const knownAudience = recipients.length > 0 && recipients.length === recipientCount(note.recipients);
  const sourceRequester = forwarded && !referenceOnly && sourceSenders.size === 1 && source[0] &&
    knownAudience && recipients.every(recipient => key(recipient) && source[0] !== key(recipient)) ? source[1] : null;
  const textOf = (title, body) => [title, body.split(ORIGINAL_DIVIDER)[0].replace(UNPARSED_PEOPLE_HEADER, '')].filter(Boolean).join('\n');
  const sections = [
    [textOf(note.title, thread.latestBody), '이번 쪽지'],
    ...thread.quotedNotes.map((quote, i) => [textOf(quote.title, quote.body), '이전 안내 ' + (i + 1)])
  ];
  const current = notePeople(sections[0][0], person(note.sender).name);
  const target = !referenceOnly && current.requested && !current.needsReview ? current.target : null;
  const latestUnclear = !referenceOnly && current.requested && !!current.target && current.needsReview;
  const quotedCheck = forwarded && !referenceOnly && !target && !latestUnclear && sections.slice(1).some(([text], i) => {
    const previous = notePeople(text, person(thread.quotedNotes[i].sender).name);
    return previous.requested && !!previous.target;
  });
  const targetReview = latestUnclear ? 'current' : quotedCheck ? 'previous' : null;
  const contacts = sections.flatMap(([text, source]) => noteContacts(text, source));
  const distinct = new Map(contacts.map(contact => [
    [contact.source, contact.label, contact.context, contact.value.replace(/[ \t]/g, '')].join('|'), contact
  ]));
  const links = new Map(sections.flatMap(([text, source]) => noteLinks(text, source)).map(link => [link.source + '|' + link.value, link]));
  return { sender, forwarded, referenceOnly, sourceRequester, quoteSenders, contacts: [...distinct.values()], links: [...links.values()], target, targetReview };
}

// 내 역할 정보(설정). 비어 있는 항목은 null로 둔다.
function profileValue(profile) {
  if (!profile || typeof profile !== 'object') return null;
  const listOf = items => Array.isArray(items) && items.length ? items : null;
  const one = (item, choices) => choices.includes(item) ? item : null;
  const value = {
    grade: Number.isInteger(profile.grade) ? profile.grade : null,
    classroom: Number.isInteger(profile.classroom) ? profile.classroom : null,
    role: one(profile.role, ['담임', '전담', '비담임', '그 밖']),
    homeroomTeacher: typeof profile.homeroomTeacher === 'boolean' ? profile.homeroomTeacher : null,
    subjects: listOf(profile.subjects),
    subjectGrades: listOf(profile.subjectGrades),
    duties: listOf(profile.duties),
    memberships: listOf(profile.memberships)
  };
  if (!Object.values(value).some(item => item !== null) && !profile.workplace) return null;
  // 근무처·학교급. 예전 설정(근무처 없음)은 초등 학교로 본다.
  const workplace = profile.workplace === '교육청' ? '교육청' : '학교';
  if (workplace === '교육청') {
    return {
      workplace, officeType: one(profile.officeType, ['시도교육청', '교육지원청']),
      department: typeof profile.department === 'string' && profile.department ? profile.department : null,
      position: one(profile.position, ['장학관·장학사', '연구관·연구사', '일반직', '그 밖']),
      coveredLevels: listOf(profile.coveredLevels), duties: value.duties, memberships: value.memberships
    };
  }
  return { workplace, schoolLevel: one(profile.schoolLevel, ['초등', '중학교', '고등학교']) ?? '초등', ...value };
}

function buildNoteInput(note, profile) {
  const thread = quotes(note.body || '');
  const { senderRole, recipientRoles, quoteRoles, aliases } = noteRoles(note, thread);
  const mask = makeNoteMask(aliases, attachmentNames(note));
  const details = profileValue(profile);
  const recipientProfile = details && Object.fromEntries(Object.entries(details).map(([name, value]) => [
    name, typeof value === 'string' ? mask(value) : Array.isArray(value) ?
      value.map(item => typeof item === 'string' ? mask(item) : item) : value
  ]));
  return {
    title: mask(note.title), datetime: trialDatetime(note.datetime), latestBody: maskThreadText(thread.latestBody, mask),
    quotedNotes: thread.quotedNotes.map((quote, i) => ({
      title: quote.title === null ? null : mask(quote.title), datetime: quote.datetime, body: maskThreadText(quote.body, mask), ...quoteRoles[i]
    })),
    replyHint: replyHint(note.title || ''), recipientCount: recipientCount(note.recipients),
    recipientRole: '나', senderRole, recipientRoles, recipientProfile
  };
}

// 보내기 전 확인 창에 보여 줄 글.
function cleanReplyBody(body) {
  const { latestBody, quotedNotes } = quotes(body);
  return [latestBody, ...quotedNotes.flatMap(quote => [
    quote.title && `이전 쪽지 제목: ${quote.title}`, quote.datetime && `이전 쪽지 날짜: ${quote.datetime}`, quote.body
  ])].filter(Boolean).join('\n');
}

module.exports = { buildNoteInput, cleanReplyBody, profileValue, trialDatetime, noteActions, noteMask, restoreNoteAnswer, withMaskingContext };
