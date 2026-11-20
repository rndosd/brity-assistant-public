'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const model = require('../renderer/task-model');

test('같은 날 전체 마감과 일부의 마감은 적용 대상을 포함한 이름으로 구분하고 다시 편집할 수 있다', () => {
  const date = { date: '2030-05-10', kind: '까지', label: '명단 제출' };
  const answer = dates => model.fromResult({ type: '할 일', title: '명단', dates }, '명단');
  const processed = answer([{ ...date, appliesTo: null }, { ...date, appliesTo: '변경된 반만' }]);
  assert.deepEqual(processed.dates.map(d => d.label), ['명단 제출', '변경된 반만 명단 제출']);
  assert.deepEqual(model.normalizeDates(processed.dates, '명단', true), processed.dates);
  assert.equal(answer([{ ...date, label: '대표만 명단 제출', appliesTo: '대표만' }]).dates[0].label, '대표만 명단 제출');
  const long = answer([{ ...date, appliesTo: '가'.repeat(model.LABEL_MAX) }]);
  assert.equal(long.dates[0].label, '명단 제출');
  assert.equal(long.uncertain, true);
});

test('담당 조건과 목적지가 합쳐져 40자를 넘는 날짜 이름도 편집 후에 보존한다', () => {
  const appliesTo = '노란 표식 받은 모둠만';
  const label = '하교 직전에 도예 상자를 별관 승강기 앞으로 옮기기';
  const expected = appliesTo + ' ' + label;
  const task = model.fromResult({ type: '할 일', dates: [{ date: '2031-04-08', kind: '그날', appliesTo, label }] }, '상자 이동');
  assert.equal(expected.length, 41);
  assert.equal(task.uncertain, false);
  assert.equal(task.dates[0].label, expected);
  assert.equal(model.normalizeDates(task.dates, task.title, true)[0].label, expected);
});

test('좁은 칸에는 짧은 담당과 행동을 합치고 자세히에는 전체 조건과 장소를 남긴다', () => {
  const date = { date: '2031-04-10', kind: '그날', appliesTo: '벽걸이형을 받은 반만', shortScope: '벽걸이형 반만',
    label: '행정실 3번 창구에서 고정 나사 수령', shortLabel: '고정 나사 수령' };
  const result = model.fromResult({ type: '할 일', dates: [date] }, '모니터 업무');
  assert.equal(result.dates[0].label, '벽걸이형을 받은 반만 행정실 3번 창구에서 고정 나사 수령');
  assert.equal(result.dates[0].shortLabel, '벽걸이형 반만 고정 나사 수령');
  assert.deepEqual(model.normalizeDates(result.dates, '', true), result.dates);
  const fallback = model.fromResult({ type: '할 일', dates: [{ ...date, shortScope: null }] }, '모니터 업무');
  assert.equal(fallback.dates[0].shortLabel, '벽걸이형을 받은 반만 고정 나사 수령');
});

test('메신저별 수신자 표시에서 실제 인원수를 읽는다', () => {
  assert.equal(model.recipientCount('수신자 (부서 : 3, 수신인 : 48)'), 48);
  assert.equal(model.recipientCount('수신자(부서:0,수신인:1)'), 1);
  assert.equal(model.recipientCount('수신자(부서:2,수신인:0)'), null);
  assert.equal(model.recipientCount('가상 교사 외 48명'), 49);
  assert.equal(model.recipientCount('가상 교사, 가상 담당자'), 2);
});

test('기간 날짜는 시작일·끝일을 갖고, AI가 끝일을 틀리게 주면 시작일 하루(그날)로 남긴다', () => {
  const ai = model.fromResult({
    type: '할 일', title: '독서 주간', summary: '',
    dates: [
      { date: '2030-05-13', end: '2030-05-17', label: '독서 주간', kind: '기간' },
      { date: '2030-05-17', end: null, label: '활동 결과', kind: '까지' },
      { date: '2030-05-20', end: '2030-05-20', label: '하루짜리', kind: '기간' }
    ],
    uncertain: false
  }, '독서 주간');
  assert.deepEqual(ai.dates, [
    { date: '2030-05-13', label: '독서 주간', kind: '기간', end: '2030-05-17' },
    { date: '2030-05-17', label: '활동 결과', kind: '까지', done: false },
    { date: '2030-05-20', label: '하루짜리', kind: '그날' }
  ]);
  assert.equal(ai.uncertain, false);
  assert.equal(model.lastDay(ai.dates[0]), '2030-05-17');
  assert.equal(model.lastDay(ai.dates[1]), '2030-05-17');
  // 손으로 고칠 때는 틀린 끝일을 받지 않는다.
  assert.throws(() => model.normalizeDates([{ date: '2030-05-13', end: '2030-05-12', label: '주간', kind: '기간' }], '주간', true));
  assert.throws(() => model.normalizeDates([{ date: '2030-05-13', label: '주간', kind: '기간' }], '주간', true));
  // 기간에는 끝낼 □가 없다. 날짜가 기간뿐이면 할 일도 체크할 칸이 없다.
  assert.deepEqual(model.boxes({ type: '할 일', dates: [ai.dates[0]] }), []);
  // 상시 기준일: 끝나지 않은 기간은 오늘도 걸린다.
  assert.equal(model.pinnedDue({ dates: [ai.dates[0]] }, '2030-05-15'), ai.dates[0]);
});

test('시간·교시는 선생님 입력에서만 남고 AI 답에서는 버린다', () => {
  const typed = model.normalizeDates([
    { date: '2030-05-13', label: '학년 협의', kind: '그날', time: ' 6교시 ' },
    { date: '2030-05-14', label: '자료 제출', kind: '까지', time: '' },
    { date: '2030-05-15', label: '전교직원 회의', kind: '그날', time: '15:30부터 아주 길게 적은 시간' }
  ], '업무', true);
  assert.equal(typed[0].time, '6교시');
  assert.equal('time' in typed[1], false);
  assert.equal(typed[2].time.length <= model.TIME_MAX, true);
  const ai = model.fromResult({
    type: '할 일', title: '협의', summary: '', uncertain: false,
    dates: [{ date: '2030-05-13', label: '학년 협의', kind: '그날', time: '15:30' }]
  }, '협의');
  assert.equal('time' in ai.dates[0], false);
});
