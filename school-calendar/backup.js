'use strict';

// 데이터 백업 ZIP 쓰기·읽기(7단계). 다른 설치물 없이 Node의 zlib만 쓴다.
// 백업 안: backup.json(판·만든 때), data/…(업무·설정·정리 기준·대화방), inbox/…(받은 쪽지·첨부).
const fs = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');

const MANIFEST = 'backup.json';
const KIND = 'school-calendar-backup';
const MAX_ENTRIES = 50_000;
const MAX_TOTAL = 4 * 1024 ** 3;

function dosTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((Math.max(1980, date.getFullYear()) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

// entries: [{ name: 'data/tasks.json', data: Buffer }]
function writeZip(entries, now = new Date()) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const { time, day } = dosTime(now);
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const packed = zlib.deflateRawSync(data);
    const stored = packed.length >= data.length;
    const body = stored ? data : packed;
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // 이름은 UTF-8
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(stored ? 0 : 8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + body.length;
    if (offset > 0xffffffff) throw new Error('Backup is too large');
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function safeEntryName(name) {
  if (typeof name !== 'string' || !name || name.length > 400 || name.includes('\\') || name.startsWith('/') || /[\u0000-\u001f:*?"<>|]/.test(name)) return false;
  const parts = name.split('/');
  return parts.every(part => part && part !== '.' && part !== '..' && !/[ .]$/.test(part));
}

function readZip(buffer) {
  const endAt = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (endAt < 0 || endAt + 22 > buffer.length) throw new Error('Not a zip file');
  const count = buffer.readUInt16LE(endAt + 10);
  const size = buffer.readUInt32LE(endAt + 12);
  let at = buffer.readUInt32LE(endAt + 16);
  if (count > MAX_ENTRIES || at + size > endAt) throw new Error('Invalid zip directory');
  const entries = [];
  let total = 0;
  for (let index = 0; index < count; index++) {
    if (buffer.readUInt32LE(at) !== 0x02014b50) throw new Error('Invalid zip entry');
    const method = buffer.readUInt16LE(at + 10);
    const crc = buffer.readUInt32LE(at + 16);
    const packedSize = buffer.readUInt32LE(at + 20);
    const plainSize = buffer.readUInt32LE(at + 24);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const localAt = buffer.readUInt32LE(at + 42);
    const name = buffer.toString('utf8', at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith('/')) continue;
    if (!safeEntryName(name)) throw new Error('Unsafe entry name');
    if (buffer.readUInt32LE(localAt) !== 0x04034b50) throw new Error('Invalid local header');
    const start = localAt + 30 + buffer.readUInt16LE(localAt + 26) + buffer.readUInt16LE(localAt + 28);
    const packed = buffer.subarray(start, start + packedSize);
    total += plainSize;
    if (total > MAX_TOTAL) throw new Error('Backup is too large');
    let data;
    if (method === 0) data = Buffer.from(packed);
    else if (method === 8) data = zlib.inflateRawSync(packed, { maxOutputLength: Math.max(1, plainSize) });
    else throw new Error('Unsupported compression');
    if (data.length !== plainSize || zlib.crc32(data) !== crc) throw new Error('Damaged entry');
    entries.push({ name, data });
  }
  return entries;
}

// 폴더 안 파일을 prefix/상대경로 이름으로 모은다. skip(이름)이 참이면 뺀다.
async function collectFolder(root, prefix, skip = () => false) {
  const entries = [];
  async function walk(folder, relative) {
    let items;
    try {
      items = await fs.readdir(folder, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    for (const item of items) {
      const rel = relative ? `${relative}/${item.name}` : item.name;
      if (skip(rel, item)) continue;
      const full = path.join(folder, item.name);
      if (item.isDirectory()) await walk(full, rel);
      else if (item.isFile()) entries.push({ name: `${prefix}/${rel}`, data: await fs.readFile(full) });
    }
  }
  await walk(root, '');
  return entries;
}

module.exports = { writeZip, readZip, collectFolder, safeEntryName, MANIFEST, KIND };
