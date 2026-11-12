'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { extractChatDecisions } = require('../chat-decisions');

const observedAt = '2026-11-11T15:20:00.000Z'; // Thursday in Korea.
const messages = (...texts) => texts.map(text => ({ text, observedAt }));
const extract = (...texts) => extractChatDecisions({ messages: messages(...texts) });
const view = decisions => decisions.map(({ action, title, due, time }) => [action, title, due, time]);

test('같은 방 앞선 제안을 새 글에서 확정할 때만 일정으로 올린다', () => {
  const context = messages('연구부 회의는 금요일 오후 2시 어떨까요?', '저는 괜찮습니다.');
  assert.deepEqual(extractChatDecisions({ context, messages: messages('넵.', '고맙습니다!') }), []);
  assert.deepEqual(view(extractChatDecisions({ context, messages: messages('그럼 그렇게 확정합니다.') })), [
    ['confirmed', '연구부 회의', '2026-11-13', '14:00']
  ]);
});

test('업무 요청은 날짜가 없어도 올리고 질문·예정·거절은 제외한다', () => {
  assert.deepEqual(view(extract(
    '안녕하세요! 내일까지 자료를 제출해 주세요.',
    '명단 확인 부탁드립니다.',
    '연구부 회의는 금요일에 할까요?',
    '설명회가 11월 18일에 열릴 예정입니다.',
    '교육 자료는 이미 제출했습니다.',
    '워크숍은 금요일로 확정되지 않았습니다.',
    '자료를 제출해 주실 수 있나요?'
  )), [
    ['task', '자료 제출', '2026-11-13', null],
    ['task', '명단 확인', null, null]
  ]);
});

test('확정된 날짜 변경과 취소를 같은 업무로 연결한다', () => {
  const existing = [{ id: 'a', title: '연구부 회의', due: '2026-11-13', time: '14:00', action: 'confirmed', observedAt }];
  const decisions = extractChatDecisions({ existing, messages: messages(
    '연구부 회의를 11월 13일에서 11월 16일 오후 3시 30분으로 변경합니다.',
    '연구부 회의는 취소됐습니다.'
  ) });
  assert.deepEqual(view(decisions), [
    ['changed', '연구부 회의', '2026-11-16', '15:30'],
    ['cancelled', '연구부 회의', null, null]
  ]);
  assert.deepEqual(decisions.map(({ matchId, messageIndex }) => [matchId, messageIndex]), [['a', 0], ['a', 1]]);
});

test('할 일의 마감 변경과 원문 한 줄의 복수 결정을 구분한다', () => {
  const decisions = extract('자료를 다음 주 월요일까지 제출해 주세요. 2026. 11. 20. 설명회는 14:10에 진행합니다.',
    '자료 제출 기한은 11월 19일로 변경됐습니다.');
  assert.deepEqual(view(decisions), [
    ['task', '자료 제출', '2026-11-16', null],
    ['confirmed', '설명회', '2026-11-20', '14:10'],
    ['changed', '자료 제출', '2026-11-19', null]
  ]);
  assert.equal(decisions[2].kind, 'task');
});

test('누가 무엇을 바꾸는지 모호하거나 날짜 후보가 여러 개면 일정으로 확정하지 않는다', () => {
  assert.deepEqual(extract(
    '금요일로 변경합니다.',
    '연구부 회의는 11월 13일 또는 11월 16일로 확정입니다.',
    '설명회가 내일 열릴 예정입니다. 진행을 취소하지 않습니다.'
  ), []);
});

test('브리티 수집 행의 발신자·시각을 일정으로 해석하지 않는다', () => {
  assert.deepEqual(view(extract(
    '가상 가상10:32연구부 회의는 금요일 오후 2시로 확정합니다.',
    '[가상] [10:33] 결과표 회신 부탁드립니다.',
    '가상 가상10:34고맙습니다.',
    '가상 가상10:3511월 20일에 설명회 진행합니다.'
  )), [
    ['confirmed', '연구부 회의', '2026-11-13', '14:00'],
    ['task', '결과표 회신', null, null],
    ['confirmed', '설명회', '2026-11-20', null]
  ]);
});

test('같은 이름의 새 일정은 독립적으로 유지하고 변경 대상이 명시된 경우에만 고친다', () => {
  const first = { id: 'a', title: '연구부 회의', due: '2026-11-13', time: '14:00', action: 'confirmed', observedAt };
  const second = { ...first, id: 'b', due: '2026-11-20' };
  const confirmed = extractChatDecisions({ existing: [first], messages: messages('11월 20일 연구부 회의 확정입니다.') });
  assert.deepEqual(view(confirmed), [['confirmed', '연구부 회의', '2026-11-20', null]]);
  assert.equal(confirmed[0].matchId, undefined);
  assert.deepEqual(extractChatDecisions({ existing: [first, second], messages: messages('연구부 회의는 취소됐습니다.') }), []);
  const changed = extractChatDecisions({ existing: [first, second], messages: messages('연구부 회의를 11월 13일에서 11월 16일로 변경합니다.') });
  assert.equal(changed[0].matchId, 'a');
  assert.equal(changed[0].previousDue, '2026-11-13');
  assert.equal(changed[0].due, '2026-11-16');
});

test('장소와 방식만 바뀌면 확정된 일정의 날짜와 시간을 유지한다', () => {
  const existing = [{ id: 'a', title: '연구부 회의', due: '2026-11-13', time: '14:00', action: 'confirmed', observedAt }];
  const decisions = extractChatDecisions({ existing, messages: messages(
    '연구부 회의 장소는 시청각실로 변경되었습니다.',
    '연구부 회의 진행 방식은 온라인으로 바뀌었습니다.'
  ) });
  assert.deepEqual(view(decisions), [
    ['changed', '연구부 회의', '2026-11-13', '14:00'],
    ['changed', '연구부 회의', '2026-11-13', '14:00']
  ]);
  assert.deepEqual(decisions.map(({ detail }) => detail), ['장소: 시청각실', '방식: 온라인']);
});

test('여러 메시지에 나뉜 주제와 날짜를 읽고 명시적인 확정이 오면 기록한다', () => {
  const context = messages('연구부 회의는 언제 할까요?', '금요일 오후 2시는 어떤가요?', ...Array(7).fill('좋은 하루 보내세요.'));
  assert.deepEqual(view(extractChatDecisions({ context, messages: messages('그럼 금요일로 할게요.') })), [
    ['confirmed', '연구부 회의', '2026-11-13', '14:00']
  ]);
  const other = messages('연구부 회의는 금요일 어떨까요?', '현장학습 설명회는 금요일 어때요?');
  assert.deepEqual(extractChatDecisions({ context: other, messages: messages('그날로 확정합니다.') }), []);
});

test('같은 묶음에서 새로 확정한 반복 일정도 명시된 이전 날짜로 변경할 수 있다', () => {
  const existing = [{ id: 'a', title: '연구부 회의', due: '2026-11-13', action: 'confirmed', observedAt }];
  const decisions = extractChatDecisions({ existing, messages: messages(
    '11월 20일 연구부 회의 확정입니다.', '연구부 회의를 11월 20일에서 11월 23일로 변경합니다.'
  ) });
  assert.deepEqual(view(decisions), [
    ['confirmed', '연구부 회의', '2026-11-20', null], ['changed', '연구부 회의', '2026-11-23', null]
  ]);
  assert.equal(decisions[1].previousDue, '2026-11-20');
  assert.equal(decisions[1].matchId, undefined);
});

test('같은 묶음에서 이어지는 취소는 같은 이름의 예전 일정에 잘못 붙이지 않는다', () => {
  const existing = [{ id: 'a', title: '연구부 회의', due: '2026-11-13', action: 'confirmed', observedAt }];
  const decisions = extractChatDecisions({ existing, messages: messages('11월 20일 연구부 회의 확정입니다.', '그 회의는 취소됐습니다.') });
  assert.equal(decisions[1].action, 'cancelled');
  assert.equal(decisions[1].title, '연구부 회의');
  assert.equal(decisions[1].previousDue, '2026-11-20');
  assert.equal(decisions[1].matchId, undefined);
});

test('취소 희망이나 날짜 확인 요청을 결정으로 받아들이지 않는다', () => {
  assert.deepEqual(view(extract(
    '연구부 회의는 취소했으면 합니다.',
    '연구부 회의는 금요일로 변경됐는지 확인 부탁드립니다.',
    '회의 확정 안내 준비는 11월 18일까지입니다.',
    '회의는 11월 18일 확정됐다고 보기는 어렵습니다.',
    '회의 날짜는 금요일에서 다음 주로 연기합니다.'
  )), [['task', '연구부 회의는 변경됐는지 확인', null, null]]);
});
