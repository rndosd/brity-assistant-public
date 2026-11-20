'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { GoogleCalendarSync, desiredEvents, eventBody } = require('../google-calendar');

// 가짜 구글 캘린더(이벤트·캘린더를 메모리에 둔다).
function fakeGoogle() {
  const db = { calendars: {}, seq: 0, calls: [] };
  const reply = (status, body) => ({ ok: status < 300, status, json: async () => body });
  const fetchImpl = async (url, init = {}) => {
    const method = init.method || 'GET';
    db.calls.push(method);
    if (url.includes('oauth2.googleapis.com/token')) return reply(200, { access_token: 'a', expires_in: 3600 });
    const parts = new URL(url).pathname.replace('/calendar/v3/', '').split('/').map(decodeURIComponent);
    const body = init.body && JSON.parse(init.body);
    if (parts.length === 1 && method === 'POST') {
      const id = `cal${++db.seq}`;
      db.calendars[id] = { ...body, id, events: {} };
      return reply(200, db.calendars[id]);
    }
    const cal = db.calendars[parts[1]];
    if (!cal) return reply(404, {});
    if (parts.length === 2) {
      if (method === 'DELETE') { delete db.calendars[parts[1]]; return reply(204); }
      return reply(200, cal);
    }
    if (parts.length === 3 && method === 'POST') {
      const id = `ev${++db.seq}`;
      cal.events[id] = { ...body, id, status: 'confirmed' };
      return reply(200, cal.events[id]);
    }
    const ev = cal.events[parts[3]];
    if (!ev) return reply(404, {});
    if (method === 'GET') return reply(200, ev);
    if (method === 'PUT') { cal.events[parts[3]] = { ...body, id: ev.id, status: 'confirmed' }; return reply(200, cal.events[parts[3]]); }
    if (method === 'DELETE') { delete cal.events[parts[3]]; return reply(204); }
    return reply(400, {});
  };
  const live = () => Object.values(db.calendars).flatMap(cal => Object.values(cal.events).filter(ev => ev.status !== 'cancelled').map(ev => ({ cal: cal.summary, summary: ev.summary })));
  return { db, fetchImpl, live };
}

function setup(tasks) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gcal-'));
  const clientFile = path.join(dir, 'google-client.json');
  fs.writeFileSync(clientFile, JSON.stringify({ installed: { client_id: 'x.apps.googleusercontent.com', client_secret: 's' } }));
  const google = fakeGoogle();
  const box = { tasks };
  const sync = new GoogleCalendarSync({
    dataDir: dir, clientFile, fetchImpl: google.fetchImpl,
    protect: text => Buffer.from(text).toString('base64'), unprotect: value => Buffer.from(value, 'base64').toString(),
    openExternal: async () => {}, getTasks: () => box.tasks
  });
  sync.state = { ...sync.state, connected: true, email: 't@example.com', token: sync.protect(JSON.stringify({ refresh_token: 'r' })), since: '2026-11-01' };
  return { sync, google, box, dir };
}

const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const tasks = () => [
  { id: uuid(1), type: '할 일', title: '참여율 제출', done: false, dates: [{ date: '2026-12-27', label: '참여율 제출', kind: '까지', done: false }] },
  { id: uuid(2), type: '알아 둘 것', title: '보안 점검', done: false, dates: [{ date: '2026-12-30', label: '보안 점검', kind: '그날' }] },
  { id: uuid(3), type: '없음', title: '인사', done: false, dates: [] },
  { id: uuid(4), type: '할 일', title: '후보', candidate: { roomKey: 'r' }, done: false, dates: [{ date: '2026-12-28', label: '후보', kind: '그날' }] }
];

test('보낼 일정: 숨김·후보는 빼고, 연결 전에 끝난 일정도 뺀다', () => {
  const list = desiredEvents([...tasks(), { id: uuid(5), type: '할 일', title: '옛 일', done: false, dates: [{ date: '2026-10-01', label: '옛 일', kind: '그날' }] }], '2026-11-01');
  assert.deepEqual(list.map(e => [e.which, e.body.summary]), [['todo', '⏰참여율 제출'], ['info', '보안 점검']]);
});

test('모양: 교시는 제목 뒤, 시간은 시간 일정, 끝냄은 회색 ✓, 메모는 보내지 않는다', () => {
  const task = { id: uuid(9), type: '할 일', title: '협의', memo: '학생 이름', important: true, done: false, dates: [] };
  assert.equal(eventBody(task, { date: '2026-12-01', label: '협의', kind: '그날', time: '6교시' }).summary, '★협의 (6교시)');
  const timed = eventBody(task, { date: '2026-12-01', label: '협의', kind: '그날', time: '15:30' });
  assert.equal(timed.start.dateTime, '2026-12-01T15:30:00');
  assert.equal(timed.colorId, '11');
  assert.doesNotMatch(timed.description, /학생 이름/);
  const done = eventBody(task, { date: '2026-12-01', label: '협의', kind: '까지', done: true });
  assert.equal(done.summary, '✓협의');
  assert.equal(done.colorId, '8');
  assert.deepEqual(eventBody(task, { date: '2026-12-01', end: '2026-12-03', label: '주간', kind: '기간' }).end, { date: '2026-12-04' });
});

test('맞춰 놓기: 넣고, 다시 해도 그대로, 고치면 고치고, 숨기면 지운다', async () => {
  const { sync, google, box } = setup(tasks());
  await sync.push();
  assert.deepEqual(google.live().map(e => e.summary).sort(), ['⏰참여율 제출', '보안 점검']);
  const calls = google.db.calls.length;
  await sync.push();
  assert.equal(google.db.calls.filter((_, i) => i >= calls).filter(m => m !== 'GET').length, 0, '바뀐 게 없으면 쓰지 않는다');
  box.tasks = box.tasks.map(t => t.id === uuid(1) ? { ...t, dates: [{ ...t.dates[0], done: true }] } : t);
  await sync.push();
  assert.ok(google.live().some(e => e.summary === '✓참여율 제출'));
  box.tasks = box.tasks.map(t => t.id === uuid(2) ? { ...t, type: '없음' } : t);
  await sync.push();
  assert.deepEqual(google.live().map(e => e.summary), ['✓참여율 제출']);
});

test('구글에서 지운 일정은 되살리지 않고, 종류를 바꾸면 다른 캘린더로 옮긴다', async () => {
  const { sync, google, box } = setup(tasks());
  await sync.push();
  for (const cal of Object.values(google.db.calendars)) for (const ev of Object.values(cal.events)) if (ev.summary === '보안 점검') ev.status = 'cancelled';
  box.tasks = box.tasks.map(t => t.id === uuid(2) ? { ...t, dates: [{ ...t.dates[0], label: '보안 점검(변경)' }] } : t);
  await sync.push();
  assert.ok(!google.live().some(e => e.summary.startsWith('보안 점검')));
  box.tasks = box.tasks.map(t => t.id === uuid(1) ? { ...t, type: '알아 둘 것' } : t);
  await sync.push();
  assert.deepEqual(google.live(), [{ cal: '학교 알림', summary: '⏰참여율 제출' }]);
});

test('연결이 끝나면(invalid_grant) 연결 끊김으로 표시하고 다시 연결을 안내한다', async () => {
  const { sync } = setup(tasks());
  sync.fetch = async url => (url.includes('token')
    ? { ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }) }
    : { ok: true, status: 200, json: async () => ({}) });
  sync.access = null;
  await sync.sync();
  assert.equal(sync.view().connected, false);
  assert.match(sync.view().error, /다시 연결/);
});

test('앱 번호 파일이 없으면 기능을 숨긴다', () => {
  const { sync, dir } = setup([]);
  fs.rmSync(path.join(dir, 'google-client.json'));
  assert.equal(sync.view().available, false);
});

test('캘린더 삭제에 실패하면 연결을 유지하고 오류를 알린다', async () => {
  const { sync } = setup(tasks());
  await sync.push();
  let fail;
  sync.api = () => new Promise((_, reject) => { fail = reject; });
  const disconnect = sync.disconnect({ removeCalendars: true });
  await new Promise(resolve => setImmediate(resolve));
  let pushed = false;
  sync.push = async () => { pushed = true; };
  sync.schedule(0);
  await sync.sync();
  assert.equal(pushed, false);
  fail(Object.assign(new Error('request failed'), { status: 503 }));
  await assert.rejects(disconnect, /모두 지우지 못했습니다/);
  assert.equal(sync.view().connected, true);
});
