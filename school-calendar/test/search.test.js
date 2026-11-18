'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { searchMatches, searchSnippet } = require('../store');

const items = [
  { id: 'a', fields: [{ name: 'title', text: '현장체험학습 신청서 제출' }, { name: 'sender', text: '가상교무' }, { name: 'body', text: '안녕하세요.\n체험 학습 양식을 붙입니다.' }] },
  { id: 'b', fields: [{ name: 'title', text: '교실 게시물 정비' }, { name: 'attachment', text: '안내.hwpx\n게시물_양식.HWPX' }, { name: 'body', text: '게시물을 정비해 주세요.' }] },
  { id: 'c', fields: [{ name: 'title', text: '회의 안내' }, { name: 'room', text: '6학년 협의방' }] }
];

test('띄어쓰기·대소문자를 무시하고 업무 제목, 보낸 사람, 본문, 첨부, 대화방에서 찾는다', () => {
  assert.deepEqual(searchMatches(items, '체험 학습').map(hit => [hit.id, hit.field]), [['a', 'title']]);
  assert.deepEqual(searchMatches(items, '가상 교무').map(hit => [hit.id, hit.field]), [['a', 'sender']]);
  assert.deepEqual(searchMatches(items, '양식').map(hit => [hit.id, hit.field]), [['a', 'body'], ['b', 'attachment']]);
  assert.equal(searchMatches(items, '양식.hwpx')[0].attachment, '게시물_양식.HWPX');
  assert.deepEqual(searchMatches(items, '협의방').map(hit => hit.id), ['c']);
});

test('한 글자 이하는 찾지 않고, 개수 한도를 지킨다', () => {
  assert.deepEqual(searchMatches(items, '양'), []);
  assert.deepEqual(searchMatches(items, '  '), []);
  assert.equal(searchMatches(items, '정비', 1).length, 1);
});

test('한 쪽지의 보낸 사람·제목·떨어진 본문 단어를 순서와 무관하게 모두 찾는다', () => {
  const [hit] = searchMatches(items, '양식 가상교무 제출');
  assert.equal(hit.id, 'a');
  assert.equal(hit.field, 'body');
  assert.match(hit.snippet, /양식/);
  assert.deepEqual(searchMatches(items, '체험 신청서').map(item => item.id), ['a']);
  assert.deepEqual(searchMatches(items, '가상교무 게시물'), []);
});

test('서로 다른 첨부 파일의 경계를 가로질러 한 단어가 일치하지 않는다', () => {
  assert.deepEqual(searchMatches(items, 'hwpx게시물'), []);
  assert.equal(searchMatches(items, '정비 양식.hwpx')[0].attachment, '게시물_양식.HWPX');
});

test('본문 미리보기는 맞은 곳 앞뒤를 한 줄로 자른다', () => {
  const body = `${'가'.repeat(80)}\n체험 학습 양식\n${'나'.repeat(80)}`;
  const snippet = searchSnippet(body, '체험학습');
  assert.match(snippet, /^…가+ 체험 학습 양식 나+…$/);
  assert.ok(snippet.length < 100);
  assert.equal(searchSnippet('짧은 본문', '없는말'), '');
});
