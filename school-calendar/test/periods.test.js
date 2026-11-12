'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { deadlineLanes, daysBetween, receivedDay } = require('../renderer/periods');

const task = (id, received, due, overrides = {}) => ({
  id, noteId: id, category: '할 일', datetime: received, due, done: false, ...overrides,
});

test('받은 날부터 마감 전날까지의 겹치는 기간은 다른 줄을 쓰고, 끝난 줄은 재사용한다', () => {
  const rows = deadlineLanes([
    task('a', '2026년 11월 05일 13:10', '2026-11-15'),
    task('b', '2026. 11. 08. 오전 10:00', '2026-11-20'),
    task('c', '2026-11-15 11:00', '2026-11-24'),
    task('done', '2026-11-15', '2026-11-24', { done: true }),
    task('reference', '2026-11-10', '2026-11-24', { category: '참고' }),
    task('same-day', '2026-11-16', '2026-11-16'),
  ]);
  assert.deepEqual(rows.map(({ task: row, lane }) => [row.id, lane]), [['a', 0], ['b', 1], ['c', 0]]);
  assert.equal(receivedDay('2026. 02. 30. 10:00'), null);
  assert.equal(daysBetween('2026-11-29', '2026-12-02'), 3);
});
