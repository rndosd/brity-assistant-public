'use strict';

// 개인 Anthropic API 키로 Claude에게 쪽지 한 건을 분류받는다(2026-11-15 사용자 "선택지를 더 주는 거잖아").
// 앱은 npm 패키지를 싣지 않으므로(전체 ZIP·패치는 앱 파일만 담는다) 공식 Messages API 형식을 그대로 부른다.
// 결과 모양은 ai-provider.js의 callOnce와 같다: { value } | { limit } | { timeout } | { status, retryAfter }.

const API_VERSION = '2026-10-21';

// Claude의 JSON 출력은 배열 길이 제한(maxItems)을 받지 않는다. 날짜 3개 제한은 받은 뒤에 지킨다.
// ["string", "null"] 같은 여러 타입은 anyOf로 바꿔 보낸다.
function claudeSchema(node) {
  if (Array.isArray(node)) return node.map(claudeSchema);
  if (!node || typeof node !== 'object') return node;
  const { maxItems, minItems, ...rest } = node;
  if (Array.isArray(rest.type)) {
    const { type, ...others } = rest;
    return { ...claudeSchema(others), anyOf: type.map(item => ({ type: item })) };
  }
  const out = {};
  for (const [key, value] of Object.entries(rest)) out[key] = key === 'enum' || key === 'required' ? value : claudeSchema(value);
  return out;
}

// 정리 기준(길고 매번 같음)은 system에 두고 캐시해, 여러 쪽지를 잇따라 분류할 때 비용을 줄인다. 쪽지 한 건은 user로 보낸다.
function splitInput(input) {
  const at = input.lastIndexOf('\n\n');
  return at > 0 ? [input.slice(0, at), input.slice(at + 2)] : ['', input];
}

function capDates(value) {
  return Array.isArray(value?.dates) && value.dates.length > 3 ? { ...value, dates: value.dates.slice(0, 3) } : value;
}

async function callClaude(provider, input, effort, schema, { apiKey, signal, fetchImpl, timeoutMs }) {
  const deadline = AbortSignal.timeout(timeoutMs);
  const execution = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const [rules, note] = splitInput(input);
  try {
    const response = await fetchImpl(provider.url, {
      method: 'POST',
      headers: { 'x-api-key': apiKey.trim(), 'anthropic-version': API_VERSION, 'content-type': 'application/json' },
      redirect: 'error',
      signal: execution,
      body: JSON.stringify({
        model: provider.model,
        max_tokens: provider.maxOutputTokens,
        ...(rules ? { system: [{ type: 'text', text: rules, cache_control: { type: 'ephemeral' } }] } : {}),
        messages: [{ role: 'user', content: note }],
        output_config: { effort, format: { type: 'json_schema', schema: claudeSchema(schema) } }
      })
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return { status: response.status, retryAfter: Number(response.headers?.get?.('retry-after')) || 0 };
    }
    const result = await response.json();
    if (result.stop_reason === 'max_tokens') return { limit: true };
    // 생각(thinking) 블록이 앞에 올 수 있으므로 text 블록을 찾는다.
    const text = result.content?.find(block => block.type === 'text')?.text;
    if (result.stop_reason === 'refusal' || typeof text !== 'string') throw new Error('No structured classification result');
    return { value: capDates(JSON.parse(text)) };
  } catch (error) {
    if (deadline.aborted && !signal?.aborted) return { timeout: true };
    throw error;
  }
}

module.exports = { callClaude, claudeSchema, API_VERSION };
