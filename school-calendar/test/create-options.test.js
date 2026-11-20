'use strict';

// 업무 추가 넓히기(2026-11-19): 여러 날짜·확인할 것·중요/상시, 직접 추가한 업무 지우기, 마감 알림 모음.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { test } = require('node:test');
const { CalendarStore } = require('../store');

async function makeStore(t) {
  const qa = path.join(__dirname, '..', '.qa');
  await fs.mkdir(qa, { recursive: true });
  const root = await fs.mkdtemp(path.join(qa, 'create-options-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new CalendarStore({ dataDir: path.join(root, 'data'), inboxDir: path.join(root, 'inbox') });
  await store.init();
  return store;
}

test('업무 추가: 날짜 셋까지, 확인할 것, 중요·상시', async t => {
  const store = await makeStore(t);
  const task = await store.create({
    title: '현장체험학습', due: '2026-12-03', kind: '까지', important: true, pinned: true,
    extraDates: [{ date: '2026-12-10', kind: '그날', label: '체험학습 당일' }, { date: '2026-12-01', kind: '까지', label: '' }]
  });
  assert.equal(task.type, '할 일');
  assert.equal(task.important, true);
  assert.equal(task.pinned, true);
  assert.deepEqual(task.dates.map(entry => [entry.date, entry.kind, entry.label]), [
    ['2026-12-01', '까지', '현장체험학습'], ['2026-12-03', '까지', '현장체험학습'], ['2026-12-10', '그날', '체험학습 당일']
  ]);
  await assert.rejects(store.create({ title: 'x', due: '2026-12-01', extraDates: [{ date: '2026-12-02' }, { date: '2026-12-03' }, { date: '2026-12-04' }] }), /3개까지/);
  await assert.rejects(store.create({ title: 'x', due: '2026-12-01', extraDates: [{ date: '2026-13-40' }] }), /날짜/);
  // 확인할 것에는 상시를 걸지 않는다.
  const reference = await store.create({ title: '방과후 강사 변경 안내', due: '2026-12-02', kind: '그날', type: '알아 둘 것', pinned: true });
  assert.equal(reference.type, '알아 둘 것');
  assert.equal(reference.pinned, undefined);
  // 직접 추가한 업무는 할 일 ↔ 확인할 것으로 옮길 수 있고, 숨기기는 막는다.
  const moved = await store.update(reference.id, { type: '할 일' });
  assert.equal(moved.type, '할 일');
  await assert.rejects(store.update(reference.id, { type: '없음' }), /지웁니다/);
});

test('업무 지우기: 직접 추가한 업무만 지운다', async t => {
  const store = await makeStore(t);
  const task = await store.create({ title: '지울 업무', due: '2026-12-01' });
  await store.remove(task.id);
  assert.ok(!store.snapshot().tasks.some(item => item.id === task.id));
  await assert.rejects(store.remove(task.id), /./);
  store.tasks.push({ ...store.tasks[0] ?? {}, id: '00000000-0000-4000-8000-000000000001', noteId: '0_1_0', title: '쪽지 업무', type: '할 일', dates: [], revision: 0 });
  await assert.rejects(store.remove('00000000-0000-4000-8000-000000000001'), /숨기기/);
});

test('마감 알림: 하루 한 번, 8시 뒤, 끝낸 것은 빼고 모은다', async t => {
  const store = await makeStore(t);
  const today = '2026-11-20';
  await store.create({ title: '오늘 제출', due: today, kind: '까지' });
  await store.create({ title: '내일 제출', due: '2026-11-21', kind: '까지' });
  await store.create({ title: '협의회', due: today, kind: '그날', time: '15:00' });
  const done = await store.create({ title: '이미 냄', due: today, kind: '까지' });
  await store.setDone(done.id, true, 0);
  await store.create({ title: '확인만', due: today, kind: '그날', type: '알아 둘 것' });
  assert.equal(store.alertDue(new Date(2026, 10, 20, 7, 30)), null);
  const digest = store.alertDue(new Date(2026, 10, 20, 8, 5));
  assert.deepEqual(digest.dueToday.map(item => item.label), ['오늘 제출']);
  assert.deepEqual(digest.dueTomorrow.map(item => item.label), ['내일 제출']);
  assert.deepEqual(digest.eventsToday.map(item => [item.label, item.time]), [['협의회', '15:00']]);
  await store.markAlerted(digest.day);
  assert.equal(store.alertDue(new Date(2026, 10, 20, 13, 0)), null);
  assert.ok(store.alertDue(new Date(2026, 10, 21, 9, 0)));
  await store.setDeadlineAlerts(false);
  assert.equal(store.alertDue(new Date(2026, 10, 21, 9, 0)), null);
  assert.equal(store.snapshot().deadlineAlerts, false);
});
