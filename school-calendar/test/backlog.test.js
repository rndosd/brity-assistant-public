'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { test } = require('node:test');
const { CalendarStore } = require('../store');

const qaRoot = path.join(__dirname, '..', '.qa');

test('AI 연결 전에 가져온 쪽지는 연결 뒤 누를 때 한꺼번에 정리하고, 손댄 쪽지는 건드리지 않는다', async (t) => {
  await fs.mkdir(qaRoot, { recursive: true });
  const root = await fs.mkdtemp(path.join(await fs.realpath(qaRoot), 'backlog-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const inboxDir = path.join(root, 'inbox');
  const dataDir = path.join(root, 'data');
  const ruleSeed = path.join(root, 'rules.md');
  await fs.mkdir(path.join(inboxDir, 'notes'), { recursive: true });
  await fs.writeFile(ruleSeed, '# 기준\n');
  const store = new CalendarStore({ dataDir, inboxDir, ruleSeed, aiDefault: 'none' });
  await store.init();
  await store.refresh();
  for (const [n, title] of [[1, '가상 제출 안내'], [2, '가상 협의회'], [3, '가상 행사']]) {
    const id = `0_20261115000000000${n}_0`;
    await fs.writeFile(path.join(inboxDir, 'notes', `${id}.json`), JSON.stringify({
      id, title, sender: '가상', datetime: '2026-11-15 09:00', verified: true, body: `${title} 본문`
    }));
  }
  const later = new Date(Date.now() + 2000);
  for (const name of await fs.readdir(path.join(inboxDir, 'notes'))) await fs.utimes(path.join(inboxDir, 'notes', name), later, later);
  await store.refresh();
  assert.equal(store.tasks.length, 3);
  assert.ok(store.tasks.every(task => task.refined === 'none' && !task.autoPending));
  assert.equal(store.snapshot().backlogPending, 3);
  await assert.rejects(store.queueBacklogClassify(), /AI를 먼저 연결/);

  // 하나는 손으로 끝냈다: 사람이 정한 것이라 정리 대상에서 뺀다.
  const touched = store.tasks.find(task => task.title === '가상 행사');
  await store.setDone(touched.id, true);
  assert.equal(store.snapshot().backlogPending, 2);

  await store.saveAiConnection('factchat', 'ENCRYPTED');
  assert.equal(await store.queueBacklogClassify(), 2);
  assert.equal(store.snapshot().backlogPending, 0);
  assert.equal(store.tasks.filter(task => task.autoPending).length, 2);
  assert.equal(store.tasks.find(task => task.id === touched.id).autoPending, false);
  assert.ok(store.nextAutomatic());
});
