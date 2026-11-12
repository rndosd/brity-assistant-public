'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');

const WINDOW = 5 * 60_000;
const CONTEXT_AGE = 24 * 60 * 60_000;
const CONTEXT_COUNT = 30;
const ROOM_FILE = /^[a-f0-9]{64}\.json$/;

function hash(text) {
  return createHash('sha256').update(text).digest('hex');
}

function checkpoint(message, count) {
  return { count, tail: hash(JSON.stringify([message.observedAt, message.text])) };
}

function* roomBatches(roomKey, roomTitle, messages, start, limit, now, processed) {
  if (start === limit) return;
  const firstRelevant = Math.max(0, start - CONTEXT_COUNT);
  const arrivals = [];
  for (let index = firstRelevant; index < limit; index++) {
    const message = messages[index];
    const at = typeof message?.observedAt === 'string' ? Date.parse(message.observedAt) : NaN;
    if (typeof message?.text !== 'string' || !Number.isFinite(at)) break;
    arrivals.push(at);
  }
  const validEnd = firstRelevant + arrivals.length;
  const arrival = index => arrivals[index - firstRelevant];
  while (start < validEnd) {
    const openedAt = arrival(start);
    const closesAt = openedAt + WINDOW;
    if (closesAt > now) break;
    let end = start + 1;
    while (end < validEnd && arrival(end) < closesAt && arrival(end) <= now) end++;
    let contextStart = start;
    while (contextStart > firstRelevant && start - contextStart < CONTEXT_COUNT &&
           arrival(contextStart - 1) >= openedAt - CONTEXT_AGE) contextStart--;
    const point = checkpoint(messages[end - 1], end);
    yield {
      id: hash(`${roomKey}:${point.count}:${point.tail}`), roomKey, roomTitle, progress: point, processed,
      context: messages.slice(contextStart, start), messages: messages.slice(start, end)
    };
    start = end;
  }
}

async function* readyChatBatches(directory, progress, now) {
  let files;
  try {
    files = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  for (const file of files) {
    if (!file.isFile() || !ROOM_FILE.test(file.name)) continue;
    let room;
    try {
      room = JSON.parse(await fs.readFile(path.join(directory, file.name), 'utf8'));
    } catch (error) {
      // A bad or temporarily unavailable journal does not hold up the other rooms.
      if (error instanceof SyntaxError || ['ENOENT', 'EBUSY', 'EPERM', 'EACCES'].includes(error.code)) continue;
      throw error;
    }
    if (room?.version !== 1 || typeof room.roomKey !== 'string' || hash(room.roomKey) + '.json' !== file.name ||
        typeof room.roomTitle !== 'string' || !Array.isArray(room.messages)) continue;
    const messages = room.messages;
    const roomKey = file.name.slice(0, -5);
    const saved = progress.get(roomKey);
    const start = saved?.count ?? 0;
    if (start > messages.length || (start && (!messages[start - 1] || checkpoint(messages[start - 1], start).tail !== saved.tail))) continue;
    let previousEnd = 0;
    for (const end of saved?.batchEnds ?? (start ? [start] : [])) {
      yield* roomBatches(roomKey, room.roomTitle, messages, previousEnd, end, Infinity, true);
      previousEnd = end;
    }
    yield* roomBatches(roomKey, room.roomTitle, messages, start, messages.length, now, false);
  }
}

module.exports = { readyChatBatches };
