'use strict';

const { CalendarError, aiStopError } = require('./store');
const { refineNote, buildClassifierInput } = require('./refine');
const { cleanReplyBody } = require('./note-text');
const schema = require('./refinement-schema.json');

const classifierSample = Object.freeze({
  title: '가상 연수 신청',
  sender: '시험용 발신자',
  datetime: '2030-05-01 09:00',
  body: '이 문장은 가짜 자료입니다. 가상 연수 신청서를 2030년 5월 10일까지 제출해 주세요.',
  attachmentNames: Object.freeze([])
});

const apiProviders = new Map([
  ['openai', {
    name: 'OpenAI API', url: 'https://api.openai.com/v1/responses', model: 'gpt-6-luna',
    maxOutputTokens: 4096,
    keySetting: 'openaiKeyEncrypted', keyPattern: /^sk-[A-Za-z0-9_-]{16,510}$/,
    limitMessage: '결제·사용 한도를 확인하거나 잠시 후 다시 시도해 주세요.'
  }],
  ['factchat', {
    name: '팩트챗 API', url: 'https://factchat-cloud.mindlogic.ai/v1/gateway/responses/', model: 'gpt-6-luna',
    maxOutputTokens: 6144,
    keySetting: 'factchatKeyEncrypted', keyPattern: /^baze_[A-Za-z0-9_-]{16,507}$/,
    limitMessage: '잠시 후 다시 시도해 주세요.'
  }]
]);

function apiError(status, { name, limitMessage }, failure) {
  switch (status) {
    case 401: return `${name} 키가 올바르지 않습니다. 발급한 키를 다시 확인해 주세요.`;
    case 402: return `${name} 크레딧이 부족합니다. 계정의 잔액을 확인해 주세요.`;
    case 403: return `${name}에서 요청을 거절했습니다. 키 권한과 모델 사용 권한을 확인해 주세요.`;
    case 429: return `${name} 사용 한도에 도달했습니다. ${limitMessage}`;
    default: return `${failure} 잠시 후 다시 시도해 주세요.`;
  }
}

// 출력 한도에 닿으면 추론 보통으로 한 번, 429·5xx 또는 시간 초과면 잠깐 쉬고 한 번 다시 부른다.
const REQUEST = Object.freeze({ effort: 'high', fallbackEffort: 'medium', timeoutMs: 90_000 });
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

async function callOnce(provider, input, effort, { apiKey, signal, fetchImpl }) {
  const deadline = AbortSignal.timeout(REQUEST.timeoutMs);
  const execution = signal ? AbortSignal.any([signal, deadline]) : deadline;
  try {
    const response = await fetchImpl(provider.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey.trim()}`, 'Content-Type': 'application/json' },
      redirect: 'error',
      signal: execution,
      body: JSON.stringify({
        model: provider.model, input, store: false,
        reasoning: { effort }, max_output_tokens: provider.maxOutputTokens,
        text: { format: { type: 'json_schema', name: 'school_note', strict: true, schema } }
      })
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return { status: response.status, retryAfter: Number(response.headers?.get?.('Retry-After')) || 0 };
    }
    const result = await response.json();
    if (result.status === 'incomplete' && result.incomplete_details?.reason === 'max_output_tokens') return { limit: true };
    const content = result.output?.filter(item => item.type === 'message' && item.role === 'assistant')
      .flatMap(item => item.content || []);
    const output = content?.find(item => item.type === 'output_text');
    if (result.status !== 'completed' || !output || content.some(item => item.type === 'refusal')) {
      throw new Error('No structured classification result');
    }
    return { value: JSON.parse(output.text) };
  } catch (error) {
    if (deadline.aborted && !signal?.aborted) return { timeout: true };
    throw error;
  }
}

async function refineApi(provider, note, { rulesPath, apiKey, signal, profile, fetchImpl = fetch, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const { name } = provider;
  if (typeof apiKey !== 'string' || !apiKey.trim()) {
    throw aiStopError(`AI 연결 설정에 ${name} 키를 먼저 등록해 주세요.`);
  }
  const failure = `${name}에서 정리를 받지 못했습니다.`;
  try {
    const input = await buildClassifierInput(note, rulesPath, profile);
    const options = { apiKey, signal, fetchImpl };
    let reply = await callOnce(provider, input, REQUEST.effort, options);
    if (reply.limit) reply = await callOnce(provider, input, REQUEST.fallbackEffort, options);
    else if (RETRY_STATUS.has(reply.status) || reply.timeout) {
      await wait(Math.max(3000, Math.min(10_000, (reply.retryAfter || 0) * 1000)));
      reply = await callOnce(provider, input, REQUEST.effort, options);
    }
    if (reply.value) return reply.value;
    if (reply.timeout) throw new CalendarError(`${name}가 ${REQUEST.timeoutMs / 1000}초 안에 응답하지 않았습니다. 다시 시도해 주세요.`);
    if (reply.limit) throw new CalendarError(`${failure} 답이 너무 길어 끝나지 않았습니다. 다시 시도해 주세요.`);
    const message = apiError(reply.status, provider, failure);
    throw [401, 402, 403].includes(reply.status) ? aiStopError(message) : new CalendarError(message);
  } catch (error) {
    if (error instanceof CalendarError) throw error;
    throw new CalendarError(`${failure} 연결을 확인한 뒤 다시 시도해 주세요.`);
  }
}

async function refineWithProvider(provider, note, options) {
  if (provider === 'codex') return refineNote(note, options);
  if (provider === 'claude') return require('./claude-cli').refineClaude(note, options);
  const connection = apiProviders.get(provider);
  if (!connection) throw aiStopError('설정에서 AI 연결 방식을 선택해 주세요.');
  return refineApi(connection, note, options);
}

module.exports = { apiProviders, classifierSample, refineWithProvider, cleanReplyBody };
