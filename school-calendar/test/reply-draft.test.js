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
const expected = intent.replace('가능하다고 해줘.', '가능합니다.');

function answerTo(input) {
  assert.ok(input.includes('약속'));
  assert.doesNotMatch(input, /김가람|한새롬|@example\.test|010-|private-file-path|가상 첨부/);
  const payload = JSON.parse(input.slice(input.lastIndexOf('\n\n') + 2));
  assert.match(payload.받은쪽지.latestBody, /금요일 오전/);
  assert.match(payload.하고싶은말, /월요일 3시 이후만/);
  return { reply: payload.하고싶은말.replace('가능하다고 해줘.', '가능합니다.') };
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
    assert.equal(result, expected);
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
  assert.equal(codex, expected);
  assert.equal(claude, expected);
});

test('입력이 없거나 쪽지 확인 전이면 보내지 않고, 입력한 연락처가 누락된 답은 표시하지 않는다', async () => {
  for (const value of ['', ' ', 'x'.repeat(2001)]) await assert.rejects(polishReply('codex', note, value), /2,000/);
  await assert.rejects(polishReply('none', note, intent), /AI를 먼저/);
  await assert.rejects(polishReply('openai', { ...note, verified: false }, intent), /원문/);
  await assert.rejects(polishReply('openai', note, intent, {
    apiKey: 'synthetic', fetchImpl: async () => Response.json({ status: 'completed', output: [{
      type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify({ reply: '월요일 가능합니다.' }) }]
    }] })
  }), /입력한 정보가 빠졌/);
});
