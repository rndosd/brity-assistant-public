'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { summarizeHwpx } = require('../hwpx-summary');

const field = (title, evidence, extra = {}) => ({ title, detail: '', dateText: '', evidence, source: 'attachment', ...extra });
const parsed = input => JSON.parse(input.slice(input.lastIndexOf('\n\n') + 2));

test('날짜 없는 첨부의 요약만 보이고 첨부 원문을 새 날짜로 채우지 않는다', async () => {
  const result = await summarizeHwpx({ text: '과학 키트는 학급별 한 상자이며 면장갑을 준비합니다.', provider: 'openai',
    requestApi: async (provider, input, _options, schema) => {
      assert.equal(provider.model, 'gpt-6-luna');
      assert.equal(parsed(input).attachment, '과학 키트는 학급별 한 상자이며 면장갑을 준비합니다.');
      assert.deepEqual(schema.required, ['summary', 'items']);
      return { summary: '학급별 키트 한 상자, 면장갑 준비', items: [] };
    } });
  assert.deepEqual(result, { summary: '학급별 키트 한 상자, 면장갑 준비', items: [] });
});

test('원문을 벗어난 날짜·시각을 버리고 맞지 않는 요일은 확인 필요로 표시한다', async () => {
  const evidence = '워크숍은 2026년 12월 4일(목) 15:30 시청각실에서 합니다.';
  const result = await summarizeHwpx({ text: evidence, note: { datetime: '2026-11-26 09:00' }, provider: 'codex',
    requestCodex: async (_input, schemaPath, options) => {
      assert.match(schemaPath, /hwpx-summary-schema\.json$/u);
      assert.equal(options.model, 'gpt-6-luna');
      return { summary: '시청각실에서 워크숍 개최', items: [
        field('워크숍', evidence, { detail: '시청각실', dateText: '2026년 12월 4일(목) 15:30' }),
        field('12월 5일 워크숍', evidence),
        field('참석 안내', evidence, { detail: '16:30에 참석', dateText: '12월 5일' })
      ] };
    } });
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].detail, '시청각실 · 2026년 12월 4일(목) 15:30 · 날짜와 요일 확인 필요');
  assert.equal(result.items[1].detail, '날짜 확인 필요');
});

test('근거는 분리된 자료와 대조하고 현재 쪽지의 정정을 첨부와 구분한다', async () => {
  const added = '제출 기한을 12월 2일 17:00로 정정합니다.';
  const attachment = '수요조사표는 12월 1일 16:00까지 도서실에 제출합니다.';
  const result = await summarizeHwpx({ text: attachment, note: { body: `${added}\nOriginal Message\nFrom: 가상\n과거 안내`, datetime: '2026-11-26 09:00' }, provider: 'anthropic',
    requestApi: async (provider, input) => {
      assert.equal(provider.model, 'claude-haiku-5-5');
      assert.equal(parsed(input).note, added);
      return { summary: '수요조사표 제출', items: [
        field('수요조사표 제출', added, { source: 'note', dateText: '12월 2일 17:00' }),
        field('잘못된 출처', attachment, { source: 'note' }),
        field('출처가 없는 항목', '반드시 회신하세요.'),
        field('수요조사표 제출', added, { source: 'note', dateText: '12월 2일 17:00' })
      ] };
    } });
  assert.deepEqual(result.items, [{ title: '수요조사표 제출', detail: '12월 2일 17:00', evidence: added, source: 'note' }]);
});

test('첨부의 이름·전화·연결은 전송 전에 가리고 근거를 검증한 뒤 원문을 돌려준다', async () => {
  const attachment = '대상: 4학년 1반 2번 김가상 학생. 문의 전화 010-1234-5678, https://example.org/fake';
  const result = await summarizeHwpx({ text: attachment, provider: 'claude',
    requestClaude: async (input, schemaText) => {
      assert.doesNotMatch(input, /김가상|010-1234-5678|example\.org/u);
      const data = parsed(input);
      assert.match(data.attachment, /⟦학생 /u);
      assert.match(schemaText, /dateText/u);
      return { summary: '대상자 확인 및 문의', items: [field('대상자 확인', data.attachment)] };
    } });
  assert.equal(result.items[0].evidence, attachment);
});

test('미정과 연도를 확인할 날짜는 원문의 표현을 보존한다', async () => {
  const result = await summarizeHwpx({ text: '연수 일자 12월 4일. 준비 회의는 추후 공지합니다.', provider: 'codex',
    requestCodex: async () => ({ summary: '12월 15일 연수', items: [
      field('연수', '연수 일자 12월 4일.', { dateText: '12월 4일' }),
      field('준비 회의', '준비 회의는 추후 공지합니다.', { dateText: '추후 공지' })
    ] }) });
  assert.equal(result.summary, '');
  assert.deepEqual(result.items.map(item => item.detail), ['12월 4일 · 연도 확인 필요', '추후 공지 · 날짜 확인 필요']);
});

test('명시된 날짜와 시각은 원문 표현으로 유지하고 확인이 필요한 날짜를 표시한다', async () => {
  const examples = [
    ['행사', '안전 연수는 2027년 1월 5일(화) 오후 3시 40분입니다.', '2027년 1월 5일(화) 오후 3시 40분'],
    ['시각 확인', '워크숍은 2026년 12월 4일 금요일 3시입니다.', '12월 4일'],
    ['연말 경계', '자료 제출 기한은 1월 5일입니다.', '1월 5일'],
    ['기간', '체험전은 12월 9일부터 12월 11일까지 진행합니다.', '12월 9일부터 12월 11일까지'],
    ['상대 날짜', '내일(11월 27일)까지 제출합니다.', '내일(11월 27일)까지'],
    ['조건부', '참여가 확정된 교사만 12월 4일 연수에 참석합니다.', '12월 4일'],
    ['정해지지 않은 종류', '자료에 12월 3일이 적혀 있습니다.', '12월 3일'],
    ['날짜 불일치', '워크숍은 2026년 12월 4일 목요일입니다.', '12월 4일'],
    ['원문 후속 선택지', '제출 기한은 12월 5일', '12월 5일', ' 또는 12월 7일입니다.'],
    ['실제로 없는 날짜', '개최 일시는 2027년 2월 29일입니다.', '2027년 2월 29일']
  ];
  const result = await summarizeHwpx({
    text: examples.map(([, evidence, , tail = '']) => evidence + tail).join('\n'),
    note: { datetime: '2026-11-26 09:00' }, provider: 'openai',
    requestApi: async () => ({ summary: '행사, 기간, 제출 기한 안내',
      items: examples.slice(0, 8).map(([title, evidence, dateText]) => field(title, evidence, { dateText })) })
  });
  for (const [index, item] of result.items.entries()) {
    const { title, detail } = item;
    assert.equal(title, examples[index][0]);
    assert.ok(detail.includes(examples[index][2]));
    assert.deepEqual(Object.keys(item).sort(), ['detail', 'evidence', 'source', 'title']);
  }
  assert.equal(result.items.length, 8);
  assert.match(result.items[7].detail, /날짜와 요일 확인 필요/u);

  const lastExamples = examples.slice(8);
  const rejected = await summarizeHwpx({
    text: lastExamples.map(([, evidence, , tail = '']) => evidence + tail).join('\n'),
    note: { datetime: '2026-11-26 09:00' }, provider: 'codex',
    requestCodex: async () => ({ summary: '자료 날짜 안내',
      items: lastExamples.map(([title, evidence, dateText]) => field(title, evidence, { dateText })) })
  });
  assert.equal(rejected.items.length, 2);
  assert.equal(rejected.items[0].detail, '12월 5일');
  assert.match(rejected.items[1].detail, /날짜 확인 필요/u);
});

test('날짜와 부분 근거가 함께 나온 유일한 첨부 표 행으로 근거를 넓힌다', async () => {
  const workshop = '| 안전교육 | 12월 9일 14:20 | 시청각실에서 안전교육 참여 |';
  const exhibit = '| 전시 기간 | 12월 14일부터 18일까지 | 1층 복도에서 안전 포스터 전시 |';
  const other = '| 사후 점검 | 12월 14일 | 정리 확인 |';
  const result = await summarizeHwpx({
    text: ['태블릿을 가져오세요.', workshop, exhibit, other, other].join('\n'),
    note: { datetime: '2026-11-26 09:00' }, provider: 'codex',
    requestCodex: async () => ({ summary: '안전교육과 포스터 전시', items: [
      field('안전교육 참여', '시청각실에서 안전교육 참여', { dateText: '12월 9일 14:20' }),
      field('안전 포스터 전시', '1층 복도에서 안전 포스터 전시', { dateText: '12월 14일부터 18일까지' }),
      field('서로 다른 행', '1층 복도에서 안전 포스터 전시', { dateText: '12월 9일 14:20' }),
      field('중복 행', '정리 확인', { dateText: '12월 14일' }),
      field('붙임의 다른 문단', '태블릿을 가져오세요.', { dateText: '12월 9일 14:20' }),
      field('근거 누락', '', { dateText: '12월 9일 14:20' })
    ] })
  });
  assert.equal(result.items.length, 5);
  assert.deepEqual(result.items[0], { title: '안전교육 참여', detail: '12월 9일 14:20', evidence: workshop, source: 'attachment' });
  assert.deepEqual(result.items[1], { title: '안전 포스터 전시', detail: '12월 14일부터 18일까지', evidence: exhibit, source: 'attachment' });
  assert.ok(result.items.slice(2).every(item => item.detail === '날짜 확인 필요'));
});

test('신청과 교육의 일자·시각 목록과 상대 기한은 그대로 표시한다', async () => {
  const schedule = [
    '신청 기간: 2026. 11. 26.(목) 20:00 ~ 12. 2.(수) 20:00',
    '교육일자: 2026. 12. 5.(토), 12. 12.(토), 12. 19.(토)',
    '교육시간: 09:00 ~ 13:00',
    '불참 시 개강 3일 전까지 연락하세요.'
  ];
  const dates = ['2026. 11. 26.(목) 20:00 ~ 12. 2.(수) 20:00',
    '2026. 12. 5.(토), 12. 12.(토), 12. 19.(토)', '09:00 ~ 13:00', '개강 3일 전까지'];
  const labels = ['신청', '교육일 확인', '교육시간 확인', '불참 알리기'];
  const result = await summarizeHwpx({
    text: schedule.join('\n'), note: { datetime: '2026-11-26 09:00' }, provider: 'codex',
    requestCodex: async () => ({
      summary: '교육에 한 번 참여하며 1인당 4시간 수강합니다.',
      items: schedule.map((evidence, index) => field(labels[index], evidence, { dateText: dates[index] }))
    })
  });
  assert.equal(result.summary, '교육에 한 번 참여하며 1인당 4시간 수강합니다.');
  assert.deepEqual(result.items.map(item => item.detail), dates);
});

test('짧게 인용한 날짜의 요일 불일치는 전체 원문에서 확인한다', async () => {
  const workshop = '워크숍은 2026년 12월 4일';
  const practice = '실습 연수는 2026년 12월 5일';
  const result = await summarizeHwpx({
    text: workshop + '(목) 15:30에 시작합니다.\n' + practice + ' 이후 선정된 학급만 참석합니다.',
    provider: 'codex',
    requestCodex: async () => ({
      summary: '워크숍과 실습 연수 안내입니다.',
      items: [
        field('워크숍', workshop, { dateText: '2026년 12월 4일' }),
        field('실습 연수', practice, { dateText: '2026년 12월 5일' })
      ]
    })
  });
  assert.match(result.items[0].detail, /날짜와 요일 확인 필요/u);
  assert.ok(result.items.every(item => !Object.hasOwn(item, 'draftDate')));
});

test('8천 자부터만 긴 공문의 실행 주체와 다른 기관 참고 일정을 구분하도록 요청한다', async () => {
  const summary = '학교 제출과 지원기관 접수 안내입니다.';
  const events = [
    '담당 교사는 12월 3일까지 교무부에 명단을 제출합니다.',
    '지원기관은 12월 7일까지 별도 접수를 받습니다.'
  ].join('\n');
  for (const size of [7_999, 8_000]) {
    const text = events + '\n' + '가'.repeat(size - events.length - 1);
    const result = await summarizeHwpx({
      text, provider: 'claude',
      requestClaude: async (input, _schema, prompt) => {
        assert.equal(parsed(input).attachment, text);
        assert.ok(input.startsWith(prompt + '\n\n'));
        if (size === 8_000) {
          assert.match(prompt, /실행 주체, 적용 대상, 제출·접수처, 행동, 기한/u);
          assert.match(prompt, /다른 기관의 참고 일정/u);
          assert.match(prompt, /주체나 대상이 다른 일정은 날짜가 달라도 서로 정정하거나 충돌한 것으로 보지 마세요/u);
        } else {
          assert.doesNotMatch(prompt, /실행 주체 확인 필요/u);
        }
        return { summary, items: [] };
      }
    });
    assert.equal(result.summary, summary);
  }
});


test('정정된 신청서 마감은 혼합 인용에서 제외하고 참여 대상과 별도 기한은 남긴다', async () => {
  const audience = '수업 나눔 주간에는 4~6학년 담임과 희망 전담 교사가 참여합니다.';
  const canceled = '참가 신청서 제출 마감은 12월 2일 16:00까지이며 교내 업무게시판에 제출합니다.';
  const current = '참가 신청서는 12월 3일 17:40까지 교내 업무게시판에 제출합니다.';
  const other = '교육청 참가 신청서 제출 마감은 12월 2일 16:00까지입니다.';
  const event = '| 공개 수업 | 12월 11일 10:20 | 솔마루실에서 수업 공개 |';
  const entry = (title, detail, dateText, evidence, source = 'attachment') => ({ title, detail, dateText, evidence, source });
  const result = await summarizeHwpx({
    text: [audience, canceled, other, event].join('\n'),
    note: { body: '붙임의 참가 신청서 마감이 변경되었습니다. ' + current, datetime: '2026-11-26 09:00' },
    provider: 'factchat',
    requestApi: async (_connection, input) => {
      assert.match(input, /참여 대상이 분명하면/);
      return {
        summary: '수업 나눔 주간 안내입니다. 참가 신청서 마감은 12월 2일 16:00까지입니다.',
        items: [
          entry('참가 신청서 제출', '', '12월 3일 17:40까지', current, 'note'),
          entry('참가 대상 및 신청 방법', '4~6학년 담임과 희망 전담 교사가 참여합니다.', '12월 2일 16:00까지', audience + '\n' + canceled),
          entry('정정 전 마감', '', '12월 2일 16:00까지', '12월 2일 16:00까지이며 교내 업무게시판에 제출합니다.'),
          entry('교육청 별도 제출', '교육청 제출용', '12월 2일 16:00까지', other),
          entry('공개 수업', '솔마루실', '12월 11일 10:20', event)
        ]
      };
    }
  });
  assert.equal(result.summary, '수업 나눔 주간 안내입니다.');
  assert.equal(result.items.length, 4);
  assert.match(result.items[0].detail, /12월 3일 17:40/u);
  assert.equal(result.items[1].evidence, audience);
  assert.doesNotMatch(result.items[1].detail, /12월 2일/);
  assert.equal(result.items[2].evidence, other);
  assert.match(result.items[2].detail, /12월 2일 16:00/);
  assert.equal(result.items[3].evidence, event);
});

test('명시된 참여 대상이 모델 출력에서 빠지면 날짜 없이 원문 근거로 보완한다', async () => {
  const evidence = '수업 나눔 주간에는 4~6학년 담임과 희망 전담 교사가 참여합니다.';
  const text = evidence + '\n교육은 추후 안내합니다.';
  const requestClaude = async () => ({ summary: '수업 나눔 주간 운영 안내입니다.', items: [] });
  const result = await summarizeHwpx({ text, provider: 'claude', requestClaude });
  assert.deepEqual(result.items, [{ title: '참여 대상', detail: '4~6학년 담임과 희망 전담 교사', evidence, source: 'attachment' }]);
  const changed = await summarizeHwpx({ text, note: { body: '참여 대상이 변경되었습니다.' }, provider: 'claude', requestClaude });
  assert.deepEqual(changed.items, []);
});

test('한 문장의 변경·정정도 같은 행동만 바꾸고 새 근거가 생략된 경우 쪽지에서 보완한다', async () => {
  const fields = (title, evidence, dateText, source = 'attachment') => ({ title, evidence, dateText, source, detail: '' });
  const cases = [
    {
      title: '과학 캠프 참가 신청',
      previous: '과학 캠프 참가 신청 마감은 12월 3일 17:00입니다.',
      correction: '과학 캠프의 참가 신청 기한을 12월 5일 17:00으로 변경합니다.',
      separate: '과학 캠프 참가 신청 증빙서류 제출 마감은 12월 3일 17:00입니다.',
      otherTitle: '증빙서류 제출'
    },
    {
      title: '학교 명단 제출',
      previous: '학교는 12월 3일 17:00까지 명단을 제출합니다.',
      correction: '학교가 명단을 제출하는 기한은 12월 5일 17:00으로 정정합니다.',
      separate: '교육지원청은 12월 3일 17:00까지 최종 명단을 제출합니다.',
      otherTitle: '교육지원청 명단 제출'
    }
  ];
  for (const row of cases) {
    const result = await summarizeHwpx({
      text: row.previous + '\n' + row.separate,
      note: { body: row.correction, datetime: '2026-11-26 09:00' },
      provider: 'factchat',
      requestApi: async () => ({
        summary: row.title + ' 기한은 12월 3일 17:00입니다.',
        items: [fields(row.title, row.previous, '12월 3일 17:00'), fields(row.otherTitle, row.separate, '12월 3일 17:00')]
      })
    });
    assert.equal(result.summary, row.correction);
    assert.equal(result.items.length, 2);
    assert.equal(result.items[0].evidence, row.correction);
    assert.match(result.items[0].evidence, /12월 5일 17:00/u);
    assert.equal(result.items[1].evidence, row.separate);
    assert.match(result.items[1].detail, /12월 3일 17:00/u);
  }
});

test('교육청 표기가 있는 원문을 학교 마감으로 표시하지 않고 학교 공모 기간은 보존한다', async () => {
  const office = '(교육청) 학년말 교육활동 우수사례 제출(~12.11.)';
  const school = '◦ (공모기간) 2026. 11. 20.(금) ~ 12. 10.(목)';
  const result = await summarizeHwpx({
    text: [office, school].join('\n'),
    note: { datetime: '2026-11-11 09:00' },
    provider: 'claude',
    requestClaude: async () => ({
      summary: "학교 학년말 운영 안내입니다. 우수사례는 교육청으로 공문 제출하며, 제출 기한은 원문의 '~12.11.'입니다.",
      items: [
        { title: '우수사례 제출', detail: '학교가 교육청에 우수사례를 제출합니다.', evidence: office, dateText: '~12.11.', source: 'attachment' },
        { title: '학교 공모 기간', detail: '우수사례 공모', evidence: school, dateText: '2026. 11. 20.(금) ~ 12. 10.(목)', source: 'attachment' }
      ]
    })
  });
  assert.equal(result.summary, '학교 학년말 운영 안내입니다.');
  assert.equal(result.items[0].detail, office);
  assert.match(result.items[0].title, /교육청/);
  assert.equal(result.items[1].evidence, school);
  assert.match(result.items[1].detail, /12\. 10/);
});

test('서로 다른 프로그램의 참여 대상을 바꿔 붙인 설명을 원문별 대상과 일정으로 분리한다', async () => {
  const audiences = ['과학 연수 대상: 4~6학년 담임', '체육 연수 대상: 신규 전담 교사'];
  const schedule = ['과학 연수 일시는 12월 5일 14:30입니다.', '체육 연수 일시는 12월 7일 14:30입니다.'];
  const result = await summarizeHwpx({
    text: [...audiences, ...schedule].join('\n'),
    note: { datetime: '2026-11-26 09:00' },
    provider: 'claude',
    requestClaude: async () => ({
      summary: '과학 연수는 신규 전담 교사, 체육 연수는 4~6학년 담임 대상입니다.',
      items: [
        { title: '과학 연수', detail: '신규 전담 교사 대상', dateText: '12월 5일 14:30', evidence: schedule[0], source: 'attachment' },
        { title: '체육 연수', detail: '4~6학년 담임 대상', dateText: '12월 7일 14:30', evidence: schedule[1], source: 'attachment' }
      ]
    })
  });
  assert.doesNotMatch(result.summary, /신규 전담 교사/);
  assert.match(result.items[0].detail, /12월 5일 14:30/u);
  assert.doesNotMatch(result.items[0].detail, /신규 전담 교사/);
  assert.match(result.items[1].detail, /12월 7일 14:30/u);
  assert.doesNotMatch(result.items[1].detail, /4~6학년/);
  assert.deepEqual(result.items.slice(2).map(item => [item.title, item.evidence]), [
    ['과학 연수 참여 대상', audiences[0]], ['체육 연수 참여 대상', audiences[1]]
  ]);
});

test('원문에 붙은 실행 주체를 제목에 표시하고 제출처만 적힌 설명은 원문으로 바꾼다', async () => {
  const office = '(교육청) 초‧중‧고 학년말 교육활동 우수사례 제출(~12.11.)';
  const school = '(학교) 학교별 자체 계획 수립‧운영(11월~)';
  const other = '참가 신청서는 12월 10일까지 공문으로 제출합니다.';
  const result = await summarizeHwpx({
    text: [office, school, other].join('\n'),
    note: { datetime: '2026-11-11 09:00' },
    provider: 'claude',
    requestClaude: async () => ({
      summary: '학년말 운영 안내입니다.',
      items: [
        { title: '학년말 교육활동 우수사례 제출', detail: '제주특별자치도교육청 중등교육과로 공문 제출하는 방식입니다.', evidence: office, dateText: '~12.11.', source: 'attachment' },
        { title: '자체 계획 수립', detail: '학교가 자체 계획을 수립하고 운영합니다.', evidence: school, dateText: '', source: 'attachment' },
        { title: '참가 신청서 제출', detail: '공문으로 제출합니다.', evidence: other, dateText: '12월 10일까지', source: 'attachment' }
      ]
    })
  });
  assert.equal(result.items[0].title, '교육청 · 학년말 교육활동 우수사례 제출');
  assert.equal(result.items[0].detail, office);
  assert.equal(result.items[1].title, '자체 계획 수립');
  assert.equal(result.items[1].detail, '학교가 자체 계획을 수립하고 운영합니다.');
  assert.equal(result.items[2].title, '참가 신청서 제출');
  assert.match(result.items[2].detail, /공문으로 제출합니다.*12월 10일/u);
});
