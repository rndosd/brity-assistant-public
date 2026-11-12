'use strict';

// 브리티 인용 구분선: "Original Message"와 "---- 원본메시지 ----"(앞 따옴표·여러 가지 줄표 변형 포함).
const DASH = '-‐‑‒–—―－ㅡ';
const DIVIDER = new RegExp(`^[ \\t]*['"‘’]?[ \\t]*(?:[${DASH}]+[ \\t]*)?(?:원본[ \\t]*메시지|Original[ \\t]+Message)(?:[ \\t]*[${DASH}]+)?[ \\t]*$`, 'iu');
const HEADER_NAMES = { 발신자: 'Sender', 보낸사람: 'Sender', 발신시간: 'Date', 보낸시간: 'Date', 제목: 'Title', 수신자: 'To', 받는사람: 'To', 참조: 'Cc', 숨은참조: 'Bcc' };

// 한국어 머리말(발 신 자 : …, 발신시간 : …)과 구분선을 영어 형식으로 맞춘다. 본문 줄은 그대로 둔다.
function normalizeHeaders(body) {
  let inHeaders = false;
  const lines = body.split(/\r\n|\r|\n/);
  return lines.map((line, index) => {
    if (DIVIDER.test(line)) {
      inHeaders = true;
      return 'Original Message';
    }
    if (!inHeaders || !line.trim()) return line;
    const match = line.match(/^[ \t]*([가-힣 \t]+?)[ \t]*:[ \t]*(.*)$/);
    const header = match && HEADER_NAMES[match[1].replace(/[ \t]/g, '')];
    if (header) return `${header}: ${match[2]}`;
    const alone = HEADER_NAMES[line.replace(/[ \t]/g, '')];
    if (alone && /^\s*:/.test(lines[index + 1] || '')) return alone;
    if (/^\s*(?:Sender|Date|Title|To|Cc|Bcc)\b/i.test(line) || /^\s*:/.test(line) || /^\s*-{3,}\s*$/.test(line)) return line;
    inHeaders = false;
    return line;
  }).join('\n');
}

function splitReply(raw) {
  const lines = normalizeHeaders(raw).split('\n');
  const divider = lines.findIndex(line => /^\s*(?:-+\s*)?Original Message(?:\s*-+)?\s*$/i.test(line));
  if (divider < 0) return null;

  let previous = divider;
  if (previous && /^\s*-{3,}\s*$/.test(lines[previous - 1])) previous--;
  let index = divider + 1;
  while (index < lines.length && /^\s*(?:-{3,})?\s*$/.test(lines[index])) index++;

  const headers = new Map();
  let recipientContinues = false;
  while (index < lines.length) {
    const line = lines[index];
    const inline = line.match(/^\s*(Sender|Date|Title|To|Cc|Bcc)\s*:\s*(.*)$/i);
    const split = line.match(/^\s*(Sender|Date|Title|To|Cc|Bcc)\s*$/i);
    const value = split ? lines[index + 1]?.match(/^\s*:\s*(.*)$/) : null;
    if (inline || value) {
      const name = (inline || split)[1].toLowerCase();
      const content = (inline ? inline[2] : value[1]).trim();
      headers.set(name, content);
      recipientContinues = /^(?:to|cc|bcc)$/.test(name) && /[,;]$/.test(content);
      index += inline ? 1 : 2;
    } else if (recipientContinues && line.trim().replace(/[,;]$/, '').split(/[,;]/)
      .every(address => /^[^<>]*<[^<>\s]+@[^<>\s]+>$/.test(address.trim()))) {
      recipientContinues = /[,;]\s*$/.test(line);
      index++;
    } else {
      break;
    }
  }

  const message = lines.slice(index).join('\n').trim();
  if (headers.size < 2 || !message) return null;
  return {
    reply: lines.slice(0, previous).join('\n').trim(),
    subject: headers.get('title') || '',
    message,
  };
}

if (typeof module !== 'undefined') module.exports = { splitReply, normalizeHeaders };
