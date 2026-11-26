'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { buildNoteInput, noteActions, restoreNoteAnswer, withMaskingContext, resolveNoteEvidence, noteEvidenceView } = require('../note-text');
const { buildWorkPrompt } = require('../work-prompt');

function note(fields) {
  return {
    title: '가상 일정', sender: '박모아 교사 <moa@example.test>',
    recipients: '강마음 <maeum@example.test>', datetime: '2030-05-01 09:00', verified: true,
    body: '', ...fields
  };
}

test('가린 구절과 중복, 틀린 인용 위치는 건너뛰고 원문 그대로 확인한 조건만 남긴다', () => {
  const repeated = '금요일까지 회신해 주세요.';
  const contact = '담당자 이메일: teacher@example.test';
  const condition = '오후 3시 이후에만 접수합니다.';
  const body = [repeated, contact, repeated, condition].join('\n');
  const source = note({ body });
  assert.equal(resolveNoteEvidence(source, [
    { part: 0, quote: repeated },
    { part: 0, quote: '담당자 이메일: [이메일]' },
    { part: 1, quote: condition }
  ]), null);
  const stored = resolveNoteEvidence(source, [
    { part: 0, quote: '<b>금요일에 회신</b>' },
    { part: 0, quote: condition },
    { part: 0, quote: '이후에만 접수합니다.' }
  ]);
  assert.deepEqual(noteEvidenceView(source, stored), {
    original: [{ start: body.indexOf(condition), end: body.length }]
  });
});

test('원문 줄바꿈이 CRLF여도 두 줄에 걸친 근거를 화면 범위로 찾아낸다', () => {
  const start = '업무 안내\r\n'.length;
  const evidence = '금요일 오후 3시 이후에만 접수합니다.\r\n그 전에는 제출하지 마세요.';
  const source = note({ body: '업무 안내\r\n' + evidence + '\n감사합니다.' });
  const stored = resolveNoteEvidence(source, [{ part: 0, quote: evidence.replaceAll('\r\n', '\n') }]);
  assert.deepEqual(noteEvidenceView(source, stored), { original: [{ start, end: start + evidence.length }] });
});

test('AI에는 참가자·학생·연락처만 가리고 요청, 날짜, 시각, 수신 역할을 전달한다', () => {
  const body = [
    '강마음 선생님은 다음 주 월요일(2030-05-06) 14:30에 교무실 회의에 참석해 주세요.',
    '학생 이름: 김구',
    '5학년 1반 최다솜 학생 보호자 연락처: 010-1234-5678',
    '이상 3명은 5월 7일까지 초안을 다 쓰고, 박모아 선생님께 teacher@example.test로 회신합니다.',
    '신청은 https://forms.example.test/register, 개인 링크 https://forms.example.test/?name=%EA%B0%95%EB%A7%88%EC%9D%8C를 확인해 주세요.',
    '첨부는 앱에서 확인', '2026.8.27(목) 오후 3시까지 승인'
  ].join('\n');
  const original = note({ title: '박모아 선생님 공지', body, attachmentNames: ['비공개 이름.txt'] });
  const input = buildNoteInput(original, { grade: 5, duties: ['박모아 선생님과 협의', 'test@example.test'] });
  assert.equal(input.senderRole, '상대 1');
  assert.deepEqual(input.recipientRoles, ['나']);
  assert.equal(input.title, '[상대 1] 선생님 공지');
  assert.match(input.latestBody, /\[나\] 선생님은 다음 주 월요일\(2030-05-06\) 14:30에 교무실 회의에 참석해 주세요\./);
  assert.match(input.latestBody, /학생 이름: \[학생 1\]/);
  assert.match(input.latestBody, /5학년 1반 \[학생 2\] 학생 보호자 연락처: \[전화번호\]/);
  assert.match(input.latestBody, /이상 3명은 5월 7일까지/);
  assert.match(input.latestBody, /신청은 \[링크\], 개인 링크 \[링크\]를 확인해 주세요/);
  assert.match(input.latestBody, /2026\.8\.27\(목\) 오후 3시까지 승인/);
  const serialized = JSON.stringify(input);
  for (const secret of ['박모아', '강마음', '김구', '최다솜', 'teacher@example.test', 'test@example.test', '010-1234-5678', '비공개 이름.txt', 'forms.example.test']) {
    assert.ok(!serialized.includes(secret));
  }
  assert.equal(original.body, body);
});

test('같은 사람의 현재·이전 발신 방향을 유지하고 인용 날짜·담당을 추정하지 않는다', () => {
  const original = note({ title: '[전달] 실험실 제출', body: [
    '아래 원문을 따릅니다. 최다솜 교사가 보낸 항목을 확인해 주세요.',
    '----- 원본메시지 -----',
    '발 신 자 : 최다솜 <dasom@example.test>',
    '수 신 자 : 박모아 <moa@example.test>,',
    '강마음 <maeum@example.test>',
    '발신시간 : 2030-05-01 오전 8시',
    '제목: 최다솜 제출 안내', '',
    '강마음 선생님, 실험 계획서를 5월 4일까지 보내 주세요.', '',
    '----- 원본메시지 -----',
    'Sender', ' : 강마음 <maeum@example.test>',
    'Date', ' : 2030-04-30',
    'Title', ' : 협조 요청', '',
    '이전 요청은 제가 취소했습니다.'
  ].join('\n') });
  const input = buildNoteInput(original, null);
  assert.match(input.latestBody, /\[상대 2\] 교사가 보낸 항목/);
  assert.deepEqual(input.quotedNotes.map(quote => [quote.senderRole, quote.recipientRoles, quote.datetime]),
    [['상대 2', ['상대 1', '나'], '2030-05-01'], ['나', [], '2030-04-30']]);
  assert.match(input.quotedNotes[0].body, /\[나\] 선생님, 실험 계획서를 5월 4일까지 보내 주세요/);
  assert.deepEqual(noteActions(original).quoteSenders, ['최다솜', '강마음']);
  assert.equal(noteActions(original).sourceRequester, '최다솜');
});

test('수신자 일부만 알려진 단체 쪽지는 나를 임의로 고르지 않는다', () => {
  const original = note({ title: '[전달] 업무 안내', recipients: '강마음 외 12명', body: [
    '아래 전달드립니다.', 'Original Message',
    'Sender: 최다솜', 'Date: 2030-05-01', '',
    '서류 제출해 주세요.'
  ].join('\n') });
  const input = buildNoteInput(original);
  assert.equal(input.recipientRole, '나');
  assert.equal(input.recipientCount, 13);
  assert.ok(!input.recipientRoles.includes('나'));
  assert.equal(noteActions(original).forwarded, true);
  assert.equal(noteActions(original).sourceRequester, null);
  assert.deepEqual(noteActions(original).quoteSenders, ['최다솜']);

  const group = note({ ...original, recipients: '수신자 (부서: 2, 수신인: 41)' });
  assert.equal(buildNoteInput(group).recipientCount, 41);
  assert.deepEqual(buildNoteInput(group).recipientRoles, []);
  assert.equal(restoreNoteAnswer({ summary: '[나]가 제출할지 확인' }, group).summary, '내가 제출할지 확인');
});

test('동명이인은 알려진 헤더의 두 역할을 나누고 본문의 어떤 개인인지 단정하지 않는다', () => {
  const original = note({
    sender: '권새길 <from@example.test>', recipients: '권새길 <to@example.test>',
    body: '권새길 선생님이 늦으면 2030-05-12까지 다른 반 담당자에게 전달해 주세요.'
  });
  const input = buildNoteInput(original);
  assert.equal(input.senderRole, '상대 1');
  assert.deepEqual(input.recipientRoles, ['나']);
  assert.match(input.latestBody, /\[동명이인\] 선생님이 늦으면 2030-05-12까지/);
  const modelAnswer = { type: '할 일', title: '[동명이인] 전달', summary: '[상대 1] 또는 [학생 99]', dates: [] };
  assert.deepEqual(restoreNoteAnswer(modelAnswer, original),
    { ...modelAnswer, summary: '[대상 확인] 또는 [대상 확인]' });
});

test('연락처는 검증된 쪽지 안에서 이번 글·이전 발신자와 연결하고 카드에서 일반 문구로 처리할 수 있다', () => {
  const body = [
    '보호자 연락처: 010-1234-5678로 5월 1일 16시까지 전화해 주세요.',
    '신청 링크: https://forms.example.test/open?contact=out-of-context@example.test',
    'Original Message', 'Sender: 최다솜 <header@example.test>', 'Date: 2030-04-27', '',
    '행정실 이메일: cash@example.test', '교무실 031-123-4567', 'https://school.example.test/outreach에서 참고하세요.'
  ].join('\n');
  const original = note({ title: '가상 업무', body });
  assert.deepEqual(noteActions(original), {
    sender: '박모아 교사', forwarded: false, referenceOnly: false, sourceRequester: null, quoteSenders: ['최다솜'],
    target: null, targetReview: null,
    contacts: [
      { label: '전화', value: '010-1234-5678', source: '이번 쪽지', context: '보호자' },
      { label: '이메일', value: 'cash@example.test', source: '이전 안내 1', context: '행정실' },
      { label: '전화', value: '031-123-4567', source: '이전 안내 1', context: '교무실' }
    ],
    links: [
      { value: 'https://forms.example.test/open?contact=out-of-context@example.test', source: '이번 쪽지' },
      { value: 'https://school.example.test/outreach', source: '이전 안내 1' }
    ],
  });
  assert.deepEqual(noteActions({ ...original, verified: false }).contacts, []);
  assert.deepEqual(noteActions({ ...original, verified: false }).links, []);
  const malformed = note({ body: '이번 글입니다.\nOriginal Message\nSender: 박겨울 <secret@example.test>\n전화 010-5555-6666' });
  assert.deepEqual(noteActions(malformed).contacts, []);
  assert.ok(!/박겨울|secret@example\.test|5555/.test(JSON.stringify(buildNoteInput(malformed))));
  assert.match(buildNoteInput(malformed).latestBody, /전화 \[전화번호\]/);
  const folded = note({ body: '이번 글입니다.\nOriginal Message\nTo: 박겨울 <secret@example.test>,\n권소담 <folded@example.test>\n5월 3일까지 재확인해 주세요.' });
  const input = buildNoteInput(folded);
  assert.ok(!/박겨울|권소담|example\.test/.test(input.latestBody));
  assert.match(input.latestBody, /5월 3일까지 재확인해 주세요/);
});

test('확인 대상의 이름과 학급은 원문에서 카드로 가져오고 AI에는 역할과 업무 문장만 보낸다', () => {
  const body = '2학년 1반 7번 윤해봄 학생이 2030.10.20까지 과제를 냈는지 확인해 주세요.';
  const original = note({ body });
  assert.equal(noteActions(original).target, '2학년 1반 7번 윤해봄');
  assert.equal(noteActions(original).targetReview, null);
  assert.equal(buildNoteInput(original).latestBody, '2학년 1반 [학생 번호] [학생 1] 학생이 2030.10.20까지 과제를 냈는지 확인해 주세요.');
  assert.doesNotMatch(buildWorkPrompt({ title: '과제 확인' }, original), /윤해봄/);
  assert.equal(original.body, body);
  assert.equal(noteActions(note({ body: '학생 이름: 윤해봄\n오늘까지 출결을 확인해 주세요.' })).target, '윤해봄');
  assert.equal(noteActions(note({ body: '윤해봄 학생이 신청을 취소했는지 확인해 주세요.' })).target, '윤해봄');
  assert.equal(noteActions({ ...original, verified: false }).target, null);
});

test('여러 학생, 동명이인, 제외된 학생, 인용 속 학생은 한 사람을 확인 대상으로 지정하지 않는다', () => {
  const multiple = note({ body: '윤해봄과 최다온 학생이 과제를 냈는지 확인해 주세요.' });
  const namesakes = note({ body: '2학년 1반 윤해봄 학생이 과제를 냈는지 확인해 주세요. 2학년 2반 윤해봄 학생도 제출했는지 확인해 주세요.' });
  const excluded = note({ body: '윤해봄 학생은 제외하고 명단을 확인해 주세요.' });
  for (const original of [multiple, namesakes, excluded]) {
    assert.equal(noteActions(original).target, null);
    assert.equal(noteActions(original).targetReview, 'current');
    assert.doesNotMatch(buildNoteInput(original).latestBody, /윤해봄|최다온/);
  }
  assert.equal(buildNoteInput(namesakes).latestBody.match(/\[동명이인\]/g)?.length, 2);
  const previous = '\nOriginal Message\nSender: 남푸름\nDate: 2030-05-01\n\n윤해봄 학생이 과제를 냈는지 확인해 주세요.';
  const forwarded = note({ title: '[전달] 확인 요청', body: '아래 요청을 전달합니다.' + previous });
  const acknowledged = note({ title: '[답장] 확인 완료', body: '감사합니다. 확인했습니다.' + previous });
  assert.equal(noteActions(forwarded).target, null);
  assert.equal(noteActions(forwarded).targetReview, 'previous');
  assert.doesNotMatch(buildNoteInput(forwarded).quotedNotes[0].body, /윤해봄/);
  assert.equal(noteActions(acknowledged).targetReview, null);
  const group = note({ body: '전입생 학생이 서류를 제출했는지 확인해 주세요.' });
  assert.equal(noteActions(group).target, null);
  assert.equal(buildNoteInput(group).latestBody, group.body);
});

test('제출 여부 질문, 학생 전달 요청과 동료 제출처를 카드와 AI 입력에서 같은 사람으로 연결한다', () => {
  const cases = [
    ['윤해봄 학생이 자료를 제출했나요? 제출 여부를 알려주시기 바랍니다.', '윤해봄', '[학생 1]'],
    ['윤해봄 학생 평가 자료는 따로 보내도록 하겠습니다.', '윤해봄', '[학생 1]'],
    ['윤해봄 평가 점수를 평가표로 보내주시면 감사하겠습니다.', '윤해봄', '[대상 1]'],
    ['최다온 학생 학급에는 안내문을 배부했습니다. 개별 안내문은 윤해봄 학생에게 배부해주시면 감사하겠습니다.', '윤해봄', '[학생 2]'],
    ['윤해봄 학생이 오늘 교실에 옵니다. 전달 말씀 부탁드립니다.', '윤해봄', '[학생 1]'],
    ['윤해봄 선생님께 제출하면 되나요?', '윤해봄', '[대상 1]'],
    ['3. 제출방법: 행정실 자료 담당(박모아)', '박모아', '[상대 1]'],
  ];
  for (const [body, name, alias] of cases) {
    const original = note({ body });
    const input = buildNoteInput(original);
    assert.equal(noteActions(original).target, name, body);
    assert.ok(input.latestBody.includes(alias), body);
    assert.ok(!input.latestBody.includes(name) && !input.latestBody.includes('최다온'), body);
    assert.equal(restoreNoteAnswer({ summary: alias }, original).summary, name);
  }
  const count = note({ body: '학급에서 정확한 학생 수를 회신해 주시면 감사하겠습니다.' });
  assert.equal(noteActions(count).target, null);
  assert.equal(noteActions(count).targetReview, null);
  assert.equal(buildNoteInput(count).latestBody, count.body);
  const twoRequests = note({ body: '윤해봄 학생이 자료를 제출했나요? 안내문은 최다온 학생에게 전달해 주세요.' });
  assert.equal(noteActions(twoRequests).target, null);
  assert.equal(noteActions(twoRequests).targetReview, 'current');
  const contactRole = note({ body: '제출방법: 행정실 보관함(원본만)' });
  assert.equal(noteActions(contactRole).target, null);
  assert.equal(buildNoteInput(contactRole).latestBody, contactRole.body);
});

test('완료해서 참고용으로 전달한 경우 인용된 요청자를 현재 업무에 연결하지 않는다', () => {
  const original = note({ title: '[전달] 자료 제출', body: [
    '이미 제출 완료했습니다. 참고용입니다.', 'Original Message', 'Sender: 최다솜', 'Date: 2030-05-01', '',
    '5월 8일까지 자료를 제출해 주세요.',
  ].join('\n') });
  const { forwarded, referenceOnly, sourceRequester, quoteSenders } = noteActions(original);
  assert.deepEqual({ forwarded, referenceOnly, sourceRequester, quoteSenders },
    { forwarded: true, referenceOnly: true, sourceRequester: null, quoteSenders: ['최다솜'] });
  const group = note({ ...original, recipients: '최다솜 <dasom@example.test>; 강마음 <maeum@example.test>',
    body: original.body.replace('이미 제출 완료했습니다. 참고용입니다.', '원문을 전달드립니다.') });
  assert.equal(noteActions(group).sourceRequester, null);
  const separateTask = note({ ...original, body: original.body.replace('참고용입니다.', '내일까지 서류를 다시 제출해 주세요.') });
  assert.equal(noteActions(separateTask).referenceOnly, false);
});

test('연속 날짜·시간을 전화나 계좌로 오인하지 않고 확인된 양식과 숫자에서만 개인정보를 가린다', () => {
  const body = [
    '일정 2030-05-01~2030-05-04. 15:30 신청. 3번 장소는 유지합니다.',
    '일정표 계좌 2030-05-07은 열 번호입니다.',
    '실제 계좌번호: 301-1234-5678-11로 5월 8일 3교시까지 입금',
    '주소 101동 1203호를 확인하고 2교시 뒤 출발',
    '가입 시 가상 비밀번호: 838xV7를 쓰고 정해진 7시까지 신청'
  ].join('\n');
  const input = buildNoteInput(note({ body }));
  assert.match(input.latestBody, /일정 2030-05-01~2030-05-04\. 15:30 신청\. 3번 장소는 유지/);
  assert.match(input.latestBody, /일정표 계좌 2030-05-07은 열 번호/);
  assert.match(input.latestBody, /계좌번호: \[계좌번호\]로 5월 8일 3교시까지 입금/);
  assert.match(input.latestBody, /\[상세 주소\]를 확인하고 2교시 뒤 출발/);
  assert.match(input.latestBody, /비밀번호: \[비밀번호\]를 쓰고 정해진 7시까지 신청/);
});

test('개인 링크, 복합 연락처, 학번과 암호를 가리고 같은 문장 안의 업무 날짜를 유지한다', () => {
  const original = note({ sender: '강봄비', attachmentNames: ['강봄비2030-05-12.pdf'], body: [
    '신청 링크 https://forms.example.test/open?token=CANARY_TOKEN을 확인하고 5월 3일까지 회신해 주세요.',
    '개인 확인 링크 https://forms.example.test/open?이름=원래이름을 확인하고 5월 4일까지 제출해 주세요.',
    '보호자 전화 (02) 555-1234, 교무실 02)555-4321. 5월 2일 13:45에 연락하세요.',
    'PIN: 8387와 암호: "secret with spaces"를 입력하고 5월 5일까지 완료해 주세요.',
    '주민등록번호: 1234561123456 / 학번: 20301022 / 학생 번호: AB882931',
    '성명: 강별하',
    '비교 날짜 2030-10-20 또는 2030. 10. 21입니다. 첨부 강봄비2030-05-12.pdf를 16:00까지 확인 바랍니다.',
  ].join('\n') });
  const payload = buildNoteInput(original).latestBody;
  for (const secret of ['CANARY_TOKEN', '원래이름', '555-1234', '555-4321', '8387', 'secret with spaces',
    '1234561123456', '20301022', 'AB882931', '강별하', '강봄비']) assert.ok(!payload.includes(secret), secret);
  for (const retained of ['5월 3일까지 회신', '5월 4일까지 제출', '5월 2일 13:45에 연락', '5월 5일까지 완료',
    '2030-10-20 또는 2030. 10. 21', '2030-05-12.pdf를 16:00까지 확인']) assert.ok(payload.includes(retained), retained);
  assert.deepEqual(noteActions(original).contacts.map(contact => contact.value), ['(02) 555-1234', '02)555-4321']);
});

test('AI가 준 제목과 근거의 알려진 이름만 로컬에서 되돌리고 업무·달력의 실제 날짜 값은 그대로 둔다', () => {
  const original = note({ body: '5학년 1반 최다솜 학생이 낸 서류를 강마음 선생님이 확인해 주세요.' });
  const response = {
    type: '할 일', title: '[학생 1] 자료 확인', summary: '[나]가 [학생 1] 서류 확인',
    dates: [{ date: '2030-05-02', end: null, kind: '까지', label: '[학생 1] 자료' }],
    uncertain: false
  };
  const local = restoreNoteAnswer(response, original);
  const scoped = restoreNoteAnswer({ ...response, dates: [{ ...response.dates[0], appliesTo: '[학생 1]만', shortScope: '[학생 1]', shortLabel: '[학생 1]에게 전달' }] }, original);
  assert.equal(scoped.dates[0].appliesTo, '최다솜만');
  assert.equal(scoped.dates[0].shortLabel, '최다솜에게 전달');
  assert.equal(scoped.dates[0].shortScope, '최다솜');
  assert.equal(scoped.dates[0].date, response.dates[0].date);
  assert.deepEqual(local, {
    ...response, title: '최다솜 자료 확인', summary: '내가 최다솜 서류 확인',
    dates: [{ ...response.dates[0], label: '최다솜 자료' }],
  });
  const prompt = buildWorkPrompt(local, original);
  assert.match(prompt, /2030-05-02까지/);
  assert.match(prompt, /\[학생 1\] 자료 확인/);
  assert.match(prompt, /이번 쪽지 · \[상대 1\] → \[나\]/);
  assert.ok(!prompt.includes('최다솜') && !prompt.includes('강마음'));
});

test('교사 호칭과 머리말에 확인된 발신자 서명은 가리고 일반 역할과 업무를 보존한다', () => {
  const original = note({ body: [
    '2030-06-03 10:30에 이봄 선생님, 최해솔쌤과 회의합니다.',
    '신규 선생님과 기존 선생님, 전담 선생님은 다음 주 화요일까지 안내장을 확인해 주세요.',
    '담임박모아드림'
  ].join('\n') });
  const input = buildNoteInput(original);
  for (const name of ['이봄', '최해솔', '박모아']) assert.ok(!input.latestBody.includes(name));
  assert.match(input.latestBody, /\[대상 1\] 선생님, \[대상 2\]쌤/);
  assert.match(input.latestBody, /담임\[상대 1\]드림$/);
  assert.match(input.latestBody, /2030-06-03 10:30/);
  assert.match(input.latestBody, /신규 선생님과 기존 선생님, 전담 선생님은 다음 주 화요일까지 안내장을 확인해 주세요/);
  assert.equal(noteActions(original).target, null);
});

test('제출 담당 표시에서 필요한 이름을 카드에 두고 전송용 입력에는 같은 사람의 별칭을 쓴다', () => {
  const original = note({ body: [
    '제출(담당: 정하늬): 6월 5일 14:00까지 계획서 제출.',
    '정하늬 선생님께 이메일 teacher@example.test로 보내 주세요.'
  ].join('\n') });
  const card = noteActions(original);
  assert.equal(card.target, '정하늬');
  assert.equal(card.targetReview, null);
  assert.equal(card.contacts[0].value, 'teacher@example.test');
  const input = buildNoteInput(original);
  assert.match(input.latestBody, /제출\(담당: \[대상 1\]\): 6월 5일 14:00까지 계획서 제출/);
  assert.match(input.latestBody, /\[대상 1\] 선생님께 이메일 \[이메일\]로 보내 주세요/);
  assert.equal(input.senderRole, '상대 1');
  assert.deepEqual(input.recipientRoles, ['나']);

  const generic = note({ body: '제출(담당: 행정실): 6월 5일까지 계획서 제출.' });
  assert.equal(noteActions(generic).target, null);
  assert.equal(buildNoteInput(generic).latestBody, generic.body);

  const two = note({ body: original.body + '\n회신 (담당자: 윤해봄): 내일까지 회신.' });
  assert.equal(noteActions(two).target, null);
  assert.equal(noteActions(two).targetReview, 'current');
});

test('호칭 없는 수업 안내에는 같은 보관함에서 학생으로 확인된 이름만 가린다', () => {
  const previous = note({ body: '이로반 학생의 수업 안내입니다.' });
  const unverified = note({ body: '정하루 학생의 수업 안내입니다.', verified: false });
  const genericNameField = note({ body: '교사 신청 성명: 박나래' });
  const inbox = new Map([['student', previous], ['unverified', unverified], ['generic', genericNameField]]);
  const original = note({ title: '이로반 수업 안내', body: [
    '오늘 3교시에 이로반 체육 수업이에요.',
    '오늘 4교시에 통합반 체육 수업이에요.',
    '내일 2교시에 정하루 수학 수업입니다.',
    '내일 3교시에 박나래 음악 수업입니다.',
    '강마음 선생님은 6월 5일 14:00까지 계획서를 박모아 선생님께 보내 주세요.'
  ].join('\n') });
  const contextual = withMaskingContext(original, inbox);
  const input = buildNoteInput(contextual);
  assert.equal(input.title, '[학생 1] 수업 안내');
  assert.equal(input.latestBody, original.body.replace('이로반', '[학생 1]')
    .replace('강마음', '[나]').replace('박모아', '[상대 1]'));
  assert.equal(input.senderRole, '상대 1');
  assert.deepEqual(input.recipientRoles, ['나']);
  assert.ok(!buildWorkPrompt({ title: original.title, dates: [] }, contextual).includes('이로반'));
  assert.equal(restoreNoteAnswer({ title: '[학생 1] 체육 수업' }, contextual).title, '이로반 체육 수업');
  assert.ok(buildNoteInput(withMaskingContext(original, new Map())).latestBody.includes('이로반'));
  assert.ok(!JSON.stringify(input).includes('이로반'));
});

test('쪽지 수신처로도 표시되는 도서실은 본문에서 위치로 남긴다', () => {
  const noteWithRoom = note({
    recipients: '도서실',
    title: '도서실에서 연수 안내',
    body: '6월 5일 14:00까지 도서실에서 연수에 참석해 주세요.'
  });
  const input = buildNoteInput(noteWithRoom);
  assert.equal(input.title, noteWithRoom.title);
  assert.equal(input.latestBody, noteWithRoom.body);
  assert.deepEqual(input.recipientRoles, ['나']);
});
