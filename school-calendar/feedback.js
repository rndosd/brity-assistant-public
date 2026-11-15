'use strict';

// 의견 보내기: 머리줄의 작은 칸에서 쓴 글을 개발자의 구글 폼으로 바로 제출한다(응답은 구글 시트에 쌓인다).
// 사용자는 구글 화면을 보지 않는다. 쪽지 원문·업무 내용은 보내지 않고, 화면에 보여 준 앱 정보만 붙인다.
// FORM.action이 비어 있으면 의견 단추를 숨긴다.
const FORM = {
  // 폼 “브리티 메신저 캘린더 의견”(2026-11-15). 응답은 폼 편집 화면의 응답 탭과 연결한 시트에서 본다.
  action: 'https://docs.google.com/forms/d/e/1FAIpQLSdtAOqZgYJ4d7CRvYItphKuhKTDv3xx1ShnqAa729V6-1IuAA/formResponse',
  message: 'entry.1744634059', // 의견(장문형)
  info: 'entry.1101122569' // 앱 정보(단답형)
};

const MAX_MESSAGE = 2000;

function feedbackAvailable(form = FORM) {
  return /^https:\/\/docs\.google\.com\/forms\/d\/e\/[\w-]+\/formResponse$/.test(form.action) && /^entry\.\d+$/.test(form.message) && /^entry\.\d+$/.test(form.info);
}

async function sendFeedback(message, info, { form = FORM, fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  const text = String(message ?? '').trim();
  if (!text) throw new Error('empty');
  const body = new URLSearchParams({ [form.message]: text.slice(0, MAX_MESSAGE), [form.info]: String(info ?? '').slice(0, 300) });
  const response = await fetchImpl(form.action, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) throw new Error(`status ${response.status}`);
  return true;
}

module.exports = { FORM, MAX_MESSAGE, feedbackAvailable, sendFeedback };
