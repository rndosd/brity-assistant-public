'use strict';

// 기한 없는 할 일(받은 날에 놓은 그날, received)과 할 일 일정 끝냄(2026-11-20).
const test = require('node:test');
const assert = require('node:assert/strict');
const model = require('../renderer/task-model');

test('받은 날 표시와 그날 끝냄은 선생님 입력을 거쳐도 남는다', () => {
  const [entry] = model.normalizeDates([{ date: '2026-11-19', label: '간식 예산 회신', kind: '그날', received: true, done: true }], '업무', true);
  assert.deepEqual(entry, { date: '2026-11-19', label: '간식 예산 회신', kind: '그날', done: true, received: true });
  const [plain] = model.normalizeDates([{ date: '2026-11-19', label: '협의회', kind: '그날' }], '업무', true);
  assert.equal('done' in plain || 'received' in plain, false);
  const [due] = model.normalizeDates([{ date: '2026-11-19', label: '제출', kind: '까지', received: true }], '업무', true);
  assert.equal('received' in due, false);
});

test('할 일의 그날도 끝낼 칸이 되고, 알아 둘 것과 기간은 아니다', () => {
  const task = { type: '할 일', dates: [{ date: '2026-11-19', label: '회신', kind: '그날', received: true }, { date: '2026-11-21', label: '행사', kind: '기간', end: '2026-11-22' }] };
  assert.deepEqual(model.boxes(task), [{ index: 0, done: false }]);
  assert.equal(model.finished(task), false);
  task.dates[0].done = true;
  assert.equal(model.finished(task), true);
  assert.deepEqual(model.boxes({ ...task, type: '알아 둘 것' }), []);
});
