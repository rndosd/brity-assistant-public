'use strict';

// 구글 캘린더로 보내기(한 방향: 앱 → 구글, 2026-11-20).
// 앱의 할 일·확인할 것을 사용자 구글 계정의 "학교 할 일"·"학교 알림" 캘린더에 넣고 고치고 지운다.
// 권한은 calendar.app.created(앱이 만든 캘린더만)라 사용자의 다른 일정은 건드릴 수 없다.
// 구글에서 고친 것은 다음 보내기 때 앱 내용으로 덮고, 구글에서 지운 일정은 되살리지 않는다.
// 앱 번호(google-client.json)는 저장소에 넣지 않고 배포 ZIP을 만들 때만 넣는다. 없으면 이 기능을 숨긴다.

const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { checkable, manualLoose } = require('./renderer/task-model');

const SCOPES = ['https://www.googleapis.com/auth/calendar.app.created', 'openid', 'email'];
const API = 'https://www.googleapis.com/calendar/v3';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

const RULES = {
  calendars: {
    todo: { name: '학교 할 일', description: '학교 업무 캘린더 앱이 넣는 할 일입니다. 고칠 때는 앱에서 고쳐 주세요.' },
    info: { name: '학교 알림', description: '학교 업무 캘린더 앱이 넣는 확인할 것입니다. 고칠 때는 앱에서 고쳐 주세요.' }
  },
  mark: { done: '✓', important: '★', deadline: '⏰' },
  color: { important: '11', done: '8' }, // 11 토마토(빨강), 8 흑연(회색)
  reminders: { deadline: [960], allDay: [360], timed: [30], info: [], done: [] }, // 분 전. 960=전날 8시, 360=전날 18시
  timedMinutes: 60,
  footer: '학교 업무 캘린더에서 보냄 · 고칠 때는 앱에서 고쳐 주세요.',
  timeZone: 'Asia/Seoul'
};

function addDays(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const lastDay = entry => (entry.kind === '기간' && entry.end ? entry.end : entry.date);
function clock(time) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time || '');
  return m && +m[1] < 24 && +m[2] < 60 ? `${m[1].padStart(2, '0')}:${m[2]}` : null;
}
function plusMinutes(day, hhmm, minutes) {
  const [h, m] = hhmm.split(':').map(Number);
  const total = h * 60 + m + minutes;
  const rest = total % 1440;
  return `${addDays(day, Math.floor(total / 1440))}T${String(Math.floor(rest / 60)).padStart(2, '0')}:${String(rest % 60).padStart(2, '0')}:00`;
}
function seoulToday() {
  return new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
}

function eventBody(task, entry) {
  const done = task.type === '할 일' && (checkable(entry) ? entry.done === true : task.done === true);
  const important = task.important === true || task.pinned === true;
  const hhmm = clock(entry.time);
  const label = entry.label || task.title;
  let mark = '';
  if (done) mark = RULES.mark.done;
  else {
    if (important) mark += RULES.mark.important;
    if (entry.kind === '까지') mark += RULES.mark.deadline;
  }
  // "6교시" 같은 글자 시간은 제목이 잘리지 않게 뒤에 붙인다.
  const summary = `${mark}${label}${entry.time && !hhmm ? ` (${entry.time})` : ''}`;
  const lines = [];
  if (task.title && task.title !== label) lines.push(task.title);
  lines.push('', RULES.footer);
  let start, end;
  if (hhmm && entry.kind !== '기간') {
    start = { dateTime: `${entry.date}T${hhmm}:00`, timeZone: RULES.timeZone };
    end = { dateTime: plusMinutes(entry.date, hhmm, RULES.timedMinutes), timeZone: RULES.timeZone };
  } else {
    start = { date: entry.date };
    end = { date: addDays(lastDay(entry), 1) };
  }
  let reminders;
  if (done) reminders = RULES.reminders.done;
  else if (task.type === '알아 둘 것') reminders = RULES.reminders.info;
  else if (start.dateTime) reminders = RULES.reminders.timed;
  else if (entry.kind === '까지') reminders = RULES.reminders.deadline;
  else reminders = RULES.reminders.allDay;
  const colorId = done ? RULES.color.done : important ? RULES.color.important : null;
  return {
    summary, description: lines.join('\n').trim(), start, end, transparency: 'transparent',
    ...(colorId && { colorId }),
    reminders: { useDefault: false, overrides: reminders.map(minutes => ({ method: 'popup', minutes })) }
  };
}

// 앱 업무 → 구글에 있어야 할 일정 목록. 숨긴 업무(없음)와 올리지 않은 대화방 후보는 뺀다.
// from은 처음 연결한 날: 그 전에 끝난 일정은 보내지 않고, 날이 지나도 이미 보낸 일정은 지우지 않는다.
function desiredEvents(tasks, from = seoulToday()) {
  const out = [];
  for (const task of tasks) {
    if (task.candidate) continue; // 올리면 candidate가 빠진다(store.js)
    if (task.type !== '할 일' && task.type !== '알아 둘 것') continue;
    const which = task.type === '할 일' ? 'todo' : 'info';
    (task.dates || []).forEach((entry, index) => {
      if (!entry?.date || manualLoose(task, entry) || lastDay(entry) < from) return;
      const key = `${task.id}:${index}`;
      out.push({ key, which, body: { ...eventBody(task, entry), extendedProperties: { private: { schoolCalendarKey: key } } } });
    });
  }
  return out;
}

const digest = body => crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 16);

class GoogleCalendarSync {
  constructor({ dataDir, clientFile, protect, unprotect, openExternal, getTasks, onChange, fetchImpl = fetch }) {
    this.file = path.join(dataDir, 'google-calendar.json');
    this.clientFile = clientFile;
    this.protect = protect;
    this.unprotect = unprotect;
    this.openExternal = openExternal;
    this.getTasks = getTasks;
    this.onChange = onChange || (() => {});
    this.fetch = fetchImpl;
    this.state = { connected: false, email: null, token: null, calendars: {}, events: {}, lastSync: null, error: null };
    this.timer = null;
    this.running = null;
    this.again = false;
    this.connecting = null;
    this.disconnecting = null;
    this.access = null;
    try { this.state = { ...this.state, ...JSON.parse(fsSync.readFileSync(this.file, 'utf8')) }; } catch {}
  }

  client() {
    try {
      const raw = JSON.parse(fsSync.readFileSync(this.clientFile, 'utf8'));
      const c = raw.installed || raw;
      return c.client_id ? c : null;
    } catch { return null; }
  }

  view() {
    return {
      available: !!this.client(),
      connected: this.state.connected,
      email: this.state.email,
      lastSync: this.state.lastSync,
      error: this.state.error,
      busy: !!this.running || !!this.connecting || !!this.disconnecting,
      counts: { events: Object.values(this.state.events || {}).filter(rec => !rec.gone).length }
    };
  }

  async save() {
    const tmp = `${this.file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.state, null, 1));
    await fs.rename(tmp, this.file);
  }

  // ---- 연결 ----
  connect() {
    if (this.disconnecting) return Promise.reject(new Error('연결을 끊는 중입니다.'));
    if (this.connecting) return this.connecting;
    this.connecting = this.authorize().finally(() => { this.connecting = null; this.onChange(); });
    this.onChange();
    return this.connecting;
  }

  async authorize() {
    const c = this.client();
    if (!c) throw new Error('이 판에는 구글 캘린더 연결이 준비되지 않았습니다.');
    const verifier = crypto.randomBytes(48).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const stateValue = crypto.randomBytes(16).toString('hex');
    const server = http.createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const redirect = `http://127.0.0.1:${server.address().port}`;
    const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
      client_id: c.client_id, redirect_uri: redirect, response_type: 'code', scope: SCOPES.join(' '),
      code_challenge: challenge, code_challenge_method: 'S256', access_type: 'offline', prompt: 'consent', state: stateValue
    });
    const code = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('5분 안에 허용하지 않아 연결을 멈췄습니다.')), 5 * 60e3);
      server.on('request', (req, res) => {
        const q = new URL(req.url, redirect).searchParams;
        if (!q.has('code') && !q.has('error')) { res.writeHead(404).end(); return; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(q.get('code') ? '<meta charset="utf-8"><p style="font:16px sans-serif">구글 캘린더에 연결했습니다. 이 창은 닫고 캘린더 앱으로 돌아가세요.</p>'
          : '<meta charset="utf-8"><p style="font:16px sans-serif">연결하지 않았습니다. 캘린더 앱으로 돌아가세요.</p>');
        clearTimeout(timer);
        if (q.get('state') !== stateValue) reject(new Error('연결 확인 값이 맞지 않습니다. 다시 연결해 주세요.'));
        else if (q.get('error')) reject(new Error(q.get('error') === 'access_denied'
          ? '구글 계정 연결이 허용되지 않았습니다. 학교 계정이라면 관리자에게 외부 앱 연결이 가능한지 확인해 주세요.' : `구글이 연결을 거절했습니다(${q.get('error')}).`));
        else resolve(q.get('code'));
      });
    });
    try {
      await this.openExternal(url);
      const token = await this.tokenRequest({
        client_id: c.client_id, ...(c.client_secret && { client_secret: c.client_secret }),
        code: await code, code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: redirect
      });
      if (!token.refresh_token) throw new Error('구글이 오래 쓰는 열쇠를 주지 않았습니다. 다시 연결해 주세요.');
      let email = null;
      try { email = JSON.parse(Buffer.from(token.id_token.split('.')[1], 'base64url').toString()).email || null; } catch {}
      const sameAccount = this.state.email && email && this.state.email === email;
      this.state = {
        ...this.state, connected: true, email, error: null,
        token: this.protect(JSON.stringify({ refresh_token: token.refresh_token })),
        ...(sameAccount ? {} : { calendars: {}, events: {}, since: seoulToday() })
      };
      this.access = { token: token.access_token, until: Date.now() + (token.expires_in - 60) * 1000 };
      await this.save();
    } finally {
      server.close();
    }
    this.schedule(0);
  }

  disconnect(options) {
    if (this.disconnecting) return this.disconnecting;
    this.disconnecting = this.finishDisconnect(options).finally(() => { this.disconnecting = null; this.onChange(); });
    this.onChange();
    return this.disconnecting;
  }

  async finishDisconnect({ removeCalendars = false } = {}) {
    clearTimeout(this.timer);
    await this.running?.catch(() => {});
    clearTimeout(this.timer);
    if (removeCalendars && this.state.connected) {
      for (const id of Object.values(this.state.calendars || {})) {
        try {
          await this.api('DELETE', `/calendars/${encodeURIComponent(id)}`);
        } catch (error) {
          if (error.status !== 404 && error.status !== 410) {
            throw new Error('구글의 학교 캘린더를 모두 지우지 못했습니다. 연결을 유지했으니 다시 시도해 주세요.');
          }
        }
      }
    }
    try {
      const refresh = JSON.parse(this.unprotect(this.state.token)).refresh_token;
      await this.fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(refresh)}`, { method: 'POST' }).catch(() => {});
    } catch {}
    this.access = null;
    this.state = removeCalendars
      ? { connected: false, email: null, token: null, calendars: {}, events: {}, lastSync: null, error: null }
      : { ...this.state, connected: false, token: null, lastSync: null, error: null };
    await this.save();
  }

  async tokenRequest(body) {
    const res = await this.fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const error = new Error(data.error === 'invalid_grant' ? '구글 연결이 끝났습니다. 다시 연결해 주세요.' : `구글 연결 오류(${data.error || res.status})`);
      error.expired = data.error === 'invalid_grant';
      throw error;
    }
    return data;
  }

  async accessToken() {
    if (this.access && Date.now() < this.access.until) return this.access.token;
    const c = this.client();
    let refresh;
    try { refresh = JSON.parse(this.unprotect(this.state.token)).refresh_token; } catch {
      const error = new Error('구글 연결 정보를 읽지 못했습니다. 다시 연결해 주세요.');
      error.expired = true;
      throw error;
    }
    const token = await this.tokenRequest({ client_id: c.client_id, ...(c.client_secret && { client_secret: c.client_secret }), refresh_token: refresh, grant_type: 'refresh_token' });
    this.access = { token: token.access_token, until: Date.now() + (token.expires_in - 60) * 1000 };
    return this.access.token;
  }

  async api(method, url, body) {
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetch(API + url, {
        method,
        headers: { Authorization: `Bearer ${await this.accessToken()}`, ...(body && { 'Content-Type': 'application/json' }) },
        body: body && JSON.stringify(body),
        signal: AbortSignal.timeout(20000)
      });
      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** attempt));
        continue;
      }
      if (res.status === 401 && attempt === 0) { this.access = null; continue; }
      if (res.status === 204) return null;
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        const error = new Error(`구글 캘린더 오류(${res.status})`);
        error.status = res.status;
        throw error;
      }
      return data;
    }
  }

  // ---- 보내기 ----
  schedule(delay = 5000) {
    if (this.disconnecting || !this.state.connected || !this.client()) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.sync().catch(() => {}), delay);
  }

  sync() {
    if (this.disconnecting || !this.state.connected) return Promise.resolve();
    if (this.running) { this.again = true; return this.running; }
    this.running = this.push().then(async () => {
      this.state.error = null;
      this.state.lastSync = new Date().toISOString();
    }, async error => {
      this.state.error = error.message || '구글 캘린더에 보내지 못했습니다.';
      if (error.expired) { this.state.connected = false; this.access = null; }
      else this.timer = setTimeout(() => void this.sync().catch(() => {}), 10 * 60e3); // 잠깐 오류: 10분 뒤 다시
    }).finally(async () => {
      this.running = null;
      await this.save().catch(() => {});
      this.onChange();
      if (this.again) { this.again = false; this.schedule(1000); }
    });
    this.onChange();
    return this.running;
  }

  async ensureCalendars() {
    for (const [which, spec] of Object.entries(RULES.calendars)) {
      const id = this.state.calendars[which];
      if (id && this.checkedCalendars?.has(id)) continue;
      if (id) {
        try {
          const cal = await this.api('GET', `/calendars/${encodeURIComponent(id)}`);
          if (cal.summary !== spec.name) await this.api('PATCH', `/calendars/${encodeURIComponent(id)}`, { summary: spec.name, description: spec.description });
          (this.checkedCalendars ??= new Set()).add(id);
          continue;
        } catch (error) {
          if (error.status !== 404) throw error;
          for (const [key, rec] of Object.entries(this.state.events)) if (rec.which === which) delete this.state.events[key];
        }
      }
      const cal = await this.api('POST', '/calendars', { summary: spec.name, description: spec.description, timeZone: RULES.timeZone });
      this.state.calendars[which] = cal.id;
      (this.checkedCalendars ??= new Set()).add(cal.id);
      await this.save();
    }
  }

  async push() {
    this.state.calendars ||= {};
    this.state.events ||= {};
    await this.ensureCalendars();
    const events = desiredEvents(this.getTasks(), this.state.since || seoulToday());
    const wanted = new Set();
    const ignore = error => { if (![404, 410].includes(error.status)) throw error; };
    for (const event of events) {
      wanted.add(event.key);
      const hash = digest(event.body);
      let rec = this.state.events[event.key];
      if (rec?.gone) continue;
      if (rec && rec.which !== event.which) {
        await this.api('DELETE', `/calendars/${encodeURIComponent(this.state.calendars[rec.which])}/events/${rec.id}`).catch(ignore);
        delete this.state.events[event.key];
        rec = null;
      }
      const calendarId = encodeURIComponent(this.state.calendars[event.which]);
      if (!rec) {
        const made = await this.api('POST', `/calendars/${calendarId}/events`, event.body);
        this.state.events[event.key] = { id: made.id, which: event.which, hash };
      } else if (rec.hash !== hash) {
        const live = await this.api('GET', `/calendars/${calendarId}/events/${rec.id}`).catch(error => (error.status === 404 || error.status === 410 ? null : Promise.reject(error)));
        if (!live || live.status === 'cancelled') rec.gone = true;
        else { await this.api('PUT', `/calendars/${calendarId}/events/${rec.id}`, event.body); rec.hash = hash; }
      } else continue;
      await this.save();
    }
    for (const [key, rec] of Object.entries(this.state.events)) {
      if (wanted.has(key)) continue;
      if (!rec.gone) await this.api('DELETE', `/calendars/${encodeURIComponent(this.state.calendars[rec.which])}/events/${rec.id}`).catch(ignore);
      delete this.state.events[key];
      await this.save();
    }
  }
}

module.exports = { GoogleCalendarSync, desiredEvents, eventBody, RULES, SCOPES };
