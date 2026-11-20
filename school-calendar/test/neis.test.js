'use strict';

// 나이스 학교·학사일정·급식. 실제 나이스 대신 가짜 응답으로 시험한다(2026-11-19 실제 응답 모양을 따름).
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { test } = require('node:test');
const neis = require('../neis');
const { CalendarStore } = require('../store');

const school = { office: 'J10', code: '7652009', name: '가곡초등학교', officeName: '경기도교육청', level: '초등학교' };

function row(date, name, off = '해당없음', grades = 'YYYYYY') {
  const fields = ['ONE_GRADE_EVENT_YN', 'TW_GRADE_EVENT_YN', 'THREE_GRADE_EVENT_YN', 'FR_GRADE_EVENT_YN', 'FIV_GRADE_EVENT_YN', 'SIX_GRADE_EVENT_YN'];
  return { AA_YMD: date.replaceAll('-', ''), EVENT_NM: name, SBTR_DD_SC_NM: off, ...Object.fromEntries(fields.map((field, i) => [field, grades[i] === 'Y' ? 'Y' : 'N'])) };
}

// 키 없는 나이스처럼: 몇 쪽을 달라 해도 앞 5줄만 준다.
function keylessFetch(all, calls = []) {
  return async url => {
    calls.push(url);
    const from = url.searchParams.get('AA_FROM_YMD');
    const to = url.searchParams.get('AA_TO_YMD');
    const rows = all.filter(item => item.AA_YMD >= from && item.AA_YMD <= to);
    const body = rows.length
      ? { SchoolSchedule: [{ head: [{ list_total_count: rows.length }, { RESULT: { CODE: 'INFO-000' } }] }, { row: rows.slice(0, 5) }] }
      : { RESULT: { CODE: 'INFO-200', MESSAGE: '해당하는 데이터가 없습니다.' } };
    return { ok: true, status: 200, json: async () => body };
  };
}

test('키 없이도 구간을 나눠 학사일정을 모두 받고, 토요휴업일은 뺀다', async () => {
  const all = [];
  for (let day = 1; day <= 28; day++) all.push(row(`2026-12-${String(day).padStart(2, '0')}`, day >= 24 ? '겨울방학' : `행사${day}`, day >= 24 ? '휴업일' : '해당없음'));
  all.push(row('2026-12-05', '토요휴업일', '휴업일'), row('2026-12-25', '성탄절', '공휴일'));
  const calls = [];
  const events = await neis.fetchSchedule(school, '2026-12-01', '2026-12-31', { fetchImpl: keylessFetch(all, calls) });
  assert.equal(events.length, 29);
  assert.ok(!events.some(event => event.name === '토요휴업일'));
  assert.deepEqual(events.find(event => event.name === '성탄절'), { date: '2026-12-25', name: '성탄절', off: '공휴일', grades: [1, 2, 3, 4, 5, 6] });
  assert.equal(events.find(event => event.date === '2026-12-03').off, null);
  assert.ok(calls.length > 1 && calls.length < 40);
});

test('학년별 행사와 자료 없음, 나이스 오류를 구분한다', async () => {
  const events = await neis.fetchSchedule(school, '2026-12-01', '2026-12-02', { fetchImpl: keylessFetch([row('2026-12-01', '6학년 수학여행', '해당없음', 'NNNNNY')]) });
  assert.deepEqual(events[0].grades, [6]);
  assert.deepEqual(await neis.fetchSchedule(school, '2027-01-01', '2027-01-02', { fetchImpl: keylessFetch([]) }), []);
  const broken = async () => ({ ok: true, status: 200, json: async () => ({ RESULT: { CODE: 'ERROR-290', MESSAGE: '인증키가 유효하지 않습니다.' } }) });
  await assert.rejects(neis.fetchSchedule(school, '2026-12-01', '2026-12-02', { fetchImpl: broken }), /인증키/);
  const offline = async () => { throw new TypeError('fetch failed'); };
  await assert.rejects(neis.searchSchools('가곡초', { fetchImpl: offline }), /연결하지 못했습니다/);
});

test('학교 찾기와 급식 메뉴 정리', async () => {
  const fetchImpl = async url => ({
    ok: true, status: 200,
    json: async () => url.pathname.endsWith('schoolInfo')
      ? { schoolInfo: [{ head: [{ list_total_count: 7 }, { RESULT: { CODE: 'INFO-000' } }] }, { row: [
        { ATPT_OFCDC_SC_CODE: 'J10', ATPT_OFCDC_SC_NM: '경기도교육청', SD_SCHUL_CODE: '7652009', SCHUL_NM: '가곡초등학교', SCHUL_KND_SC_NM: '초등학교', ORG_RDNMA: '경기도 남양주시' },
        { ATPT_OFCDC_SC_CODE: 'B10', ATPT_OFCDC_SC_NM: '서울특별시교육청', SD_SCHUL_CODE: '       ', SCHUL_NM: '(가칭)새학교' }
      ] }] }
      : { mealServiceDietInfo: [{ head: [{ list_total_count: 1 }, { RESULT: { CODE: 'INFO-000' } }] }, { row: [
        { MMEAL_SC_NM: '중식', DDISH_NM: '발아현미밥 <br/>@돈육김치찌개 (5.6.9.10)<br/>달걀말이* (1.5.6.13)<br/>(유상)우유 (2)', CAL_INFO: '617.9 Kcal' }
      ] }] }
  });
  const found = await neis.searchSchools('가곡초', { fetchImpl });
  assert.equal(found.schools.length, 1);
  assert.equal(found.more, true);
  assert.deepEqual(found.schools[0], { office: 'J10', officeName: '경기도교육청', code: '7652009', name: '가곡초등학교', level: '초등학교', address: '경기도 남양주시' });
  await assert.rejects(neis.searchSchools('가', { fetchImpl }), /두 글자/);
  const meals = await neis.fetchMeals(school, '2026-11-19', { fetchImpl });
  assert.deepEqual(meals, [{ kind: '중식', items: ['발아현미밥', '돈육김치찌개', '달걀말이', '(유상)우유'], kcal: '617.9 Kcal' }]);
});

test('학년도 범위와 학교 값 확인', () => {
  assert.deepEqual(neis.schoolYearRange('2026-11-19'), { from: '2026-03-01', to: '2027-02-28' });
  assert.deepEqual(neis.schoolYearRange('2028-02-10'), { from: '2027-03-01', to: '2028-02-29' });
  assert.deepEqual(neis.schoolYearRange('2026-03-01'), { from: '2026-03-01', to: '2027-02-28' });
  assert.throws(() => neis.schoolValue({ office: 'J10', code: '12' }), /다시 골라/);
  assert.equal(neis.schoolValue({ ...school, level: '대학교' }).level, '');
});

test('저장소: 학교를 고르고 받은 학사일정을 남기며, 학교를 바꾸면 옛 일정은 쓰지 않는다', async t => {
  const qa = path.join(__dirname, '..', '.qa');
  await fs.mkdir(qa, { recursive: true });
  const root = await fs.mkdtemp(path.join(qa, 'neis-store-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const make = async () => {
    const store = new CalendarStore({ dataDir: path.join(root, 'data'), inboxDir: path.join(root, 'inbox') });
    await store.init();
    return store;
  };
  const store = await make();
  assert.equal(store.snapshot().school, null);
  await store.setSchool(school);
  assert.equal(store.schoolNeedsRefresh(), true);
  const events = [{ date: '2026-12-25', name: '성탄절', off: '공휴일', grades: [1, 2, 3, 4, 5, 6] }];
  await store.saveSchoolSchedule(school, events, { from: '2026-03-01', to: '2027-02-28' });
  let view = store.snapshot();
  assert.equal(view.school.count, 1);
  assert.deepEqual(view.schoolEvents, events);
  assert.equal(store.schoolNeedsRefresh(), false);
  // 한 번 받으면 일주일은 다시 받지 않고, 학년도가 바뀌면(받아 둔 범위 밖) 바로 받는다.
  const fetched = Date.parse(store.snapshot().school.fetchedAt);
  assert.equal(store.schoolNeedsRefresh(fetched + 6 * 86_400_000), false);
  assert.equal(store.schoolNeedsRefresh(fetched + 8 * 86_400_000), true);
  assert.equal(store.schoolNeedsRefresh(Date.parse('2027-03-02T09:00:00')), true);
  // 다시 켜도 남아 있다.
  view = (await make()).snapshot();
  assert.equal(view.school.name, '가곡초등학교');
  assert.deepEqual(view.schoolEvents, events);
  // 다른 학교로 바꾸면 옛 일정은 보이지 않고, 받는 중에 바뀐 학교의 결과는 버린다.
  await store.setSchool({ ...school, code: '7652010', name: '다른초등학교' });
  assert.deepEqual(store.snapshot().schoolEvents, []);
  await store.saveSchoolSchedule(school, events, { from: '2026-03-01', to: '2027-02-28' });
  assert.deepEqual(store.snapshot().schoolEvents, []);
  await store.setSchool(null);
  assert.equal(store.snapshot().school, null);
  // 오늘 급식 보이기: 기본 켬, 설정에서 끈다.
  assert.equal(store.snapshot().showMeal, true);
  await store.setShowMeal(false);
  assert.equal(store.snapshot().showMeal, false);
  assert.throws(() => store.setShowMeal('no'), /급식/);
});
