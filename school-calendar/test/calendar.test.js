'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { test } = require('node:test');
const { CalendarStore } = require('../store');
const chatDecisions = require('../chat-decisions');
const { buildWorkPrompt } = require('../work-prompt');

const qaRoot = path.join(__dirname, '..', '.qa');
const noteId = '0_202611100000000001_0';
const otherId = '0_202611100000000002_0';

async function setup(t) {
  await fs.mkdir(qaRoot, { recursive: true });
  const root = await fs.mkdtemp(path.join(await fs.realpath(qaRoot), 'store-test-'));
  t.after(async () => {
    if (await fs.realpath(root) === root && path.dirname(root) === await fs.realpath(qaRoot)) {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  const inboxDir = path.join(root, 'inbox');
  const dataDir = path.join(root, 'data');
  const ruleSeed = path.join(root, 'rules.md');
  const notes = path.join(inboxDir, 'notes');
  await fs.mkdir(notes, { recursive: true });
  await fs.writeFile(ruleSeed, '# 정리 기준\n');
  const makeStore = async (options = {}) => {
    const store = new CalendarStore({ dataDir, inboxDir, ruleSeed, ...options });
    await store.init();
    return store;
  };
  return { root, inboxDir, dataDir, notes, makeStore };
}

const note = (id, overrides = {}) => ({
  id, title: '시험 쪽지', sender: '가상 발신자', datetime: '2026-11-10 08:00',
  verified: true, body: '<b>시험 원문</b>\n둘째 줄', saved: [], ...overrides,
});
const writeNote = (notes, row) => fs.writeFile(path.join(notes, `${row.id}.json`), '\uFEFF' + JSON.stringify(row));

test('숨긴 쪽지를 재실행 뒤 되돌려도 저장한 날짜와 마감 완료 상태가 남는다', async (t) => {
  const { makeStore, notes } = await setup(t);
  await writeNote(notes, note(noteId));
  const store = await makeStore();
  await store.refresh();
  const [task] = store.snapshot().tasks;
  const dates = [
    { date: '2026-11-14', kind: '까지', label: '가상 제출', done: true },
    { date: '2026-11-15', kind: '기간', end: '2026-11-17', label: '가상 운영' }
  ];
  await store.update(task.id, { dates });
  const hidden = await store.update(task.id, { type: '없음', dates: [] });
  assert.equal(hidden.type, '없음');
  assert.deepEqual(hidden.dates, dates);
  const reopened = await makeStore();
  const restored = await reopened.update(task.id, { type: '할 일' });
  assert.equal(restored.type, '할 일');
  assert.deepEqual(restored.dates, dates);
});

test('없음으로 분류된 쪽지의 원래 제목과 읽음 상태를 업무 변경 및 재시작 뒤에도 보존한다', async (t) => {
  const { makeStore, notes } = await setup(t);
  await writeNote(notes, note(noteId, { title: '분류 전 원래 제목' }));
  const store = await makeStore();
  await store.refresh();
  const [task] = store.snapshot().tasks;
  await store.update(task.id, { title: '바뀐 업무 제목', type: '없음', dates: [], revision: task.revision });
  const beforeOpen = store.snapshot();
  assert.deepEqual(beforeOpen.messages, [{
    kind: 'note', id: task.id, title: '분류 전 원래 제목', source: '가상 발신자', at: '2026-11-10 08:00', unread: true,
    type: '없음', recipients: null
  }]);
  assert.equal((await store.detail(task.id)).note.body, note(noteId).body);
  await Promise.all([store.markMessageSeen('note', task.id), store.markMessageSeen('note', task.id)]);
  assert.deepEqual(store.snapshot().tasks, beforeOpen.tasks);

  const reopened = await makeStore();
  await reopened.refresh();
  assert.deepEqual(reopened.snapshot().messages, [{ ...beforeOpen.messages[0], unread: false }]);
  assert.equal(reopened.snapshot().tasks[0].type, '없음');
});

test('검증 실패한 쪽지는 정확한 본문으로 교체한 뒤 직접 열어야 읽음으로 기록할 수 있다', async (t) => {
  const { makeStore, notes } = await setup(t);
  await writeNote(notes, note(noteId, { verified: false, body: '확인되지 않은 본문' }));
  const store = await makeStore();
  await store.refresh();
  const [message] = store.snapshot().messages;
  assert.equal((await store.detail(message.id)).note.verified, false);
  await assert.rejects(store.markMessageSeen('note', message.id), /원문을 확인하지 못했습니다/);

  await writeNote(notes, note(noteId, { body: '검증된 본문' }));
  await store.refresh();
  assert.deepEqual(store.snapshot().messages, [message]);
  assert.equal((await store.detail(message.id)).note.body, '검증된 본문');
  await store.markMessageSeen('note', message.id);
  assert.equal(store.snapshot().messages[0].unread, false);
});

test('할 일이 없는 이전 대화 묶음도 보이고, 늦게 들어온 대화와 기존 읽음 상태를 보존한다', async (t) => {
  const { makeStore, dataDir } = await setup(t);
  const chats = path.join(dataDir, 'chats');
  await fs.mkdir(chats, { recursive: true });
  const roomKey = 'trial-room';
  const journalKey = createHash('sha256').update(roomKey).digest('hex');
  const start = Date.parse('2026-11-10T08:00:00+09:00');
  const now = minutes => start + minutes * 60_000;
  const message = (minutes, text) => ({ observedAt: new Date(now(minutes)).toISOString(), text });
  const greeting = message(0, '감사합니다!');
  const request = message(3, '참석 여부를 회신해 주세요.');
  const tail = createHash('sha256').update(JSON.stringify([greeting.observedAt, greeting.text])).digest('hex');
  await fs.writeFile(path.join(dataDir, 'tasks.json'), JSON.stringify({
    version: 1, tasks: [], chatProgress: { [journalKey]: { count: 1, tail } }
  }));
  await fs.writeFile(path.join(chats, `${journalKey}.json`), JSON.stringify({
    version: 1, roomKey, roomTitle: '시험 대화방', messages: [greeting]
  }));

  const store = await makeStore();
  await store.refreshChat(now(7));
  assert.equal(store.snapshot().tasks.length, 0);
  const [greetingBatch] = store.snapshot().messages;
  assert.equal(greetingBatch.title, '시험 대화방');
  assert.equal(greetingBatch.unread, true);
  assert.equal('messages' in greetingBatch, false);
  assert.deepEqual(store.chatBatch(greetingBatch.id).messages, [greeting]);
  await store.markMessageSeen('chat', greetingBatch.id);

  await fs.writeFile(path.join(chats, `${journalKey}.json`), JSON.stringify({
    version: 1, roomKey, roomTitle: '시험 대화방', messages: [greeting, request]
  }));
  const reopened = await makeStore();
  await reopened.refreshChat(now(9));
  const [replyBatch, readBatch] = reopened.snapshot().messages;
  assert.equal(replyBatch.unread, true);
  assert.deepEqual(readBatch, { ...greetingBatch, unread: false });
  const [reply] = reopened.snapshot().tasks;
  assert.equal(reply.type, '할 일');
  assert.deepEqual(reply.dates, []);
  assert.equal(reply.chatSource.batchId, replyBatch.id);
  assert.deepEqual((await reopened.detail(reply.id)).batch.messages, [request]);
  const again = await makeStore();
  await again.refreshChat(now(10));
  assert.deepEqual(again.snapshot().messages.map(batch => batch.id), [replyBatch.id, greetingBatch.id]);
  assert.equal(again.snapshot().tasks.length, 1);
});

test('전달 글은 글마다 표시하고, 같은 원문 줄은 재실행하거나 저장을 반복해도 한 업무에 연결한다', async (t) => {
  const { makeStore, dataDir } = await setup(t);
  const chats = path.join(dataDir, 'chats');
  await fs.mkdir(chats, { recursive: true });
  const roomKey = 'forwarded-trial';
  const start = Date.parse('2026-11-10T08:00:00+09:00');
  const observedAt = new Date(start).toISOString();
  const first = '회의 전달\r\n  1. 교실\r\n   이어지는 설명\r\n\r\n2) 사진\r\n① 자료\r\n• 안내\r\n- 환경';
  const second = '알림장 초안\n① 알림장\n② 생존수영\n③ 장소\n④ 버스\n⑤ 준비물';
  const texts = ['1. 사진\n2. 책\n3. 안내\n4. 게시', '- 교실\n- 자료', first, second];
  const file = `${createHash('sha256').update(roomKey).digest('hex')}.json`;
  await fs.writeFile(path.join(chats, file), JSON.stringify({
    version: 1, roomKey, roomTitle: '전달 글 시험방', messages: texts.map(text => ({ observedAt, text }))
  }));

  const store = await makeStore();
  await store.refreshChat(start + 5 * 60_000);
  assert.equal(store.snapshot().tasks.length, 0);
  const [batch] = store.snapshot().messages;
  assert.equal(batch.forwardedReviewed, false);
  assert.deepEqual(batch.forwarded.map(item => [item.messageIndex, item.lines.length]), [[2, 5], [3, 5]]);
  assert.deepEqual(batch.forwarded[0].lines[0], {
    lineIndex: 1, endLineIndex: 3, text: '  1. 교실\n   이어지는 설명', taskId: null
  });
  assert.deepEqual(store.chatBatch(batch.id).messages.map(item => item.text), texts);
  const draft = { type: '알아 둘 것', title: '수영 준비물 확인', dates: [] };
  await assert.rejects(store.acceptForwardedLine(batch.id, 0, 0, draft), /올릴 줄을 다시/);
  await assert.rejects(store.acceptForwardedLine(batch.id, 2, 2, draft), /올릴 줄을 다시/);

  const [saved, repeated] = await Promise.all([
    store.acceptForwardedLine(batch.id, 3, 5, draft),
    store.acceptForwardedLine(batch.id, 3, 5, { ...draft, title: '두 번째 등록 시도' })
  ]);
  assert.equal(saved.id, repeated.id);
  assert.equal(repeated.title, draft.title);
  assert.deepEqual(saved.forwardedSource, { batchId: batch.id, messageIndex: 3, lineIndex: 5 });
  assert.deepEqual((await store.detail(saved.id)).batch.forwarded[1].lines[4], { lineIndex: 5, endLineIndex: 6, text: '⑤ 준비물' });
  await store.reviewForwardedBatch(batch.id);

  const reopened = await makeStore();
  await reopened.refreshChat(start + 5 * 60_000);
  const [reopenedBatch] = reopened.snapshot().messages;
  assert.equal(reopenedBatch.forwardedReviewed, true);
  assert.equal(reopenedBatch.unread, false);
  assert.equal(reopenedBatch.forwarded[1].lines[4].taskId, saved.id);
  assert.equal((await reopened.acceptForwardedLine(batch.id, 3, 5, draft)).id, saved.id);
  const due = { kind: '까지', date: '2026-11-13', label: '수영 안내 확인', done: false };
  const remaining = await reopened.acceptForwardedLine(batch.id, 3, 2, { type: '할 일', title: '수영 안내 확인', dates: [due] });
  assert.equal(remaining.type, '할 일');
  assert.deepEqual(remaining.dates, [due]);
  assert.equal(reopened.snapshot().tasks.length, 2);
});

test('묶음 정리 끝은 확인한 후보와 원문만 처리하고 같은 방의 다른 묶음은 남긴다', async (t) => {
  const { makeStore, dataDir } = await setup(t);
  const chats = path.join(dataDir, 'chats');
  await fs.mkdir(chats, { recursive: true });
  const roomKey = 'finish-forwarded';
  const start = Date.parse('2026-11-10T08:00:00+09:00');
  const file = `${createHash('sha256').update(roomKey).digest('hex')}.json`;
  const messages = [
    { observedAt: new Date(start).toISOString(), text: '- 교실\n- 게시판\n- 자료를 제출해 주세요.\n- 준비물\n- 운동장' },
    { observedAt: new Date(start + 600_000).toISOString(), text: '신청서는 11월 13일까지 제출해 주세요.' }
  ];
  await fs.writeFile(path.join(chats, file), JSON.stringify({ version: 1, roomKey, roomTitle: '정리 시험방', messages }));

  const store = await makeStore();
  await store.refreshChat(start + 1_200_000);
  const first = store.snapshot().messages.find(message => message.forwarded?.length);
  const candidate = store.snapshot().tasks.find(task => task.chatSource?.batchId === first.id);
  const other = store.snapshot().tasks.find(task => task.chatSource?.batchId !== first.id);
  assert.equal(first.roomKey, other.chatSource.roomKey);
  await assert.rejects(store.finishChatBatch(first.id, []), /남은 후보가 달라졌습니다/);
  assert.equal(store.snapshot().messages.find(message => message.id === first.id).forwardedReviewed, false);

  await store.finishChatBatch(first.id, [candidate.id]);
  const reopened = await makeStore();
  await reopened.refreshChat(start + 1_200_000);
  const snapshot = reopened.snapshot();
  const reviewed = snapshot.messages.find(message => message.id === first.id);
  assert.equal(reviewed.forwardedReviewed, true);
  assert.equal(reviewed.unread, false);
  assert.equal(snapshot.tasks.find(task => task.id === candidate.id).candidate.discarded, true);
  assert.equal(snapshot.tasks.find(task => task.id === other.id).candidate.discarded, false);
  assert.equal((await reopened.restoreCandidate(candidate.id)).candidate.discarded, false);
});

test('대화 후보 분석에 실패해도 전달 원문을 올릴 수 있고 실패한 묶음을 다시 분석한다', async (t) => {
  const { makeStore, dataDir } = await setup(t);
  const chats = path.join(dataDir, 'chats');
  await fs.mkdir(chats, { recursive: true });
  const roomKey = 'forwarded-retry';
  const start = Date.parse('2026-11-10T08:00:00+09:00');
  const text = '- 교실\n- 게시판\n- 자료를 제출해 주세요.\n- 준비물\n- 운동장';
  const message = { observedAt: new Date(start).toISOString(), text };
  const file = `${createHash('sha256').update(roomKey).digest('hex')}.json`;
  await fs.writeFile(path.join(chats, file), JSON.stringify({ version: 1, roomKey, roomTitle: '실패 시험방', messages: [message] }));

  const store = await makeStore();
  const extractor = t.mock.method(chatDecisions, 'extractChatDecisions', () => { throw new Error('후보 분석 시험 오류'); });
  await assert.rejects(store.refreshChat(start + 5 * 60_000), /후보 분석 시험 오류/);
  assert.equal(store.chatProgress.size, 0);
  const [batch] = store.snapshot().messages;
  assert.equal(batch.forwarded[0].lines.length, 5);
  const saved = await store.acceptForwardedLine(batch.id, 0, 3, { type: '할 일', title: '준비물', dates: [] });
  extractor.mock.restore();
  await store.refreshChat(start + 5 * 60_000);
  assert.equal(store.chatProgress.size, 1);
  const recovered = store.snapshot();
  assert.deepEqual(recovered.tasks.find(task => task.candidate).candidate.evidence, [0]);
  assert.equal(recovered.messages[0].forwarded[0].lines.length, 5);
  assert.equal(recovered.messages[0].forwarded[0].lines[3].taskId, saved.id);
});

test('첫 가져오기 설정은 재실행 뒤에도 남고, 수동을 선택하면 쪽지만 자동 갱신을 끈다', async (t) => {
  const { makeStore } = await setup(t);
  const store = await makeStore();
  await store.saveCollectorConnection(store.inboxDir, { firstImport: true });
  assert.equal(store.snapshot().collectorConnected, true);
  assert.equal(store.snapshot().collectorFirstImportPending, true);
  const reopened = await makeStore();
  assert.equal(reopened.snapshot().collectorFirstImportPending, true);
  const finished = await reopened.finishCollectorFirstImport(false);
  assert.equal(finished.collectorFirstImportPending, false);
  assert.equal(finished.autoRefresh.notes.enabled, false);
  assert.equal(finished.autoRefresh.chats.enabled, true);
  const persisted = (await makeStore()).snapshot();
  assert.equal(persisted.collectorFirstImportPending, false);
  assert.equal(persisted.autoRefresh.notes.enabled, false);
});

test('팩트챗 연결은 암호화된 키를 저장하고 자동 분류를 켜며 화면에 키를 보내지 않는다', async (t) => {
  const { makeStore } = await setup(t);
  const store = await makeStore();
  await store.saveAiConnection('openai', 'openai-ciphertext');
  await store.setAutomatic(true);

  const view = await store.saveAiConnection('factchat', 'factchat-ciphertext');
  const reopened = await makeStore();
  assert.equal(view.aiProvider, 'factchat');
  assert.equal(view.automatic, true);
  assert.equal(JSON.stringify(view).includes('ciphertext'), false);
  assert.equal(reopened.settings.factchatKeyEncrypted, 'factchat-ciphertext');
  assert.equal(reopened.settings.openaiKeyEncrypted, undefined);

  await reopened.saveAiConnection('none');
  const off = await makeStore();
  assert.equal(off.settings.factchatKeyEncrypted, undefined);
  assert.equal(off.settings.automatic, false);
});

test('대화방 묶음(한 번 가져온 새 글)은 바로 후보로 남고, 올린 업무의 변경·취소는 선생님이 고른 업무에만 반영한다', async (t) => {
  const { dataDir, makeStore } = await setup(t);
  const chats = path.join(dataDir, 'chats');
  await fs.mkdir(chats, { recursive: true });
  const base = Date.parse('2026-11-11T00:00:00Z');
  const now = minutes => base + minutes * 60_000;
  const chat = (minutes, text) => ({ observedAt: new Date(now(minutes)).toISOString(), text });
  async function journal(roomTitle, messages) {
    const key = createHash('sha256').update(roomTitle).digest('hex');
    await fs.writeFile(path.join(chats, `${key}.json`), JSON.stringify({
      version: 1, roomTitle, roomKey: roomTitle, fingerprints: [], messages
    }));
  }
  const room = '시험 회의방';
  const conversation = [
    chat(0, '연구부 회의는 11월 18일 오후 2시 어떨까요?'),
    ...Array.from({ length: 7 }, () => chat(2, '감사합니다!'))
  ];
  await journal(room, conversation);
  await journal('다른 시험방', [chat(1, '그럼 확정입니다.')]);
  const store = await makeStore();
  const manual = await store.create({ title: '직접 입력한 시험 업무', due: '2026-11-12' });
  const chatTasks = instance => instance.snapshot().tasks.filter(task => task.chatSource);
  // 기다리지 않고 바로 처리한다(묶음은 같은 때 가져온 글).
  await store.refreshChat(now(2));
  assert.deepEqual(chatTasks(store), []);
  assert.equal(store.chatProgress.size, 2);
  await store.refreshChat(now(6));
  assert.deepEqual(chatTasks(store), []);
  assert.deepEqual([...store.chatProgress.values()].map(point => point.count).sort(), [1, 8]);

  conversation.push(chat(7, '그럼 그 시간으로 확정하겠습니다.'));
  await journal(room, conversation);
  const restarted = await makeStore();
  await restarted.refreshChat(now(7));
  const [meeting] = chatTasks(restarted);
  assert.equal(chatTasks(restarted).length, 1);
  assert.equal(meeting.title, '연구부 회의');
  assert.deepEqual(meeting.dates, [{ date: '2026-11-18', label: '연구부 회의', kind: '그날' }]);
  assert.equal(meeting.chatSource.time, '14:00');
  assert.equal(meeting.chatSource.action, 'confirmed');
  // 대화방에서 찾은 일은 바로 업무가 되지 않고 후보로 남는다. 근거 글은 묶음 안 순번.
  assert.deepEqual(meeting.candidate, { suggestedType: '할 일', evidence: [0], change: false, targetId: null, discarded: false });
  await assert.rejects(restarted.update(meeting.id, { type: '할 일' }), /올리기나 버리기/);
  await assert.rejects(restarted.setDone(meeting.id, true), /먼저 올려/);
  assert.equal((await restarted.detail(meeting.id)).note, null);
  await restarted.acceptCandidate(meeting.id, { type: '할 일', revision: meeting.revision });
  assert.equal(chatTasks(restarted)[0].candidate, undefined);

  conversation.push(chat(13, '연구부 회의는 11월 19일 오후 3시로 변경되었습니다.'));
  await journal(room, conversation);
  const commit = restarted.commit.bind(restarted);
  restarted.commit = async () => { throw new Error('simulated write failure'); };
  await assert.rejects(restarted.refreshChat(now(18)), /simulated write failure/);
  assert.equal(chatTasks(restarted).length, 1);
  restarted.commit = commit;
  await Promise.all([restarted.refreshChat(now(18)), restarted.refreshChat(now(18))]);
  // 올린 업무는 그대로 두고 변경 후보를 따로 만든다(짐작한 앞 업무를 targetId로).
  const [kept, change] = chatTasks(restarted);
  assert.equal(chatTasks(restarted).length, 2);
  assert.equal(kept.id, meeting.id);
  assert.equal(kept.dates[0].date, '2026-11-18');
  assert.equal(change.dates[0].date, '2026-11-19');
  assert.equal(change.candidate.change, true);
  assert.equal(change.candidate.targetId, meeting.id);
  assert.equal(change.chatSource.previousDue, '2026-11-18');
  assert.deepEqual((await restarted.detail(change.id)).roomTasks.map(item => [item.id, item.suggested]), [[meeting.id, true]]);
  const changed = await restarted.applyCandidateChange(change.id, meeting.id);
  assert.equal(changed.dates[0].date, '2026-11-19');
  assert.equal(changed.chatSource.previousDue, '2026-11-18');
  assert.equal(chatTasks(restarted).length, 1);

  conversation.push(chat(19, '연구부 회의는 취소되었습니다.'));
  await journal(room, conversation);
  const finished = await makeStore();
  await finished.refreshChat(now(24));
  await finished.refreshChat(now(25));
  const cancelCandidate = chatTasks(finished)[1];
  assert.equal(chatTasks(finished).length, 2);
  assert.equal(cancelCandidate.chatSource.action, 'cancelled');
  assert.equal(cancelCandidate.candidate.targetId, meeting.id);
  const cancelled = await finished.applyCandidateChange(cancelCandidate.id, meeting.id);
  assert.equal(chatTasks(finished).length, 1);
  assert.deepEqual(cancelled.dates, []);
  assert.equal(cancelled.chatSource.action, 'cancelled');
  assert.equal(cancelled.chatSource.previousDue, '2026-11-19');
  assert.equal(cancelled.done, true);
  assert.equal((await finished.detail(manual.id)).task.title, manual.title);
  assert.equal(finished.nextAutomatic(), null);

  conversation.push(
    chat(26, '연구부 회의는 11월 25일 오후 2시로 확정합니다.'),
    chat(26, '연구부 회의는 11월 26일 오후 2시로 확정합니다.'),
    chat(26, '연구부 회의는 11월 25일 오후 2시로 확정합니다.')
  );
  await journal(room, conversation);
  await finished.refreshChat(now(31));
  const firstDate = task => task.dates[0]?.date ?? null;
  assert.deepEqual(chatTasks(finished).map(firstDate), [null, '2026-11-25', '2026-11-26']);
  // 묶음의 남은 후보 버리기 → 숨긴 것(되살릴 수 있음). 같은 말이 다시 와도 다시 묻지 않는다.
  const batchId = chatTasks(finished)[1].chatSource.batchId;
  await finished.discardCandidates({ batchId });
  assert.deepEqual(chatTasks(finished).slice(1).map(task => [task.type, task.candidate.discarded]), [['없음', true], ['없음', true]]);
  const restored = await finished.restoreCandidate(chatTasks(finished)[2].id);
  assert.equal(restored.type, '할 일');
  assert.equal(restored.candidate.discarded, false);
  const asReference = await finished.acceptCandidate(restored.id, { type: '알아 둘 것' });
  assert.equal(asReference.type, '알아 둘 것');

  conversation.push(
    chat(32, '연구부 회의는 11월 27일 오후 2시로 확정합니다.'),
    chat(32, '연구부 회의는 11월 27일에서 11월 28일 오후 3시로 변경되었습니다.')
  );
  await journal(room, conversation);
  await finished.refreshChat(now(37));
  assert.deepEqual(chatTasks(finished).map(firstDate), [null, '2026-11-25', '2026-11-26', '2026-11-28']);
  // 같은 묶음 안에서 날짜가 바뀐 새 후보는 변경 후보가 아니라 그 후보를 고친다.
  assert.equal(chatTasks(finished).at(-1).chatSource.previousDue, '2026-11-27');
  assert.equal(chatTasks(finished).at(-1).candidate.change, false);

  // 고른 결과는 이 PC에 쌓인다.
  const choices = (await fs.readFile(path.join(dataDir, 'chat-choices.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line).chosen);
  assert.deepEqual(choices, ['할 일', '변경 반영', '취소 반영', '버림', '버림', '되살림', '알아 둘 것']);
});

test('수집 중이던 파일을 다음 읽기에서 추가하고 재시작 뒤에도 업무를 한 건씩 보존한다', async (t) => {
  const { makeStore, notes } = await setup(t);
  await writeNote(notes, note(noteId, { verified: false }));
  await fs.writeFile(path.join(notes, `${otherId}.json`), '{');
  const store = await makeStore();
  await store.refresh();
  await store.create({ title: '직접 등록', due: '2026-11-13' });
  const initial = await store.snapshot();
  assert.equal(initial.tasks.length, 2);
  const imported = initial.tasks.find((task) => task.noteId === noteId);
  assert.deepEqual(imported.dates, []);
  const detail = await store.detail(imported.id);
  assert.equal(detail.note.body, note(noteId).body);
  assert.equal(detail.note.verified, false);
  await writeNote(notes, note(otherId));
  await Promise.all([store.refresh(), store.refresh()]);
  const restarted = await makeStore();
  await restarted.refresh();
  const final = await restarted.snapshot();
  assert.equal(final.tasks.length, 3);
  assert.equal(final.tasks.filter((task) => task.noteId === otherId).length, 1);
  assert.deepEqual(final.tasks.find((task) => task.title === '직접 등록').dates, [{ date: '2026-11-13', label: '직접 등록', kind: '까지', done: false }]);
});

test('작업 카드에 원문이 있고 업무 시작을 반복해도 사본과 수집기 원본을 덮어쓰지 않는다', async (t) => {
  const { makeStore, notes, inboxDir, dataDir } = await setup(t);
  const files = path.join(inboxDir, 'files', noteId);
  await fs.mkdir(files, { recursive: true });
  const original = path.join(files, '시험 자료.pdf');
  await fs.writeFile(original, '수집기 원본');
  await writeNote(notes, note(noteId, { saved: [{ name: '시험 자료.pdf', path: original }] }));
  const store = await makeStore();
  await store.refresh();
  const [{ id }] = (await store.snapshot()).tasks;
  await store.prepareWork(id);
  const workDir = path.join(dataDir, 'tasks', id);
  const copy = path.join(workDir, '첨부', '시험 자료.pdf');
  assert.equal(await fs.readFile(copy, 'utf8'), '수집기 원본');
  const card = await fs.readFile(path.join(workDir, '업무.md'), 'utf8');
  for (const line of note(noteId).body.split('\n')) assert.ok(card.includes(line));
  await fs.writeFile(copy, '업무용 수정 사본');
  await store.prepareWork(id);
  assert.equal(await fs.readFile(copy, 'utf8'), '업무용 수정 사본');
  assert.equal(await fs.readFile(original, 'utf8'), '수집기 원본');
});

test('새 쪽지 첨부는 다운로드 폴더에 바로 복사하고 기존 파일은 덮어쓰지 않는다', async (t) => {
  const { root, inboxDir, notes, dataDir, makeStore } = await setup(t);
  const downloadsDir = path.join(root, 'Downloads');
  await fs.mkdir(downloadsDir, { recursive: true });
  const occupied = path.join(downloadsDir, '안내.pdf');
  await fs.writeFile(occupied, '기존 다운로드 파일');

  const originals = [noteId, otherId].map(id => path.join(inboxDir, 'files', id, '안내.pdf'));
  for (const source of originals) {
    await fs.mkdir(path.dirname(source), { recursive: true });
    await fs.writeFile(source, '수집기 파일');
  }
  await writeNote(notes, note(noteId, { saved: [{ name: '안내.pdf', path: originals[0] }] }));
  const past = new Date(Date.now() - 10_000);
  await fs.utimes(path.join(notes, `${noteId}.json`), past, past);

  const store = await makeStore({ downloadsDir });
  await store.refresh();
  await writeNote(notes, note(otherId, { saved: [{ name: '안내.pdf', path: originals[1] }] }));
  const next = new Date(Date.now() + 2_000);
  await fs.utimes(path.join(notes, `${otherId}.json`), next, next);
  await Promise.all([store.refresh(), store.refresh()]);
  const restarted = await makeStore({ downloadsDir });
  await restarted.refresh();

  const oldTask = restarted.snapshot().tasks.find(task => task.noteId === noteId);
  const newTask = restarted.snapshot().tasks.find(task => task.noteId === otherId);
  const copied = path.join(downloadsDir, '안내 (2).pdf');
  assert.equal((await restarted.attachment(oldTask.id, 0)).path, originals[0]);
  assert.equal((await restarted.attachment(newTask.id, 0)).path, copied);
  assert.equal(await fs.readFile(occupied, 'utf8'), '기존 다운로드 파일');
  assert.equal(await fs.readFile(copied, 'utf8'), '수집기 파일');
  assert.deepEqual((await fs.readdir(downloadsDir)).sort(), ['안내 (2).pdf', '안내.pdf']);
  assert.equal('downloadedAttachments' in newTask, false);

  await fs.unlink(copied);
  await restarted.refresh();
  assert.deepEqual(await fs.readdir(downloadsDir), ['안내.pdf']);
  assert.equal((await restarted.attachment(newTask.id, 0)).path, originals[1]);

  const legacyFolder = path.join(downloadsDir, '브리티 첨부', noteId);
  await fs.mkdir(legacyFolder, { recursive: true });
  const legacyCopy = path.join(legacyFolder, '안내.pdf');
  await fs.writeFile(legacyCopy, '이전 방식으로 저장한 첨부');
  const tasksFile = path.join(dataDir, 'tasks.json');
  const tasks = JSON.parse(await fs.readFile(tasksFile, 'utf8'));
  tasks.find(task => task.id === oldTask.id).downloadedAttachments = [{ source: originals[0], name: '안내.pdf' }];
  await fs.writeFile(tasksFile, JSON.stringify(tasks));
  const upgraded = await makeStore({ downloadsDir });
  await upgraded.refresh();
  assert.equal((await upgraded.attachment(oldTask.id, 0)).path, legacyCopy);
});

test('자동 분류는 초기 쪽지를 보내지 않고, 새로 모은 검증된 쪽지만 대기열에 넣는다', async (t) => {
  const { makeStore, notes } = await setup(t);
  await writeNote(notes, note(noteId));
  const store = await makeStore();
  await store.setAutomatic(true);
  await store.refresh();
  assert.equal(store.nextAutomatic(), null);
  const unverifiedId = '0_202611100000000003_0';
  await writeNote(notes, note(otherId));
  await writeNote(notes, note(unverifiedId, { verified: false }));
  await store.refresh();
  const id = store.nextAutomatic();
  assert.equal(store.snapshot().tasks.find((task) => task.id === id).noteId, otherId);
  const result = await store.refine(id, async (sent) => {
    assert.equal(sent.body, note(otherId).body);
    assert.deepEqual(sent.attachmentNames, []);
    assert.equal('attachments' in sent, false);
    return { title: '시험 인사', category: '인사', due: null, kind: '기타', summary: '할 일 없음' };
  }, { automatic: true });
  assert.equal(result.status, 'done');
  assert.equal(result.task.type, '없음');
  assert.equal(store.nextAutomatic(), null);
});

test('자동 분류를 다시 켜도 꺼진 동안 모인 쪽지는 뒤늦게 전송하지 않는다', async (t) => {
  const { makeStore, notes } = await setup(t);
  const store = await makeStore();
  await store.refresh();
  await writeNote(notes, note(noteId));
  await new Promise((resolve) => setTimeout(resolve, 10));
  await store.setAutomatic(true);
  await writeNote(notes, note(otherId));
  await store.refresh();
  const queued = store.snapshot().tasks.find((task) => task.id === store.nextAutomatic());
  assert.equal(queued?.noteId, otherId);
});

test('표시 이름과 파일 이름이 같은 첨부 두 건도 각각 다른 사본으로 보존한다', async (t) => {
  const { makeStore, notes, inboxDir } = await setup(t);
  const files = path.join(inboxDir, 'files', noteId);
  const originals = ['첫째', '둘째'].map((dir) => path.join(files, dir, '시험.pdf'));
  for (const [index, original] of originals.entries()) {
    await fs.mkdir(path.dirname(original), { recursive: true });
    await fs.writeFile(original, `시험 ${index + 1}`);
  }
  await writeNote(notes, note(noteId, { saved: originals.map((original) => ({ name: '시험.pdf', path: original })) }));
  const store = await makeStore();
  await store.refresh();
  const [{ id }] = store.snapshot().tasks;
  const work = await store.prepareWork(id);
  const copies = await fs.readdir(path.join(work.folder, '첨부'));
  assert.equal(copies.length, 2);
  const texts = await Promise.all(copies.map((name) => fs.readFile(path.join(work.folder, '첨부', name), 'utf8')));
  assert.deepEqual(texts.sort(), ['시험 1', '시험 2']);
  assert.equal(work.missing, 0);
});

test('AI 실패 뒤 원문을 보존하고, 다듬는 중 저장한 사용자 편집을 AI로 덮어쓰지 않는다', async (t) => {
  const { makeStore, notes } = await setup(t);
  await writeNote(notes, note(noteId));
  const store = await makeStore();
  await store.refresh();
  const [{ id }] = store.snapshot().tasks;
  const failed = await store.refine(id, async () => ({ title: '날짜 오류', category: '할 일', due: '2026-02-31', kind: '제출', summary: '' }));
  assert.equal(failed.status, 'failed');
  assert.equal((await store.detail(id)).note.body, note(noteId).body);
  let start;
  let finish;
  const started = new Promise((resolve) => { start = resolve; });
  const gate = new Promise((resolve) => { finish = resolve; });
  const waiting = store.refine(id, async () => {
    start();
    await gate;
    return { title: 'AI 제목', category: '할 일', due: '2026-11-12', kind: '제출', summary: '' };
  });
  await started;
  try { await store.update(id, { title: '사용자가 입력한 제목', type: '알아 둘 것', dates: [{ date: '2026-11-19', label: '도서관 휴관', kind: '그날' }] }); }
  finally { finish(); }
  assert.equal((await waiting).status, 'edited');
  const final = (await store.detail(id)).task;
  assert.equal(final.title, '사용자가 입력한 제목');
  assert.deepEqual(final.dates, [{ date: '2026-11-19', label: '도서관 휴관', kind: '그날' }]);
  assert.equal(final.type, '알아 둘 것');
});

test('수집기 범위 밖 첨부는 막고 실행 형식은 파일 열기 대신 탐색기로 보낸다', async (t) => {
  const { root, makeStore, notes, inboxDir } = await setup(t);
  const outside = path.join(root, '외부.txt');
  const files = path.join(inboxDir, 'files', noteId);
  await fs.mkdir(files, { recursive: true });
  const script = path.join(files, '시험.cmd');
  await fs.writeFile(outside, 'fake');
  await fs.writeFile(script, '@rem synthetic fixture');
  await writeNote(notes, note(noteId, { saved: [{ name: '외부.txt', path: outside }, { name: '시험.cmd', path: script }] }));
  const store = await makeStore();
  await store.refresh();
  const [{ id }] = store.snapshot().tasks;
  const { note: detail } = await store.detail(id);
  assert.equal(detail.attachments[0].available, false);
  await assert.rejects(() => store.attachment(id, 0));
  assert.equal((await store.attachment(id, 1)).direct, false);
});

test('복사할 지시문은 로컬 파일 없이도 회신과 이전 안내를 이해할 수 있다', () => {
  const task = { title: '계획서 회신', dates: [{ date: '2026-11-15', label: '계획서 회신', kind: '까지' }], reply: true, summary: '행사 계획서를 회신합니다.' };
  const note = { body: '결과입니다.\n--- Original Message ---\nTitle: 행사 안내\nTo: sample@example.test\n계획서를 회신해 주세요.' };
  const prompt = buildWorkPrompt(task, note);
  for (const text of ['계획서 회신', '2026-11-15까지', '답장 필요', task.summary, '결과입니다.', '행사 안내', '계획서를 회신해 주세요.']) {
    assert.ok(prompt.includes(text));
  }
  assert.ok(!prompt.includes('sample@example.test'));
  assert.ok(buildWorkPrompt({ title: '직접 추가한 업무' }, null).includes('직접 추가한 업무'));
});

test('자동 분류는 개인정보 검사로 막지 않고 보낸다(2026-11-11 결정)', async (t) => {
  const { makeStore, notes } = await setup(t);
  const store = await makeStore();
  await store.setAutomatic(true);
  await store.refresh();
  await writeNote(notes, note(otherId, { body: '학부모 연락처 010-1234-5678 확인 부탁드립니다.' }));
  await store.refresh();
  let sent = 0;
  for (let id; (id = store.nextAutomatic());) {
    const result = await store.refine(id, async () => { sent++; return { type: '할 일', title: '연락처 확인', summary: '', dates: [], reply: true, uncertain: false }; }, { automatic: true });
    assert.equal(result.status, 'done');
  }
  assert.equal(sent, 1);
  assert.equal('privacyHold' in store.snapshot().tasks[0], false);
});

test('옛 분류로 저장된 업무는 백업을 남기고 새 구조로 한 번 옮긴다', async (t) => {
  const { makeStore, dataDir } = await setup(t);
  await fs.mkdir(dataDir, { recursive: true });
  const legacy = (title, fields) => ({ id: randomUUID(), noteId: null, title, summary: '', refined: 'none', chats: [], autoPending: false, revision: 0, done: false, ...fields });
  const old = [
    legacy('협의회', { category: '할 일', kind: '참석', due: '2026-11-14' }),
    legacy('계획서', { category: '할 일', kind: '제출', due: '2026-11-13', done: true }),
    legacy('명단 회신', { category: '할 일', kind: '회신', due: '2026-11-12' }),
    legacy('게시물 정비', { category: '할 일', kind: '기타', due: null }),
    legacy('도서관 휴관', { category: '참고', kind: '기타', due: '2026-11-15' }),
    legacy('감사 인사', { category: '인사', kind: '기타', due: null, privacyHold: ['x'] }),
  ];
  await fs.writeFile(path.join(dataDir, 'tasks.json'), JSON.stringify(old));
  const store = await makeStore();
  const moved = Object.fromEntries(store.snapshot().tasks.map(task => [task.title, task]));
  assert.deepEqual(moved['협의회'].dates, [{ date: '2026-11-14', label: '협의회', kind: '그날' }]);
  assert.deepEqual(moved['계획서'].dates, [{ date: '2026-11-13', label: '계획서', kind: '까지', done: true }]);
  assert.equal(moved['명단 회신'].reply, true);
  assert.equal(moved['게시물 정비'].type, '할 일');
  assert.deepEqual(moved['게시물 정비'].dates, []);
  assert.equal(moved['도서관 휴관'].type, '알아 둘 것');
  assert.equal(moved['도서관 휴관'].dates[0].kind, '그날');
  assert.equal(moved['감사 인사'].type, '없음');
  for (const task of store.tasks) for (const field of ['category', 'kind', 'due', 'privacyHold']) assert.equal(field in task, false);
  const backups = (await fs.readdir(dataDir)).filter(name => name.startsWith('tasks.before-new-types-'));
  assert.equal(backups.length, 1);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dataDir, backups[0]), 'utf8')), old);
  await makeStore();
  assert.equal((await fs.readdir(dataDir)).filter(name => name.startsWith('tasks.before-new-types-')).length, 1);
});

test('날짜가 둘인 쪽지는 까지 날짜마다 따로 끝내고, 답장과 고친 값을 기록한다', async (t) => {
  const { makeStore, notes, dataDir } = await setup(t);
  await writeNote(notes, note(noteId, { recipients: '홍길동' }));
  const store = await makeStore();
  await store.refresh();
  const [{ id }] = store.snapshot().tasks;
  assert.equal(store.snapshot().tasks[0].recipients, 1);
  const refined = await store.refine(id, async () => ({
    type: '할 일', title: '발표회', summary: '', reply: true, uncertain: false,
    dates: [{ date: '2026-11-15', label: '발표회', kind: '그날' }, { date: '2026-11-14', label: '발표 자료 제출', kind: '까지' }, { date: '2026-02-31', label: '틀린 날', kind: '까지' }]
  }));
  const task = refined.task;
  assert.deepEqual(task.dates.map(entry => entry.date), ['2026-11-14', '2026-11-15']);
  assert.equal(task.uncertain, true);
  await store.setDone(id, true, 0);
  let current = (await store.detail(id)).task;
  assert.equal(current.dates[0].done, true);
  assert.equal('done' in current.dates[1], false);
  await assert.rejects(store.setDone(id, true, 1), /끝냄으로 표시할 칸이 없습니다/);
  await store.setReplied(id, true);
  assert.equal((await store.detail(id)).task.replied, true);

  await store.update(id, { title: '발표회', type: '할 일', reply: false, dates: [{ date: '2026-11-15', label: '발표회', kind: '그날' }] });
  current = (await store.detail(id)).task;
  assert.equal(current.replied, false);
  assert.equal(current.uncertain, false);
  const saved = JSON.parse(await fs.readFile(path.join(dataDir, 'tasks.json'), 'utf8'));
  const record = (Array.isArray(saved) ? saved : saved.tasks)[0];
  assert.equal(record.aiAnswer.reply, true);
  assert.equal(record.aiAnswer.dates.length, 2);
  assert.deepEqual(record.correction.value, { type: '할 일', reply: false, dates: [{ date: '2026-11-15', label: '발표회', kind: '그날' }] });
  await assert.rejects(store.update(id, { type: '할 일', dates: [1, 2, 3, 4].map(day => ({ date: `2026-11-0${day}`, label: 'x', kind: '그날' })) }), /3개까지/);
});

test('날짜 없는 할 일은 받은 날 그날에 놓고, 설정한 내 역할을 AI에 넘긴다', async (t) => {
  const { makeStore, notes, dataDir } = await setup(t);
  await writeNote(notes, note(noteId, { datetime: '2026-11-10 08:00' }));
  const store = await makeStore();
  await store.refresh();
  await assert.rejects(store.setProfile({ grade: '열', classroom: '' }), /숫자로/);
  const view = await store.setProfile({ grade: '4', classroom: '2', homeroomTeacher: true, duties: '학생자치, 방송', memberships: '' });
  // 예전 설정(근무처·학교급 없음)은 초등 학교로 읽는다.
  const office = { officeType: null, department: '', position: null, coveredLevels: [] };
  assert.deepEqual(view.profile, { workplace: '학교', schoolLevel: '초등', grade: 4, classroom: 2, role: '담임', homeroomTeacher: true, subjects: [], subjectGrades: [], ...office, duties: ['학생자치', '방송'], memberships: [] });
  const specialist = await store.setProfile({ role: '전담', subjects: '영어, 체육', subjectGrades: '4, 3학년, 4', duties: '' });
  assert.deepEqual(specialist.profile, { workplace: '학교', schoolLevel: '초등', grade: null, classroom: null, role: '전담', homeroomTeacher: false, subjects: ['영어', '체육'], subjectGrades: [3, 4], ...office, duties: [], memberships: [] });
  await assert.rejects(store.setProfile({ role: '교감' }), /담임·전담·그 밖/);
  await assert.rejects(store.setProfile({ role: '전담', subjectGrades: '7' }), /1~6/);
  // 중·고: 학년은 1~3, 역할은 담임·비담임·그 밖, 과목은 담임이어도 받는다.
  const middle = await store.setProfile({ workplace: '학교', schoolLevel: '중학교', grade: '2', classroom: '5', role: '담임', subjects: '수학', subjectGrades: '1, 2', duties: '' });
  assert.deepEqual(middle.profile, { workplace: '학교', schoolLevel: '중학교', grade: 2, classroom: 5, role: '담임', homeroomTeacher: true, subjects: ['수학'], subjectGrades: [1, 2], ...office, duties: [], memberships: [] });
  await assert.rejects(store.setProfile({ schoolLevel: '고등학교', grade: '4' }), /1~3/);
  await assert.rejects(store.setProfile({ schoolLevel: '중학교', role: '전담' }), /담임·비담임·그 밖/);
  // 교육청: 학년·반·역할은 비우고 기관·부서·직위·담당 학교급을 받는다.
  const officer = await store.setProfile({ workplace: '교육청', officeType: '교육지원청', department: '초등교육과', position: '장학관·장학사', coveredLevels: ['고등학교', '초등'], grade: '4', duties: '학생자치' });
  assert.deepEqual(officer.profile, { workplace: '교육청', schoolLevel: null, grade: null, classroom: null, role: null, homeroomTeacher: null, subjects: [], subjectGrades: [], officeType: '교육지원청', department: '초등교육과', position: '장학관·장학사', coveredLevels: ['초등', '고등학교'], duties: ['학생자치'], memberships: [] });
  await assert.rejects(store.setProfile({ workplace: '교육청', coveredLevels: ['대학'] }), /담당 학교급/);
  await assert.rejects(store.setProfile({ workplace: '회사' }), /근무처/);
  await store.setProfile({ grade: '4', classroom: '2', role: '담임', subjects: '영어', subjectGrades: '3', duties: '학생자치, 방송', memberships: '' });
  const [{ id }] = store.snapshot().tasks;
  let sentProfile;
  const { task } = await store.refine(id, async (_note, options) => {
    sentProfile = options.profile;
    return { type: '할 일', title: '전화 회신', summary: '', dates: [], uncertain: false };
  });
  assert.deepEqual(sentProfile, view.profile);
  assert.deepEqual(task.dates, [{ date: '2026-11-10', label: '전화 회신', kind: '그날', received: true }]);
  const saved = JSON.parse(await fs.readFile(path.join(dataDir, 'tasks.json'), 'utf8'));
  assert.deepEqual((Array.isArray(saved) ? saved : saved.tasks)[0].aiAnswer.dates, []);
  const known = await store.refine(id, async () => ({ type: '알아 둘 것', title: '연수 자료', summary: '', dates: [], uncertain: false }));
  assert.deepEqual(known.task.dates, []);
});

test('직접 추가한 업무와 쪽지 업무에 메모를 적고, 다시 다듬어도 메모는 그대로 둔다', async (t) => {
  const { makeStore, notes } = await setup(t);
  await writeNote(notes, note(noteId));
  const store = await makeStore();
  await store.refresh();
  const manual = await store.create({ title: '협의회 자료', due: '2026-11-20', memo: '준비물: 학년 계획서\r\n제출: 교무실' });
  assert.equal(manual.memo, '준비물: 학년 계획서\n제출: 교무실');
  await assert.rejects(store.create({ title: '긴 메모', due: '2026-11-20', memo: 'ㄱ'.repeat(4001) }), /4000자/);
  const noteTask = store.snapshot().tasks.find(task => task.noteId);
  assert.equal(noteTask.memo, '');
  const edited = await store.update(noteTask.id, { memo: '부장님께 먼저 여쭤 보기', revision: noteTask.revision });
  assert.equal(edited.memo, '부장님께 먼저 여쭤 보기');
  assert.equal(store.tasks.find(task => task.id === noteTask.id).correction, undefined);
  const { task } = await store.refine(noteTask.id, async () => ({ type: '할 일', title: '자료 제출', summary: 'AI 정리', dates: [], uncertain: false }));
  assert.equal(task.summary, 'AI 정리');
  assert.equal(task.memo, '부장님께 먼저 여쭤 보기');
  const reopened = await makeStore();
  assert.equal(reopened.tasks.find(item => item.id === manual.id).memo, '준비물: 학년 계획서\n제출: 교무실');
});

test('상시는 할 일만 켜고, 끝내면 묶음에서 빠지며, 남은 까지 중 가장 이른 날을 기준으로 삼는다', async (t) => {
  const model = require('../renderer/task-model');
  const { makeStore } = await setup(t);
  const store = await makeStore();
  const task = await store.create({ title: '학년말 평가 계획', due: '2026-12-20' });
  const pinned = await store.setPinned(task.id, true);
  assert.equal(pinned.pinned, true);
  assert.equal(model.isPinned(pinned), true);
  assert.equal(model.pinnedDue(pinned, '2026-11-12').date, '2026-12-20');
  const reopened = await makeStore();
  assert.equal(reopened.tasks[0].pinned, true);
  const done = await reopened.setDone(task.id, true, 0);
  assert.equal(model.isPinned(done), false);
  assert.equal(done.pinned, true);
  await assert.rejects(async () => reopened.setPinned(task.id, 'yes'), /상시 여부/);
  const two = { type: '할 일', pinned: true, dates: [
    { date: '2026-11-30', label: '초안', kind: '까지', done: true },
    { date: '2026-12-05', label: '협의', kind: '그날' },
    { date: '2026-12-20', label: '최종', kind: '까지', done: false }
  ] };
  assert.equal(model.pinnedDue(two, '2026-11-12').label, '최종');
  assert.equal(model.isPinned({ ...two, type: '알아 둘 것' }), false);
});

test('첨부 저장 폴더를 고르면 거기에 복사하고, 쓸 수 없으면 기본 폴더에 저장하며 알린다', async (t) => {
  const { root, inboxDir, notes, dataDir, makeStore } = await setup(t);
  const downloadsDir = path.join(root, 'Downloads');
  const chosen = path.join(root, '업무 첨부');
  await fs.mkdir(downloadsDir, { recursive: true });
  await fs.mkdir(chosen, { recursive: true });
  const ids = [noteId, otherId, '0_202611100000000003_0'];
  const sources = ids.map(id => path.join(inboxDir, 'files', id, `${id.slice(-3)}.pdf`));
  for (const source of sources) {
    await fs.mkdir(path.dirname(source), { recursive: true });
    await fs.writeFile(source, '수집기 파일');
  }
  const store = await makeStore({ downloadsDir });
  await store.refresh();
  assert.deepEqual(store.snapshot().downloads, { folder: downloadsDir, custom: false, enabled: true, warning: null });
  await assert.rejects(store.setDownloadsDir('상대 경로'), /다시 골라/);
  await assert.rejects(store.setDownloadsDir(path.join(root, '없는 폴더')), /저장할 수 없습니다/);
  await assert.rejects(store.setDownloadsDir(path.join(dataDir)), /자료 폴더 안/);
  await store.setDownloadsDir(chosen);
  assert.equal(store.snapshot().downloads.custom, true);

  const add = async (index) => {
    await writeNote(notes, note(ids[index], { saved: [{ name: path.basename(sources[index]), path: sources[index] }] }));
    const later = new Date(Date.now() + 2_000);
    await fs.utimes(path.join(notes, `${ids[index]}.json`), later, later);
    await store.refresh();
    return store.snapshot().tasks.find(task => task.noteId === ids[index]);
  };
  const first = await add(0);
  assert.deepEqual(await fs.readdir(chosen), [path.basename(sources[0])]);
  assert.equal((await store.attachment(first.id, 0)).path, path.join(await fs.realpath(chosen), path.basename(sources[0])));

  await fs.rm(chosen, { recursive: true });
  const second = await add(1);
  assert.deepEqual(await fs.readdir(downloadsDir), [path.basename(sources[1])]);
  assert.match(store.snapshot().downloads.warning, /쓸 수 없어 기본 다운로드 폴더/);
  assert.equal((await store.attachment(second.id, 0)).path, path.join(await fs.realpath(downloadsDir), path.basename(sources[1])));
  // 예전 폴더의 사본이 사라지면 수집기 원본을 연다.
  assert.equal((await store.attachment(first.id, 0)).path, sources[0]);

  await store.setDownloadsDir(null);
  assert.deepEqual(store.snapshot().downloads, { folder: downloadsDir, custom: false, enabled: true, warning: null });
  await add(2);
  assert.equal((await fs.readdir(downloadsDir)).length, 2);
});

test('가져올 대화방 선택은 비어 있는 상태로 시작하고 저장과 재실행 뒤에도 갱신 설정과 따로 유지된다', async (t) => {
  const { makeStore } = await setup(t);
  const store = await makeStore();
  assert.deepEqual(store.snapshot().chatRooms, []);
  const label = '가상 협의방 4';
  const room = { label, key: createHash('sha256').update(label).digest('hex') };
  assert.throws(() => store.setChatRooms([{ ...room, label: '다른 방' }]), /가져올 대화방/);
  assert.throws(() => store.setChatRooms([room, room]), /가져올 대화방/);
  await store.setChatRooms([room]);
  await store.setAutoRefresh({ chats: { enabled: false, minutes: 30 } });
  const reopened = await makeStore();
  assert.deepEqual(reopened.snapshot().chatRooms, [room]);
  assert.deepEqual(reopened.snapshot().autoRefresh.chats, { enabled: false, minutes: 30 });
  await reopened.setChatRooms([]);
  assert.deepEqual((await makeStore()).snapshot().chatRooms, []);
});

test('자동 갱신은 기본 켜짐·1시간이고, 쪽지·대화방을 따로 켜고 주기를 고른다', async (t) => {
  const { makeStore } = await setup(t);
  const store = await makeStore();
  assert.deepEqual(store.snapshot().autoRefresh, { notes: { enabled: true, minutes: 60 }, chats: { enabled: true, minutes: 60 }, choices: [5, 10, 30, 60, 120] });
  await store.setAutoRefresh({ notes: { enabled: true, minutes: 10 }, chats: { enabled: false, minutes: 60 } });
  const reopened = await makeStore();
  assert.deepEqual(reopened.snapshot().autoRefresh.notes, { enabled: true, minutes: 10 });
  assert.deepEqual(reopened.snapshot().autoRefresh.chats, { enabled: false, minutes: 60 });
  await assert.rejects(reopened.setAutoRefresh({ notes: { enabled: true, minutes: 7 } }), /자동 갱신 설정/);
  await reopened.setAutoRefresh({ chats: { enabled: true, minutes: 120 } });
  assert.deepEqual(reopened.snapshot().autoRefresh.notes, { enabled: true, minutes: 10 });
});

test('쪽지 가져오기 버튼으로 받은 쪽지는 자동 분류가 꺼져 있어도 분류하고, 그 전 쪽지는 건드리지 않는다', async (t) => {
  const { makeStore, notes } = await setup(t);
  await writeNote(notes, note(noteId, { title: '버튼 전에 있던 쪽지' }));
  const store = await makeStore();
  await store.saveAiConnection('factchat', 'ENCRYPTED');
  await store.setAutomatic(false);
  await store.refresh();
  const pressed = Date.now();
  await new Promise(resolve => setTimeout(resolve, 20));
  await writeNote(notes, note(otherId, { title: '버튼으로 받은 쪽지' }));
  await store.refresh({ classifyFrom: pressed });
  const byTitle = title => store.tasks.find(task => task.title === title);
  assert.equal(byTitle('버튼 전에 있던 쪽지').autoPending, false);
  assert.equal(byTitle('버튼으로 받은 쪽지').autoPending, true);
  assert.equal(store.nextAutomatic(), byTitle('버튼으로 받은 쪽지').id);
  const result = await store.refine(store.nextAutomatic(), async () => ({ type: '할 일', title: '분류됨', summary: '', dates: [], uncertain: false }), { automatic: true });
  assert.equal(result.status, 'done');
  assert.equal(store.nextAutomatic(), null);
});

test('AI의 원래 답에 확인 필요 표시를 남기고, 같은 유형으로 저장하면 확인만 풀린다', async (t) => {
  const { makeStore, notes } = await setup(t);
  await writeNote(notes, note(noteId));
  const store = await makeStore();
  await store.refresh();
  const [{ id }] = store.snapshot().tasks;
  const { task } = await store.refine(id, async () => ({ type: '알아 둘 것', title: '연수 안내', summary: '해당 여부가 갈림', dates: [], uncertain: true }));
  assert.equal(task.uncertain, true);
  assert.equal(store.tasks[0].aiAnswer.uncertain, true);
  const confirmed = await store.update(id, { type: '알아 둘 것', revision: task.revision });
  assert.equal(confirmed.uncertain, false);
  assert.equal(store.tasks[0].correction, undefined);
  const moved = await store.update(id, { type: '할 일', revision: confirmed.revision });
  assert.equal(moved.type, '할 일');
  assert.equal(store.tasks[0].correction.ai.uncertain, true);
  assert.equal(store.tasks[0].correction.value.type, '할 일');
});

test('분류 실패는 사유를 남겨 다시 정하게 하고, 잠깐 생긴 오류는 1분 뒤 한 번 더, 연결 오류면 자동 분류를 멈춘다', async (t) => {
  const { CalendarError, aiStopError } = require('../store');
  const { makeStore, notes } = await setup(t);
  const store = await makeStore();
  await store.setAutomatic(true);
  await store.refresh();
  await writeNote(notes, note(noteId));
  await writeNote(notes, note(otherId));
  await store.refresh();
  const first = store.nextAutomatic();
  assert.ok(first);

  // 키 오류: 쪽지를 실패로 두지 않고 차례를 남긴 채 자동 분류를 멈춘다.
  const blocked = await store.refine(first, async () => { throw aiStopError('키가 올바르지 않습니다.'); }, { automatic: true });
  assert.equal(blocked.status, 'blocked');
  assert.equal(store.snapshot().aiBlocked, '키가 올바르지 않습니다.');
  assert.equal(store.snapshot().tasks.find(task => task.id === first).queued, true);
  assert.equal(store.nextAutomatic(), null);
  await store.saveAiConnection('factchat', 'ENCRYPTED');
  assert.equal(store.snapshot().aiBlocked, null);

  // 시간 초과: 실패로 남기고 사유를 저장한다. 1분이 지나면 한 번 더, 두 번째 실패 뒤에는 더 보내지 않는다.
  await store.setAutomatic(true);
  await writeNote(notes, note('0_202611100000000005_0'));
  await store.refresh();
  const id = store.nextAutomatic();
  const timeout = async () => { throw new CalendarError('90초 안에 응답하지 않았습니다.'); };
  const failed = await store.refine(id, timeout, { automatic: true });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.task.refineFailure.message, '90초 안에 응답하지 않았습니다.');
  assert.equal(failed.task.refineFailure.attempts, 1);
  assert.equal(store.nextAutomatic(), null);
  const later = Date.now() + 61_000;
  assert.equal(store.nextAutomatic(later), id);
  t.mock.timers.enable({ apis: ['Date'], now: later });
  const again = await store.refine(id, timeout, { automatic: true });
  assert.equal(again.task.refineFailure.attempts, 2);
  assert.equal(store.nextAutomatic(later + 120_000), null);
  t.mock.timers.reset();

  // 선생님이 유형을 고르면 실패 표시를 지운다.
  const chosen = await store.update(id, { type: '알아 둘 것', revision: again.task.revision });
  assert.equal(chosen.refineFailure, undefined);
});

test('업무 추가는 날짜 고치기와 같이 마감·일정·기간과 시간·교시를 받는다', async (t) => {
  const { makeStore } = await setup(t);
  const store = await makeStore();
  await store.refresh();
  const plain = await store.create({ title: '자료 제출', due: '2026-11-20' });
  assert.deepEqual(plain.dates, [{ date: '2026-11-20', label: '자료 제출', kind: '까지', done: false }]);
  const event = await store.create({ title: '학년 협의', due: '2026-11-20', kind: '그날', time: ' 6교시 ' });
  assert.deepEqual(event.dates, [{ date: '2026-11-20', label: '학년 협의', kind: '그날', time: '6교시' }]);
  const span = await store.create({ title: '독서 주간', due: '2026-11-23', kind: '기간', end: '2026-11-27', time: '' });
  assert.deepEqual(span.dates, [{ date: '2026-11-23', label: '독서 주간', kind: '기간', end: '2026-11-27' }]);
  await assert.rejects(store.create({ title: '틀린 기간', due: '2026-11-23', kind: '기간', end: '2026-11-22' }), /끝 날짜/);
});
