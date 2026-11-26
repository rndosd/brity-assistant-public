'use strict';

// 수업 탭의 바탕(화면·저장 양쪽에서 쓴다). 설계와 결정은 진행-정리.md "수업 캘린더 이어받기".
// 시간표는 [교시][요일(월~금)] 칸 글자. 담임은 "국어", 교과는 "2-3 국어"(학년-반 과목).
const lessonModel = (() => {
  const WEEKDAYS = ['월', '화', '수', '목', '금'];
  const MAX_PERIODS = 12;
  const DATE = /^\d{4}-\d{2}-\d{2}$/;
  const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

  // ── 붙여넣은 표 읽기(한글·엑셀·주간학습안내) ──
  const subjectName = value => /^(?:[가-힣]\s+)+[가-힣]$/.test(value) ? value.replace(/\s/g, '') : value;
  const periodOf = value => Number(String(value ?? '').match(/^\s*(\d{1,2})\s*교시\s*$/)?.[1] || 0);
  const weekdayLabel = value => String(value ?? '').trim().match(/^([월화수목금])(?:요일)?(?:\s*\(?[\d./-]+(?:일)?\)?)?$/)?.[1];
  const empty = value => !value || /^[-–—]$/.test(value);
  const cell = (name = '', review = false) => ({ name: empty(name) ? '' : subjectName(name.trim()), review });

  // 칸마다 줄이 바뀌는 일반 텍스트(한글 표를 메모장 등에 붙인 모양): "1교시" 다음 다섯 줄이 월~금.
  function textPlan(input) {
    const lines = input.replace(/\r\n?/g, '\n').split('\n').map(line => line.trim());
    const starts = lines.flatMap((line, index) => periodOf(line) ? [index] : []);
    if (!starts.length) return null;
    const header = lines.slice(0, starts[0]).filter(line => weekdayLabel(line));
    const hasHeader = header.length === 5 && new Set(header.map(weekdayLabel)).size === 5;
    const days = hasHeader ? header.map(weekdayLabel) : WEEKDAYS;
    const rows = starts.map((start, index) => {
      const block = lines.slice(start + 1, starts[index + 1]);
      const names = block.slice(0, 5);
      // 과목 다섯 줄 뒤에 수업 내용 다섯 줄이 오는 주간학습안내도 있다. 그보다 많으면 믿지 않는다.
      const unreliable = names.length < 5 || block.slice(10).some(Boolean);
      return { period: periodOf(lines[start]), cells: Array.from({ length: 5 }, (_, column) => cell(names[column], unreliable)) };
    });
    return { days, rows, hasHeader };
  }

  // 표 모양(엑셀 탭 구분 또는 HTML 표): 요일 다섯 개가 있는 줄을 머리로, "N교시" 칸이 있는 줄을 교시로 본다.
  function tabularPlan(matrix) {
    const headerIndex = matrix.findIndex(row => new Set(row.map(weekdayLabel).filter(Boolean)).size === 5);
    if (headerIndex < 0) return null;
    const header = matrix[headerIndex];
    const columns = header.flatMap((value, index) => weekdayLabel(value) ? [index] : []);
    const days = columns.map(index => weekdayLabel(header[index]));
    // 교시 칸은 "1교시"가 보통이고, 요일 왼쪽 칸이면 숫자만("1") 있어도 교시로 본다(학교 시간표 한글 파일, 11/26).
    const numberOf = (value, at) => periodOf(value) || (at < columns[0] ? Number(/^\s*(\d{1,2})\s*$/.exec(String(value ?? ''))?.[1] || 0) : 0);
    const periodIndex = matrix.slice(headerIndex + 1).find(row => row.some(numberOf))?.findIndex(numberOf) ?? -1;
    if (periodIndex < 0) return null;
    const rows = [];
    for (let index = headerIndex + 1; index < matrix.length; index += 1) {
      const number = numberOf(matrix[index][periodIndex] || '', periodIndex);
      if (!number) continue;
      // 칸 안 첫 줄이 과목, 그 아래 줄은 수업 내용(주간학습안내)이라 버린다.
      rows.push({ period: number, cells: columns.map(column => cell(String(matrix[index][column] || '').split('\n')[0])) });
    }
    return rows.length ? { days, rows, hasHeader: true } : null;
  }

  // 교과 시간표 칸은 학교마다 2-3, 203, 2-3 국어, 국어(2-3)처럼 다르다. "학년-반 과목"으로 맞춘다.
  function classCell(value, fallback = '') {
    const text = String(value || '').trim();
    if (!text) return '';
    let match = /^(.+?)\s*\(\s*(\d)\s*-\s*(\d{1,2})\s*\)$/.exec(text);
    if (match) return `${match[2]}-${Number(match[3])} ${match[1].trim()}`;
    match = /^(\d)\s*-\s*(\d{1,2})\s*(.*)$/.exec(text) || /^(\d)(\d{2})(?!\d)\s*(.*)$/.exec(text);
    if (match) return `${match[1]}-${Number(match[2])} ${match[3].trim() || fallback}`.trim();
    return text;
  }

  // matrices: HTML 표들을 칸 글자 배열로 바꾼 것(화면 쪽 DOMParser가 만든다). mode가 subject면 칸을 "학년-반 과목"으로.
  function readTimetable(text, { matrices = [], mode = 'homeroom', fallbackSubject = '' } = {}) {
    let result = null;
    for (const matrix of matrices) if (!result) result = tabularPlan(matrix);
    if (!result && String(text).includes('\t')) {
      result = tabularPlan(String(text).split(/\r?\n/).map(row => row.split('\t').map(value => value.trim())));
    }
    if (!result) result = textPlan(String(text || ''));
    const rows = result?.rows || [];
    const valid = result?.days.length === 5 && rows.length > 0 && new Set(rows.map(row => row.period)).size === rows.length &&
      rows.every(row => row.period > 0 && row.period <= MAX_PERIODS && row.cells.length === 5 && row.cells.every(slot => !slot.review));
    if (!valid) return { schedule: null, message: '요일과 교시가 들어간 표를 다시 복사해 주세요.' };
    const schedule = Array.from({ length: Math.max(...rows.map(row => row.period)) }, (_, index) => {
      const row = rows.find(item => item.period === index + 1);
      return WEEKDAYS.map(day => {
        const name = row?.cells[result.days.indexOf(day)]?.name || '';
        return mode === 'subject' ? classCell(name, fallbackSubject) : name;
      });
    });
    return { schedule, message: result.hasHeader ? '바뀐 칸을 확인한 뒤 등록하세요.' : '월~금 순서로 채웠어요. 바뀐 칸을 확인해 주세요.' };
  }

  // 시정표 읽기: "1교시" 뒤에 오는 시각 두 개를 그 교시로 본다. 한글에서 복사해 칸마다 줄이 바뀌어도 된다.
  // 교시 표시가 없으면 시각 두 개씩 1교시부터 채운다. 7시 전 시각(1:00 등)과 "오후"는 오후로 읽는다.
  function parsePeriodTimes(text) {
    const result = [];
    let current = null;
    let times = [];
    let sequential = 0;
    const source = String(text || '');
    const hasMarkers = /\d\s*교시/.test(source);
    for (const match of source.matchAll(/(\d{1,2})\s*교시|(오후\s*)?(\d{1,2})\s*[:：시]\s*(\d{2})/g)) {
      if (match[1]) { current = Number(match[1]); times = []; continue; }
      if (hasMarkers && current === null) continue;
      let hour = Number(match[3]);
      if ((match[2] && hour < 12) || hour < 7) hour += 12;
      times.push(`${String(hour).padStart(2, '0')}:${match[4]}`);
      if (times.length === 2) {
        const period = hasMarkers ? current : ++sequential;
        if (period >= 1 && period <= MAX_PERIODS && !result[period - 1]) result[period - 1] = times;
        // 교시 표시가 있으면 다음 "N교시"가 나올 때까지 남는 시각(점심시간 등)은 버린다.
        times = hasMarkers ? [null, null, null] : [];
      }
    }
    const filled = Array.from({ length: result.length }, (_, index) => result[index] || null);
    return filled.length && filled.every(Boolean) && filled.every(([start, end]) => start < end) ? filled : null;
  }

  const BELL_TIME = '(?:(?:오전|오후)\\s*)?\\d{1,2}\\s*[:：시]\\s*[0-5]\\d(?:\\s*분)?';
  const BELL_CELL = new RegExp('^\\s*' + BELL_TIME + '(?:\\s*(?:[~～–—-]|부터)?\\s*' + BELL_TIME + '(?:\\s*까지)?)?\\s*$', 'u');
  const BELL_WITH_PERIOD = new RegExp('^\\s*(\\d{1,2})\\s*교시\\s*\\(\\s*(' + BELL_TIME + '\\s*[~～–—-]\\s*' + BELL_TIME + ')\\s*\\)\\s*$', 'u');
  const BELL_HEADING = /^(?:시작|종료|끝)(?:\s*(?:시각|시간))?$|^(?:시간|시각|수업\s*시간)$/u;
  function collectBellTimes(rows) {
    if (!rows.length || new Set(rows.map(([period]) => period)).size !== rows.length) return null;
    if (rows.some(([, times]) => [...times.matchAll(new RegExp(BELL_TIME, 'gu'))].length !== 2)) return null;
    const result = parsePeriodTimes(rows.map(([period, times]) => period + '교시 ' + times).join('\n'));
    return result && result.length === rows.length && result.every(pair => pair.every(time => TIME.test(time))) ? result : null;
  }
  function matrixBellTimes(matrix) {
    const weekdayColumns = matrix.find(row => new Set(row.map(weekdayLabel).filter(Boolean)).size === 5) || [];
    const firstWeekday = weekdayColumns.findIndex(weekdayLabel);
    const header = matrix.find(row => row.some(item => BELL_HEADING.test(String(item).trim()))) || [];
    const periodColumn = header.findIndex(item => /^(?:교시|구분)$/u.test(String(item).trim()));
    const timeColumns = header.flatMap((item, index) => BELL_HEADING.test(String(item).trim()) ? [index] : []);
    const rows = [];
    for (const row of matrix) {
      const periodAt = row.findIndex((item, index) =>
        (firstWeekday < 0 || index < firstWeekday) && (periodOf(item) || BELL_WITH_PERIOD.test(String(item))));
      const combined = BELL_WITH_PERIOD.exec(String(row[periodAt]));
      const period = combined ? Number(combined[1]) : periodAt >= 0 ? periodOf(row[periodAt]) :
        periodColumn >= 0 && /^\d{1,2}$/u.test(String(row[periodColumn]).trim()) ? Number(row[periodColumn]) : 0;
      if (!period) continue;
      const times = combined?.[2] || row.filter((item, index) => !weekdayLabel(weekdayColumns[index]) &&
        (timeColumns.length ? timeColumns.includes(index) : index > periodAt) && BELL_CELL.test(String(item))).join(' ');
      if (times) rows.push([period, times]);
    }
    return collectBellTimes(rows);
  }
  function textBellTimes(text) {
    const rows = [];
    let current = null;
    for (const line of String(text || '').split(/\r?\n/u).map(line => line.trim()).filter(Boolean)) {
      const match = BELL_WITH_PERIOD.exec(line) || /^(\d{1,2})\s*교시(?:\s+(.+))?$/u.exec(line);
      if (match) {
        current = [Number(match[1]), match[2] && BELL_CELL.test(match[2]) ? match[2] : ''];
        rows.push(current);
      } else if (current && BELL_CELL.test(line)) {
        current[1] = [current[1], line].filter(Boolean).join(' ');
      } else {
        current = null;
      }
    }
    return collectBellTimes(rows);
  }
  function readTimetableSetup(text, { matrices = [], ...options } = {}) {
    const tsv = String(text || '').includes('\t')
      ? [String(text).split(/\r?\n/u).map(row => row.split('\t').map(cell => cell.trim()))] : [];
    const tables = [...matrices, ...tsv];
    let schedule = null;
    let periodTimes = null;
    for (const matrix of tables) {
      if (!schedule) {
        const courseRows = matrix.map(row => row.map(cell => {
          const numbered = BELL_WITH_PERIOD.exec(String(cell));
          return numbered ? numbered[1] + '교시' : cell;
        }));
        schedule = cleanSchedule(readTimetable('', { ...options, matrices: [courseRows] }).schedule);
      }
      periodTimes ||= matrixBellTimes(matrix);
    }
    if (!tables.length) {
      periodTimes = textBellTimes(text);
      const lines = String(text || '').split(/\r?\n/u).map(line => line.trim());
      const hasDayLabels = new Set(lines.map(weekdayLabel).filter(Boolean)).size === 5;
      const hasBellLines = lines.some(line => BELL_CELL.test(line) || BELL_WITH_PERIOD.test(line) ||
        /^\d{1,2}\s*교시\s+/u.test(line) && new RegExp(BELL_TIME, 'u').test(line));
      if (hasDayLabels || !hasBellLines) schedule = cleanSchedule(readTimetable(text, options).schedule);
    }
    return { schedule, periodTimes };
  }

  const addMinutes = (time, minutes) => {
    const [hour, minute] = time.split(':').map(Number);
    const total = hour * 60 + minute + minutes;
    return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
  };
  // 시정표를 넣기 전 기본값: 초등 40분, 중 45분, 고 50분 수업에 쉬는 시간 10분, 4교시 뒤 점심 50분.
  function defaultPeriodTimes(level) {
    const length = level === '고등학교' ? 50 : level === '중학교' ? 45 : 40;
    const times = [];
    let start = '09:00';
    for (let period = 1; period <= 7; period += 1) {
      times.push([start, addMinutes(start, length)]);
      start = addMinutes(start, length + (period === 4 ? 50 : 10));
    }
    return times;
  }

  // 수업 탭의 보기 방식은 내 역할로 정한다. 초등 전담·중고 선생님은 교과 보기, 그 밖은 담임 보기.
  function lessonMode(profile) {
    if (!profile || profile.workplace === '교육청') return 'homeroom';
    const level = profile.schoolLevel || '초등';
    return level !== '초등' || profile.role === '전담' ? 'subject' : 'homeroom';
  }

  const CLASS_CELL = /^(\d)-(\d{1,2})\s+(.+)$/;
  function partsOf(value) {
    const text = String(value || '');
    const match = CLASS_CELL.exec(text);
    return match ? { grade: Number(match[1]), room: Number(match[2]), cls: `${match[1]}-${match[2]}`, subject: match[3] }
      : { grade: null, room: null, cls: '', subject: text };
  }

  const toDate = value => { const [y, m, d] = value.split('-').map(Number); return new Date(y, m - 1, d); };
  const toKey = date => `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const column = dateKey => (toDate(dateKey).getDay() + 6) % 7;
  const inTerm = (dateKey, term) => (!term?.start || dateKey >= term.start) && (!term?.end || dateKey <= term.end);

  // 그날만 바꾼 수업(11/26 사용자 "시간표 수정을 엄청 편하게"): changes["모드|날짜|교시"] = 칸 글자.
  // ''는 그날 그 교시 수업 없음. 기초 시간표보다 앞서고, 적용 기간 밖이어도 보인다(직접 넣은 것이라).
  function changedOn(changes, mode, dateKey) {
    const own = new Map();
    const prefix = `${mode}|${dateKey}|`;
    for (const [id, value] of Object.entries(changes || {})) if (id.startsWith(prefix)) own.set(Number(id.slice(prefix.length)), value);
    return own;
  }
  const baseCell = (dateKey, period, schedule, term) => {
    const at = column(dateKey);
    return at > 4 || !inTerm(dateKey, term) ? '' : schedule?.[period - 1]?.[at] || '';
  };

  // 그날 수업: [{ period, cell }]. 주말·적용 기간 밖은 없다. 그날만 바꾼 칸은 changed: true.
  function lessonsOn(dateKey, schedule, term, { changes, mode = 'homeroom' } = {}) {
    if (column(dateKey) > 4) return [];
    const own = changedOn(changes, mode, dateKey);
    const length = Math.max(inTerm(dateKey, term) ? schedule?.length || 0 : 0, ...own.keys());
    const found = [];
    for (let period = 1; period <= length; period += 1) {
      const cell = own.has(period) ? own.get(period) : baseCell(dateKey, period, schedule, term);
      if (cell) found.push(own.has(period) ? { period, cell, changed: true } : { period, cell });
    }
    return found;
  }

  // 같은 수업의 앞선 시간: 같은 날 앞 교시부터 하루씩 거슬러 올라간다. 칸 글자 전체가 같아야 한다
  // (교과 방식은 반마다 진도가 달라 "학년-반 과목"이 같아야 한다, 11/25 사용자).
  function earlierLessons(dateKey, period, schedule, term, count = 3, options = {}) {
    const target = lessonsOn(dateKey, schedule, term, options).find(lesson => lesson.period === period)?.cell;
    if (!target) return [];
    const found = [];
    let date = toDate(dateKey);
    let before = period - 1;
    for (let back = 0; back < 120 && found.length < count; back += 1) {
      const day = toKey(date);
      if (term?.start && day < term.start) break;
      for (const lesson of lessonsOn(day, schedule, term, options).reverse()) {
        if (lesson.period <= before && lesson.cell === target && found.length < count) found.push({ date: day, period: lesson.period, cell: lesson.cell });
      }
      date.setDate(date.getDate() - 1);
      before = MAX_PERIODS;
    }
    return found;
  }

  const recordKey = (mode, dateKey, period) => `${mode}|${dateKey}|${period}`;

  // ── 저장 전에 고르기(store가 쓴다) ──
  const text = (value, max) => String(value ?? '').replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, max);
  function cleanSchedule(value) {
    if (value === null || value === undefined) return null;
    if (!Array.isArray(value) || value.length > MAX_PERIODS) throw new Error('시간표는 12교시까지 넣을 수 있어요.');
    const rows = value.map(row => {
      if (!Array.isArray(row) || row.length !== 5) throw new Error('시간표는 월~금 다섯 칸이어야 해요.');
      return row.map(item => text(item, 40));
    });
    while (rows.length && rows.at(-1).every(item => !item)) rows.pop();
    return rows.length ? rows : null;
  }
  function cleanImportedSchedule(value) {
    const schedule = cleanSchedule(value);
    if (Array.isArray(value) && [...value].some(row => !row || [...row].some(cell => typeof cell !== 'string'))) {
      throw new Error('시간표에 넣을 수업을 확인해 주세요.');
    }
    return schedule;
  }
  function cleanTimes(value) {
    if (value === null || value === undefined) return null;
    if (!Array.isArray(value) || value.length > MAX_PERIODS) throw new Error('교시 시각을 확인해 주세요.');
    return value.map(pair => {
      if (!Array.isArray(pair) || pair.length !== 2 || !pair.every(time => TIME.test(time)) || pair[0] >= pair[1]) {
        throw new Error('교시 시각은 시작이 끝보다 앞서야 해요.');
      }
      return [pair[0], pair[1]];
    });
  }
  function cleanTerm(value) {
    if (!value) return null;
    const start = value.start || null;
    const end = value.end || null;
    if ((start && !DATE.test(start)) || (end && !DATE.test(end))) throw new Error('적용 기간 날짜를 확인해 주세요.');
    if (start && end && end < start) throw new Error('끝 날짜가 시작보다 앞이에요.');
    return start || end ? { start, end } : null;
  }
  function cleanFile(file, validTrack) {
    const filePath = String(file?.path ?? '');
    if (!filePath || filePath.length > 1000 || /[\u0000-\u001f]/.test(filePath)) throw new Error('자료 파일 경로를 확인해 주세요.');
    const clean = { path: filePath, name: text(file?.name || filePath.split(/[\\/]/).pop(), 200) };
    if (validTrack?.(file.track)) {
      const { volume, dev, ino } = file.track;
      clean.track = { volume, dev, ino };
    }
    return clean;
  }
  function cleanRecord(value, validTrack) {
    const memo = String(value?.memo ?? '').slice(0, 4000);
    const files = (Array.isArray(value?.files) ? value.files : []).slice(0, 30).map(file => cleanFile(file, validTrack));
    return { memo, files };
  }
  const RECORD_ID = /^(homeroom|subject)\|\d{4}-\d{2}-\d{2}\|\d{1,2}$/;
  function cleanChanges(value) {
    const changes = {};
    for (const [id, cellText] of Object.entries(value && typeof value === 'object' ? value : {}).slice(0, 2000)) {
      if (RECORD_ID.test(id) && Number(id.split('|')[2]) >= 1 && Number(id.split('|')[2]) <= MAX_PERIODS && typeof cellText === 'string') changes[id] = text(cellText, 40);
    }
    return changes;
  }
  function weekDates({ weekStart, mode } = {}) {
    if (mode !== 'homeroom' && mode !== 'subject') throw new Error('시간표 종류를 확인해 주세요.');
    if (typeof weekStart !== 'string' || !DATE.test(weekStart)) throw new Error('시간표를 넣을 주를 확인해 주세요.');
    const monday = toDate(weekStart);
    if (toKey(monday) !== weekStart || monday.getDay() !== 1) throw new Error('시간표를 넣을 주의 월요일을 확인해 주세요.');
    return WEEKDAYS.map((_, index) => {
      const date = new Date(monday);
      date.setDate(date.getDate() + index);
      return toKey(date);
    });
  }
  function weekOverrides(plan, scope) {
    const days = weekDates(scope);
    return Object.fromEntries(Object.entries(plan.changes || {}).filter(([id]) => {
      const [owner, date] = id.split('|');
      return owner === scope.mode && days.includes(date);
    }));
  }
  // 한 주 전체를 바꾸며 null이면 그 주의 월~금을 기초 시간표로 되돌린다.
  function replaceWeekSchedule(plan, input) {
    const { mode, schedule } = input || {};
    const days = weekDates(input || {});
    let rows = null;
    if (schedule !== null) {
      rows = cleanImportedSchedule(schedule);
      if (!rows) throw new Error('이번 주 시간표에 수업이 한 칸 이상 있어야 해요.');
    }
    const changes = Object.fromEntries(Object.entries(plan.changes || {}).filter(([id]) => {
      const [owner, date] = id.split('|');
      return owner !== mode || !days.includes(date);
    }));
    if (rows) {
      for (const [at, day] of days.entries()) {
        for (let period = 1; period <= MAX_PERIODS; period += 1) {
          const cell = rows[period - 1]?.[at] || '';
          if (cell !== baseCell(day, period, plan[mode], plan.term)) changes[recordKey(mode, day, period)] = cell;
        }
      }
    }
    return changes;
  }
  // 기초 시간표와 같아진 "그날만" 칸은 지운다(되돌린 것과 같다).
  function pruneChanges(plan) {
    const changes = {};
    for (const [id, cellText] of Object.entries(plan.changes || {})) {
      const [mode, dateKey, period] = id.split('|');
      if (cellText !== baseCell(dateKey, Number(period), plan[mode], plan.term)) changes[id] = cellText;
    }
    return changes;
  }
  function emptyPlan() {
    return { version: 1, homeroom: null, subject: null, periodTimes: null, term: null, records: {}, changes: {} };
  }
  function cleanPlan(value, validTrack) {
    const plan = emptyPlan();
    if (!value || typeof value !== 'object') return plan;
    plan.homeroom = cleanSchedule(value.homeroom);
    plan.subject = cleanSchedule(value.subject);
    plan.periodTimes = cleanTimes(value.periodTimes);
    plan.term = cleanTerm(value.term);
    plan.changes = pruneChanges({ ...plan, changes: cleanChanges(value.changes) });
    for (const [id, record] of Object.entries(value.records || {})) {
      if (!/^(homeroom|subject)\|\d{4}-\d{2}-\d{2}\|\d{1,2}$/.test(id)) continue;
      const clean = cleanRecord(record, validTrack);
      if (clean.memo || clean.files.length) plan.records[id] = clean;
    }
    return plan;
  }

  return {
    WEEKDAYS, readTimetable, readTimetableSetup, classCell, parsePeriodTimes, defaultPeriodTimes, lessonMode, partsOf,
    lessonsOn, changedOn, earlierLessons, recordKey, inTerm, emptyPlan, cleanPlan, cleanSchedule, cleanImportedSchedule, cleanTimes, cleanTerm, cleanRecord, cleanFile, cleanChanges, pruneChanges, replaceWeekSchedule, weekOverrides
  };
})();

if (typeof module !== 'undefined') module.exports = lessonModel;
