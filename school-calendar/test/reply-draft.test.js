'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { polishReply } = require('../reply-draft');
const replySchema = require('../reply-schema.json');

const note = {
  title: '가상 일정 문의', sender: '김가람 <test@example.test>', recipients: '한새롬', verified: true,
  body: '김가람 선생님입니다. 금요일 오전에 전화 가능하신가요? 010-0000-0000',
  attachments: [{ name: '가상 첨부.pdf', path: 'private-file-path' }]
};
const intent = '김가람 선생님께 금요일은 어렵고 월요일 3시 이후만 가능하다고 해줘. 연락은 sample@example.test 또는 010-1234-5678.';
const expected = { kind: 'draft', text: intent.replace('가능하다고 해줘.', '가능합니다.') };

function answerTo(input) {
  assert.ok(input.includes('약속'));
  assert.doesNotMatch(input, /김가람|한새롬|@example\.test|010-|private-file-path|가상 첨부/);
  const payload = JSON.parse(input.slice(input.lastIndexOf('\n\n') + 2));
  assert.match(payload.받은쪽지.latestBody, /금요일 오전/);
  assert.match(payload.하고싶은말, /월요일 3시 이후만/);
  return { reply: payload.하고싶은말.replace('가능하다고 해줘.', '가능합니다.'), question: '', choices: [] };
}

for (const provider of ['openai', 'factchat', 'anthropic']) {
  test(`${provider} 답장은 내 말을 가려 보내고 편집할 본문에 입력한 연락처와 이름을 복원한다`, async () => {
    const result = await polishReply(provider, note, intent, {
      apiKey: 'synthetic-test', fetchImpl: async (_url, options) => {
        const body = JSON.parse(options.body);
        const anthropic = provider === 'anthropic';
        const input = anthropic ? body.system[0].text + '\n\n' + body.messages[0].content : body.input;
        assert.deepEqual(anthropic ? body.output_config.format.schema : body.text.format.schema, replySchema);
        const text = JSON.stringify(answerTo(input));
        return Response.json(anthropic
          ? { stop_reason: 'end_turn', content: [{ type: 'text', text }] }
          : { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] });
      }
    });
    assert.deepEqual(result, expected);
  });
}

test('구독 Codex와 Claude Code는 답장 스키마와 가려진 입력으로 답장만 반환한다', async () => {
  const codex = await polishReply('codex', note, intent, {
    resolveExecutable: async () => 'mock-codex.exe',
    run: async (_exe, args, { input }) => {
      assert.equal(path.basename(args[args.indexOf('--output-schema') + 1]), 'reply-schema.json');
      return [
        { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(answerTo(input)) } },
        { type: 'turn.completed' }
      ].map(event => JSON.stringify(event)).join('\n');
    }
  });
  const claude = await polishReply('claude', note, intent, {
    claudeExecutable: process.execPath,
    run: async (_exe, args, { input }) => {
      assert.deepEqual(JSON.parse(args[args.indexOf('--json-schema') + 1]), replySchema);
      assert.match(args[args.indexOf('--system-prompt') + 1], /답장/);
      return { code: 0, output: JSON.stringify({ structured_output: answerTo(input) }) };
    }
  });
  assert.deepEqual(codex, expected);
  assert.deepEqual(claude, expected);
});

test('입력이 없거나 쪽지 확인 전이면 보내지 않고, 입력한 연락처가 누락된 답은 표시하지 않는다', async () => {
  for (const value of ['', ' ', 'x'.repeat(2001)]) await assert.rejects(polishReply('codex', note, value), /2,000/);
  await assert.rejects(polishReply('none', note, intent), /AI를 먼저/);
  await assert.rejects(polishReply('openai', { ...note, verified: false }, intent), /원문/);
  await assert.rejects(polishReply('openai', note, intent, {
    apiKey: 'synthetic', fetchImpl: async () => Response.json({ status: 'completed', output: [{
      type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify({ reply: '월요일 가능합니다.', question: '', choices: [] }) }]
    }] })
  }), /입력한 정보가 빠졌/);
});

test('시간과 경계가 같은 답장에서만 작성자가 붙인 만을 살리거나 덧붙은 만을 뺀다', async () => {
  const examples = [
    ['오후 2시 20분 이후에만 도착 가능.', '14:20 이후에 도착할 수 있습니다.', '14:20 이후에만 도착할 수 있습니다.'],
    ['오후 2시 20분 이후 도착 가능.', '오후 2시 20분 이후에만 도착할 수 있습니다.', '오후 2시 20분 이후에 도착할 수 있습니다.'],
    ['오전 11시 전에만 통화 가능.', '오전 11시 전에는 통화할 수 있습니다.', '오전 11시 전에만 통화할 수 있습니다.'],
    ['오후 4시까지만 상담 가능.', '오후 4시까지 상담 가능합니다.', '오후 4시까지만 상담 가능합니다.'],
    ['15:30부터 통화 가능.', '오후 3시 30분부터만 통화할 수 있습니다.', '오후 3시 30분부터 통화할 수 있습니다.'],
    ['오후 2시 이후에만 방문 가능.', '오전 2시 이후에 방문 가능합니다.', '오전 2시 이후에 방문 가능합니다.'],
    ['오후 2시 이후에만 방문 가능.', '오후 2시 전에는 방문 가능합니다.', '오후 2시 전에는 방문 가능합니다.'],
    ['월요일 오후 2시 이후에만, 화요일 오후 2시 이후에도 가능.', '월요일 오후 2시 이후에 가능합니다.', '월요일 오후 2시 이후에 가능합니다.'],
    ['오후 2시 이후에만 말고 다른 시간도 괜찮다고.', '오후 2시 이후에도 가능합니다.', '오후 2시 이후에도 가능합니다.'],
    ['오후 2시 이후에만 방문 가능.', '월요일 오후 2시 이후 방문, 화요일 오후 2시 이후 통화 가능합니다.', '월요일 오후 2시 이후 방문, 화요일 오후 2시 이후 통화 가능합니다.']
  ];
  for (const [message, reply, text] of examples) {
    const answer = codexReply(() => ({ reply, question: '', choices: [] }));
    assert.deepEqual(await polishReply('codex', note, message, answer), { kind: 'draft', text }, message);
  }
});

test('고른 선택지의 답장마다 공통 시간 제한을 보존한다', async () => {
  const answer = codexReply(() => ({
    reply: '',
    question: '어느 요일로 답할까요?',
    choices: [
      { label: '월요일', reply: '월요일 오후 3시 이후에 갈 수 있습니다.' },
      { label: '화요일', reply: '화요일 오후 3시 이후에 갈 수 있습니다.' }
    ]
  }));
  const result = await polishReply('codex', note, '그날로 하고 오후 3시 이후에만 갈 수 있다고.', answer);
  assert.deepEqual(result.choices.map(choice => choice.text), [
    '월요일 오후 3시 이후에만 갈 수 있습니다.',
    '화요일 오후 3시 이후에만 갈 수 있습니다.'
  ]);
});

function codexReply(answer) {
  return {
    resolveExecutable: async () => 'mock-codex.exe',
    run: async (_exe, _args, { input }) => [
      { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(answer(input)) } },
      { type: 'turn.completed' }
    ].map(event => JSON.stringify(event)).join('\n')
  };
}

test('확인이 필요한 경우 초안 없이 선택지와 작성자 연락처를 복원한 답장을 돌려준다', async () => {
  const result = await polishReply('codex', note, '그 시간으로 부탁해요. 연락은 reply-qa@example.test로 주세요.', codexReply(input => {
    const payload = JSON.parse(input.slice(input.lastIndexOf('\n\n') + 2));
    const email = payload.하고싶은말.match(/⟦이메일_[^⟧]+⟧/u)[0];
    assert.doesNotMatch(input, /reply-qa@example\.test/u);
    return {
      reply: '', question: '어느 시간으로 답할까요?',
      choices: [
        { label: '월요일 오후 3시', reply: `월요일 오후 3시 가능합니다. 연락은 ${email}로 주세요.` },
        { label: '화요일 오전 10시', reply: `화요일 오전 10시 가능합니다. 연락은 ${email}로 주세요.` }
      ]
    };
  }));
  assert.deepEqual(result, {
    kind: 'clarification', question: '어느 시간으로 답할까요?',
    choices: [
      { label: '월요일 오후 3시', text: '월요일 오후 3시 가능합니다. 연락은 reply-qa@example.test로 주세요.' },
      { label: '화요일 오전 10시', text: '화요일 오전 10시 가능합니다. 연락은 reply-qa@example.test로 주세요.' }
    ]
  });
});

test('입력한 주소 두 개가 각 선택지에 있으면 고른 주소와 공통 연락처만 복원한다', async () => {
  const message = 'first-choice@example.test와 second-choice@example.test 중 그 주소로 보내 달라고 하고, 연락은 010-0000-1001로.';
  const answer = (input, valid) => {
    const [first, second] = input.match(/⟦이메일_[^⟧]+⟧/gu);
    const phone = input.match(/⟦전화번호_[^⟧]+⟧/u)[0];
    return {
      reply: '', question: '어느 주소로 받을까요?',
      choices: [
        { label: first, reply: `${first}로 보내 주세요. 전화는 ${phone}입니다.` },
        { label: second, reply: valid ? `${second}로 보내 주세요. 전화는 ${phone}입니다.` : `${second}로 보내 주세요.` }
      ]
    };
  };
  const result = await polishReply('codex', note, message, codexReply(input => answer(input, true)));
  assert.deepEqual(result.choices, [
    { label: 'first-choice@example.test', text: 'first-choice@example.test로 보내 주세요. 전화는 010-0000-1001입니다.' },
    { label: 'second-choice@example.test', text: 'second-choice@example.test로 보내 주세요. 전화는 010-0000-1001입니다.' }
  ]);
  await assert.rejects(polishReply('codex', note, message, codexReply(input => answer(input, false))), /입력한 정보가 빠졌/);
});

test('확인 질문에 붙은 별도 초안, 중복 선택지와 원문 가림 표시는 편집할 결과가 되지 않는다', async () => {
  const choice = { label: '오전', reply: '오전에 가능합니다.' };
  const clarification = { reply: '', question: '언제로 답할까요?', choices: [] };
  for (const answer of [
    { ...clarification, reply: '오전에 가능합니다.' },
    { ...clarification, choices: [choice, { ...choice, reply: '오전으로 부탁드립니다.' }] },
    { ...clarification, choices: [choice, { label: '오후', reply: '[상대 1] 선생님, 오후에 가능합니다.' }] }
  ]) {
    await assert.rejects(polishReply('codex', note, '그 시간으로 해주세요.', codexReply(() => answer)), /답장을 받지 못했습니다/);
  }
  assert.deepEqual(await polishReply('codex', note, '그 시간으로 해주세요.', codexReply(() => clarification)), {
    kind: 'clarification', question: '언제로 답할까요?', choices: []
  });
});
