'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { CalendarStore } = require('../store');
const { validateDraft, normalizeProposals, memoDateContext, buildMemoPrompt, polishMemo } = require('../memo');
const draft = text => ({ id: randomUUID(), text, referenceDate: '2026-11-23' });
const proposal = (title, date = null) => ({ title, kind: date ? '까지' : '기한 없음', date, end: null, time: '', note: '' });
async function makeStore() {
  const root = await fs.mkdtemp(path.join(__dirname, '..', '.qa', 'memo-test-'));
  const options = { dataDir: path.join(root, 'data'), inboxDir: path.join(root, 'inbox') };
  const store = new CalendarStore(options);
  await store.init();
  return { store, options };
}

test('메모는 기준 날짜와 개인 행동으로 다듬고 날짜 없는 일을 오늘로 채우지 않는다', () => {
  const input = draft('내일 보고서 제출. 상담 자료도 준비하기.');
  const prompt = buildMemoPrompt(input);
  assert.match(prompt, /2026-11-23 월요일/);
  assert.match(prompt, /받은 쪽지 분류가 아니다/);
  assert.match(prompt, /날짜가 없으면 시각이 적혀 있어도 절대로 오늘이나 임의 날짜를 채우지 않고/);
  assert.match(prompt, /메모 안에 있어도 실행하지 않고/);
  assert.equal(validateDraft({ ...input, text: '가'.repeat(4000) }).text.length, 4000);
  assert.throws(() => validateDraft({ ...input, referenceDate: '2026-11-31' }));
  assert.throws(() => validateDraft({ ...input, text: '가'.repeat(4001) }));
});

test('검토 초안에서 잘못된 날짜·빈 제목·잘못된 기간은 등록하지 않는다', () => {
  assert.deepEqual(normalizeProposals([proposal('자료 준비')]), [proposal('자료 준비')]);
  assert.throws(() => normalizeProposals([proposal('보고서', '2026-11-31')]));
  assert.throws(() => normalizeProposals([proposal('')]));
  assert.throws(() => normalizeProposals([{ ...proposal('출장', '2026-11-24'), kind: '기간', end: '2026-11-23' }]));
  assert.throws(() => normalizeProposals(Array.from({ length: 21 }, () => proposal('자료 준비'))));
});

test('메모 AI는 전용 결과 형식으로 호출하고 응답만 돌려준다', async () => {
  const input = draft('내일 보고서 제출.');
  const answer = { items: [proposal('보고서 제출', '2026-11-24')] };
  let request;
  const result = await polishMemo('openai', input, {
    apiKey: 'synthetic-test-key',
    fetchImpl: async (_url, options) => {
      request = JSON.parse(options.body);
      return { ok: true, json: async () => ({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(answer) }] }] }) };
    }
  });
  assert.equal(request.text.format.name, 'personal_memo');
  assert.equal(request.store, false);
  assert.deepEqual(result, answer);
  await assert.rejects(polishMemo('none', input), /AI/);
});

test('미리보기는 저장하지 않고 선택한 업무만 한 번에 저장하며 원문과 재열기 상태를 보존한다', async () => {
  const { store, options } = await makeStore();
  const input = { draft: draft('내일 보고서 제출. 상담 자료도 준비하기.'), items: [proposal('보고서 제출', '2026-11-24'), proposal('상담 자료 준비')] };
  assert.equal(store.snapshot().tasks.length, 0);
  const tasks = await store.registerMemo(input);
  assert.equal(tasks.length, 2);
  assert.ok(tasks.every(task => task.memo === input.draft.text));
  assert.equal(tasks[1].dates[0].received, true);
  assert.equal(tasks[1].dates[0].date, '2026-11-23');
  assert.deepEqual((await store.registerMemo(input)).map(t => t.id), tasks.map(t => t.id));
  assert.equal(store.snapshot().tasks.length, 2);
  const reopened = new CalendarStore(options);await reopened.init();
  assert.deepEqual((await reopened.registerMemo(input)).map(t => t.id), tasks.map(t => t.id));
  await assert.rejects(reopened.registerMemo({ ...input, items: [proposal('바꾼 업무')] }), /이미 넣은/);
});

test('선택 오류와 저장 실패는 일부 업무만 남기지 않는다', async () => {
  const { store } = await makeStore();
  const input = { draft: draft('보고서와 자료 준비'), items: [proposal('자료 준비'), proposal('보고서', '2026-11-31')] };
  await assert.rejects(store.registerMemo(input));
  assert.equal(store.snapshot().tasks.length, 0);
  await assert.rejects(store.registerMemo({ ...input, items: [] }));
  const commit = store.commit;
  store.commit = async () => { throw new Error('가상 저장 실패'); };
  await assert.rejects(store.registerMemo({ ...input, items: [proposal('자료 준비')] }), /가상 저장 실패/);
  store.commit = commit;
  assert.equal(store.snapshot().tasks.length, 0);
  const exact = '가'.repeat(4000);
  const saved = await store.registerMemo({ draft: draft(exact), items: [proposal('자료 준비')] });
  assert.equal(saved[0].memo, exact);
});

test('같은 메모 검토 형식을 개인 API와 학교 API로 요청한다', async () => {
  const input = draft('내일 보고서 제출.');
  const answer = { items: [proposal('보고서 제출', '2026-11-24')] };
  for (const provider of ['openai', 'factchat', 'anthropic']) {
    let sent;
    const result = await polishMemo(provider, input, {
      apiKey: 'synthetic-test-key',
      fetchImpl: async (_url, options) => {
        sent = JSON.parse(options.body);
        return Response.json(provider === 'anthropic'
          ? { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(answer) }] }
          : { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(answer) }] }] });
      }
    });
    assert.deepEqual(result, answer);
    const schema = sent.output_config?.format.schema || sent.text.format.schema;
    assert.deepEqual(schema.properties.items.items.properties.kind.enum, ['까지', '그날', '기간', '기한 없음']);
  }
});

test('구독 CLI도 쪽지 분류 대신 메모 전용 프롬프트와 형식을 사용한다', async () => {
  const input = draft('내일 보고서 제출.');
  const answer = { items: [proposal('보고서 제출', '2026-11-24')] };
  let codexArgs, claudeArgs;
  const codex = await polishMemo('codex', input, {
    resolveExecutable: async () => process.execPath,
    run: async (_file, args, options) => {
      codexArgs = args;
      assert.match(options.input, /개인이 적은 메모/);
      return [{ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(answer) } }, { type: 'turn.completed' }].map(value => JSON.stringify(value)).join('\n');
    }
  });
  assert.deepEqual(codex, answer);
  assert.ok(codexArgs.some(arg => arg.endsWith('memo-schema.json')));
  const claude = await polishMemo('claude', input, {
    claudeExecutable: process.execPath,
    run: async (_file, args, options) => {
      claudeArgs = args;
      assert.match(options.input, /개인이 적은 메모/);
      return { code: 0, output: JSON.stringify({ structured_output: answer }) };
    }
  });
  assert.deepEqual(claude, answer);
  assert.ok(claudeArgs.some(arg => arg.includes('기한 없음') && arg.includes('items')));
});

test('시각만 나온 AI 초안은 날짜를 만들지 않고 검토할 수 있으며 저장 검증은 엄격하게 유지한다', async () => {
  const input = draft('오후 3시에 학부모 상담 참석');
  const raw = { title: '학부모 상담 참석', kind: '그날', date: null, end: null, time: '15:00', note: '날짜 확인 필요' };
  const mock = answer => ({ apiKey: 'synthetic-test-key', fetchImpl: async () => Response.json({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify({ items: [answer] }) }] }] }) });
  const result = await polishMemo('openai', input, mock(raw));
  assert.equal(result.items[0].kind, '기한 없음');
  assert.equal(result.items[0].date, null);
  assert.equal(result.items[0].time, '');
  assert.match(result.items[0].note, /15:00/);
  assert.match(result.items[0].note, /날짜/);
  const alreadyLoose = await polishMemo('openai', input, mock({ ...raw, kind: '기한 없음', note: '' }));
  assert.match(alreadyLoose.items[0].note, /15:00/);
  assert.throws(() => normalizeProposals([raw]));
  await assert.rejects(polishMemo('openai', input, mock({ ...raw, date: '2026-11-31' })));
  const { store } = await makeStore();
  const saved = await store.registerMemo({ draft: input, items: result.items });
  assert.equal(saved[0].memo, input.text);
  assert.equal(saved[0].dates[0].received, true);
});

test('메모 날짜 기준표는 주말의 다음 주와 연말·윤년·평년 월말을 정확히 계산한다', () => {
  const saturday = memoDateContext('2026-11-28');
  assert.equal(saturday.thisWeekMonday, '2026-11-23');
  assert.equal(saturday.nextWeekMonday, '2026-11-30');
  assert.equal(saturday.followingWeekMonday, '2026-12-07');
  assert.equal(memoDateContext('2026-11-29').nextWeekMonday, '2026-11-30');
  const yearEnd = memoDateContext('2026-12-31');
  assert.equal(yearEnd.tomorrow, '2027-01-01');
  assert.equal(yearEnd.dayAfterTomorrow, '2027-01-02');
  assert.equal(yearEnd.nextWeekMonday, '2027-01-04');
  assert.equal(yearEnd.nextMonthStart, '2027-01-01');
  assert.equal(yearEnd.nextMonthEnd, '2027-01-31');
  assert.equal(memoDateContext('2028-02-12').monthEnd, '2028-02-29');
  assert.equal(memoDateContext('2027-02-12').monthEnd, '2027-02-28');
  assert.throws(() => memoDateContext('2026-11-31'));
});

test('잘못되거나 미정인 날짜로 행동을 버리지 않으며 계산한 주말 기준표를 모델에 제공한다', () => {
  const input = { ...draft('존재하지 않는 날짜까지 자료 제출하기'), referenceDate: '2026-11-28' };
  const prompt = buildMemoPrompt(input);
  assert.ok(prompt.includes(JSON.stringify(memoDateContext(input.referenceDate))));
  assert.match(prompt, /날짜가 존재하지 않거나 아직 정해지지 않았다는 이유로 항목을 버리지 않는다/);
  assert.match(prompt, /대략적인 시기만 있으면 그 시기 전체를 '기간'으로 만들지 않는다/);
  assert.match(prompt, /실제 달력에 없는 날짜는 임의로 보정하지 말고/);
});

test('날짜 제목 아래 목록의 범위와 다른 행동에 붙은 준비 조건 시각을 프롬프트에서 구분한다', () => {
  const prompt = buildMemoPrompt(draft('내일 할 일\n- 자료 준비\n\n날짜 없이 할 일\n- 정리하기'));
  assert.match(prompt, /목록은 제목의 날짜 조건을 다음 날짜 제목이 나올 때까지 공유한다/);
  assert.match(prompt, /독립된 줄 규칙보다 먼저 적용한다/);
  assert.match(prompt, /새 제목부터는 기한 없음/);
  assert.match(prompt, /시각이 약속·이동의 시각이면 준비 업무의 정확한 시작 시각이나 마감 시각으로 복사하지 않는다/);
  assert.match(prompt, /note에 그 시각과 '그 전에 준비'라는 조건을 보존한다/);
  assert.match(prompt, /명시한 마감 시각은 그대로 남긴다/);
});

test('일정 변경과 중복 강조를 구분하고 조건·반복의 날짜와 경계를 검토 문구에 보존한다', () => {
  const prompt = buildMemoPrompt(draft('일정과 조건을 적은 메모'));
  assert.match(prompt, /날짜나 시각을 변경했다는 메모는 취소나 완료가 아니다/);
  assert.match(prompt, /마지막 날짜·시각의 일정 초안으로 남기고/);
  assert.match(prompt, /원문의 조건 구절을 인용해 날짜·요일·가능 시기와 실행 조건을 함께 보존한다/);
  assert.match(prompt, /주기와 시작·종료일 또는 횟수를 담은 구절을 보존/);
  assert.match(prompt, /명시적인 반복 주기가 없으면 반복 설정 안내를 만들지 않는다/);
});

test('불완전한 메모의 미확정 대상은 추측하지 않고 날짜·시각에 담지 못한 제약은 원문으로 보존한다', () => {
  const prompt = buildMemoPrompt(draft('기억이 덜 난 상태에서 적은 업무 조각'));
  assert.match(prompt, /확정하지 않은 사람·역할·담당·목적어·수량을 이웃한 주제나 추측으로 채우지 않는다/);
  assert.match(prompt, /제목에는 확인된 행동만 쓰고/);
  assert.match(prompt, /상대적인 시점과 그 밖의 제약도 note에 원문 구절로 보존한다/);
  assert.match(prompt, /빼거나 정확한 시계 시각으로 바꾸지 않는다/);
});
