'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { feedbackAvailable, sendFeedback } = require('../feedback');

const form = { action: 'https://docs.google.com/forms/d/e/1FAIpQLSexample-ID/formResponse', message: 'entry.111', info: 'entry.222' };

test('의견 보내기는 구글 폼 주소와 항목 번호가 모두 있을 때만 켜진다', () => {
  assert.equal(feedbackAvailable({ action: '', message: '', info: '' }), false);
  assert.equal(feedbackAvailable(form), true);
  assert.equal(feedbackAvailable({ ...form, action: 'https://example.com/formResponse' }), false);
  assert.equal(feedbackAvailable({ ...form, info: 'entry.x' }), false);
});

test('의견과 앱 정보만 폼 형식으로 제출한다', async () => {
  let sent;
  await sendFeedback('  달력이 좋아요  ', '0.4.8 · 일반판', {
    form,
    fetchImpl: async (url, request) => { sent = { url, request }; return new Response('', { status: 200 }); }
  });
  assert.equal(sent.url, form.action);
  assert.equal(sent.request.method, 'POST');
  const body = new URLSearchParams(sent.request.body.toString());
  assert.deepEqual([...body.keys()], ['entry.111', 'entry.222']);
  assert.equal(body.get('entry.111'), '달력이 좋아요');
  assert.equal(body.get('entry.222'), '0.4.8 · 일반판');
});

test('빈 글은 보내지 않고, 실패 응답은 오류로 돌려준다', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return new Response('', { status: 500 }); };
  await assert.rejects(sendFeedback('   ', '', { form, fetchImpl }));
  assert.equal(calls, 0);
  await assert.rejects(sendFeedback('의견', '', { form, fetchImpl }));
  assert.equal(calls, 1);
});
