'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { zipEntries } = require('./timetable-file');

const MAX_FILE = 30 * 1024 * 1024;
const MAX_XML = 8 * 1024 * 1024;
const MAX_SECTION = 4 * 1024 * 1024;
const MAX_METADATA = 256 * 1024;
const MAX_TEXT = 48_000;
const MAX_TABLE_CELLS = 6_000;
const SECTION_NAME = /^Contents\/section(\d+)\.xml$/i;

const TOO_LARGE = '한글 문서가 너무 크거나 내용이 많아요. 필요한 부분만 새 한글 파일로 저장해 넣어 주세요.';
const ENCRYPTED = '암호가 걸린 한글 문서예요. 열 수 있는 사본이나 필요한 내용을 넣어 주세요.';
const INVALID = '한글(.hwpx) 파일을 읽지 못했어요. 한글에서 열리는지 확인한 뒤 다시 저장해 주세요.';

class HwpxError extends Error {}

function checkText(text) {
  if (text.length > MAX_TEXT) throw new HwpxError(TOO_LARGE);
  return text;
}

function xmlText(text) {
  return text.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi, (entity, code) => {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[code];
    if (named) return named;
    const value = code[1]?.toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
    return value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff) ? String.fromCodePoint(value) : entity;
  });
}

function attributes(tag) {
  const result = Object.create(null);
  for (const match of tag.matchAll(/\s([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    result[match[1].split(':').at(-1)] = xmlText(match[2] ?? match[3]);
  }
  return result;
}

// HWPX uses XML paragraphs and table controls. Processing here needs no DTD or external entities.
function scanXml(xml, { open, close, text }) {
  const token = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<\/?([A-Za-z_][\w:.-]*)(?:[^<>"']|"[^"]*"|'[^']*')*>|[^<]+/gy;
  const stack = [];
  let at = 0;
  while (at < xml.length) {
    const match = token.exec(xml);
    if (!match) throw new HwpxError(INVALID);
    at = token.lastIndex;
    const [tag, qualifiedName] = match;
    if (qualifiedName) {
      const name = qualifiedName.split(':').at(-1);
      if (tag.startsWith('</')) {
        if (stack.pop() !== qualifiedName) throw new HwpxError(INVALID);
        close?.(name);
      } else {
        open?.(name, tag);
        if (tag.endsWith('/>')) close?.(name);
        else if (stack.push(qualifiedName) > 128) throw new HwpxError(TOO_LARGE);
      }
    } else if (tag.startsWith('<![CDATA[')) text?.(tag.slice(9, -3));
    else if (!tag.startsWith('<') && text) text(xmlText(tag));
  }
  if (stack.length) throw new HwpxError(INVALID);
}

function sectionOrder(names, packageXml) {
  const sections = names.filter(name => SECTION_NAME.test(name)).sort((a, b) => Number(SECTION_NAME.exec(a)[1]) - Number(SECTION_NAME.exec(b)[1]));
  if (!packageXml) return sections;
  const sectionsByName = new Map(sections.map(name => [name.toLowerCase(), name]));
  const byId = new Map();
  const spine = [];
  scanXml(packageXml, { open(name, tag) {
    if (name === 'item') {
      const { id, href } = attributes(tag);
      if (!id || !href) return;
      const normalized = path.posix.normalize(href);
      const file = sectionsByName.get(normalized.toLowerCase()) ?? sectionsByName.get(path.posix.join('Contents', normalized).toLowerCase());
      if (file) byId.set(id, file);
    } else if (name === 'itemref') spine.push(attributes(tag).idref);
  } });
  const ordered = [...new Set(spine.map(id => byId.get(id)).filter(Boolean))];
  return ordered.length ? ordered : sections;
}

function tableText(rows, addCharacters) {
  const grid = new Map();
  let height = 0;
  let width = 0;
  let cellCharacters = 0;
  rows.forEach((row, rowIndex) => {
    let nextColumn = 0;
    for (const cell of row) {
      const y = cell.row ?? rowIndex;
      const x = cell.column ?? nextColumn;
      const spanRows = cell.spanRows ?? 1;
      const spanColumns = cell.spanColumns ?? 1;
      nextColumn = x + spanColumns;
      height = Math.max(height, y + spanRows);
      width = Math.max(width, nextColumn);
      if (height * width > MAX_TABLE_CELLS) throw new HwpxError(TOO_LARGE);
      const value = cell.parts.join('\n').trim();
      if (!value) continue;
      cellCharacters += value.length;
      const span = [spanRows > 1 ? `${y + 1}~${y + spanRows}행` : '', spanColumns > 1 ? `${x + 1}~${x + spanColumns}열` : ''].filter(Boolean).join(' ');
      if (!grid.has(y)) grid.set(y, new Map());
      if (grid.get(y).has(x)) throw new HwpxError(INVALID);
      grid.get(y).set(x, `${span ? `[${span}] ` : ''}${value.replace(/\|/g, '\\|').replace(/\n/g, ' <br> ')}`);
    }
  });
  if (!grid.size) return '';
  const line = values => `| ${values.join(' | ')} |`;
  const lines = Array.from({ length: height }, (_, row) => line(Array.from({ length: width }, (_, column) => grid.get(row)?.get(column) ?? '')));
  lines.splice(1, 0, line(Array(width).fill('---')));
  const rendered = lines.join('\n');
  addCharacters(rendered.length - cellCharacters);
  return rendered;
}

function sectionText(xml) {
  const scope = [{ name: 'sec', parts: [] }];
  const current = () => scope.at(-1);
  const append = value => {
    if (!value) return;
    if (current().name === 'p') current().parts.push('\n', value, '\n');
    else current().parts.push(value);
  };
  let inText = 0;
  let image = false;
  let characters = 0;
  const addCharacters = length => {
    characters += length;
    if (characters > MAX_TEXT) throw new HwpxError(TOO_LARGE);
  };
  const pushText = value => {
    addCharacters(value.length);
    current().parts.push(value);
  };
  scanXml(xml, {
    open(name, tag) {
      if (name === 'pic') image = true;
      if (name === 'p') scope.push({ name, parts: [] });
      else if (name === 'tbl') scope.push({ name, rows: [], cellCount: 0 });
      else if (name === 'tr' && current().name === 'tbl') {
        if (current().rows.length >= MAX_TABLE_CELLS) throw new HwpxError(TOO_LARGE);
        scope.push({ name, cells: [] });
      }
      else if (name === 'tc' && current().name === 'tr') scope.push({ name, parts: [] });
      else if (name === 't') inText += 1;
      else if (current().name === 'p' && name === 'lineBreak') pushText('\n');
      else if (current().name === 'p' && ['tab', 'fwSpace', 'nbSpace'].includes(name)) pushText(' ');
      else if (current().name === 'tc' && (name === 'cellAddr' || name === 'cellSpan')) {
        const attrs = attributes(tag);
        const numeric = key => /^\d{1,6}$/.test(attrs[key]) ? Number(attrs[key]) : undefined;
        if (name === 'cellAddr') Object.assign(current(), { row: numeric('rowAddr'), column: numeric('colAddr') });
        else Object.assign(current(), { spanRows: numeric('rowSpan') || 1, spanColumns: numeric('colSpan') || 1 });
      }
    },
    close(name) {
      if (name === 't') inText -= 1;
      if (current().name !== name || scope.length === 1) return;
      const frame = scope.pop();
      if (name === 'p') append(checkText(frame.parts.join('').replace(/\n{3,}/g, '\n\n').trim()));
      else if (name === 'tbl') append(tableText(frame.rows, addCharacters));
      else if (name === 'tr') current().rows.push(frame.cells);
      else if (name === 'tc') {
        const table = scope.at(-2);
        if (++table.cellCount > MAX_TABLE_CELLS) throw new HwpxError(TOO_LARGE);
        current().cells.push(frame);
      }
    },
    text(value) {
      if (inText && current().name === 'p') pushText(value);
    }
  });
  return { text: checkText(current().parts.join('\n\n')), image };
}

async function readArchive(filePath) {
  const file = await fs.open(filePath, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new HwpxError(INVALID);
    if (stat.size > MAX_FILE) throw new HwpxError(TOO_LARGE);
    // Read one extra byte to detect a size change without allocating an unbounded buffer.
    const data = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < data.length) {
      const { bytesRead } = await file.read(data, offset, data.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== stat.size) throw new HwpxError(INVALID);
    return zipEntries(data.subarray(0, offset));
  } finally {
    await file.close();
  }
}

async function readHwpxText(filePath) {
  try {
    const zip = await readArchive(filePath);
    const names = new Map(zip.names.map(name => [name.toLowerCase(), name]));
    const readMetadata = name => names.has(name) ? zip.read(names.get(name), MAX_METADATA) : '';
    scanXml(readMetadata('meta-inf/manifest.xml'), { open(name) {
      if (name === 'encryption-data') throw new HwpxError(ENCRYPTED);
    } });
    const sections = sectionOrder(zip.names, readMetadata('contents/content.hpf'));
    if (!sections.length) throw new HwpxError(INVALID);
    let remainingXml = MAX_XML;
    let text = '';
    let image = false;
    for (const name of sections) {
      const xml = zip.read(name, Math.min(remainingXml, MAX_SECTION));
      remainingXml -= Buffer.byteLength(xml);
      if (remainingXml < 0) throw new HwpxError(TOO_LARGE);
      const section = sectionText(xml);
      if (section.text) text = checkText(text ? `${text}\n\n${section.text}` : section.text);
      image ||= section.image;
    }
    if (text) return text;
    if (image) throw new HwpxError('그림만 들어 있어 본문과 표를 읽을 수 없어요. 첨부를 열어 원문을 확인해 주세요.');
    throw new HwpxError('한글 문서에서 읽을 수 있는 글을 찾지 못했어요.');
  } catch (error) {
    if (error instanceof HwpxError) throw error;
    if (error.code === 'ZIP_ENCRYPTED') throw new HwpxError(ENCRYPTED);
    if (error.code === 'ZIP_TOO_LARGE') throw new HwpxError(TOO_LARGE);
    throw new HwpxError(INVALID);
  }
}

module.exports = { readHwpxText, scanXml, attributes };
