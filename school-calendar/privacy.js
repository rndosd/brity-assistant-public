'use strict';

// 쪽지를 AI로 보내기 전에 이 PC 안에서만 하는 개인정보 검사.
// 놓칠 수 있으므로 "의심되면 보내지 않는다"에만 쓰고, 가려서 보내는 데는 쓰지 않는다.
// 흔한 성씨로 시작하는 2~4글자만 이름 후보로 본다.
const SURNAMES = '김이박최정강조윤장임한오서신권황안송류유홍전고문양손배백허남심노하곽성차주우구민진나지엄채원천방공현함변염여추도소석선설마길연위표명기반왕금옥육인맹제모탁국어은편용예봉경사부가복태';
const NAME = `[${SURNAMES}][가-힣]{1,3}`;
const PATTERNS = [
  ['주민등록번호', /(?<!\d)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\s*-?\s*[1-8]\d{6}(?!\d)/],
  ['휴대전화 번호', /(?<!\d)01[016789][\s.-]?\d{3,4}[\s.-]?\d{4}(?!\d)/],
  ['계좌번호', /(?:은행|계좌|입금)[^\n]{0,20}?(?<!\d)\d{2,6}-\d{2,6}-\d{2,8}(?!\d)/],
  ['집 주소', /\d+\s*동\s*\d+\s*호/],
  ['학생 번호와 이름', new RegExp(`(?<![\\d-])\\d{1,2}\\s*번\\s*${NAME}(?![가-힣])|${NAME}\\s*\\(\\s*\\d{1,2}\\s*번\\s*\\)`)],
];
const EMAIL = /[\w.+-]+@([\w-]+(?:\.[\w-]+)+)/g;
const NOT_NAME = /^(학생|선생|교사|담임|학부모|어린이|아이들|친구|교실|이상|이하|정도|안건|문항|자료|사항|부터|까지|순서|조사|정리|이내|모둠|문제|사진|공문|제출|서류|신청|회의|안내|문서|계획|결과|참고|수업|활동|장소|시간|일정|항목|내용|양식|파일|첨부|교시|조별|반별|부서|안건)/;
// 세네 글자 이름은 단독 표기도 찾고, 두 글자 이름은 호칭이 붙었을 때 찾는다.
// 명단 없이 하는 추정이므로 일반 단어도 걸릴 수 있다. 자동 전송 보류에만 사용한다.
const NAME_PARTICLE = '(?:께서는|께서|께|에게서|에게는|에게|한테|으로|에서|은|는|이|가|을|를|의|와|과|도|만|에|로|까지|부터|이라고|라고|입니다)?';
const NAME_ROLE = '(?:선생님|선생|학생|학부모|보호자|교사|님|씨)';
const WORD_END = new RegExp(`${NAME_PARTICLE}$`);
const POSSIBLE_NAME = new RegExp(`(?<![가-힣A-Za-z0-9])([${SURNAMES}][가-힣]{2,3}?)(?:${NAME_ROLE})?${NAME_PARTICLE}(?![가-힣A-Za-z0-9])`, 'g');
const NAME_WITH_ROLE = new RegExp(`(?<![가-힣A-Za-z0-9])([${SURNAMES}][가-힣]{1,3}?)\\s*${NAME_ROLE}${NAME_PARTICLE}(?![가-힣A-Za-z0-9])`, 'g');
const ORDINARY_WORDS = new Set([
  '연락처', '이메일', '이름', '주민번호', '주민등록', '계좌번호', '입금자',
  '교무실', '도서실', '도서관', '보건실', '급식실', '강당',
  '월요일', '화요일', '수요일', '목요일', '금요일', '토요일', '일요일',
  '이번', '이번주', '이번달', '지난주', '지난달', '지난번', '오늘',
  '연수', '공유', '공지', '전달', '문의', '입력', '이용', '이용자', '조회',
  '이후', '이전', '이때', '이처럼', '이렇게', '이것', '이러한',
  '정보', '정부', '정해진', '정확한',
  '개학일', '방학식', '방학중', '종업식', '졸업식', '체험학습', '교육과정',
  '가정통신', '가정', '가운데', '가능한', '가입', '가입자', '가상',
  '공동체', '공휴일', '공개수업', '전교생', '전학년',
  '부탁', '부탁드려', '주시기', '주세요', '입니다', '이어요',
]);

function hasPossibleName(text) {
  for (const pattern of [POSSIBLE_NAME, NAME_WITH_ROLE]) {
    for (const match of text.matchAll(pattern)) {
      const word = match[1];
      if (!NOT_NAME.test(word) && !ORDINARY_WORDS.has(word) && !ORDINARY_WORDS.has(word.replace(WORD_END, ''))) return true;
    }
  }
  return false;
}

function roster(names) {
  if (!Array.isArray(names)) return [];
  return [...new Set(names.map(name => typeof name === 'string' ? name.trim() : '').filter(name => /^[가-힣]{2,5}$/.test(name)))];
}

function findPersonalInfo(texts, names = []) {
  const text = (Array.isArray(texts) ? texts : [texts]).filter(value => typeof value === 'string').join('\n');
  const found = new Set();
  for (const [label, pattern] of PATTERNS) {
    const match = text.match(pattern);
    if (!match) continue;
    if (label === '학생 번호와 이름' && NOT_NAME.test(match[0].replace(/^\d{1,2}\s*번\s*/, ''))) continue;
    found.add(label);
  }
  for (const [, domain] of text.matchAll(EMAIL)) {
    // 학교·교육청 업무 메일(go.kr)은 회신 머리말마다 들어가므로 개인 메일만 본다.
    if (!/(^|\.)go\.kr$/i.test(domain)) { found.add('개인 이메일'); break; }
  }
  if (roster(names).some(name => text.includes(name))) found.add('우리 반 학생 이름');
  if (!found.has('학생 번호와 이름') && !found.has('우리 반 학생 이름') && hasPossibleName(text)) {
    found.add('이름으로 보이는 표현');
  }
  return [...found];
}

const MAIL_ADDRESS = /[\w.+%-]+@[\w-]+(?:\.[\w-]+)+/g;
const PHONE_NUMBER = /(?<![\d-])(?:(?:\+82[ .\t-]?1|01)[016789][ .\t-]?\d{3,4}[ .\t-]?\d{4}|(?:\(?0(?:2|[3-6]\d|70)\)|0(?:2|[3-6]\d|70)[ .\t-]+|\+82[ .\t-]?(?:2|[3-6]\d|70)[ .\t-]+)[ .\t-]*\d{3,4}[ .\t-]+\d{4})(?![\d-])/g;
const CONTACT_PATTERNS = [['이메일', MAIL_ADDRESS], ['전화', PHONE_NUMBER]];
const CONTACT_OWNER = /((?:학생\s*)?(?:보호자|학부모)|담임(?:교사)?|교무실|행정실|보건실|담당자|원\s*요청자)\s*(?:연락처|휴대전화|전화(?:번호)?|이메일|메일)?\s*(?:[:：=]|[은는])?\s*$/u;
const ISO_DAY = /^(?:19|20)\d{2}-(?:0?[1-9]|1[0-2])-(?:0?[1-9]|[12]\d|3[01])$/;
const ACCOUNT_NUMBER = /((?:계좌(?:번호)?|입금계좌)[ \t]*[:：]?[ \t]*)(\d{2,6}-\d{2,6}-\d{2,8}(?:-\d{1,4})?)(?!\d)/g;
const NATIONAL_ID = /(?<!\d)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\s*-\s*[1-8](?:\d{6}|\*{6})(?!\d)/g;
const COMPACT_NATIONAL_ID = /((?:주민\s*등록\s*번호|주민번호)[ \t]*[:：]?[ \t]*)\d{6}[1-8]\d{6}(?!\d)/g;
const STUDENT_ID = /((?:학번|학생[ \t]*(?:번호|ID))[ \t]*[:：=][ \t]*)([A-Z]{0,3}\d{4,}(?:-\d{2,})*)(?![A-Z\d-])/gi;
const ADDRESS_UNIT = /(?<!\d)\d{1,4}[ \t]*동[ \t]*\d{1,5}[ \t]*호(?=(?:에서|으로|[은는이가을를의에로])?(?![가-힣0-9]))/g;
const PASSWORD_FIELD = /((?:비밀번호|암호|비밀\s*코드|인증번호|password|passcode|pw|pin)[ \t]*[:：=][ \t]*)(?:"[^"\r\n]+"|'[^'\r\n]+'|[A-Za-z0-9!@#$%^&*_.~-]{4,})(?![A-Za-z0-9])/gi;
const URL_TEXT = /(?:https?:\/\/|www\.)[^\s<>"']+/gi;
const LINK_PUNCTUATION = /[.,;:!?…·)\]}]$/u;
const LINK_BRACKETS = { ')': '(', ']': '[', '}': '{' };
const LINK_FOLLOWUP = /(?<=[\x21-\x7e])(?:(?:[을를에로]|에서|으로)(?:(?:확인|신청|제출|입력|접수|접속)(?:해(?:주세요)?|하세요|하면|합니다)?|열어|누르면|들어가)?|(?:확인|신청|제출|입력|접수|접속)(?:해주세요|하세요|하면|합니다)|열어|누르면|들어가)$/u;
const PERSON_END = NAME_ROLE.replace('선생|', '선생|샘|쌤|') + '?' + NAME_PARTICLE + '(?![가-힣A-Za-z0-9])';
const STUDENT_NAMES = [
  new RegExp('학생[ \\t]*(?:이름|성명)[ \\t]*[:：][ \\t]*(' + NAME + ')(?![가-힣])', 'g'),
  new RegExp('(?<!\\d)(?:[1-6][ \\t]*학년[ \\t]*\\d{1,2}[ \\t]*반(?:[ \\t]*\\d{1,2}[ \\t]*번)?|\\d{1,2}[ \\t]*번)[ \\t]+(' +
    NAME + ')(?=[ \\t]*(?:학생|선수|어린이|군|양)' + NAME_PARTICLE + '(?![가-힣]))', 'g'),
  new RegExp('(?<![가-힣A-Za-z0-9])(' + NAME + ')[ \\t]*\\([ \\t]*\\d{1,2}[ \\t]*번[ \\t]*\\)', 'g'),
  new RegExp('(?<![가-힣])성명[ \\t]*[:：][ \\t]*(' + NAME + ')(?![가-힣])', 'g'),
];
const STUDENT_NAME_IN_REQUEST = `[${SURNAMES}][가-힣]{2,3}`;
const STUDENT_SUBJECT_SEPARATOR = /(?:[ \t]*[·,/][ \t]*|[ \t]*(?:및|와|과)[ \t]+)/;
const STUDENT_SUBJECTS = new RegExp(`(?<![가-힣A-Za-z0-9])(${STUDENT_NAME_IN_REQUEST}(?:${STUDENT_SUBJECT_SEPARATOR.source}${STUDENT_NAME_IN_REQUEST})*)[ \\t]*학생(${NAME_PARTICLE})(?![가-힣A-Za-z0-9])`, 'g');
const STUDENT_CLASS = new RegExp(`(?<!\\d)([1-6])[ \\t]*학년[ \\t]*(\\d{1,2})[ \\t]*반(?:[ \\t]*(\\d{1,2})[ \\t]*번)?[ \\t]+(${STUDENT_NAME_IN_REQUEST})(?=[ \\t]*학생)`, 'g');
const STUDENT_CHECK = /확인[ \t]*(?:(?:을[ \t]*)?부탁|해[ \t]*(?:주|봐)|하여[ \t]*주시|하세요|바랍니다|요청)/u;
const CHECK_SUBJECT_CUE = /(?:는지|인지|은지|여부|출결|제출[ \t]*상태|참석[ \t]*기록)/u;
const CHECK_EXCEPTION = /동명이인|(?:학생|대상)[은는을를이가]?[ \t]*(?:제외|말고|대신|아닌|변경|미정)|(?:제외|변경)[ \t]*대상|확인[ \t]*(?:요청[은는]?[ \t]*)?(?:취소|보류)|확인하지[ \t]*마/u;
const GROUP_STUDENT_WORD = /^(?:고등학교|중학교|초등학교|장애인|전입생|전학생|특수교육|교육대상|지원대상|이주배경|외국인|미제출|미참석|가정학습|전학년|신입생|편입생|재학생|졸업생|다문화|대학생|봉사자|신청한|신청하는|선정된|지원받는|해당하는|참여하는|희망하는|관련된|담당하는|필요한|선생님)$/u;
const WORK_QUESTION = /(?:제출|제공|회신|신청|참여|등록|수령|입력)[^\n]{0,15}(?:했나요|하셨나요|했는지|하셨는지|였나요|인가요|여부)|(?:냈나요|낸[ \t]*건가요|냈는지)/u;
const SEND_REQUEST = /(?:보내[ \t]*(?:주|면)|회신[ \t]*(?:해[ \t]*주|부탁|바람)|제출[ \t]*(?:해[ \t]*주|부탁|하면)|전달[ \t]*(?:해[ \t]*주|부탁|말씀)|알(?:림해|려[ \t]*주)|(?:배부|안내)[ \t]*해[ \t]*주|연락[ \t]*(?:해[ \t]*주|부탁|드려[ \t]*주))/u;
const STUDENT_FOLLOWUP = /(?:학생[ \t]*(?:에게|한테)[ \t]*(?:알림해|알려|안내해|전달해|보내[ \t]*주)|전달[ \t]*말씀[ \t]*부탁)/u;
const OFFER_OR_REQUEST = /(?:보내[ \t]*(?:드리|주|어|도록)|회신[ \t]*(?:해[ \t]*주|부탁))/u;
const NAMED_ASSESSMENT = new RegExp(`^[ \\t]*(${STUDENT_NAME_IN_REQUEST})[ \\t]+(?:평가(?:지|표|서)?)(?=${NAME_PARTICLE}(?![가-힣]))`, 'u');
const NAMED_STAFF_DESTINATION = new RegExp(`(?<![가-힣A-Za-z0-9])(${STUDENT_NAME_IN_REQUEST})[ \\t]*(?:선생님|선생|샘|교사|주무관|실무사|부장님)[ \\t]*(?:에게|한테|께)(?!서)`, 'g');
const DESTINATION_FIELD = new RegExp(`(?:제출|회신)[ \\t]*(?:처|방법|담당자)?[ \\t]*[:：][^\\n]{0,22}(?:행정실|교무실|연구실|업무담당)[ \\t]*(?:\\([ \\t]*)?(?:(?:실장|주무관|실무사|선생님)[ \\t]+)?(${STUDENT_NAME_IN_REQUEST})(?=${PERSON_END})`, 'g');
const STAFF_HONORIFIC = '(?:선생님|샘|쌤)';
const SPACED_STAFF_TITLE = new RegExp(`(?<![가-힣A-Za-z0-9])(${NAME})[ \t]+${STAFF_HONORIFIC}${NAME_PARTICLE}(?![가-힣A-Za-z0-9])`, 'g');
const ATTACHED_STAFF_TITLE = new RegExp(`(?<![가-힣A-Za-z0-9])(${STUDENT_NAME_IN_REQUEST})${STAFF_HONORIFIC}${NAME_PARTICLE}(?![가-힣A-Za-z0-9])`, 'g');
const LABELED_DESTINATION = new RegExp(`(?:제출|회신)[ \t]*\\([ \t]*담당(?:자)?[ \t]*[:：][ \t]*(${STUDENT_NAME_IN_REQUEST})[ \t]*\\)`, 'g');
const ORDINARY_STAFF_WORD = /^(?:우리|이번|이전|다음|해당|기존|장애|교육|자율|임시|원어민|신규|전담|교과|전교|고용|급식|강사|강당|시간제|경력|교구|공개|일반|전출|전입|신입|동료|복직|초등|학교|중등|정교|보조|은퇴|기간제|저희|특수|실습|퇴직|보건|사서|상담|영상|일정|개인|정담임|교무|행정|명단|의견|원본|자료실|방과후)$/u;
const OFFICE_CONTACT = new RegExp(`(?:제출|회신)[ \\t]*(?:처|방법|담당자)?[ \\t]*[:：][ \\t]*(?:행정실|교무실|연구실)[^\\n()]{0,14}\\([ \\t]*(${STUDENT_NAME_IN_REQUEST})[ \\t]*\\)`, 'g');

const SCHEDULED_CLASS = new RegExp(
  `(?<![가-힣])(?:오늘|내일|모레)[ \t]+\\d{1,2}[ \t]*교시(?:에|에는|엔)[ \t]+(${STUDENT_NAME_IN_REQUEST})[ \t]+` +
  '(?:국어|수학|영어|사회|과학|체육|음악|미술|도덕|실과)[ \t]+수업(?:이에요|입니다|이[ \t]*있어요|이[ \t]*있습니다)(?![가-힣])',
  'gu'
);

function scheduledStudentNames(text) {
  return [...text.matchAll(SCHEDULED_CLASS)].map(match => match[1]);
}

function studentClasses(text) {
  const byName = new Map();
  for (const [, grade, room, number, name] of text.matchAll(STUDENT_CLASS)) {
    if (!byName.has(name)) byName.set(name, new Set());
    byName.get(name).add(`${grade}학년 ${room}반${number ? ` ${number}번` : ''}`);
  }
  return byName;
}

function plausibleName(name) {
  return !NOT_NAME.test(name) && !ORDINARY_WORDS.has(name) && !GROUP_STUDENT_WORD.test(name);
}

function notePeople(text, senderName) {
  const explicit = new Set();
  const students = new Set();
  const candidates = new Set();
  const destinations = new Set();
  const named = new Map();
  for (const sentence of text.split(/\n|(?<=[!?。！？])|(?<!\d)\.(?!\d)/u)) {
    const namedTask = WORK_QUESTION.test(sentence) || SEND_REQUEST.test(sentence) ||
      STUDENT_CHECK.test(sentence) && (CHECK_SUBJECT_CUE.test(sentence) || CHECK_EXCEPTION.test(sentence)) ||
      /평가(?:지|표|서)?/.test(sentence) && OFFER_OR_REQUEST.test(sentence);
    for (const [match, names, particle] of sentence.matchAll(STUDENT_SUBJECTS)) {
      const people = names.split(STUDENT_SUBJECT_SEPARATOR).filter(plausibleName);
      const direct = /^(?:에게|한테|께)$/.test(particle) && SEND_REQUEST.test(sentence.slice(match.index + match.length));
      for (const name of people) {
        students.add(name);
        named.set(name, 'student');
        if (direct) destinations.add(name);
        else if (namedTask) candidates.add(name);
      }
    }
    for (const match of sentence.matchAll(NAMED_STAFF_DESTINATION)) {
      if (!plausibleName(match[1]) || !/(?:보내|제출|회신|전달|연락|문의|보고)/u.test(sentence.slice(match.index + match[0].length))) continue;
      named.set(match[1], 'person');
      destinations.add(match[1]);
    }
    for (const [, name] of sentence.matchAll(DESTINATION_FIELD)) {
      if (!plausibleName(name)) continue;
      named.set(name, 'person');
      destinations.add(name);
    }
    for (const [, name] of [...sentence.matchAll(SPACED_STAFF_TITLE), ...sentence.matchAll(ATTACHED_STAFF_TITLE)]) {
      if (plausibleName(name) && !ORDINARY_STAFF_WORD.test(name) && !named.has(name)) named.set(name, 'person');
    }
    for (const [, name] of sentence.matchAll(LABELED_DESTINATION)) {
      if (!plausibleName(name) || ORDINARY_STAFF_WORD.test(name)) continue;
      if (!named.has(name)) named.set(name, 'person');
      destinations.add(name);
    }
    for (const [, name] of sentence.matchAll(OFFICE_CONTACT)) {
      if (name !== senderName) continue;
      named.set(name, 'person');
      destinations.add(name);
    }
    const assessment = sentence.match(NAMED_ASSESSMENT);
    if (assessment && plausibleName(assessment[1]) && OFFER_OR_REQUEST.test(sentence)) {
      named.set(assessment[1], 'person');
      candidates.add(assessment[1]);
    }
    for (const pattern of STUDENT_NAMES) {
      for (const [, name] of sentence.matchAll(pattern)) {
        if (!plausibleName(name)) continue;
        explicit.add(name);
        named.set(name, 'student');
      }
    }
  }
  if (STUDENT_CHECK.test(text)) for (const name of explicit) candidates.add(name);
  if (students.size === 1 && (STUDENT_FOLLOWUP.test(text) || /[?？]/u.test(text) && /말씀[ \t]*부탁/u.test(text))) {
    candidates.add(students.values().next().value);
  }
  const names = [...new Set([...destinations, ...candidates])];
  const [name] = names;
  const classes = name && studentClasses(text).get(name);
  const [studentClass] = classes || [];
  return { target: name ? [studentClass, name].filter(Boolean).join(' ') : null, named,
    needsReview: names.length > 1 || (classes?.size ?? 0) > 1 || CHECK_EXCEPTION.test(text), requested: names.length > 0 };
}

function explicitStudentNames(texts) {
  const found = new Set();
  for (const text of texts) {
    for (const [, names] of String(text ?? '').matchAll(STUDENT_SUBJECTS)) {
      for (const name of names.split(STUDENT_SUBJECT_SEPARATOR).filter(plausibleName)) found.add(name);
    }
  }
  return [...found];
}

function noteContacts(text, source) {
  const links = [...text.matchAll(URL_TEXT)];
  const contacts = CONTACT_PATTERNS.flatMap(([label, pattern]) =>
    [...text.matchAll(pattern)].filter(match =>
      !links.some(url => url.index <= match.index && match.index < url.index + url[0].length)).map(match => {
      const line = text.slice(text.lastIndexOf('\n', match.index - 1) + 1, match.index);
      return { index: match.index, label, value: match[0], source, context: line.match(CONTACT_OWNER)?.[1] ?? null };
    }));
  return contacts.sort((a, b) => a.index - b.index).map(({ index, ...contact }) => contact);
}

function splitNoteLink(url) {
  let core = url;
  while (LINK_PUNCTUATION.test(core)) {
    const end = core.at(-1);
    const open = LINK_BRACKETS[end];
    if (open && core.split(open).length >= core.split(end).length) break;
    core = core.slice(0, -1);
  }
  const suffix = core.match(LINK_FOLLOWUP)?.[0] || '';
  const end = core.length - suffix.length;
  return [url.slice(0, end), url.slice(end)];
}

function noteLinks(text, source) {
  return [...text.matchAll(URL_TEXT)].flatMap(([url]) => {
    const [value] = splitNoteLink(url);
    try {
      const parsed = new URL(/^www\./i.test(value) ? 'https://' + value : value);
      return /^(?:https?):$/.test(parsed.protocol) ? [{ value: parsed.href, source }] : [];
    } catch {
      return [];
    }
  });
}

function makeNoteMask(aliases, attachmentNames = []) {
  const names = [...aliases.keys()].sort((a, b) => b.length - a.length);
  const escape = text => text.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&');
  const patterns = names.map(name => {
    const literal = escape(name);
    const context = name.length === 2 && (NOT_NAME.test(name) || ORDINARY_WORDS.has(name)) ?
      '(?=[ \\t]*' + NAME_ROLE + '|(?:에게(?:서|는)?|한테|께(?:서|서는)?)(?![가-힣]))' : '';
    return [new RegExp('(?<![가-힣A-Za-z0-9])' + literal + context + '(?=' + PERSON_END + ')', 'g'), aliases.get(name)];
  });
  // 머리말에서 확인된 상대가 끝인사에 소속과 이름을 붙여 쓰는 경우도 가린다.
  const signaturePatterns = names.filter(name => name.length >= 3 && /^\[상대 \d+\]$/u.test(aliases.get(name))).map(name =>
    [new RegExp(escape(name) + '(?=[ \\t]*(?:드림|올림)[ \\t]*[.!…]?[ \\t]*$)', 'gm'), aliases.get(name)]);
  const filenamePatterns = names.map(name =>
    [new RegExp('(?<![가-힣A-Za-z])' + escape(name) + '(?![가-힣A-Za-z])', 'g'), aliases.get(name)]);
  const attachments = [...new Set(attachmentNames)].filter(name => typeof name === 'string' && name.length > 0).sort((a, b) => b.length - a.length);
  return value => {
    let text = String(value ?? '');
    for (const attachment of attachments) {
      const masked = filenamePatterns.reduce((filename, [pattern, alias]) => filename.replace(pattern, alias), attachment);
      if (masked !== attachment) text = text.replaceAll(attachment, () => masked);
    }
    text = text.replace(URL_TEXT, url => '[링크]' + splitNoteLink(url)[1])
      .replace(NATIONAL_ID, '[주민등록번호]')
      .replace(COMPACT_NATIONAL_ID, '$1[주민등록번호]')
      .replace(STUDENT_ID, (match, label, number) => ISO_DAY.test(number) ? match : label + '[학생 번호]')
      .replace(STUDENT_CLASS, (match, _grade, _room, number, name) => number && aliases.has(name) ?
        match.replace(/\d{1,2}[ \t]*번/u, '[학생 번호]') : match)
      .replace(ACCOUNT_NUMBER, (match, label, account) => ISO_DAY.test(account) ? match : label + '[계좌번호]')
      .replace(ADDRESS_UNIT, '[상세 주소]')
      .replace(PASSWORD_FIELD, '$1[비밀번호]');
    for (const [label, pattern] of CONTACT_PATTERNS) {
      text = text.replace(pattern, label === '전화' ? '[전화번호]' : '[이메일]');
    }
    for (const pattern of STUDENT_NAMES) {
      text = text.replace(pattern, (match, name) => {
        const alias = aliases.get(name);
        if (!alias) return match;
        const offset = match.lastIndexOf(name);
        return match.slice(0, offset) + alias + match.slice(offset + name.length);
      });
    }
    for (const [pattern, replacement] of patterns) text = text.replace(pattern, replacement);
    for (const [pattern, replacement] of signaturePatterns) text = text.replace(pattern, replacement);
    return text;
  };
}

module.exports = { findPersonalInfo, roster, notePeople, studentClasses, explicitStudentNames, scheduledStudentNames, noteContacts, noteLinks, makeNoteMask };
