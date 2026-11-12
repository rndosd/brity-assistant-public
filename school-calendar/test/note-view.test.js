'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { splitReply } = require('../renderer/note-view');

test('브리티 회신에서 여러 줄 머리말을 접고 두 본문을 보여준다', () => {
  const raw = [
    '결과를 보냅니다.', '---------', ' Original Message', '---------',
    'Sender', ' : 샘플 <sender@example.test>', 'Date', ' : 2026-11-10',
    'Title', ' : 선거 안내', 'To', ' : 가상1 <one@example.test>,',
    '가상2 <two@example.test>', '문의는 샘플 <help@example.test>에 연락해 주세요.', '', '내일까지 회신 바랍니다.',
  ].join('\r\n');
  assert.deepEqual(splitReply(raw), {
    reply: '결과를 보냅니다.', subject: '선거 안내',
    message: '문의는 샘플 <help@example.test>에 연락해 주세요.\n\n내일까지 회신 바랍니다.',
  });
});

test('일반 쪽지나 머리말이 확실하지 않은 쪽지는 원문 그대로 표시할 수 있다', () => {
  assert.equal(splitReply('안녕하세요. 오늘 회의가 있습니다.'), null);
  assert.equal(splitReply('Original Message\nTitle: 일반 본문\n다음 내용'), null);
});
