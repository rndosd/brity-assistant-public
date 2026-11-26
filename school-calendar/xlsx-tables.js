'use strict';

const fs = require('node:fs/promises');
const path = require('node:path').posix;
const { zipEntries } = require('./timetable-file');

const MAX_FILE = 30 * 1024 * 1024;
const MAX_XML = 40 * 1024 * 1024;
const MAX_GRID_CELLS = 250_000;

function decodeXml(source) {
  return source.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[\da-f]+);/gi, (_, entity) => {
    const named = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }[entity];
    if (named) return named;
    const point = /^#x/i.test(entity) ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return Number.isInteger(point) && point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : '\uFFFD';
  });
}

function elements(xml, localName) {
  const prefix = '(?:[\\w.-]+:)?';
  const tag = '<' + prefix + localName + '(?=[\\s/>])';
  const attrs = "((?:[^<>\"']|\"[^\"]*\"|'[^']*')*?)";
  return xml.matchAll(new RegExp(tag + attrs + '(?:/\\s*>|>([\\s\\S]*?)</' + prefix + localName + '\\s*>)', 'g'));
}

function attributes(tag) {
  return Object.fromEntries(Array.from(tag.matchAll(/([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g),
    ([, name, doubleQuoted, singleQuoted]) => [name, decodeXml(doubleQuoted ?? singleQuoted)]));
}

function richText(xml) {
  const pieces = xml.replace(/<(?:[\w.-]+:)?rPh\b[^>]*>[\s\S]*?<\/(?:[\w.-]+:)?rPh\s*>/g, '');
  return Array.from(elements(pieces, 't'), ([, , content]) => decodeXml(content || '')).join('');
}

function numberFormats(xml = '') {
  const custom = new Map();
  for (const [, tag] of elements(xml, 'numFmt')) {
    const { numFmtId, formatCode } = attributes(tag);
    const code = (formatCode || '').replace(/"[^"]*"|\\.|_\S|\*\S/g, '');
    custom.set(Number(numFmtId), code);
  }
  const cellXfs = elements(xml, 'cellXfs').next().value?.[2] || '';
  return Array.from(elements(cellXfs, 'xf'), ([, tag]) => {
    const id = Number(attributes(tag).numFmtId);
    const code = custom.get(id);
    if (code) return /h/i.test(code) && /m/i.test(code) && !/[dy]/i.test(code) && !/\[[hms]+\]/i.test(code);
    return [18, 19, 20, 21, 45, 47].includes(id);
  });
}

function cellValue(type, body, style, strings, times) {
  if (type === 'inlineStr') return richText(body);
  const value = decodeXml(elements(body, 'v').next().value?.[2] || '');
  if (type === 's') return /^\d+$/.test(value) ? strings[Number(value)] || '' : '';
  if (type === 'b') return value === '1' ? 'TRUE' : 'FALSE';
  if (type === 'e') return '';
  if (type === 'd') return /T(\d\d:\d\d)/.exec(value)?.[1] || value;
  if (value && (!type || type === 'n') && times[Number(style || 0)]) {
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0 && number < 1) {
      const minutes = Math.floor(number * 1440 + 1e-7);
      return [Math.floor(minutes / 60), minutes % 60].map(part => String(part).padStart(2, '0')).join(':');
    }
  }
  return value;
}

function columnIndex(letters) {
  let index = 0;
  for (const letter of letters) index = index * 26 + letter.charCodeAt(0) - 64;
  return index - 1;
}

function sheetRows(xml, strings, times, budget) {
  const cells = [];
  const data = elements(xml, 'sheetData').next().value?.[2] || '';
  let rowIndex = -1;
  let width = 0;
  let height = 0;
  for (const [, rowTag, rowBody] of elements(data, 'row')) {
    const rowNumber = attributes(rowTag).r;
    rowIndex = rowNumber ? Number(rowNumber) - 1 : rowIndex + 1;
    let column = -1;
    for (const [, cellTag, body] of elements(rowBody || '', 'c')) {
      const { r, t, s } = attributes(cellTag);
      const address = /^([A-Z]{1,3})([1-9]\d*)$/.exec(r || '');
      column = address ? columnIndex(address[1]) : column + 1;
      const row = address ? Number(address[2]) - 1 : rowIndex;
      const value = body ? cellValue(t, body, s, strings, times).trim() : '';
      if (!value) continue;
      if (row < 0 || row >= 1_048_576 || column < 0 || column >= 16_384 || !Number.isInteger(row)) {
        throw new Error('잘못된 셀 주소');
      }
      width = Math.max(width, column + 1);
      height = Math.max(height, row + 1);
      if (width * height > budget.remaining) throw Object.assign(new Error('엑셀 표가 너무 커요. 필요한 시트와 셀만 남겨 다시 넣어 주세요.'), { code: 'ZIP_TOO_LARGE' });
      cells.push([row, column, value]);
    }
  }
  budget.remaining -= width * height;
  const rows = Array.from({ length: height }, () => []);
  for (const [row, column, value] of cells) rows[row][column] = value;
  return rows.map(row => Array.from(row, value => value ?? ''));
}

function relationships(xml, source = '') {
  const result = new Map();
  for (const [, tag] of elements(xml, 'Relationship')) {
    const { Id, Type, Target, TargetMode } = attributes(tag);
    if (!Id || !Type || !Target || TargetMode?.toLowerCase() === 'external') continue;
    const resolved = path.normalize(Target.startsWith('/') ? Target.slice(1) : path.join(source, Target));
    if (resolved === '..' || resolved.startsWith('../') || /[\\\0]/.test(resolved)) continue;
    result.set(Id, { type: Type.split('/').at(-1), target: resolved });
  }
  return result;
}

async function readWorkbook(filePath) {
  const fd = await fs.open(filePath, 'r');
  try {
    const stat = await fd.stat();
    if (!stat.isFile()) throw new Error('엑셀 파일을 선택해 주세요.');
    if (stat.size > MAX_FILE) throw Object.assign(new Error('파일이 너무 커요(30MB까지).'), { code: 'ZIP_TOO_LARGE' });
    const buffer = Buffer.allocUnsafe(stat.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await fd.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== stat.size) throw new Error('읽는 중에 엑셀 파일이 바뀌었어요. 저장한 뒤 다시 넣어 주세요.');
    return buffer.subarray(0, offset);
  } finally {
    await fd.close();
  }
}

async function readXlsxSheets(filePath) {
  const buffer = await readWorkbook(filePath);
  try {
    const zip = zipEntries(buffer);
    let remainingXml = MAX_XML;
    const read = name => {
      const xml = zip.read(name, remainingXml);
      remainingXml -= Buffer.byteLength(xml);
      if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) throw new Error('unexpected XML declaration');
      return xml.replace(/<!--[\s\S]*?-->/g, '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, text) =>
        text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));
    };
    const rootRels = zip.names.includes('_rels/.rels') ? relationships(read('_rels/.rels')) : new Map();
    const root = [...rootRels.values()].find(relation => relation.type === 'officeDocument')?.target || 'xl/workbook.xml';
    const folder = path.dirname(root);
    const workbook = read(root);
    const links = relationships(read(path.join(folder, '_rels', path.basename(root) + '.rels')), folder);
    const targetOf = type => [...links.values()].find(link => link.type === type)?.target;
    const stringsPart = targetOf('sharedStrings');
    const stylesPart = targetOf('styles');
    const strings = stringsPart ? Array.from(elements(read(stringsPart), 'si'), ([, , body]) => richText(body || '')) : [];
    const times = numberFormats(stylesPart ? read(stylesPart) : '');
    const budget = { remaining: MAX_GRID_CELLS };
    const sheets = [];
    for (const [, tag] of elements(workbook, 'sheet')) {
      const metadata = attributes(tag);
      const id = Object.entries(metadata).find(([name]) => name.endsWith(':id'))?.[1];
      const link = links.get(id);
      if (!link) throw new Error('missing sheet relationship');
      if (link.type !== 'worksheet') continue;
      const rows = sheetRows(read(link.target), strings, times, budget);
      sheets.push({ name: metadata.name || '', rows });
    }
    if (!sheets.length) throw new Error('missing worksheets');
    return sheets;
  } catch (error) {
    if (error.code === 'ZIP_TOO_LARGE' || error.message.startsWith('엑셀 표가 너무 커요')) {
      throw Object.assign(new Error('엑셀 표가 너무 커요. 필요한 시트와 셀만 남겨 다시 넣어 주세요.'), { code: 'ZIP_TOO_LARGE' });
    }
    throw Object.assign(new Error('엑셀(.xlsx) 파일을 읽지 못했어요. 엑셀에서 다시 저장해 주세요.'), { code: error.code });
  }
}

async function readXlsxTables(filePath) {
  return (await readXlsxSheets(filePath)).map(sheet => sheet.rows);
}

module.exports = { readXlsxSheets, readXlsxTables, decodeXml };
