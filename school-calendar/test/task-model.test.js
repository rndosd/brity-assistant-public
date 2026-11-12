'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const model = require('../renderer/task-model');

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
