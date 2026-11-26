'use strict';

// 시간표 파일 읽기(11/26): .hwpx 표, 숫자만 있는 교시, AI 답 고르기, .hwp 안내.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const T = require('../timetable-file');
const L = require('../renderer/lesson-model');

function fakeZip(parts) {
  const localEntries = [];
  const directory = [];
  let offset = 0;
  for (const [name, xml] of Object.entries(parts)) {
    const entryName = Buffer.from(name);
    const data = zlib.deflateRawSync(Buffer.from(xml));
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(Buffer.byteLength(xml), 22);
    local.writeUInt16LE(entryName.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(Buffer.byteLength(xml), 24);
    central.writeUInt16LE(entryName.length, 28);
    central.writeUInt32LE(offset, 42);
    localEntries.push(local, entryName, data);
    directory.push(central, entryName);
    offset += local.length + entryName.length + data.length;
  }
  const count = Object.keys(parts).length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(Buffer.concat(directory).length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localEntries, ...directory, end]);
}
const fakeHwpx = xml => fakeZip({ 'Contents/section0.xml': xml });
const tc = (row, column, text, { rows = 1, columns = 1 } = {}) =>
  `<hp:tc><hp:subList><hp:p><hp:run><hp:t>${text}</hp:t></hp:run></hp:p></hp:subList><hp:cellAddr colAddr="${column}" rowAddr="${row}"/><hp:cellSpan colSpan="${columns}" rowSpan="${rows}"/></hp:tc>`;
const table = rows => `<hp:tbl>${rows.map(cells => `<hp:tr>${cells.join('')}</hp:tr>`).join('')}</hp:tbl>`;

test('.hwpx 표를 칸 배열로 읽고, 숫자만 있는 교시도 시간표로 읽는다', async t => {
  const xml = `<hs:sec>${table([
    [tc(0, 0, '과목'), tc(0, 1, '4학년 2반', { columns: 5 })],
    ['요일', '월', '화', '수', '목', '금'].map((text, column) => tc(1, column, text)),
    ['1', '국어', '수학', '과학(전)', '사회', '체육'].map((text, column) => tc(2, column, text)),
    ['2', '수학', '국어 &amp; 독서', '', '음악', '미술'].map((text, column) => tc(3, column, text))
  ])}${table([
    ['교시', '시작', '종료'].map((text, column) => tc(0, column, text)),
    ['1교시', '09:00', '09:40'].map((text, column) => tc(1, column, text)),
    ['쉬는 시간', '09:40', '09:50'].map((text, column) => tc(2, column, text)),
    ['2교시', '09:50', '10:30'].map((text, column) => tc(3, column, text))
  ])}</hs:sec>`;
  const dir = await fs.mkdtemp(path.join(path.resolve(__dirname, '..', '..', '.qa'), 'timetable-file-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, '시간표.hwpx');
  await fs.writeFile(file, fakeHwpx(xml));
  const [matrix] = await T.readHwpxTables(file);
  assert.deepEqual(matrix[0], ['과목', '4학년 2반', '', '', '', ''], '합친 칸 나머지는 빈 칸');
  const read = L.readTimetable('', { matrices: [matrix] });
  assert.deepEqual(read.schedule, [['국어', '수학', '과학(전)', '사회', '체육'], ['수학', '국어 & 독서', '', '음악', '미술']]);
  const { matrices } = await T.readTimetableSource({ filePath: file, settings: true }, { provider: 'none' });
  assert.deepEqual(L.readTimetableSetup('', { matrices }), { schedule: read.schedule, periodTimes: [['09:00', '09:40'], ['09:50', '10:30']] });
});

test('표 안의 표는 따로 읽고 바깥 칸 글자에 섞지 않는다', () => {
  const inner = table([[tc(0, 0, '안쪽')]]);
  const xml = `<hp:tbl><hp:tr><hp:tc><hp:subList><hp:p><hp:run><hp:t>바깥</hp:t></hp:run></hp:p>${inner}</hp:subList><hp:cellAddr colAddr="0" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/></hp:tc></hp:tr></hp:tbl>`;
  assert.deepEqual(T.hwpxTables(xml), [[['안쪽']], [['바깥']]]);
});

test('숫자만 있는 칸은 요일 왼쪽 칸일 때만 교시로 본다', () => {
  const matrix = [['', '월', '화', '수', '목', '금'], ['1', '국어', '수학', '과학', '사회', '체육']];
  assert.ok(L.readTimetable('', { matrices: [matrix] }).schedule);
  const wrongSide = [['월', '화', '수', '목', '금', ''], ['국어', '수학', '과학', '사회', '체육', '1']];
  assert.equal(L.readTimetable('', { matrices: [wrongSide] }).schedule, null);
});

test('AI 답을 시간표·교시 시각으로 고른다', () => {
  const value = { found: true, note: '', rows: [
    { period: 2, mon: '수학', tue: '', wed: '국어', thu: '', fri: '' },
    { period: 1, mon: '국어', tue: '창체', wed: '', thu: '수학', fri: '영어' },
    { period: 20, mon: '없음', tue: '', wed: '', thu: '', fri: '' }
  ], times: [{ period: 1, start: '9:00', end: '9:40' }, { period: 2, start: '09:50', end: '10:30' }] };
  const read = T.scheduleFromAi(value);
  assert.deepEqual(read.schedule, [['국어', '창체', '', '수학', '영어'], ['수학', '', '국어', '', '']]);
  assert.deepEqual(read.periodTimes, [['09:00', '09:40'], ['09:50', '10:30']]);
  assert.equal(T.scheduleFromAi({ ...value, times: [{ period: 1, start: '10:00', end: '09:00' }] }).periodTimes, null, '거꾸로 된 시각은 버린다');
  assert.equal(T.scheduleFromAi({ found: false, rows: [], times: [], note: '표 없음' }).schedule, null);
});

test('.hwp·모르는 파일은 안내하고, AI 연결이 없으면 그림을 읽지 않는다', async () => {
  await assert.rejects(T.readTimetableSource({ filePath: 'C:\\없음\\시간표.hwp' }, {}), /\.hwpx나 PDF로 저장/);
  await assert.rejects(T.readTimetableSource({ filePath: 'C:\\없음\\시간표.docx' }, {}), /엑셀\(\.xlsx\), PDF 또는 그림/);
  await assert.rejects(T.readTimetableSource({ image: { bytes: new Uint8Array([1, 2, 3]), type: 'image/png' } }, { provider: 'none' }), /AI를 먼저 연결/);
});

test('설정용 AI 시정표는 과목표 없이도 남고 비연속 교시는 당겨 채우지 않는다', async () => {
  const value = { found: false, rows: [], times: [{ period: 2, start: '09:50', end: '10:30' }, { period: 1, start: '09:00', end: '09:40' }] };
  assert.deepEqual(T.scheduleFromAi(value, true), { schedule: null, periodTimes: [['09:00', '09:40'], ['09:50', '10:30']], note: '' });
  assert.equal(T.scheduleFromAi(value).periodTimes, null, '주간 읽기는 과목표만 받는다');
  assert.equal(T.scheduleFromAi({ ...value, times: [{ ...value.times[0], period: 3 }, value.times[1]] }, true).periodTimes, null);
  assert.equal(T.scheduleFromAi({ ...value, times: [value.times[1], value.times[1]] }, true).periodTimes, null);
  const observed = await T.readTimetableSource({ settings: true, image: { bytes: new Uint8Array([1, 2, 3]), type: 'image/png' } }, {
    provider: 'codex', requestCodex: async prompt => {
      assert.match(prompt, /과목표가 없어도 times/u);
      assert.match(prompt, /쉬는 시간·점심/u);
      return value;
    }
  });
  assert.deepEqual(observed, { schedule: null, periodTimes: [['09:00', '09:40'], ['09:50', '10:30']], note: '', ai: true });
});

test('.xlsx 파일의 여러 시트에서 시간표와 엑셀 시간 서식을 AI 없이 읽는다', async t => {
  const { readXlsxSheets } = require('../xlsx-tables');
  const dir = await fs.mkdtemp(path.join(path.resolve(__dirname, '..', '..', '.qa'), 'timetable-xlsx-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, '시간표.xlsx');
  const inline = (address, text) => '<c r="' + address + '" t="inlineStr"><is><t>' + text + '</t></is></c>';
  const header = (labels, row) => labels.map((label, index) => inline(String.fromCharCode(65 + index) + row, label)).join('');
  const parts = {
    '_rels/.rels': '<Relationships><Relationship Id="root" Type="type/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml': '<workbook xmlns:r="urn:relationship"><sheets><sheet name="시정표" r:id="bell"/><sheet name="과목 &amp; 수업" r:id="course"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="course" Type="type/worksheet" Target="/xl/worksheets/a.xml"/><Relationship Id="bell" Type="type/worksheet" Target="worksheets/b.xml"/><Relationship Id="styles" Type="type/styles" Target="styles.xml"/><Relationship Id="text" Type="type/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="external" Type="type/worksheet" Target="https://example.invalid" TargetMode="External"/></Relationships>',
    'xl/styles.xml': '<styleSheet><cellXfs><xf numFmtId="0"/><xf numFmtId="20"/></cellXfs></styleSheet>',
    'xl/sharedStrings.xml': '<sst><si><r><t>국어 &amp; </t></r><r><t>독서</t></r><rPh><t>빼기</t></rPh></si></sst>',
    'xl/worksheets/a.xml': '<worksheet><sheetData><row r="1">' + header(['교시', '월', '화', '수', '목', '금'], 1) +
      '</row><row r="2"><c r="A2"><v>1</v></c><c r="B2" t="s"><v>0</v></c>' + inline('D2', '수학') +
      '</row></sheetData></worksheet>',
    'xl/worksheets/b.xml': '<worksheet><sheetData><row r="1">' + header(['교시', '시작', '종료'], 1) +
      '</row><row r="2"><c r="A2"><v>1</v></c><c r="B2" s="1"><v>0.375</v></c><c r="C2" s="1"><v>0.402777777777778</v></c></row></sheetData></worksheet>'
  };
  await fs.writeFile(file, fakeZip(parts));
  assert.deepEqual((await readXlsxSheets(file)).map(sheet => sheet.name), ['시정표', '과목 & 수업']);
  const { matrices } = await T.readTimetableSource({ filePath: file }, { provider: 'none' });
  assert.deepEqual(L.readTimetableSetup('', { matrices }), {
    schedule: [['국어 & 독서', '', '수학', '', '']],
    periodTimes: [['09:00', '09:40']]
  });
  await fs.writeFile(file, fakeZip({
    ...parts,
    'xl/worksheets/a.xml': '<worksheet><sheetData><row r="1048576">' + inline('XFD1048576', '범위 초과') + '</row></sheetData></worksheet>'
  }));
  await assert.rejects(T.readTimetableSource({ filePath: file }, { provider: 'none' }), /엑셀 표가 너무 커요/);
  await fs.writeFile(file, fakeZip({ ...parts, 'xl/workbook.xml': '<!DOCTYPE workbook SYSTEM "https://example.invalid">' }));
  await assert.rejects(T.readTimetableSource({ filePath: file }, { provider: 'none' }), /엑셀\(\.xlsx\) 파일을 읽지 못했어요/);
});
