'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { readDocumentText } = require('../document-text');

async function fixture(t, extension, contents) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'calendar-document-'));
  const file = path.join(folder, '가상 일정.' + extension);
  t.after(async () => {
    await fs.unlink(file);
    await fs.rmdir(folder);
  });
  await fs.writeFile(file, contents);
  return file;
}

function zip(files) {
  const payload = [];
  const directory = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const filename = Buffer.from(name);
    const data = Buffer.from(text);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(filename.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE(offset, 42);
    payload.push(local, filename, data);
    directory.push(central, filename);
    offset += local.length + filename.length + data.length;
  }
  const entries = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(directory.length / 2, 8);
  end.writeUInt16LE(directory.length / 2, 10);
  end.writeUInt32LE(entries.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...payload, entries, end]);
}

function pdf(stream) {
  const content = text => '<< /Length ' + Buffer.byteLength(text) + ' >>\nstream\n' + text + '\nendstream';
  const cmap = '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CMapType 2 def\n'
    + '1 begincodespacerange\n<00> <FF>\nendcodespacerange\n'
    + '4 beginbfchar\n<41> <AC00>\n<42> <2460>\n<43> <2212>\n<44> <B098>\nendbfchar\n'
    + 'endcmap\nCMapName currentdict /CMap defineresource pop\nend end';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /ToUnicode 6 0 R >>',
    content(stream),
    content(cmap)
  ];
  let result = '%PDF-1.4\n';
  const offsets = objects.map((object, index) => {
    const offset = Buffer.byteLength(result);
    result += (index + 1) + ' 0 obj\n' + object + '\nendobj\n';
    return offset;
  });
  const xref = Buffer.byteLength(result);
  result += 'xref\n0 ' + (objects.length + 1) + '\n0000000000 65535 f \n';
  for (const offset of offsets) result += String(offset).padStart(10, '0') + ' 00000 n \n';
  result += 'trailer\n<< /Size ' + (objects.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
  return result;
}

test('PDF preserves Unicode punctuation and symbols from the document text layer', async t => {
  const file = await fixture(t, 'PDF', pdf('BT /F1 12 Tf 10 200 Td <41424344> Tj ET'));
  assert.equal(await readDocumentText(file), '[1쪽]\n가①−나');
});

test('PDF with drawn content and no text explains the scan limitation', async t => {
  const file = await fixture(t, 'pdf', pdf('0 0 10 10 re f'));
  await assert.rejects(readDocumentText(file), /선택할 수 있는 글.*스캔이나 사진/);
});

test('PPTX follows presentation order and preserves split runs, symbols, and table columns', async t => {
  const paragraph = text => '<a:p><a:r><a:t>' + text + '</a:t></a:r></a:p>';
  const cell = text => '<a:tc><a:txBody>' + paragraph(text) + '</a:txBody></a:tc>';
  const slide = text => '<p:sld xmlns:p="presentation" xmlns:a="drawing">' + text + '</p:sld>';
  const files = {
    'ppt/presentation.xml': '<p:presentation xmlns:p="presentation" xmlns:r="relationships"><p:sldIdLst><p:sldId id="301" r:id="two"/><p:sldId id="302" r:id="one"/></p:sldIdLst></p:presentation>',
    'ppt/_rels/presentation.xml.rels': '<Relationships><Relationship Id="one" Type="relationships/slide" Target="slides/slide1.xml"/><Relationship Id="two" Type="relationships/slide" Target="slides/slide2.xml"/></Relationships>',
    'ppt/slides/slide1.xml': slide(paragraph('마지막 슬라이드')),
    'ppt/slides/slide2.xml': slide(
      '<a:p><a:r><a:t>② 안내 &amp;</a:t></a:r><a:r><a:t> 일정</a:t></a:r></a:p>'
      + '<a:tbl><a:tr>' + cell('12/9(수)') + cell('3×4 − ①') + '</a:tr></a:tbl>'
    )
  };
  const file = await fixture(t, 'pptx', zip(files));
  assert.equal(await readDocumentText(file), '[슬라이드 1]\n② 안내 & 일정\n12/9(수)\t3×4 − ①\n\n[슬라이드 2]\n마지막 슬라이드');
});

test('XLSX attachment includes sheet labels, cells, and symbols', async t => {
  const file = await fixture(t, 'xlsx', zip({
    'xl/workbook.xml': '<workbook xmlns:r="relationships"><sheets><sheet name="가상 &amp; 일정" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Type="relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>① 신청</t></is></c><c r="B1" t="inlineStr"><is><t>3×4 − ①</t></is></c></row><row r="2"><c r="A2"><v>14</v></c></row></sheetData></worksheet>'
  }));
  assert.equal(await readDocumentText(file), '[가상 & 일정]\n① 신청\t3×4 − ①\n14');
});

test('oversized and damaged attachments fail with readable guidance', async t => {
  const large = await fixture(t, 'pptx', '');
  await fs.truncate(large, 30 * 1024 * 1024 + 1);
  await assert.rejects(readDocumentText(large), /문서가 너무 크/);
  const broken = await fixture(t, 'pdf', 'bad data');
  await assert.rejects(readDocumentText(broken), /PDF 파일을 읽지 못했어요/);
});
