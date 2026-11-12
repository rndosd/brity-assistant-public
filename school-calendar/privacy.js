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

module.exports = { findPersonalInfo, roster };
