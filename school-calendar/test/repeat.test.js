'use strict';

// 반복 업무(2026-11-20, 반복-업무-설계.md 줄인 1차안).
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { test } = require('node:test');
const model = require('../renderer/task-model');
const { CalendarStore } = require('../store');

async function makeStore(t) {
  const qa = path.join(__dirname, '..', '.qa');
  await fs.mkdir(qa, { recursive: true });
  const root = await fs.mkdtemp(path.join(qa, 'repeat-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new CalendarStore({ dataDir: path.join(root, 'data'), inboxDir: path.join(root, 'inbox') });
  await store.init();
  return store;
}
const series = (store, id) => store.tasks.filter(task => task.repeat?.seriesId === id).sort((a, b) => a.dates[0].date.localeCompare(b.dates[0].date));

test('반복 날짜 계산: 매주·격주·매월(없는 날은 말일)·건너뛰기·60회·학기 끝', () => {
  assert.deepEqual(model.repeatDates('week', '2026-11-19', '2026-12-10'), ['2026-11-19', '2026-11-26', '2026-12-03', '2026-12-10']);
  assert.deepEqual(model.repeatDates('2weeks', '2026-11-25', '2026-12-31'), ['2026-11-25', '2026-12-09', '2026-12-23']);
  assert.deepEqual(model.repeatDates('month', '2027-01-31', '2027-04-30'), ['2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30']);
  assert.deepEqual(model.repeatDates('week', '2026-12-17', '2027-01-07', ['2026-12-24', '2026-12-31']), ['2026-12-17', '2027-01-07']);
  assert.equal(model.repeatDates('week', '2026-01-01', '2030-01-01').length, model.REPEAT_MAX);
  assert.deepEqual(model.repeatDates('week', '2026-12-01', '2026-11-01'), []);
  assert.equal(model.semesterEnd('2026-11-19'), '2027-02-28');
  assert.equal(model.semesterEnd('2026-04-01'), '2026-08-31');
  assert.equal(model.semesterEnd('2028-01-10'), '2028-02-29');
  assert.equal(model.repeatLabel('week', '2026-11-19'), '매주 목');
  assert.equal(model.repeatLabel('2weeks', '2026-11-25'), '격주 수');
  assert.equal(model.repeatLabel('month', '2026-11-19'), '매월 19일');
});

test('반복 만들기: 회차마다 업무, 끝냄은 회차별, 학교 쉬는 날 빼기, 반복 못 거는 경우', async t => {
  const store = await makeStore(t);
  const first = await store.create({ title: '주간학습안내 제출', due: '2026-11-19', kind: '까지', repeat: 'week', until: '2026-12-31' });
  const all = series(store, first.repeat.seriesId);
  assert.equal(all.length, 7);
  assert.deepEqual(all.map(task => task.dates[0].date), ['2026-11-19', '2026-11-26', '2026-12-03', '2026-12-10', '2026-12-17', '2026-12-24', '2026-12-31']);
  await store.setDone(all[0].id, true, 0);
  assert.equal(series(store, first.repeat.seriesId).filter(task => task.dates[0].done).length, 1);
  // 학교 쉬는 날(받아 둔 학사일정의 휴업일·공휴일)을 빼고 만든다.
  store.settings.school = { office: 'J10', code: '7652009', name: '가곡초등학교' };
  store.schoolSchedule = { office: 'J10', code: '7652009', from: '2026-03-01', to: '2027-02-28', fetchedAt: new Date().toISOString(), events: [
    { date: '2026-12-31', name: '겨울방학', off: '휴업일', grades: [] }, { date: '2027-01-07', name: '겨울방학', off: '휴업일', grades: [] },
    { date: '2026-12-10', name: '학예회', off: null, grades: [] }
  ] };
  const skipped = await store.create({ title: '학년 협의회', due: '2026-12-03', kind: '그날', time: '15:00', repeat: 'week', until: '2027-01-14', skipSchoolOff: true });
  assert.deepEqual(series(store, skipped.repeat.seriesId).map(task => task.dates[0].date), ['2026-12-03', '2026-12-10', '2026-12-17', '2026-12-24', '2027-01-14']);
  assert.equal(series(store, skipped.repeat.seriesId)[1].dates[0].time, '15:00');
  await assert.rejects(store.create({ title: 'x', due: '2026-12-01', repeat: 'week', extraDates: [{ date: '2026-12-02' }] }), /날짜가 하나/);
  await assert.rejects(store.create({ title: 'x', due: '2026-12-01', kind: '기간', end: '2026-12-03', repeat: 'week' }), /날짜가 하나/);
  await assert.rejects(store.create({ title: 'x', due: '2026-12-01', type: '알아 둘 것', repeat: 'week' }), /할 일/);
  // 기본 끝 날짜는 학기 끝.
  const semester = await store.create({ title: '월말 보고', due: '2026-11-30', repeat: 'month' });
  assert.equal(semester.repeat.until, '2027-02-28');
  assert.deepEqual(series(store, semester.repeat.seriesId).map(task => task.dates[0].date), ['2026-11-30', '2026-12-30', '2027-01-30', '2027-02-28']);
});

test('이 회차만 고치면 그 회차만, 이 회차부터 모두는 뒤 회차를 같이 민다(끝냄·따로 고친 회차는 그대로)', async t => {
  const store = await makeStore(t);
  const first = await store.create({ title: '주간학습안내', due: '2026-12-03', repeat: 'week', until: '2026-12-31' });
  const id = first.repeat.seriesId;
  let all = series(store, id);
  // 12/10 회차만 금요일로
  await store.update(all[1].id, { dates: [{ ...all[1].dates[0], date: '2026-12-11' }] });
  all = series(store, id);
  assert.equal(all[1].dates[0].date, '2026-12-11');
  assert.equal(all[1].repeat.edited, true);
  assert.equal(all[2].dates[0].date, '2026-12-17');
  // 12/24 회차는 끝냄
  await store.setDone(all[3].id, true, 0);
  // 12/17 회차부터 모두: 제목을 바꾸고 하루 뒤로
  await store.update(all[2].id, { title: '주간학습안내 제출', dates: [{ ...all[2].dates[0], date: '2026-12-18', label: '주간학습안내 제출' }], repeatScope: 'following' });
  all = series(store, id);
  assert.deepEqual(all.map(task => [task.dates[0].date, task.title]), [
    ['2026-12-03', '주간학습안내'], ['2026-12-11', '주간학습안내'], ['2026-12-18', '주간학습안내 제출'],
    ['2026-12-24', '주간학습안내'], ['2027-01-01', '주간학습안내 제출']
  ]);
  // 날짜를 둘로 늘리면 그 업무는 반복에서 빠진다.
  await store.update(all[0].id, { dates: [all[0].dates[0], { date: '2026-12-05', kind: '그날', label: '추가' }] });
  assert.equal(store.getTask(all[0].id).repeat, undefined);
});

test('이번만 건너뛰기와 반복 그만, 반복 바꾸기·풀기', async t => {
  const store = await makeStore(t);
  const first = await store.create({ title: '안전점검', due: '2026-12-01', repeat: 'week', until: '2026-12-29' });
  const id = first.repeat.seriesId;
  let all = series(store, id);
  await store.skipOccurrence(all[1].id);
  all = series(store, id);
  assert.deepEqual(all.map(task => task.dates[0].date), ['2026-12-01', '2026-12-15', '2026-12-22', '2026-12-29']);
  assert.deepEqual(all[0].repeat.skip, ['2026-12-08']);
  // 반복 그만(12/15 회차에서): 연 회차는 남기고 뒤 12/22·12/29만 지운다.
  const result = await store.stopSeries(all[1].id);
  assert.equal(result.removed, 2);
  all = series(store, id);
  assert.deepEqual(all.map(task => task.dates[0].date), ['2026-12-01', '2026-12-15']);
  assert.ok(all.every(task => task.repeat.until === '2026-12-15'));
  // 보통 업무에 반복을 걸고, 매월로 바꾸고, 풀기
  const plain = await store.create({ title: '월간 계획', due: '2026-12-05' });
  const weekly = await store.setRepeat(plain.id, 'week');
  assert.ok(series(store, weekly.repeat.seriesId).length > 5);
  const monthly = await store.setRepeat(plain.id, 'month');
  assert.deepEqual(series(store, monthly.repeat.seriesId).map(task => task.dates[0].date), ['2026-12-05', '2027-01-05', '2027-02-05']);
  assert.equal(series(store, weekly.repeat.seriesId).length, 0);
  const none = await store.setRepeat(plain.id, 'none');
  assert.equal(none.repeat, undefined);
  assert.equal(series(store, monthly.repeat.seriesId).length, 0);
  assert.ok(store.getTask(plain.id));
});

test('찾기는 같은 반복에서 가장 가까운 남은 회차 하나만 보여 준다', async t => {
  const store = await makeStore(t);
  const now = new Date();
  const day = offset => { const date = new Date(now); date.setDate(date.getDate() + offset); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; };
  await store.create({ title: '반복찾기시험', due: day(-14), repeat: 'week', until: day(21) });
  const { results } = store.search('반복찾기시험');
  assert.equal(results.length, 1);
  const shown = store.getTask(results[0].id);
  assert.ok(shown.dates[0].date >= day(0) && shown.dates[0].date <= day(6));
});
