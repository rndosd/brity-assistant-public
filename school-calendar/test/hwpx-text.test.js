'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { deflateRawSync } = require('node:zlib');
const { readHwpxText } = require('../hwpx-text');

function fixtureZip(entries) {
  const entriesBytes = [];
  const directoryBytes = [];
  let offset = 0;
  let directorySize = 0;
  for (const { name, text, encrypted = false, stored = false, declaredSize } of entries) {
    const nameBytes = Buffer.from(name);
    const bytes = Buffer.from(text);
    const compressed = stored ? bytes : deflateRawSync(bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(encrypted ? 1 : 0, 6);
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(declaredSize ?? bytes.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(encrypted ? 1 : 0, 8);
    central.writeUInt16LE(stored ? 0 : 8, 10);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(declaredSize ?? bytes.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    entriesBytes.push(local, nameBytes, compressed);
    directoryBytes.push(central, nameBytes);
    offset += local.length + nameBytes.length + compressed.length;
    directorySize += central.length + nameBytes.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directorySize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...entriesBytes, ...directoryBytes, end]);
}

async function writeFixture(t, entries) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'calendar-hwpx-'));
  const file = path.join(dir, 'fixture.hwpx');
  t.after(async () => {
    await fs.unlink(file);
    await fs.rmdir(dir);
  });
  await fs.writeFile(file, fixtureZip(entries));
  return file;
}

const p = text => `<hp:p><hp:run><hp:t>${text}</hp:t></hp:run></hp:p>`;
const section = text => `<hs:sec xmlns:hs="section" xmlns:hp="paragraph">${text}</hs:sec>`;
const tableCell = (row, col, text, span = 1) => `<hp:tc><hp:subList>${p(text)}</hp:subList><hp:cellAddr colAddr='${col}' rowAddr='${row}'/><hp:cellSpan colSpan='${span}' rowSpan='1'/></hp:tc>`;

test('HWPX prose, table cells, and runs stay in source order, using the section spine', async t => {
  const table = `<hp:tbl><hp:tr>${tableCell(0, 0, '가상 일정', 2)}</hp:tr><hp:tr>${tableCell(1, 1, '12월 2일<hp:lineBreak/>16:35')}${tableCell(1, 0, '접수 마감')}</hp:tr></hp:tbl>`;
  const file = await writeFixture(t, [
    { name: 'Contents/section0.xml', text: section(p('마지막 절')) },
    { name: 'Contents/section2.xml', text: section(p('대상은 5학년 &amp; 담임') + table + p('<![CDATA[설명에 <기호>가 포함됨]]>')) },
    { name: 'Contents/content.hpf', stored: true, text: `<opf:package xmlns:opf="opf"><opf:manifest><opf:item id="first" href="section2.xml"/><opf:item id="last" href="Contents/section0.xml"/></opf:manifest><opf:spine><opf:itemref idref="first"/><opf:itemref idref="last"/></opf:spine></opf:package>` },
  ]);
  const text = await readHwpxText(file);
  assert.equal(text, '대상은 5학년 & 담임\n\n| [1~2열] 가상 일정 |  |\n| --- | --- |\n| 접수 마감 | 12월 2일 <br> 16:35 |\n\n설명에 <기호>가 포함됨\n\n마지막 절');
});

test('nested cells, split runs, and document numerals remain associated', async t => {
  const inner = `<hp:tbl><hp:tr>${tableCell(0, 0, '일정 ① | 12/9')}</hp:tr></hp:tbl>`;
  const first = `<hp:tc><hp:subList>${p('일정 안내')}${inner}${p('준비물')}</hp:subList><hp:cellAddr rowAddr="0" colAddr="0"/></hp:tc>`;
  const table = `<hp:tbl><hp:tr>${first}${tableCell(0, 1, '담임')}</hp:tr></hp:tbl>`;
  const file = await writeFixture(t, [{ name: 'Contents/section0.xml', text: section('<hp:p><hp:run><hp:t>다음</hp:t></hp:run><hp:run><hp:t> 달</hp:t></hp:run></hp:p>' + table) }]);
  const text = await readHwpxText(file);
  assert.match(text, /^다음 달\n\n\| 일정 안내 <br> .*일정 ①.*12\/9.*준비물 \| 담임 \|/);
});

test('image-only HWPX provides a route to read its content', async t => {
  const file = await writeFixture(t, [{ name: 'Contents/section0.xml', text: section('<hp:p><hp:run><hp:pic/></hp:run></hp:p>') }]);
  await assert.rejects(readHwpxText(file), /그림만.*원문을 확인/);
});

test('password-protected body XML is detected via ZIP flags or encryption manifest', async t => {
  const body = { name: 'Contents/section0.xml', text: section(p('보호됨')) };
  const encrypted = await writeFixture(t, [{ ...body, encrypted: true }]);
  const manifest = await writeFixture(t, [body, { name: 'META-INF/manifest.xml', text: `<manifest><entry><encryption-data/></entry></manifest>` }]);
  await assert.rejects(readHwpxText(encrypted), /암호/);
  await assert.rejects(readHwpxText(manifest), /암호/);
});

test('section and text limits reject the document without returning a partial result', async t => {
  const oversizedBody = await writeFixture(t, [{ name: 'Contents/section0.xml', text: section(p('가')), declaredSize: 4 * 1024 * 1024 + 1 }]);
  const oversizedText = await writeFixture(t, [
    { name: 'Contents/section0.xml', text: section(p('가'.repeat(24_000))) },
    { name: 'Contents/section1.xml', text: section(p('나'.repeat(24_000))) },
  ]);
  await assert.rejects(readHwpxText(oversizedBody), /너무 크거나/);
  await assert.rejects(readHwpxText(oversizedText), /너무 크거나/);
});

test('ZIP payloads with forged stored and deflated lengths fail closed', async t => {
  for (const stored of [false, true]) {
    const file = await writeFixture(t, [{ name: 'Contents/section0.xml', text: section(p('가상 공문')), stored, declaredSize: 2 }]);
    await assert.rejects(readHwpxText(file), /읽지 못했어요/);
  }
});
