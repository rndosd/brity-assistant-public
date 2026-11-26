'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { zipEntries } = require('./timetable-file');
const { scanXml, attributes } = require('./hwpx-text');

const MAX_FILE = 30 * 1024 * 1024;
const MAX_XML = 8 * 1024 * 1024;
const MAX_PART = 4 * 1024 * 1024;
const MAX_TEXT = 48_000;
const MAX_PAGES = 100;
const TOO_LARGE = '문서가 너무 크거나 내용이 많아요. 필요한 부분만 새 파일에 저장해 넣어 주세요.';
const ENCRYPTED = '암호가 걸린 문서예요. 열 수 있는 사본을 넣어 주세요.';

class DocumentError extends Error {}

function collectText(separator = '\n\n') {
  const sections = [];
  let length = 0;
  return {
    add(text) {
      const content = text.trim();
      if (!content) return;
      length += content.length + (sections.length ? separator.length : 0);
      if (length > MAX_TEXT) throw new DocumentError(TOO_LARGE);
      sections.push(content);
    },
    toString() { return sections.join(separator); }
  };
}

async function readFile(filePath) {
  const file = await fs.open(filePath, 'r');
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error('not a file');
    if (info.size > MAX_FILE) throw new DocumentError(TOO_LARGE);
    const data = new Uint8Array(info.size + 1);
    let offset = 0;
    while (offset < data.length) {
      const { bytesRead } = await file.read(data, offset, data.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== info.size) throw new Error('file changed while reading');
    return data.subarray(0, offset);
  } finally {
    await file.close();
  }
}

function readSlideOrder(zip, readXml) {
  const paths = new Map();
  const names = new Set(zip.names);
  scanXml(readXml('ppt/_rels/presentation.xml.rels'), { open(name, tag) {
    if (name !== 'Relationship') return;
    const { Id, Target, Type, TargetMode } = attributes(tag);
    if (TargetMode === 'External' || !Type?.endsWith('/slide') || !Target) return;
    const part = Target.startsWith('/') ? path.posix.normalize(Target).slice(1) : path.posix.join('ppt', Target);
    if (names.has(part)) paths.set(Id, part);
  } });
  const slides = [];
  scanXml(readXml('ppt/presentation.xml'), { open(name, tag) {
    if (name !== 'sldId') return;
    // Both the numeric slide ID and relationship ID have local name "id".
    const relationshipId = /\s[\w.-]+:id\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(tag);
    const slide = paths.get(relationshipId?.[1] ?? relationshipId?.[2]);
    if (!slide) throw new Error('missing slide relationship');
    slides.push(slide);
    if (slides.length > MAX_PAGES) throw new DocumentError(TOO_LARGE);
  } });
  if (!slides.length) throw new Error('no slide parts');
  return slides;
}

function slideText(xml) {
  const parts = [];
  let length = 0;
  let inText = false;
  let row = null;
  let cell = null;
  const add = value => {
    length += value.length;
    if (length > MAX_TEXT) throw new DocumentError(TOO_LARGE);
    (cell ?? parts).push(value);
  };
  scanXml(xml, {
    open(name) {
      if (name === 't') inText = true;
      else if (name === 'br') add('\n');
      else if (name === 'tr') row = [];
      else if (name === 'tc' && row) cell = [];
    },
    close(name) {
      if (name === 't') inText = false;
      else if (name === 'p') add('\n');
      else if (name === 'tc' && cell) {
        row.push(cell.join('').trim().replaceAll('\n', ' '));
        cell = null;
      } else if (name === 'tr' && row) {
        add(row.join('\t') + '\n');
        row = null;
      }
    },
    text(value) {
      if (inText) add(value);
    }
  });
  return parts.join('').replace(/\n{3,}/g, '\n\n').trim();
}

function readPptx(data) {
  const zip = zipEntries(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
  let remaining = MAX_XML;
  const readXml = name => {
    const xml = zip.read(name, Math.min(MAX_PART, remaining));
    remaining -= Buffer.byteLength(xml);
    if (!xml) throw new Error('missing presentation part');
    if (remaining < 0) throw new DocumentError(TOO_LARGE);
    return xml;
  };
  const result = collectText();
  for (const [index, slide] of readSlideOrder(zip, readXml).entries()) {
    const text = slideText(readXml(slide));
    if (text) result.add('[슬라이드 ' + (index + 1) + ']\n' + text);
  }
  return result.toString();
}

async function readXlsx(filePath) {
  const { readXlsxSheets } = require('./xlsx-tables');
  const result = collectText();
  for (const { name, rows } of await readXlsxSheets(filePath)) {
    const sheet = collectText('\n');
    for (const row of rows) {
      if (row.some(Boolean)) sheet.add(row.join('\t'));
    }
    const text = sheet.toString();
    if (text) result.add('[' + name + ']\n' + text);
  }
  return result.toString();
}

async function readPdf(data) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const root = path.dirname(require.resolve('pdfjs-dist/package.json'));
  const task = getDocument({
    data,
    cMapUrl: pathToFileURL(path.join(root, 'cmaps') + path.sep).href,
    cMapPacked: true,
    standardFontDataUrl: pathToFileURL(path.join(root, 'standard_fonts') + path.sep).href,
    disableFontFace: true,
    isEvalSupported: false,
    useWasm: false,
    useWorkerFetch: false,
    verbosity: 0
  });
  try {
    const doc = await task.promise;
    if (doc.numPages > MAX_PAGES) throw new DocumentError(TOO_LARGE);
    const result = collectText();
    for (let number = 1; number <= doc.numPages; number += 1) {
      const page = await doc.getPage(number);
      const reader = page.streamTextContent({ disableNormalization: true }).getReader();
      const pieces = [];
      let length = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          for (const item of value.items) {
            if (typeof item.str !== 'string') continue;
            const piece = item.str + (item.hasEOL ? '\n' : '');
            length += piece.length;
            if (length > MAX_TEXT) throw new DocumentError(TOO_LARGE);
            pieces.push(piece);
          }
        }
      } finally {
        await reader.cancel();
        page.cleanup();
      }
      const text = pieces.join('').trim();
      if (text) result.add('[' + number + '쪽]\n' + text);
    }
    return result.toString();
  } finally {
    await task.destroy();
  }
}

const labels = { '.xlsx': '엑셀(.xlsx)', '.pptx': '파워포인트(.pptx)', '.pdf': 'PDF' };

async function readDocumentText(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (!Object.hasOwn(labels, extension)) throw new DocumentError('엑셀(.xlsx), 파워포인트(.pptx), PDF 파일을 읽을 수 있어요.');
  try {
    const text = extension === '.xlsx' ? await readXlsx(filePath)
      : extension === '.pptx' ? readPptx(await readFile(filePath))
        : await readPdf(await readFile(filePath));
    if (text) return text;
    if (extension === '.pdf') {
      throw new DocumentError('PDF에서 선택할 수 있는 글을 찾지 못했어요. 스캔이나 사진은 첨부를 열어 확인해 주세요.');
    }
    throw new DocumentError(labels[extension] + ' 문서에서 읽을 수 있는 글을 찾지 못했어요. 첨부를 열어 원문을 확인해 주세요.');
  } catch (error) {
    if (error instanceof DocumentError) throw error;
    if (error.name === 'PasswordException' || error.code === 'ZIP_ENCRYPTED') throw new DocumentError(ENCRYPTED);
    if (error.code === 'ZIP_TOO_LARGE') throw new DocumentError(TOO_LARGE);
    if (extension === '.pdf' && error.code === 'ERR_MODULE_NOT_FOUND') {
      throw new DocumentError('PDF를 읽는 파일이 설치본에 없어요. 앱을 다시 설치한 뒤 시도해 주세요.');
    }
    throw new DocumentError(labels[extension] + ' 파일을 읽지 못했어요. 파일이 열리는지 확인한 뒤 다시 저장해 주세요.');
  }
}

module.exports = { readDocumentText };
