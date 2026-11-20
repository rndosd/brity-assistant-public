'use strict';

// 브리티 인용 구분선: "Original Message"와 "---- 원본메시지 ----"(앞 따옴표·여러 가지 줄표 변형 포함).
const DASH = '-‐‑‒–—―－ㅡ';
const DIVIDER = new RegExp(`^[ \\t]*['"‘’]?[ \\t]*(?:[${DASH}]+[ \\t]*)?(?:원본[ \\t]*메시지|Original[ \\t]+Message)(?:[ \\t]*[${DASH}]+)?[ \\t]*$`, 'iu');
const HEADER_NAMES = { 발신자: 'Sender', 보낸사람: 'Sender', 발신시간: 'Date', 보낸시간: 'Date', 제목: 'Title', 수신자: 'To', 받는사람: 'To', 참조: 'Cc', 숨은참조: 'Bcc' };
const MORE_RECIPIENTS = /[,;]\s*$/;
const isAddressContinuation = line => line.trim().replace(/[,;]$/, '').split(/[,;]/)
  .every(address => /^[^<>]*<[^<>\s]+@[^<>\s]+>$/.test(address.trim()));

// 한국어 머리말(발 신 자 : …, 발신시간 : …)과 구분선을 영어 형식으로 맞춘다. 본문 줄은 그대로 둔다.
function normalizeHeaders(body) {
  let inHeaders = false;
  let recipientContinues = false;
  const lines = body.split(/\r\n|\r|\n/);
  return lines.map((line, index) => {
    if (DIVIDER.test(line)) {
      inHeaders = true;
      recipientContinues = false;
      return 'Original Message';
    }
    if (!inHeaders || !line.trim()) return line;
    if (recipientContinues && isAddressContinuation(line)) {
      recipientContinues = MORE_RECIPIENTS.test(line);
      return line;
    }
    const match = line.match(/^[ \t]*([가-힣 \t]+?)[ \t]*:[ \t]*(.*)$/);
    const header = match && HEADER_NAMES[match[1].replace(/[ \t]/g, '')];
    if (header) {
      recipientContinues = /^(?:To|Cc|Bcc)$/.test(header) && MORE_RECIPIENTS.test(match[2]);
      return `${header}: ${match[2]}`;
    }
    const alone = HEADER_NAMES[line.replace(/[ \t]/g, '')];
    if (alone && /^\s*:/.test(lines[index + 1] || '')) {
      recipientContinues = /^(?:To|Cc|Bcc)$/.test(alone) && MORE_RECIPIENTS.test(lines[index + 1]);
      return alone;
    }
    if (/^\s*(?:To|Cc|Bcc)\b/i.test(line)) recipientContinues = MORE_RECIPIENTS.test(line);
    if (/^\s*(?:Sender|Date|Title|To|Cc|Bcc)\b/i.test(line) || /^\s*:/.test(line) || /^\s*-{3,}\s*$/.test(line)) return line;
    inHeaders = false;
    return line;
  }).join('\n');
}

function splitReply(raw, { includeHeaders = false } = {}) {
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
      recipientContinues = /^(?:to|cc|bcc)$/.test(name) && MORE_RECIPIENTS.test(content);
      index += inline ? 1 : 2;
    } else if (recipientContinues && isAddressContinuation(line)) {
      if (includeHeaders) {
        const name = [...headers.keys()].at(-1);
        headers.set(name, headers.get(name) + ' ' + line.trim());
      }
      recipientContinues = MORE_RECIPIENTS.test(line);
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
    ...(includeHeaders ? {
      sender: headers.get('sender') || '',
      recipients: headers.get('to') || '',
      datetime: headers.get('date') || '',
    } : {}),
  };
}

// 원문 속 웹 주소를 찾는다(2026-11-17 사용자 "링크지원"). http(s)://와 www.만 링크로 본다.
// 한글이 바로 붙으면("…/view주소입니다") 거기서 끊고, 끝의 문장부호·짝 없는 닫는 괄호는 주소에서 뺀다.
const LINK = /(?:https?:\/\/|www\.)[^\s<>"'`가-힣ㄱ-ㅎㅏ-ㅣ「」『』【】〈〉《》]+/giu;
const TRAILING = /[.,;:!?…·'"’”)\]}>]$/u;
const PAIRS = { ')': '(', ']': '[', '}': '{' };

function trimLink(text) {
  let link = text;
  while (TRAILING.test(link)) {
    const last = link.at(-1);
    const open = PAIRS[last];
    if (open && link.split(open).length >= link.split(last).length) break;
    link = link.slice(0, -1);
  }
  return link;
}

// [{ text }, { text, url }] 순서로 나눈다. 링크가 없으면 글 한 조각.
function findLinks(text) {
  const source = String(text ?? '');
  const parts = [];
  let last = 0;
  for (const match of source.matchAll(LINK)) {
    const link = trimLink(match[0]);
    if (!/[a-z0-9-]\.[a-z]{2,}/iu.test(link)) continue;
    let url;
    try {
      url = new URL(/^www\./iu.test(link) ? `http://${link}` : link);
    } catch {
      continue;
    }
    if (!/^https?:$/u.test(url.protocol)) continue;
    if (match.index > last) parts.push({ text: source.slice(last, match.index) });
    parts.push({ text: link, url: url.href });
    last = match.index + link.length;
  }
  if (last < source.length || !parts.length) parts.push({ text: source.slice(last) });
  return parts;
}

if (typeof module !== 'undefined') module.exports = { splitReply, normalizeHeaders, findLinks };
