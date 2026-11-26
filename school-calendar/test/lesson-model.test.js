'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const L = require('../renderer/lesson-model');
const { CalendarStore } = require('../store');
const { fileTrack, findTracked, validTrack } = require('../file-track');

test('엑셀처럼 탭으로 나뉜 시간표를 요일 순서대로 읽는다', () => {
  const text = ['교시\t월\t화\t수\t목\t금', '1교시\t국어\t창체\t체육\t수학\t창체', '2교시\t과학\t수학\t창체\t국어\t창체'].join('\n');
  const { schedule, message } = L.readTimetable(text);
  assert.deepEqual(schedule, [['국어', '창체', '체육', '수학', '창체'], ['과학', '수학', '창체', '국어', '창체']]);
  assert.match(message, /확인/);
});

test('요일 머리가 섞인 순서여도 월~금 칸으로 맞추고, 칸 둘째 줄(수업 내용)은 버린다', () => {
  const matrix = [['', '화', '월', '수', '목', '금'], ['1교시', '수학\n분수', '국어', '과학', '사회', '영어']];
  const { schedule } = L.readTimetable('', { matrices: [matrix] });
  assert.deepEqual(schedule, [['국어', '수학', '과학', '사회', '영어']]);
});

test('한글 표를 글자로 붙이면 교시 뒤 다섯 줄을 월~금으로 읽고, 빈 교시는 빈칸', () => {
  const text = ['월', '화', '수', '목', '금', '1교시', '국어', '수학', '-', '사회', '과학', '3교시', '음악', '', '', '', ''].join('\n');
  const { schedule } = L.readTimetable(text);
  assert.deepEqual(schedule, [['국어', '수학', '', '사회', '과학'], ['', '', '', '', ''], ['음악', '', '', '', '']]);
});

test('요일·교시가 없으면 읽지 않는다', () => {
  assert.equal(L.readTimetable('국어 수학 과학').schedule, null);
});

test('교과 칸은 학교마다 다른 모양을 "학년-반 과목"으로 맞춘다', () => {
  assert.equal(L.classCell('203', '국어'), '2-3 국어');
  assert.equal(L.classCell('국어(2-3)'), '2-3 국어');
  assert.equal(L.classCell('2 - 03 독서'), '2-3 독서');
  assert.equal(L.classCell('2-3', '영어'), '2-3 영어');
  assert.equal(L.classCell('창체'), '창체');
  const { schedule } = L.readTimetable('교시\t월\t화\t수\t목\t금\n1교시\t203\t\t국어(1-5)\t\t2-1', { mode: 'subject', fallbackSubject: '국어' });
  assert.deepEqual(schedule, [['2-3 국어', '', '1-5 국어', '', '2-1 국어']]);
});

test('시정표: 교시 뒤 시각 둘을 읽고 점심시간은 건너뛰며 1:10은 오후로', () => {
  const text = ['교시', '시간', '1교시', '09:00~09:40', '2교시', '09:50~10:30', '점심시간', '12:10~13:10', '3교시', '1:10~1:50'].join('\n');
  assert.deepEqual(L.parsePeriodTimes(text), [['09:00', '09:40'], ['09:50', '10:30'], ['13:10', '13:50']]);
  assert.equal(L.parsePeriodTimes('1교시 09:00~09:40\n3교시 10:40~11:20'), null, '빠진 교시가 있으면 읽지 않는다');
});

test('설정에서는 과목표와 시정표를 별도로 또는 같은 표에서 읽는다', () => {
  const courses = [['교시', '월', '화', '수', '목', '금'], ['1교시', '국어', '수학', '', '', '음악'], ['2교시', '과학', '', '', '', '']];
  const bell = [['교시', '시작', '종료'], ['1', '09:00', '09:40'], ['쉬는 시간', '09:40', '09:50'],
    ['2', '09:50', '10:30'], ['점심', '12:00', '13:00']];
  const schedule = courses.slice(1).map(row => row.slice(1));
  const periodTimes = [['09:00', '09:40'], ['09:50', '10:30']];
  assert.deepEqual(L.readTimetableSetup('', { matrices: [courses] }), { schedule, periodTimes: null });
  assert.deepEqual(L.readTimetableSetup('', { matrices: [bell] }), { schedule: null, periodTimes });
  assert.deepEqual(L.readTimetableSetup('', { matrices: [bell, courses] }), { schedule, periodTimes });
  const combined = [['교시', '시작', '종료', ...L.WEEKDAYS],
    ['1', ...periodTimes[0], ...schedule[0]], ['2', ...periodTimes[1], ...schedule[1]]];
  assert.deepEqual(L.readTimetableSetup(combined.map(row => row.join('\t')).join('\n')), { schedule, periodTimes });
  const inline = [courses[0], ['1교시(09:00~09:40)', ...schedule[0]], ['2교시 (09:50~10:30)', ...schedule[1]]];
  assert.deepEqual(L.readTimetableSetup('', { matrices: [inline] }), { schedule, periodTimes });
  assert.deepEqual(L.readTimetableSetup('1교시\n09:00\n09:40\n쉬는 시간\n09:40~09:50\n2교시 09:50~10:30'), { schedule: null, periodTimes });
});

test('설정 시정표는 과목 칸 안 시각·이름 없는 행사·중간 교시 누락을 채우지 않는다', () => {
  const unrelated = [['교시', '월', '화', '수', '목', '금'], ['1교시', '09:00~09:40', '국어', '', '', '']];
  assert.equal(L.readTimetableSetup('', { matrices: [unrelated] }).periodTimes, null);
  assert.deepEqual(L.readTimetableSetup('등교 08:30~09:00\n점심 12:00~13:00'), { schedule: null, periodTimes: null });
  assert.equal(L.readTimetableSetup('1교시 09:00~09:40\n3교시 10:40~11:20').periodTimes, null);
  assert.equal(L.readTimetableSetup('교시\t시작\t종료\n1\t09:00\t09:40\n3\t10:40\t11:20').periodTimes, null);
});

test('기본 교시 시각은 학교급마다 수업 길이가 다르다', () => {
  assert.deepEqual(L.defaultPeriodTimes('초등')[0], ['09:00', '09:40']);
  assert.deepEqual(L.defaultPeriodTimes('고등학교')[1], ['10:00', '10:50']);
  assert.deepEqual(L.defaultPeriodTimes('초등')[4], ['13:00', '13:40'], '4교시 뒤 점심 50분');
});

test('보기 방식은 내 역할로 정한다', () => {
  assert.equal(L.lessonMode(null), 'homeroom');
  assert.equal(L.lessonMode({ workplace: '학교', schoolLevel: '초등', role: '담임' }), 'homeroom');
  assert.equal(L.lessonMode({ workplace: '학교', schoolLevel: '초등', role: '전담' }), 'subject');
  assert.equal(L.lessonMode({ workplace: '학교', schoolLevel: '중학교', role: '담임' }), 'subject');
});

test('그날 수업은 주말과 적용 기간 밖에는 없다', () => {
  const schedule = [['국어', '수학', '', '', ''], ['', '', '', '', '체육']];
  assert.deepEqual(L.lessonsOn('2026-11-23', schedule), [{ period: 1, cell: '국어' }]); // 월
  assert.deepEqual(L.lessonsOn('2026-11-27', schedule), [{ period: 2, cell: '체육' }]); // 금
  assert.deepEqual(L.lessonsOn('2026-11-28', schedule), []); // 토
  assert.deepEqual(L.lessonsOn('2026-11-23', schedule, { start: '2026-11-24', end: null }), []);
});

test('지난 수업은 칸 글자가 같은 것만, 같은 날 앞 교시부터 거슬러 찾는다', () => {
  const schedule = [['2-3 국어', '1-2 국어', '', '', ''], ['', '', '', '', ''], ['2-3 국어', '', '', '', '']];
  const found = L.earlierLessons('2026-11-23', 3, schedule, null, 3);
  assert.deepEqual(found.map(item => `${item.date} ${item.period}`), ['2026-11-23 1', '2026-11-16 3', '2026-11-16 1']);
  assert.deepEqual(L.earlierLessons('2026-11-23', 3, schedule, { start: '2026-11-20' }, 3).map(item => item.period), [1]);
});

test('저장 전에 시간표·시각·기간·기록을 고른다', () => {
  assert.throws(() => L.cleanSchedule([['국어']]), /다섯 칸/);
  assert.deepEqual(L.cleanSchedule([['국어', '', '', '', ''], ['', '', '', '', '']]), [['국어', '', '', '', '']], '끝의 빈 교시는 자른다');
  assert.throws(() => L.cleanTimes([['10:00', '09:00']]), /앞서야/);
  assert.throws(() => L.cleanTerm({ start: '2026-12-01', end: '2026-11-01' }), /앞이에요/);
  assert.deepEqual(L.cleanRecord({ memo: '발표', files: [{ path: 'C:\\자료\\활동지.hwpx' }] }).files, [{ path: 'C:\\자료\\활동지.hwpx', name: '활동지.hwpx' }]);
  const plan = L.cleanPlan({ homeroom: [['국어', '', '', '', '']], records: { 'homeroom|2026-11-23|1': { memo: 'a', files: [] }, 'bad': { memo: 'x' }, 'subject|2026-11-23|2': { memo: '', files: [] } } });
  assert.deepEqual(Object.keys(plan.records), ['homeroom|2026-11-23|1']);
});

async function lessonFixture(t) {
  const qa = path.resolve(__dirname, '..', '..', '.qa');
  await fs.mkdir(qa, { recursive: true });
  const root = await fs.realpath(qa);
  const dir = await fs.mkdtemp(path.join(root, 'lesson-store-'));
  t.after(async () => {
    const resolved = await fs.realpath(dir);
    assert.equal(path.dirname(resolved), root);
    assert.match(path.basename(resolved), /^lesson-store-/);
    await fs.rm(resolved, { recursive: true, force: true });
  });
  const make = () => new CalendarStore({ dataDir: path.join(dir, 'data'), inboxDir: path.join(dir, 'inbox') });
  return { dir, make };
}

test('저장소: 시간표·메모·자료 연결을 함께 저장하고 다시 읽는다', async t => {
  const { dir, make } = await lessonFixture(t);
  const store = make();
  await store.init();
  const id = 'homeroom|2026-11-23|1';
  const source = path.join(dir, '활동지.txt');
  await fs.writeFile(source, '가상 원본');
  assert.equal(store.snapshot().lessons.homeroom, null);
  await store.setLessonPlan({ mode: 'homeroom', schedule: [['국어', '수학', '', '', '']] });
  await store.setLessonPlan({ periodTimes: [['09:00', '09:40']], term: { start: '2026-08-24', end: null } });
  await Promise.all([store.addLessonFiles(id, [source, source]), store.setLessonRecord(id, { memo: '3모둠 발표' })]);
  await assert.rejects(store.setLessonPlan({ mode: 'other', schedule: [] }), /종류/);
  await assert.rejects(store.setLessonRecord('../x', { memo: 'a' }), /수업/);
  const again = make();
  await again.init();
  const { lessons } = again.snapshot();
  assert.deepEqual(lessons.homeroom, [['국어', '수학', '', '', '']]);
  assert.deepEqual(lessons.term, { start: '2026-08-24', end: null });
  assert.deepEqual(lessons.periodTimes, [['09:00', '09:40']]);
  assert.equal(lessons.records[id].memo, '3모둠 발표');
  assert.deepEqual(lessons.records[id].files.map(file => file.path), [source]);
  assert.equal((await again.resolveLessonFile(id, 0, source)).path, source);
  await again.setLessonRecord(id, { memo: '' });
  await again.removeLessonFile(id, 0, source);
  assert.equal(again.snapshot().lessons.records[id], undefined, '비면 기록을 지운다');
  assert.equal(await fs.readFile(source, 'utf8'), '가상 원본');
});

test('NTFS에서 기존 연결의 ID를 채우고, 관찰한 Office 교체 저장과 이동을 따라간다', { skip: process.platform !== 'win32' }, async t => {
  const { dir, make } = await lessonFixture(t);
  const id = 'homeroom|2026-11-23|1';
  const original = path.join(dir, '수업 자료.docx');
  const newVersion = path.join(dir, '~WRD0001.tmp');
  const backup = path.join(dir, '~WRL0002.tmp');
  const replace = async contents => {
    await fs.writeFile(newVersion, contents);
    await fs.rename(original, backup);
    await fs.rename(newVersion, original);
    await fs.unlink(backup);
  };
  const movedDir = path.join(dir, '정리한 자료');
  const moved = path.join(movedDir, '이름 바꾼 자료.docx');
  await fs.writeFile(original, '이전 내용');
  await fs.mkdir(movedDir);
  const first = make();
  await first.init();
  await fs.writeFile(first.lessonsPath, JSON.stringify({ records: { [id]: { memo: '지난 수업', files: [{ path: original, name: '수업 자료.docx' }] } } }));
  const store = make();
  await store.init();
  assert.equal(store.lessonRecord(id).files[0].track, undefined);
  assert.equal(await store.refreshLessonFileTracks(id), true);
  const oldTrack = store.lessonRecord(id).files[0].track;
  assert.ok(validTrack(oldTrack));
  assert.equal(await store.refreshLessonFileTracks(id), false);

  await store.startFileTracking();
  try {
    await replace('덮어쓴 가상 내용');
    await store.refreshLessonFileTracks(id);
    const refreshedTrack = store.lessonRecord(id).files[0].track;
    assert.notEqual(refreshedTrack.ino, oldTrack.ino);
    assert.equal(await findTracked(oldTrack), null);

    await replace('열기 직전 교체한 가상 내용');
    await fs.rename(original, moved);
    const track = await fileTrack(moved);
    assert.notEqual(track.ino, refreshedTrack.ino);
    await store.setLessonRecord(id, { memo: '새 메모' });
    assert.equal((await store.resolveLessonFile(id, 0, original, refreshedTrack)).path, moved);
    await assert.rejects(store.removeLessonFile(id, 0, original), /자료 연결이 바뀌었습니다/);
    await assert.rejects(fs.stat(original), { code: 'ENOENT' });
    assert.equal(await fs.readFile(moved, 'utf8'), '열기 직전 교체한 가상 내용');
    const again = make();
    await again.init();
    assert.deepEqual(again.lessonRecord(id), { memo: '새 메모', files: [{ path: moved, name: '이름 바꾼 자료.docx', track }] });
    assert.deepEqual(await again.resolveLessonFile(id, 0, moved), { path: moved, changed: false });
  } finally {
    await store.stopFileTracking();
  }
});

for (const action of ['자세히 갱신', '자료 열기']) {
  test(`NTFS ${action}: 기존 자리에 다른 파일이 생겼어도 이동한 원본을 찾아 저장한다`, { skip: process.platform !== 'win32' }, async t => {
    const { dir, make } = await lessonFixture(t);
    const id = 'homeroom|2026-11-23|1';
    const original = path.join(dir, '수업 자료.txt');
    const movedDir = path.join(dir, '옮긴 폴더');
    const moved = path.join(movedDir, '이름 바꾼 원본.txt');
    const store = make();
    await store.init();
    await fs.writeFile(original, '가상 수업 원본');
    await store.addLessonFiles(id, [original]);
    const track = store.lessonRecord(id).files[0].track;
    await fs.mkdir(movedDir);
    await fs.rename(original, moved);
    await fs.writeFile(original, '동명 파일의 다른 내용');
    assert.notEqual((await fileTrack(original)).ino, track.ino);
    assert.equal(await findTracked(track), moved);

    if (action === '자세히 갱신') {
      const [refreshed, opened] = await Promise.all([
        store.refreshLessonFileTracks(id), store.resolveLessonFile(id, 0, original, track)
      ]);
      assert.equal(refreshed, true);
      assert.deepEqual(opened, { path: moved, changed: false });
    } else {
      assert.deepEqual(await store.resolveLessonFile(id, 0, original), { path: moved, changed: true });
    }
    const again = make();
    await again.init();
    assert.deepEqual(again.lessonRecord(id).files, [{ path: moved, name: '이름 바꾼 원본.txt', track }]);
    assert.equal(await fs.readFile(moved, 'utf8'), '가상 수업 원본');
    assert.equal(await fs.readFile(original, 'utf8'), '동명 파일의 다른 내용');
  });
}

test('NTFS에서 끝나지 않은 교체 저장의 임시 백업과 동명 파일을 자료로 열지 않는다', { skip: process.platform !== 'win32' }, async t => {
  const { dir, make } = await lessonFixture(t);
  const id = 'homeroom|2026-11-23|1';
  const source = path.join(dir, '수업 자료.xlsx');
  const backup = path.join(dir, 'C6232AF.tmp');
  const staging = path.join(dir, '69BA500');
  const moved = path.join(dir, '먼저 사라진 임시 저장본.xlsx');
  const store = make();
  await store.init();
  await fs.writeFile(source, '연결한 원본');
  await store.addLessonFiles(id, [source]);
  const track = store.lessonRecord(id).files[0].track;
  await store.startFileTracking();
  try {
    await fs.writeFile(staging, '저장 중인 내용');
    await fs.rename(source, backup);
    assert.equal(await store.resolveLessonFile(id, 0, source), null);
    const restartedWithoutObservation = make();
    await restartedWithoutObservation.init();
    assert.equal(await restartedWithoutObservation.resolveLessonFile(id, 0, source), null);

    await fs.rename(staging, source);
    await fs.rename(source, moved);
    await fs.writeFile(source, '동명 미끼');
    await fs.unlink(backup);
    assert.equal(await store.resolveLessonFile(id, 0, source), null);
    assert.deepEqual(store.lessonRecord(id).files[0].track, track);
  } finally {
    await store.stopFileTracking();
  }
});

test('원본을 찾지 못하면 기존 연결을 유지하고, 직접 고른 원본으로 그 연결만 바꾼다', async t => {
  const { dir, make } = await lessonFixture(t);
  const id = 'subject|2026-11-23|3';
  const original = path.join(dir, '잃어버린 자료.txt');
  const other = path.join(dir, '다른 자료.txt');
  const replacement = path.join(dir, '다시 연결한 자료.txt');
  const store = make();
  await store.init();
  await Promise.all([original, other, replacement].map(file => fs.writeFile(file, path.basename(file))));
  await store.addLessonFiles(id, [original, other]);
  await store.setLessonRecord(id, { memo: '같은 반의 지난 수업' });
  await fs.unlink(original);
  assert.equal(await store.resolveLessonFile(id, 0, original), null);
  assert.equal(store.lessonRecord(id).files[0].path, original);
  await assert.rejects(store.relinkLessonFile(id, 0, original, other), /이미 연결/);
  await assert.rejects(store.relinkLessonFile(id, 0, original, dir), /자료 파일을 찾지 못했습니다/);
  await store.relinkLessonFile(id, 0, original, replacement);
  const again = make();
  await again.init();
  assert.equal(again.lessonRecord(id).memo, '같은 반의 지난 수업');
  assert.deepEqual(again.lessonRecord(id).files.map(file => file.path), [replacement, other]);
  assert.equal(await fs.readFile(replacement, 'utf8'), path.basename(replacement));
  if (process.platform === 'win32') {
    assert.ok(validTrack(again.lessonRecord(id).files[0].track));
    const renamed = path.join(dir, '다시 옮긴 자료.txt');
    await fs.rename(replacement, renamed);
    assert.deepEqual(await again.resolveLessonFile(id, 0, replacement), { path: renamed, changed: true });
  }
});

// 그날만 바꾸기(11/26 사용자 "시간표 수정을 엄청 편하게").
test('그날만 바꾼 수업이 기초 시간표보다 앞서고 지난 수업 찾기에도 쓰인다', () => {
  const schedule = [['국어', '', '', '', ''], ['수학', '', '', '', '']];
  const changes = { 'homeroom|2026-11-23|1': '체육', 'homeroom|2026-11-23|2': '', 'homeroom|2026-11-23|6': '국어', 'subject|2026-11-23|1': '2-3 과학' };
  const options = { changes, mode: 'homeroom' };
  assert.deepEqual(L.lessonsOn('2026-11-23', schedule, null, options), [{ period: 1, cell: '체육', changed: true }, { period: 6, cell: '국어', changed: true }]);
  assert.deepEqual(L.lessonsOn('2026-11-30', schedule, null, options), [{ period: 1, cell: '국어' }, { period: 2, cell: '수학' }], '다른 주는 그대로');
  assert.deepEqual(L.lessonsOn('2026-11-23', schedule, { start: '2026-12-01' }, options).map(item => item.period), [1, 6], '적용 기간 밖이어도 직접 바꾼 칸은 보인다');
  assert.deepEqual(L.earlierLessons('2026-11-30', 1, schedule, null, 2, options).map(item => `${item.date} ${item.period}`), ['2026-11-23 6', '2026-11-16 1']);
  const plan = L.cleanPlan({ homeroom: schedule, changes: { ...changes, 'homeroom|2026-11-24|1': '', 'homeroom|2026-11-30|1': '국어', bad: '국어', 'homeroom|2026-11-23|13': '국어' } });
  assert.deepEqual(Object.keys(plan.changes).sort(), ['homeroom|2026-11-23|1', 'homeroom|2026-11-23|2', 'homeroom|2026-11-23|6', 'subject|2026-11-23|1'],
    '기초와 같은 칸·잘못된 칸은 버린다');
});

test('저장소: 그날만 바꾸기·되돌리기, 맞바꾸면 메모·자료도 따라간다', async t => {
  const { CalendarStore } = require('../store');
  const qa = path.resolve(__dirname, '..', '..', '.qa');
  await fs.mkdir(qa, { recursive: true });
  const dir = await fs.mkdtemp(path.join(await fs.realpath(qa), 'lesson-changes-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const make = () => new CalendarStore({ dataDir: path.join(dir, 'data'), inboxDir: path.join(dir, 'inbox') });
  const store = make();
  await store.init();
  await store.setLessonPlan({ mode: 'homeroom', schedule: [['국어', '수학', '', '', ''], ['과학', '', '', '', '']] });
  await store.setLessonRecord('homeroom|2026-11-23|1', { memo: '국어 메모' });
  const a = 'homeroom|2026-11-23|1';
  const b = 'homeroom|2026-11-23|2';
  await store.setLessonPlan({ changes: { [a]: '과학', [b]: '국어' }, swapRecords: [a, b] });
  let { lessons } = store.snapshot();
  assert.deepEqual(lessons.changes, { [a]: '과학', [b]: '국어' });
  assert.equal(lessons.records[b].memo, '국어 메모');
  assert.equal(lessons.records[a], undefined);
  assert.deepEqual(lessons.homeroom, [['국어', '수학', '', '', ''], ['과학', '', '', '', '']], '기초 시간표는 그대로');
  await store.setLessonPlan({ changes: { [a]: '국어' } });
  assert.deepEqual(store.snapshot().lessons.changes, { [b]: '국어' }, '기초와 같아지면 지운다');
  await assert.rejects(store.setLessonPlan({ changes: { '../x': '국어' } }), /바꿀 수업/);
  await assert.rejects(store.setLessonPlan({ swapRecords: [a, a] }), /바꿀 수업/);
  const again = make();
  await again.init();
  ({ lessons } = again.snapshot());
  assert.deepEqual(lessons.changes, { [b]: '국어' });
  await again.setLessonPlan({ changes: { [b]: null } });
  assert.deepEqual(again.snapshot().lessons.changes, {});
});

test('저장소: 한 주만 시간표를 교체하고 재실행 후 기초로 되돌린다', async t => {
  const { CalendarStore } = require('../store');
  const qa = path.resolve(__dirname, '..', '..', '.qa');
  await fs.mkdir(qa, { recursive: true });
  const dir = await fs.mkdtemp(path.join(await fs.realpath(qa), 'lesson-week-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const make = () => new CalendarStore({ dataDir: path.join(dir, 'data'), inboxDir: path.join(dir, 'inbox') });
  const store = make();
  await store.init();
  const weekStart = '2026-11-23';
  const mode = 'homeroom';
  const base = [['국어', '수학', '', '', ''], ['과학', '', '', '', '']];
  await store.setLessonPlan({ mode, schedule: base, periodTimes: [['09:00', '09:40']] });
  await store.setLessonPlan({ mode: 'subject', schedule: [['4-1 음악', '', '', '', '']] });
  const existing = {
    'homeroom|2026-11-23|1': '국어 변경',
    'homeroom|2026-11-23|12': '추가 수업',
    'homeroom|2026-11-30|1': '다른 주',
    'homeroom|2026-11-28|1': '주말 기록',
    'subject|2026-11-23|1': '4-2 음악'
  };
  await store.setLessonPlan({ changes: existing });
  const memoId = 'homeroom|2026-11-23|2';
  await store.setLessonRecord(memoId, { memo: '보존할 기록' });
  const originalFile = path.join(dir, '자료.txt');
  await fs.writeFile(originalFile, '가상 수업 자료');
  await store.addLessonFiles(memoId, [originalFile]);
  const before = store.snapshot().lessons;
  const replacement = [['음악', '', '', '', '미술']];
  const invalid = [
    { weekStart: '2026-11-24' }, { weekStart: '2026-11-31' }, { mode: 'other' },
    { schedule: undefined }, { schedule: [] }, { schedule: [['', '', '', '', '']] },
    { schedule: [['과학']] }, { schedule: [['과학', true, '', '', '']] },
    { schedule: Array.from({ length: 13 }, () => replacement[0]) }
  ];
  for (const overrides of invalid) {
    await assert.rejects(store.setLessonPlan({ weekSchedule: { weekStart, mode, schedule: replacement, ...overrides } }));
  }
  await assert.rejects(store.setLessonPlan({ weekSchedule: { weekStart, mode, schedule: replacement }, periodTimes: null }));
  assert.deepEqual(store.snapshot().lessons, before);
  const untouched = Object.fromEntries(Object.entries(existing).filter(([key]) => !key.startsWith('homeroom|2026-11-23|')));
  const changed = {
    ...untouched,
    'homeroom|2026-11-23|1': '음악',
    'homeroom|2026-11-23|2': '',
    'homeroom|2026-11-24|1': '',
    'homeroom|2026-11-27|1': '미술'
  };
  const importRequest = { weekSchedule: { weekStart, mode, schedule: replacement }, captureImportUndo: true };
  const { lessonImportUndo } = await store.setLessonPlan(importRequest);
  assert.deepEqual(store.snapshot().lessons, { ...before, changes: changed });
  assert.deepEqual(L.lessonsOn(weekStart, base, null, { mode, changes: changed }), [{ period: 1, cell: '음악', changed: true }]);
  const unrelated = 'homeroom|2026-12-07|1';
  await store.setLessonPlan({ changes: { [unrelated]: '새 변경' } });
  await store.setLessonPlan({ undoLessonImport: lessonImportUndo });
  assert.deepEqual(store.snapshot().lessons, { ...before, changes: { ...existing, [unrelated]: '새 변경' } });
  await assert.rejects(store.setLessonPlan({ undoLessonImport: lessonImportUndo }), /되돌릴 수 없어요/u);
  await store.setLessonPlan({ changes: { [unrelated]: null } });
  const second = await store.setLessonPlan(importRequest);
  const changedKey = 'homeroom|2026-11-23|1';
  await store.setLessonPlan({ changes: { [changedKey]: '가져온 뒤 수정' } });
  await assert.rejects(store.setLessonPlan({ undoLessonImport: second.lessonImportUndo }), /시간표가 바뀌어서/u);
  assert.equal(store.snapshot().lessons.changes[changedKey], '가져온 뒤 수정');
  await store.setLessonPlan(importRequest);
  const reopened = make();
  await reopened.init();
  assert.deepEqual(reopened.snapshot().lessons, { ...before, changes: changed });
  await reopened.setLessonPlan({ weekSchedule: { weekStart, mode, schedule: null } });
  assert.deepEqual(reopened.snapshot().lessons, { ...before, changes: untouched });
  const restored = make();
  await restored.init();
  assert.deepEqual(restored.snapshot().lessons, { ...before, changes: untouched });
  assert.deepEqual(L.lessonsOn(weekStart, base, null, { mode, changes: untouched }), [{ period: 1, cell: '국어' }, { period: 2, cell: '과학' }]);
});

test('설정 가져오기 되돌리기는 가져온 값만 원복하고 충돌하면 변경하지 않는다', async t => {
  const { CalendarStore } = require('../store');
  const qa = path.resolve(__dirname, '..', '..', '.qa');
  const dir = await fs.mkdtemp(path.join(await fs.realpath(qa), 'lesson-import-undo-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = new CalendarStore({ dataDir: path.join(dir, 'data'), inboxDir: path.join(dir, 'inbox') });
  await store.init();
  const base = [['국어', '', '', '', '']];
  const replacement = [['수학', '', '', '', '']];
  const manual = [['과학', '', '', '', '']];
  const times = [['09:00', '09:40']];
  const mode = 'homeroom';
  const synced = await store.setLessonPlan({ periodTimes: times, captureImportUndo: true });
  await store.setLessonPlan({ mode, schedule: base });
  await store.setLessonPlan({ undoLessonImport: synced.lessonImportUndo });
  assert.deepEqual(store.snapshot().lessons.homeroom, base);
  assert.equal(store.snapshot().lessons.periodTimes, null);

  const id = 'homeroom|2026-11-23|1';
  await store.setLessonPlan({ changes: { [id]: '수학' } });
  const applied = await store.setLessonPlan({ mode, schedule: replacement, periodTimes: times, captureImportUndo: true });
  assert.deepEqual(applied.lessons.changes, {});
  await store.setLessonPlan({ undoLessonImport: applied.lessonImportUndo });
  assert.deepEqual(store.snapshot().lessons.homeroom, base);
  assert.deepEqual(store.snapshot().lessons.changes, { [id]: '수학' });
  assert.equal(store.snapshot().lessons.periodTimes, null);

  const changed = await store.setLessonPlan({ mode, schedule: replacement, periodTimes: times, captureImportUndo: true });
  await store.setLessonPlan({ mode, schedule: manual });
  const before = store.snapshot().lessons;
  const disk = await fs.readFile(store.lessonsPath, 'utf8');
  await assert.rejects(store.setLessonPlan({ undoLessonImport: changed.lessonImportUndo }), /시간표가 바뀌어서/u);
  await assert.rejects(store.setLessonPlan({ mode, schedule: [], captureImportUndo: true }), /한 칸 이상/u);
  await assert.rejects(store.setLessonPlan({ periodTimes: [], captureImportUndo: true }), /교시 시각/u);
  assert.deepEqual(store.snapshot().lessons, before);
  assert.equal(await fs.readFile(store.lessonsPath, 'utf8'), disk);
});
