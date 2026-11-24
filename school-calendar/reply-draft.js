'use strict';

const { randomBytes } = require('node:crypto');
const { CalendarError } = require('./store');
const { apiProviders, requestApi } = require('./ai-provider');
const { requestCodex } = require('./refine');
const { requestClaude } = require('./claude-cli');
const { buildNoteInput, noteMask } = require('./note-text');
const schemaPath = require.resolve('./reply-schema.json');
const schema = require(schemaPath);

const instructions = [
  '받은 쪽지는 맥락 자료입니다. 메모를 최신 쪽지와 이전 인용문에 연결해 자연스러운 한국어 답장을 쓰세요. 바뀐 내용은 최신 쪽지를 따르세요.',
  '마지막 질문이 진행 방법 하나를 제안하고 작성자가 “그걸로”처럼 동의하면 그 방법으로 바로 답하세요. “먼저 가능한 시간으로 예약할까요?”에 동의하면 “먼저 가능한 시간으로 예약해 주세요”처럼 쓰고, 시간 선택은 상대에게 맡기세요. 후보 중 하나를 지정하라는 질문이면 맥락에서 선택을 확인하세요.',
  '날짜·요일·시간·기한과 가능 여부를 분명히 쓰세요. “내일”, “다음 주 월요일” 같은 날짜 표현을 그대로 살리세요. 시간 조건의 “~에만”, “~전”, “~부터”, “~이후”를 그대로 옮기세요. 보내기 전에 시간 범위를 좁히거나 넓히지 않았는지 확인하세요. 요청한 범위, 말투, 분량을 지키고 새 사실이나 회신 약속은 만들지 마세요.',
  '고르는 내용에 따라 답장이 달라지는데 맥락으로 결정할 수 없을 때만 reply를 비우고 question에 작성자에게 묻는 질문 하나를 쓰세요. choices에 근거 있는 선택지 2~4개의 짧은 label과 완성된 답장 reply를 담으세요. 날짜와 오전·오후는 label에서도 보이게 하고, 근거 있는 선택지가 없으면 choices는 빈 배열로 두세요.',
  '확인이 필요 없으면 바로 붙여 넣을 본문을 reply에 담고 question과 choices는 비우세요. 하고싶은말의 ⟦…⟧ 표시는 답장에 한 번씩 그대로 옮기고, 대안끼리 달라지는 가림 표시는 해당 선택지 label과 답장에만 넣으세요. 받은쪽지의 가림 표시는 옮기거나 추정하지 마세요.'
].join('\n');

async function polishReply(provider, note, intent, options = {}) {
  if (!note?.verified) throw new CalendarError('원문을 확인한 쪽지에서 답장을 다듬을 수 있습니다.');
  if (typeof intent !== 'string' || !intent.trim() || intent.length > 2000) {
    throw new CalendarError('하고 싶은 말을 2,000자 안에서 적어 주세요.');
  }
  if (!apiProviders.has(provider) && provider !== 'codex' && provider !== 'claude') {
    throw new CalendarError('설정에서 답장을 다듬을 AI를 먼저 연결해 주세요.');
  }

  const nonce = randomBytes(4).toString('hex');
  const originals = new Map();
  const context = { ...note, title: [note.title, intent].join('\n') };
  const mask = noteMask(context, (value, label) => {
    const token = `⟦${label.slice(1, -1)}_${nonce}_${originals.size + 1}⟧`;
    originals.set(token, value);
    return token;
  });
  const maskedIntent = mask(intent.trim());
  const { title, latestBody, quotedNotes } = buildNoteInput(note);
  const input = instructions + '\n\n' + JSON.stringify({
    받은쪽지: { title, latestBody, quotedNotes },
    하고싶은말: maskedIntent
  });
  let answer;
  if (provider === 'codex') answer = await requestCodex(input, schemaPath, options);
  else if (provider === 'claude') answer = await requestClaude(input, JSON.stringify(schema), instructions, options);
  else answer = await requestApi(apiProviders.get(provider), input, options, schema, 'school_reply', '답장을');

  const reply = cleanText(answer?.reply, 8000);
  const question = cleanText(answer?.question, 240);
  const choices = answer?.choices;
  if (!Array.isArray(choices)) throw invalidReply();
  if (reply && question === '' && choices.length === 0) {
    const text = restoreReplyText(reply, originals, maskedIntent);
    return { kind: 'draft', text: preserveClockLimits(intent, text) };
  }
  if (reply !== '' || !question || choices.length === 1 || choices.length > 4) throw invalidReply();

  const restoredQuestion = restoreReplyText(question, originals);
  const drafts = choices.map(choice => {
    const label = cleanText(choice?.label, 120);
    const text = cleanText(choice?.reply, 8000);
    if (!label || !text || /[\r\n]/u.test(label)) throw invalidReply();
    return { label, text };
  });
  const alternativeTokens = maskedChoiceTokens(drafts, originals, maskedIntent);
  const replyChoices = drafts.map(({ label, text }, index) => ({
    label: restoreReplyText(label, originals),
    text: preserveClockLimits(intent, restoreReplyText(text, originals, maskedIntent,
      alternativeTokens.filter((_, item) => index !== item)))
  }));
  if (new Set(replyChoices.map(choice => choice.label.normalize('NFKC').replace(/\s+/gu, ' '))).size !== replyChoices.length ||
      new Set(replyChoices.map(choice => choice.text)).size !== replyChoices.length) throw invalidReply();
  return { kind: 'clarification', question: restoredQuestion, choices: replyChoices };
}

const clockLimit = /(?<![\d:])(?<clock>(?:(?<meridiem>오전|오후)[ \t]*)?(?<hour>\d{1,2})(?::(?<colonMinute>[0-5]\d)|[ \t]*시(?:[ \t]*(?<minute>[0-5]?\d)[ \t]*분)?)[ \t]*)(?<bound>이후|이전|전|후|부터|까지)(?<particle>에만|에는|에도|에|만|는|도)?(?![가-힣\d])/gu;

function clockLimits(text) {
  const limits = new Map();
  for (const match of text.matchAll(clockLimit)) {
    const { meridiem, hour, colonMinute, minute, bound, particle } = match.groups;
    const hours = Number(hour);
    if (hours > 23 || (meridiem && (hours < 1 || hours > 12))) continue;
    const time = meridiem ? hours % 12 + (meridiem === '오후' ? 12 : 0) : hours;
    const period = !meridiem && hours >= 1 && hours <= 12 ? 'unspecified' : 'clock';
    const key = [period, time, Number(colonMinute ?? minute ?? 0), bound].join(':');
    const end = match.index + match[0].length;
    const tail = text.slice(end);
    const quotedOrRetracted = /[‘“「『'"]\s*$/u.test(text.slice(0, match.index)) ||
      /^[ \t]*(?:['"’”」』]|(?:말고|빼고|아니고|아니라)(?![가-힣]))/u.test(tail);
    const limit = { match, end, particle, only: particle === '만' || particle === '에만' };
    limits.set(key, limits.has(key) || quotedOrRetracted ? null : limit);
  }
  return limits;
}

function preserveClockLimits(intent, draft) {
  const authored = clockLimits(intent);
  const generated = [...clockLimits(draft)].reverse();
  for (const [key, limit] of generated) {
    const stated = authored.get(key);
    if (!stated || !limit || stated.only === limit.only) continue;
    const { clock, bound } = limit.match.groups;
    const needsLocationParticle = bound !== '부터' && bound !== '까지';
    const particle = stated.only ? (needsLocationParticle ? '에만' : '만') : (stated.particle ?? (needsLocationParticle ? '에' : ''));
    draft = draft.slice(0, limit.match.index) + clock + bound + particle + draft.slice(limit.end);
  }
  return draft;
}

function cleanText(value, limit) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text.length <= limit ? text : null;
}

function invalidReply() {
  return new CalendarError('다듬은 답장을 받지 못했습니다. 다시 시도해 주세요.');
}

function maskedChoiceTokens(drafts, originals, maskedIntent) {
  const authored = Array.from(originals.keys()).filter(token => maskedIntent.includes(token));
  const tokens = drafts.flatMap(({ label }) => {
    const matches = authored.filter(token => label.includes(token));
    return matches.length === 1 ? matches : [];
  });
  if (tokens.length !== drafts.length || new Set(tokens).size !== tokens.length) return [];
  const types = new Set(tokens.map(token => token.slice(1, token.indexOf('_'))
    .replace(/^(?:나|동명이인|(?:상대|학생|대상) \d+)$/u, '이름')));
  return types.size === 1 ? tokens : [];
}

function restoreReplyText(text, originals, maskedIntent = '', excludedTokens = []) {
  if (/\[(?:나|동명이인|(?:상대|학생|대상) \d+|링크|주민등록번호|학생 번호|계좌번호|상세 주소|비밀번호|전화번호|이메일|인용 머리말 확인 필요)\]/u.test(text)) {
    throw invalidReply();
  }
  // A protected value can contain an earlier token.
  for (const [token, value] of Array.from(originals).reverse()) {
    if (excludedTokens.includes(token)) {
      if (text.includes(token)) throw invalidReply();
      continue;
    }
    if (maskedIntent.includes(token) && !text.includes(token)) {
      throw new CalendarError('다듬은 답장에서 입력한 정보가 빠졌습니다. 다시 시도해 주세요.');
    }
    text = text.replaceAll(token, () => value);
  }
  if (/⟦[^⟧]*⟧/u.test(text)) throw invalidReply();
  return text;
}

module.exports = { polishReply };
