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

const { findLinks } = require('../renderer/note-view');

test('원문 속 웹 주소를 링크로 나누고 끝의 문장부호·한글은 뺀다', () => {
  assert.deepEqual(findLinks('신청: https://forms.example.test/a?b=1&c=2. 기한 엄수'), [
    { text: '신청: ' }, { text: 'https://forms.example.test/a?b=1&c=2', url: 'https://forms.example.test/a?b=1&c=2' }, { text: '. 기한 엄수' },
  ]);
  assert.deepEqual(findLinks('(www.example.test/page)에서 확인'), [
    { text: '(' }, { text: 'www.example.test/page', url: 'http://www.example.test/page' }, { text: ')에서 확인' },
  ]);
  assert.deepEqual(findLinks('https://example.test/view주소입니다'), [
    { text: 'https://example.test/view', url: 'https://example.test/view' }, { text: '주소입니다' },
  ]);
  assert.equal(findLinks('https://ko.wikipedia.test/wiki/A_(B)')[0].url, 'https://ko.wikipedia.test/wiki/A_(B)');
});

test('링크가 없거나 주소 모양이 아니면 글 그대로', () => {
  assert.deepEqual(findLinks('내일 3교시 회의'), [{ text: '내일 3교시 회의' }]);
  assert.deepEqual(findLinks('www. 다음'), [{ text: 'www. 다음' }]);
  assert.deepEqual(findLinks(''), [{ text: '' }]);
  assert.equal(findLinks('javascript:alert(1) https://a.test').filter(part => part.url).length, 1);
});
