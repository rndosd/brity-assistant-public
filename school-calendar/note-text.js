'use strict';

// AI로 보내는 쪽지 자료. 시험(.qa/model-trial/prepare-evaluation.mjs)과 같은 형식으로 만든다.
// 머리말(수신자 목록·메일 주소)은 빼고, 이번 글(latestBody)과 인용된 이전 쪽지(quotedNotes)를 나눈다.
const { splitReply, normalizeHeaders } = require('./renderer/note-view');
const { recipientCount } = require('./renderer/task-model');

function quotes(body) {
  const latest = [];
  const quoted = [];
  let remaining = normalizeHeaders(body);
  for (let part = splitReply(remaining); part; part = splitReply(remaining)) {
    if (!quoted.length) latest.push(part.reply);
    const header = remaining.split(/^Original Message$/im)[1] || '';
    const datetime = header.match(/^Date\s*:\s*(\d{4}-\d{2}-\d{2})/im)?.[1] ?? null;
    const nested = splitReply(part.message);
    quoted.push({ title: part.subject || null, datetime, body: nested ? nested.reply : part.message });
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
  const { latestBody, quotedNotes } = quotes(note.body || '');
  return {
    title: note.title, datetime: trialDatetime(note.datetime), latestBody, quotedNotes,
    replyHint: replyHint(note.title || ''), recipientCount: recipientCount(note.recipients),
    recipientRole: '나', senderRole: '상대 1', recipientProfile: profileValue(profile)
  };
}

// 보내기 전 확인 창에 보여 줄 글.
function cleanReplyBody(body) {
  const { latestBody, quotedNotes } = quotes(body);
  return [latestBody, ...quotedNotes.flatMap(quote => [
    quote.title && `이전 쪽지 제목: ${quote.title}`, quote.datetime && `이전 쪽지 날짜: ${quote.datetime}`, quote.body
  ])].filter(Boolean).join('\n');
}

module.exports = { buildNoteInput, cleanReplyBody, profileValue, trialDatetime };
