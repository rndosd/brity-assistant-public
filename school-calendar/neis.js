'use strict';

// 나이스 교육정보 개방 포털(open.neis.go.kr)에서 학교 찾기·학사일정·급식을 받는다.
// 인증키 없이도 부르지만 앞 5줄만 주고, 2쪽부터도 같은 5줄을 준다(2026-11-19 실제 응답으로 확인).
// 그래서 키가 없으면 날짜 구간을 5줄 이하가 될 때까지 나눠 받는다(학년도 하나에 수십 번).
// 키가 있으면(settings.neisKey 또는 SCHOOL_CALENDAR_NEIS_KEY) 한 번에 1000줄씩 받는다.
// 보내는 것은 학교 이름·교육청 코드·학교 코드·날짜뿐이다(공개 정보). 쪽지·업무 내용은 보내지 않는다.

const BASE = 'https://open.neis.go.kr/hub/';
const KEYLESS_PAGE = 5;
const KEY_PAGE = 1000;
const MAX_PAGES = 80;
const TIMEOUT_MS = 15_000;
const LEVELS = ['초등학교', '중학교', '고등학교', '특수학교'];

class NeisError extends Error {}

function ymd(value) {
  return value.replaceAll('-', '');
}
function fromYmd(value) {
  return /^\d{8}$/.test(value) ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}` : null;
}

async function call(service, params, { key, fetchImpl = fetch } = {}) {
  const url = new URL(service, BASE);
  url.searchParams.set('Type', 'json');
  if (key) url.searchParams.set('KEY', key);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, String(value));
  let response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new NeisError('나이스에 연결하지 못했습니다. 인터넷 연결을 확인해 주세요.');
  }
  if (!response.ok) throw new NeisError(`나이스가 응답하지 않습니다(${response.status}). 잠시 뒤 다시 시도해 주세요.`);
  let body;
  try {
    body = await response.json();
  } catch {
    throw new NeisError('나이스 응답을 읽지 못했습니다.');
  }
  // 자료 없음은 RESULT만 온다: {"RESULT":{"CODE":"INFO-200",...}}
  if (body?.RESULT?.CODE === 'INFO-200') return { total: 0, rows: [] };
  if (body?.RESULT) throw new NeisError(`나이스 오류: ${body.RESULT.MESSAGE || body.RESULT.CODE}`);
  const parts = body?.[service];
  const head = parts?.[0]?.head;
  const code = head?.[1]?.RESULT?.CODE;
  if (code && code !== 'INFO-000') throw new NeisError(`나이스 오류: ${head[1].RESULT.MESSAGE || code}`);
  return { total: Number(head?.[0]?.list_total_count) || 0, rows: Array.isArray(parts?.[1]?.row) ? parts[1].row : [] };
}

async function callAll(service, params, options = {}) {
  const rows = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { total, rows: part } = await call(service, { ...params, pIndex: page, pSize: KEY_PAGE }, options);
    rows.push(...part);
    if (!part.length || rows.length >= total) break;
  }
  return rows;
}

function addDays(value, days) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
function monthWindows(from, to) {
  const windows = [];
  for (let start = from; start <= to;) {
    const date = new Date(`${start}T00:00:00Z`);
    const monthEnd = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
    const end = monthEnd < to ? monthEnd : to;
    windows.push([start, end]);
    start = addDays(end, 1);
  }
  return windows;
}

// 키 없이: 달마다 묻고, 5줄이 넘는 구간은 반으로 나눠 다시 묻는다. 하루에 6줄 넘는 날은 앞 5줄만 남는다.
async function callByDates(service, params, from, to, options = {}) {
  const rows = [];
  let calls = 0;
  const queue = monthWindows(from, to);
  const worker = async () => {
    for (let range = queue.shift(); range; range = queue.shift()) {
      const [start, end] = range;
      if (++calls > 400) throw new NeisError('학사일정이 너무 많아 다 받지 못했습니다. 나이스 인증키를 넣어 주세요.');
      const { total, rows: part } = await call(service, { ...params, AA_FROM_YMD: ymd(start), AA_TO_YMD: ymd(end), pIndex: 1, pSize: KEYLESS_PAGE }, options);
      if (total <= part.length || start === end) {
        rows.push(...part);
        continue;
      }
      const span = Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000);
      const middle = addDays(start, Math.floor(span / 2));
      queue.push([start, middle], [addDays(middle, 1), end]);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  return { rows, calls };
}

function cleanText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

// 학교 찾기: 이름 일부로 찾는다(예: "가곡초"). 키 없이는 앞 5곳만 오므로 이름을 길게 적도록 안내한다.
async function searchSchools(name, options = {}) {
  const text = cleanText(name).slice(0, 40);
  if (text.length < 2) throw new NeisError('학교 이름을 두 글자 이상 적어 주세요.');
  const { total, rows } = await call('schoolInfo', { SCHUL_NM: text, pIndex: 1, pSize: options.key ? 30 : KEYLESS_PAGE }, options);
  const schools = rows.filter(row => row.SD_SCHUL_CODE?.trim() && row.ATPT_OFCDC_SC_CODE).map(row => ({
    office: row.ATPT_OFCDC_SC_CODE, officeName: cleanText(row.ATPT_OFCDC_SC_NM), code: row.SD_SCHUL_CODE.trim(),
    name: cleanText(row.SCHUL_NM), level: cleanText(row.SCHUL_KND_SC_NM), address: cleanText(row.ORG_RDNMA)
  }));
  return { schools, more: total > rows.length };
}

// 학년도: 3월~다음 해 2월. 1~2월이면 앞 해 학년도.
function schoolYearRange(today) {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const start = month >= 3 ? year : year - 1;
  const febLast = new Date(Date.UTC(start + 1, 2, 0)).getUTCDate();
  return { from: `${start}-03-01`, to: `${start + 1}-02-${String(febLast).padStart(2, '0')}` };
}

const GRADE_FIELDS = ['ONE_GRADE_EVENT_YN', 'TW_GRADE_EVENT_YN', 'THREE_GRADE_EVENT_YN', 'FR_GRADE_EVENT_YN', 'FIV_GRADE_EVENT_YN', 'SIX_GRADE_EVENT_YN'];

// 학사일정. 토요휴업일은 매주 토요일이라 뺀다. off: '휴업일'·'공휴일'이면 쉬는 날.
async function fetchSchedule(school, from, to, options = {}) {
  const where = { ATPT_OFCDC_SC_CODE: school.office, SD_SCHUL_CODE: school.code };
  const rows = options.key
    ? await callAll('SchoolSchedule', { ...where, AA_FROM_YMD: ymd(from), AA_TO_YMD: ymd(to) }, options)
    : (await callByDates('SchoolSchedule', where, from, to, options)).rows;
  const events = [];
  const seen = new Set();
  for (const row of rows) {
    const date = fromYmd(row.AA_YMD);
    const name = cleanText(row.EVENT_NM).slice(0, 40);
    if (!date || !name || name === '토요휴업일') continue;
    const id = `${date}|${name}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const grades = GRADE_FIELDS.map((field, index) => row[field] === 'Y' ? index + 1 : 0).filter(Boolean);
    const offName = cleanText(row.SBTR_DD_SC_NM);
    events.push({ date, name, off: offName === '휴업일' || offName === '공휴일' ? offName : null, grades });
  }
  return events.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name, 'ko'));
}

// 급식 한 끼. 알레르기 번호 "(5.6.9)"와 표시 기호(*·@)는 빼고 음식 이름만 남긴다.
function menuItems(text) {
  return String(text ?? '').split(/<br\s*\/?>/i).map(item => item
    .replace(/\([\d.\s]+\)/g, '').replace(/^[*@#&\s]+|[*@#&\s]+$/g, '').replace(/\s+/g, ' ').trim()).filter(Boolean);
}

async function fetchMeals(school, date, options = {}) {
  const { rows } = await call('mealServiceDietInfo', {
    ATPT_OFCDC_SC_CODE: school.office, SD_SCHUL_CODE: school.code, MLSV_YMD: ymd(date), pIndex: 1, pSize: KEYLESS_PAGE
  }, options);
  return rows.map(row => ({ kind: cleanText(row.MMEAL_SC_NM) || '급식', items: menuItems(row.DDISH_NM), kcal: cleanText(row.CAL_INFO) }))
    .filter(meal => meal.items.length);
}

function schoolValue(input) {
  const office = typeof input?.office === 'string' ? input.office.trim() : '';
  const code = typeof input?.code === 'string' ? input.code.trim() : '';
  if (!/^[A-Z]\d{2}$/.test(office) || !/^\d{7}$/.test(code)) throw new NeisError('학교를 다시 골라 주세요.');
  return {
    office, code, name: cleanText(input.name).slice(0, 60) || '학교', officeName: cleanText(input.officeName).slice(0, 40),
    level: LEVELS.includes(input.level) ? input.level : ''
  };
}

module.exports = { NeisError, searchSchools, fetchSchedule, fetchMeals, schoolYearRange, menuItems, schoolValue };
