'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { test } = require('node:test');
const { CalendarStore } = require('../store');
const { openProjectHandoff, listWorkProjects } = require('../project-handoff');

async function fixture(t) {
  const qa = path.join(__dirname, '..', '.qa');
  await fs.mkdir(qa, { recursive: true });
  const parent = await fs.realpath(qa);
  const root = await fs.mkdtemp(path.join(parent, 'project-handoff-'));
  t.after(async () => {
    if (await fs.realpath(root) === root && path.dirname(root) === parent) await fs.rm(root, { recursive: true, force: true });
  });
  const projectDir = path.join(root, '가상 업무 + 검토 & 자료 #2');
  const inboxDir = path.join(root, 'inbox');
  const noteId = '0_202611100000000001_0';
  const notes = path.join(inboxDir, 'notes');
  const files = path.join(inboxDir, 'files', noteId);
  await Promise.all([fs.mkdir(projectDir), fs.mkdir(notes, { recursive: true }), fs.mkdir(files, { recursive: true })]);
  const saved = ['선택한 양식 & 자료.txt', '개인 메모.txt'].map(name => ({ name, path: path.join(files, name) }));
  await Promise.all(saved.map(item => fs.writeFile(item.path, item.name)));
  const note = { id: noteId, title: '가상 쪽지', sender: '가상 발신자', datetime: '2026-11-10 08:00', verified: true, body: '가상 요청 원문', saved };
  await fs.writeFile(path.join(notes, noteId + '.json'), JSON.stringify(note));
  const store = new CalendarStore({ dataDir: path.join(root, 'data'), inboxDir, ruleSeed: path.join(__dirname, '..', 'rules-seed.md'), aiDefault: 'none' });
  await store.init();
  const [task] = (await store.refresh()).tasks;
  return { store, taskId: task.id, projectDir, selection: [{ index: 0, name: saved[0].name }] };
}

test('채팅은 선택한 프로젝트에 열리고 가리키는 업무 사본에는 고른 첨부만 남는다', async t => {
  const input = await fixture(t);
  let url;
  const codex = await openProjectHandoff({ ...input, agent: 'codex', openExternal: address => { url = new URL(address); } });
  assert.equal(url.protocol, 'codex:');
  assert.equal(url.host, 'threads');
  assert.equal(url.pathname, '/new');
  assert.equal(url.searchParams.get('path'), input.projectDir);
  assert.match(url.search, /%20%2B%20/);
  const relative = path.relative(input.projectDir, codex.card).split(path.sep).join('/');
  assert.ok(url.searchParams.get('prompt').includes(relative));
  assert.ok(!url.search.includes(encodeURIComponent('가상 요청 원문')));
  assert.match(await fs.readFile(codex.card, 'utf8'), /가상 요청 원문/);
  assert.deepEqual(await fs.readdir(path.join(codex.folder, '첨부')), [input.selection[0].name]);

  let invocation;
  const claude = await openProjectHandoff({ ...input, agent: 'claude', openClaude: (cwd, prompt) => { invocation = { cwd, prompt }; } });
  assert.equal(invocation.cwd, input.projectDir);
  assert.ok(invocation.prompt.includes(path.relative(input.projectDir, claude.card).split(path.sep).join('/')));
  assert.notEqual(codex.folder, claude.folder);
  assert.match(await fs.readFile(codex.card, 'utf8'), /가상 쪽지/);
});

test('첨부 변경·앱 실행 오류는 앞서 넘긴 작업을 남기고 이번 작업만 거둔다', async t => {
  const input = await fixture(t);
  const previous = await openProjectHandoff({ ...input, agent: 'codex', openExternal: () => {} });
  const bad = { ...input, selection: [{ index: 0, name: '변경 전.txt' }] };
  let calls = 0;
  const openExternal = () => { calls++; throw new Error('unregistered protocol'); };
  await assert.rejects(openProjectHandoff({ ...bad, agent: 'codex', openExternal }), /첨부가 바뀌었거나/);
  assert.equal(calls, 0);
  await assert.rejects(openProjectHandoff({ ...input, agent: 'codex', openExternal }), /Codex를 열지 못했습니다/);
  assert.equal(calls, 1);
  assert.deepEqual(await fs.readdir(path.dirname(previous.folder)), [path.basename(previous.folder)]);
});

test('앱에 등록된 프로젝트 이름과 실제 폴더를 연결하고 없는 경로·중복을 거른다', async t => {
  const { projectDir } = await fixture(t);
  const home = path.dirname(projectDir);
  const env = { CODEX_HOME: home, CLAUDE_CONFIG_DIR: home };
  const missing = path.join(home, 'moved');
  const write = (name, json) => fs.writeFile(path.join(home, name), JSON.stringify(json));
  await write('.codex-global-state.json', { 'local-projects': { one: { name: '학교 업무', rootPaths: [projectDir, missing, projectDir] } },
    'project-order': ['one'], 'electron-saved-workspace-roots': [home] });
  await write('.claude.json', { projects: { [missing]: {}, [projectDir]: {} } });
  assert.deepEqual(await listWorkProjects('codex', env, home), [{ name: '학교 업무', folder: projectDir }]);
  const byFolder = [{ name: path.basename(projectDir), folder: projectDir }];
  assert.deepEqual(await listWorkProjects('claude', env, home), byFolder);
  await write('.codex-global-state.json', { 'electron-saved-workspace-roots': [projectDir, projectDir] });
  assert.deepEqual(await listWorkProjects('codex', env, home), byFolder);
});

test('입력한 지시와 줄바꿈이 작업 사본에 남고 Claude 실행 인자에는 사본 위치만 들어간다', async t => {
  const input = await fixture(t);
  const instruction = '첫 줄 "검토" & 정리\n두 번째 줄';
  let draft;
  const first = await openProjectHandoff({ ...input, instruction, agent: 'codex', openExternal: url => { draft = new URL(url); } });
  assert.ok(draft.searchParams.get('prompt').includes(instruction));
  assert.ok((await fs.readFile(first.card, 'utf8')).includes(instruction));
  let prompt;
  const second = await openProjectHandoff({ ...input, instruction, agent: 'claude', openClaude: (_, text) => { prompt = text; } });
  assert.ok((await fs.readFile(second.card, 'utf8')).includes(instruction));
  assert.ok(prompt.includes(path.relative(input.projectDir, second.card).split(path.sep).join('/')));
  assert.ok(!prompt.includes(instruction));
});
