'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { classifierSample, refineWithProvider } = require('../ai-provider');
const { buildNoteInput, profileValue } = require('../note-text');
const schema = require('../refinement-schema.json');

const rulesPath = path.join(__dirname, '..', 'rules-seed.md');
const syntheticKey = 'synthetic-api-key-for-tests';
const structured = { type: '할 일', title: '가상 연수 신청', summary: '신청서 제출', dates: [{ date: '2030-05-10', label: '신청서 제출', kind: '까지' }], uncertain: false };
const completed = value => Response.json({ status: 'completed', output: [
  { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(value) }] }
] });
const sentNote = input => JSON.parse(input.slice(input.lastIndexOf('\n\n') + 2));

const connections = [
  { id: 'openai', endpoint: 'https://api.openai.com/v1/responses', maxOutputTokens: 4096 },
  { id: 'factchat', endpoint: 'https://factchat-cloud.mindlogic.ai/v1/gateway/responses/', maxOutputTokens: 6144 }
];

for (const { id, endpoint, maxOutputTokens } of connections) {
  test(`${id} 분류는 시험과 같은 모델·추론·형식으로 이번 글과 인용을 나눠 보내고 수신인·첨부 이름은 보내지 않는다`, async () => {
    const note = {
      ...classifierSample, recipients: '가상 수신자 외 23',
      body: '이전 공지 확인\r\n-----Original Message-----\r\nSender: a@example.test\r\nTo: b@example.test\r\nDate: 2030-05-01\r\nTitle: 가상 연수\r\n\r\n전달합니다.\r\n-----Original Message-----\r\nSender: c@example.test\r\nTo: d@example.test\r\nDate: 2030-04-30\r\nTitle: 가상 신청서\r\n\r\n2030년 5월 10일까지 제출',
      attachmentNames: ['외부에 보내지 않을 첨부.pdf']
    };
    let sent;
    const result = await refineWithProvider(id, note, {
      rulesPath, apiKey: syntheticKey, profile: { grade: 4, classroom: 2, role: '전담', homeroomTeacher: false, subjects: ['영어'], subjectGrades: [3, 4], duties: ['학생자치'], memberships: [] },
      fetchImpl: async (url, request) => {
        assert.equal(url, endpoint);
        assert.equal(request.headers.Authorization, `Bearer ${syntheticKey}`);
        sent = JSON.parse(request.body);
        return completed(structured);
      }
    });
    assert.deepEqual(result, structured);
    assert.equal(sent.model, 'gpt-6-luna');
    assert.deepEqual(sent.reasoning, { effort: 'high' });
    assert.equal(sent.max_output_tokens, maxOutputTokens);
    assert.equal(sent.store, false);
    assert.equal(sent.text.format.strict, true);
    assert.deepEqual(sent.text.format.schema, schema);
    assert.ok(!sent.tools);
    const input = sentNote(sent.input);
    assert.equal(input.latestBody, '이전 공지 확인');
    assert.deepEqual(input.quotedNotes.map(quote => [quote.title, quote.datetime]), [['가상 연수', '2030-05-01'], ['가상 신청서', '2030-04-30']]);
    assert.equal(input.quotedNotes[1].body, '2030년 5월 10일까지 제출');
    assert.equal(input.recipientCount, 24);
    assert.equal(input.recipientRole, '나');
    assert.deepEqual(input.recipientProfile, { workplace: '학교', schoolLevel: '초등', grade: 4, classroom: 2, role: '전담', homeroomTeacher: false, subjects: ['영어'], subjectGrades: [3, 4], duties: ['학생자치'], memberships: null });
    assert.equal(input.datetime, '2030-05-01 09:00:00');
    assert.ok(!/example\.test|외부에 보내지 않을 첨부|시험용 발신자/.test(sent.input));
  });
}

test('출력 한도에 닿으면 추론 보통으로 한 번, 일시 오류면 쉬었다가 한 번 다시 부른다', async () => {
  const requests = [];
  const limited = await refineWithProvider('factchat', classifierSample, {
    rulesPath, apiKey: syntheticKey,
    fetchImpl: async (_url, request) => {
      requests.push(JSON.parse(request.body));
      return requests.length === 1 ? Response.json({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] }) : completed(structured);
    }
  });
  assert.deepEqual(requests.map(request => request.reasoning.effort), ['high', 'medium']);
  assert.deepEqual(requests.map(request => request.max_output_tokens), [6144, 6144]);
  assert.deepEqual(limited, structured);

  const waits = [];
  let calls = 0;
  await refineWithProvider('factchat', classifierSample, {
    rulesPath, apiKey: syntheticKey, wait: async ms => { waits.push(ms); },
    fetchImpl: async () => ++calls === 1 ? new Response('busy', { status: 503 }) : completed(structured)
  });
  assert.equal(calls, 2);
  assert.deepEqual(waits, [3000]);

  let failing = 0;
  await assert.rejects(refineWithProvider('factchat', classifierSample, {
    rulesPath, apiKey: syntheticKey, wait: async () => {},
    fetchImpl: async () => { failing++; return new Response('busy', { status: 503 }); }
  }), /팩트챗 API에서 정리를 받지 못했습니다/);
  assert.equal(failing, 2);
});

test('브리티의 원본메시지 구분선과 한국어 머리말도 이번 글과 인용으로 나눈다', () => {
  const body = [
    '네 내일 2시에 뵙겠습니다.', '',
    "'-------------------- 원본메시지 --------------------",
    '발 신 자 : 가상 상대 <x@example.test>', '발신시간 : 2030-05-07 오전 11:14', '',
    '내일 찾아뵈어도 될까요?', '',
    '-------------------- 원본메시지 --------------------',
    '발 신 자 : 가상 나', '발신시간 : 2030-05-07 오전 11:03', '',
    '자료 확인 부탁드립니다.'
  ].join('\n');
  const input = buildNoteInput({ title: 'RE: 자료 확인', datetime: '2030-05-08 09:00', body, recipients: '가상 상대' }, null);
  assert.equal(input.latestBody, '네 내일 2시에 뵙겠습니다.');
  assert.deepEqual(input.quotedNotes.map(quote => [quote.datetime, quote.body]), [['2030-05-07', '내일 찾아뵈어도 될까요?'], ['2030-05-07', '자료 확인 부탁드립니다.']]);
  assert.equal(input.replyHint, '답장');
  assert.equal(input.recipientCount, 1);
  assert.equal(input.recipientProfile, null);
  assert.ok(!JSON.stringify(input).includes('example.test'));
});

test('OpenAI 인증 실패 메시지는 키나 원격 오류 본문을 포함하지 않는다', async () => {
  await assert.rejects(refineWithProvider('openai', classifierSample, {
    rulesPath, apiKey: syntheticKey,
    fetchImpl: async () => Response.json({ error: { message: `raw upstream error ${syntheticKey}` } }, { status: 401 })
  }), error => error.message.includes('API 키가 올바르지') && !error.message.includes(syntheticKey));
});

test('팩트챗 크레딧 부족을 안내하고 원격 오류 본문을 노출하지 않는다', async () => {
  await assert.rejects(refineWithProvider('factchat', classifierSample, {
    rulesPath, apiKey: syntheticKey,
    fetchImpl: async () => Response.json({ error: { message: syntheticKey } }, { status: 402 })
  }), error => error.message.includes('팩트챗 API 크레딧이 부족') && !error.message.includes(syntheticKey));
});

test('내 역할: 교육청 사용자는 기관·부서·직위·담당 학교급만 AI에 보낸다', () => {
  const office = profileValue({ workplace: '교육청', schoolLevel: null, grade: null, role: null, officeType: '시도교육청', department: '', position: '일반직', coveredLevels: ['중학교'], duties: ['방과후'], memberships: [] });
  assert.deepEqual(office, { workplace: '교육청', officeType: '시도교육청', department: null, position: '일반직', coveredLevels: ['중학교'], duties: ['방과후'], memberships: null });
  assert.equal(profileValue({ workplace: '학교', schoolLevel: '고등학교', grade: 1 }).schoolLevel, '고등학교');
  assert.equal(profileValue(null), null);
});
