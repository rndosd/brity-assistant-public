'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { findPersonalInfo, roster } = require('../privacy');

test('전화번호·주민번호·개인 메일·주소·학생 번호와 이름을 찾는다', () => {
  assert.deepEqual(findPersonalInfo('학부모 연락처 010-1234-5678로 연락 바랍니다.'), ['휴대전화 번호']);
  assert.deepEqual(findPersonalInfo('주민번호 120315-3123456 확인'), ['주민등록번호']);
  assert.deepEqual(findPersonalInfo('메일은 parent123@naver.com 입니다'), ['개인 이메일']);
  assert.deepEqual(findPersonalInfo('주소 ○○로 12, 101동 1203호'), ['집 주소']);
  assert.deepEqual(findPersonalInfo('3번 김민수 학생이 결석했습니다.'), ['학생 번호와 이름']);
  assert.deepEqual(findPersonalInfo('회장 박서연(12번)'), ['학생 번호와 이름']);
  assert.deepEqual(findPersonalInfo('농협 계좌 301-1234-5678-11로 입금'), ['계좌번호']);
});

test('학교 업무 메일, 교무실 번호, 날짜와 일반 안내는 개인정보로 보지 않는다', () => {
  const reply = 'Sender : 가상 교사 <teacher@gdp.goe.go.kr>\nDate : 2026-08-24 12:49\n교무실 031-123-4567\n2026.8.27.(목) 15시 도서실, 3번 안건 확인';
  assert.deepEqual(findPersonalInfo(reply), []);
  assert.deepEqual(findPersonalInfo('1번 학생부터 순서대로 나와 주세요. 9.3(목)까지 제출'), []);
});

test('우리 반 명단의 이름이 본문이나 첨부 이름에 있으면 찾는다', () => {
  const names = ['홍길동', ' 이서윤 ', 'x', '홍길동'];
  assert.deepEqual(roster(names), ['홍길동', '이서윤']);
  assert.deepEqual(findPersonalInfo(['임원 선거 결과입니다.', '결과(이서윤).hwpx'], names), ['우리 반 학생 이름']);
  assert.deepEqual(findPersonalInfo('임원 선거 결과입니다.', names), []);
});

test('명단 없이도 이름 후보와 조사·호칭이 붙은 이름을 찾는다', () => {
  for (const text of [
    '참석자: 김민수', '이서윤이 회신했습니다.', '홍길동에게 전달해 주세요.',
    '박서연입니다.', '김구 선생님께 확인해 주세요.', '황보혜정 학생',
    '상담_박서연.hwpx', '이서윤 학생의 상담 일정',
  ]) {
    assert.deepEqual(findPersonalInfo(text), ['이름으로 보이는 표현'], text);
    assert.deepEqual(findPersonalInfo(text), ['이름으로 보이는 표현'], '반복 검사도 같은 결과여야 한다');
  }
});

test('이름 후보 검사에서 일반 학교 안내와 조사가 붙은 업무 단어를 제외한다', () => {
  for (const text of [
    '전교생은 금요일 도서관에서 연수를 받습니다.',
    '개학일과 방학식 일정을 확인해 주세요.',
    '이름과 연락처를 입력해 주세요. 주민번호와 계좌번호는 필요 없습니다.',
    '가상 교사, 일반 안내, 오늘의 공지, 정보를 공유합니다.',
  ]) assert.deepEqual(findPersonalInfo(text), [], text);
});
