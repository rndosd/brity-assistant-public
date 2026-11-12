'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');

const today = new Date();
const month = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
const root = path.join(__dirname, '.demo', month);
const dataDir = path.join(root, 'data');
const inboxDir = path.join(root, 'inbox');

function day(offset) {
  const monthEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  const anchor = Math.min(monthEnd - 8, Math.max(6, today.getDate()));
  return `${month}-${String(anchor + offset).padStart(2, '0')}`;
}

const election = [
  '학급 임원 선거 결과를 보냅니다. 첨부한 집계표를 확인해 주세요.',
  '---------',
  'Original Message',
  ' ---------',
  'Sender\n : 샘플 교무부 <office@example.test>',
  `Date\n : ${day(-4)} 12:49 (GMT+9)`,
  'Title\n : 학급 임원 선거 안내',
  'To\n : ' + Array.from({ length: 10 }, (_, i) => `가상 수신자 ${i + 1}<recipient${i + 1}@example.test>`).join(', '),
  '선생님 안녕하세요.',
  '',
  `학급 임원 선거는 ${day(1)}에 진행합니다. 각 학급에서 회장과 부회장을 선출해 주세요.`,
  `양식에 후보별 득표수와 무효표를 적어 ${day(2)}까지 회신해 주세요.`,
].join('\n');

const samples = [
  { title: '학급 임원 선거 결과', received: -1, due: 2, kind: '회신', body: election, summary: `${day(2)}까지 후보별 득표수와 무효표를 적은 결과 양식을 회신합니다.`, attachment: true },
  { title: '체험학습 계획서 제출', received: -5, due: 2, kind: '제출', body: '반별 체험학습 계획서를 작성하고 참가 인원과 이동 방법을 확인해 제출해 주세요.' },
  { title: '수업 나눔 협의 참석', received: -2, due: 3, kind: '참석', body: '방과 후 15시 30분에 시청각실에서 수업 나눔을 진행합니다. 협의회에 참석해 주세요.' },
  { title: '학년 행사 인원 회신', received: -4, due: 1, kind: '회신', body: '다음 학년 행사에 참가할 반별 인원을 확인해 회신해 주세요.' },
  { title: '독서 주간 운영안 제출', received: 0, due: 7, kind: '제출', body: '반별 독서 활동 계획과 필요한 책을 정리하여 제출해 주세요.' },
  { title: '기자재 점검표 제출', received: -5, due: -2, kind: '제출', body: '교실 기자재를 확인하고 점검표를 제출해 주세요.' },
  { title: '도서관 휴관', received: -3, due: 2, category: '참고', body: '자료 정리로 하루 동안 도서관이 휴관합니다. 대출은 다음 날부터 가능합니다.' },
  { title: '강당 바닥 공사', received: -2, due: 6, category: '참고', body: '강당 바닥 공사일에는 강당을 이용할 수 없습니다.' },
  { title: '교직원 연수 자료', received: 0, category: '참고', body: '연수 자료는 교내 공유 폴더에 올려 두었습니다.' },
  { title: '교실 게시물 정비', received: 0, body: '교실 게시물 상태를 확인해 주세요. 마감 일정은 별도로 안내드리겠습니다.' },
  { title: '방과후 교실 확인', received: -1, verified: false, body: '방과후 수업에 사용할 교실을 확인해 주세요.' },
  { title: '급식 알레르기 조사', received: -5, due: -1, kind: '제출', done: true, body: '반별로 조사표를 작성해 제출해 주세요.' },
  { title: '자료 확인 인사', received: 0, category: '인사', body: '보내 주신 가상 자료를 확인했습니다. 감사합니다.' },
  { title: '교실 환경 정리', due: 5, manual: true },
];

// 대화방 후보함 샘플(8단계). 가상 대화 두 방. 업무방에는 이미 올린 회의가 하나 있고, 그 회의를 바꾸는 말이 온다.
// 이미 만든 샘플 폴더에도 data/chats가 없으면 더한다.
const spoken = value => `${Number(value.slice(5, 7))}월 ${Number(value.slice(8, 10))}일`;
const ago = minutes => new Date(Date.now() - minutes * 60_000).toISOString();
const roomHash = roomKey => createHash('sha256').update(roomKey).digest('hex');
const chatRooms = () => [
  { roomKey: 'demo-room-grade', roomTitle: '샘플 4학년 협의방', messages: [
    [190, `다음 학년 협의회는 ${spoken(day(3))} 오후 3시 어떨까요?`],
    [189, '좋습니다.'],
    [188, '그럼 그 시간으로 확정하겠습니다.'],
    [187, `현장체험학습 동의서는 ${spoken(day(4))}까지 회수해 주세요.`],
    [186, '네 알겠습니다!'],
    [60, '오늘 점심 맛있었어요 ㅎㅎ'],
    [59, `과학실 사용 신청서는 ${spoken(day(5))}까지 제출해 주세요.`]
  ] },
  { roomKey: 'demo-room-office', roomTitle: '샘플 교무 업무방', messages: [
    [2000, `교육과정 협의회는 ${spoken(day(2))} 오후 2시로 확정합니다.`],
    [30, `교육과정 협의회는 ${spoken(day(6))} 오후 2시로 변경되었습니다.`],
    [29, '확인했습니다.']
  ] }
];

async function seedDemoChats(tasksFile) {
  const chats = path.join(dataDir, 'chats');
  if (await fs.stat(chats).catch(error => { if (error.code !== 'ENOENT') throw error; })) return;
  await fs.mkdir(chats, { recursive: true });
  for (const room of chatRooms()) {
    await fs.writeFile(path.join(chats, `${roomHash(room.roomKey)}.json`), JSON.stringify({
      version: 1, roomKey: room.roomKey, roomTitle: room.roomTitle,
      messages: room.messages.map(([minutes, text]) => ({ observedAt: ago(minutes), text }))
    }));
  }
  // 업무방의 첫 회의는 선생님이 이미 올린 것으로 둔다(변경 후보가 고칠 대상).
  const saved = JSON.parse(await fs.readFile(tasksFile, 'utf8'));
  const tasks = Array.isArray(saved) ? saved : saved.tasks;
  const due = day(2);
  tasks.push({
    id: randomUUID(), noteId: null, title: '교육과정 협의회', type: '할 일', dates: [{ date: due, label: '교육과정 협의회', kind: '그날', time: '6교시' }],
    done: false, reply: false, replied: false, uncertain: false, summary: '', memo: '', refined: 'none', chats: [], autoPending: false, revision: 1,
    chatSource: {
      roomKey: roomHash('demo-room-office'), roomTitle: '샘플 교무 업무방', batchId: '0'.repeat(64),
      subject: '교육과정 협의회', kind: 'event', action: 'confirmed', due, time: '14:00', detail: null, observedAt: ago(2000), previousDue: null, previousTime: null
    }
  });
  await fs.writeFile(tasksFile, JSON.stringify(Array.isArray(saved) ? tasks : { ...saved, tasks }, null, 2));
}

// 기간 샘플(2026-11-12): 독서 주간(할 일)과 겹치는 상담 주간, 이미 시작한 체육관 공사(알아 둘 것). 기간 업무가 없을 때만 더한다.
async function seedDemoSpans(tasksFile) {
  const saved = JSON.parse(await fs.readFile(tasksFile, 'utf8'));
  const tasks = Array.isArray(saved) ? saved : saved.tasks;
  if (tasks.some(task => (task.dates || []).some(entry => entry.kind === '기간'))) return;
  const span = (title, type, start, end) => ({
    id: randomUUID(), noteId: null, title, type, dates: [{ date: day(start), end: day(end), label: title, kind: '기간' }],
    done: false, reply: false, replied: false, uncertain: false, summary: '', memo: '', refined: 'none', chats: [], autoPending: false, revision: 0
  });
  tasks.push(span('독서 주간', '할 일', 1, 5), span('학부모 상담 주간', '할 일', 3, 8), span('체육관 바닥 공사', '알아 둘 것', -3, 1));
  await fs.writeFile(tasksFile, JSON.stringify(Array.isArray(saved) ? tasks : { ...saved, tasks }, null, 2));
}

// 같은 업무 쪽지 두 번(2026-11-12): 전교직원 회의 안내와 재안내. 달력·목록에는 한 줄로 묶여 보인다. 없을 때만 더한다.
async function seedDemoDuplicates(tasksFile) {
  const saved = JSON.parse(await fs.readFile(tasksFile, 'utf8'));
  const tasks = Array.isArray(saved) ? saved : saved.tasks;
  if (tasks.some(task => task.noteId === 'demo-meeting-1')) return;
  const notes = path.join(inboxDir, 'notes');
  await fs.mkdir(notes, { recursive: true });
  const meeting = day(4);
  const copies = [
    { noteId: 'demo-meeting-1', title: '전교직원 회의 안내', received: -3, label: '전교직원 회의', body: `${spoken(meeting)} 15시 30분 시청각실에서 전교직원 회의가 있습니다.` },
    { noteId: 'demo-meeting-2', title: '[재안내] 전교직원 회의 개최', received: -1, label: '전교직원 회의 (시청각실)', body: `다시 안내드립니다. ${spoken(meeting)} 15시 30분 전교직원 회의에 참석해 주세요.` }
  ];
  for (const copy of copies) {
    await fs.writeFile(path.join(notes, `${copy.noteId}.json`), JSON.stringify({ id: copy.noteId, title: copy.title, sender: '샘플 교무부', datetime: `${day(copy.received)} 09:30`, body: copy.body, verified: true, saved: [] }));
    tasks.push({
      id: randomUUID(), noteId: copy.noteId, title: copy.title, type: '할 일', dates: [{ date: meeting, label: copy.label, kind: '그날', time: '15:30' }],
      datetime: `${day(copy.received)} 09:30`, done: false, reply: false, replied: false, uncertain: false, summary: '', memo: '', refined: 'none', chats: [], autoPending: false, revision: 0
    });
  }
  await fs.writeFile(tasksFile, JSON.stringify(Array.isArray(saved) ? tasks : { ...saved, tasks }, null, 2));
}

async function seedDemo() {
  const tasksFile = path.join(dataDir, 'tasks.json');
  if (await fs.stat(tasksFile).catch(error => { if (error.code !== 'ENOENT') throw error; })) {
    await seedDemoChats(tasksFile);
    await seedDemoSpans(tasksFile);
    return seedDemoDuplicates(tasksFile);
  }
  const notes = path.join(inboxDir, 'notes');
  await fs.mkdir(notes, { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  const tasks = [];
  for (const [index, sample] of samples.entries()) {
    const noteId = sample.manual ? null : `demo-${index + 1}`;
    const due = sample.due === undefined ? null : day(sample.due);
    const summary = sample.summary || (due && noteId && sample.category !== '참고' ? `${due}까지 ${sample.title} 업무를 확인합니다.` : '');
    tasks.push({ id: randomUUID(), noteId, title: sample.title, due, category: sample.category || '할 일', kind: sample.kind || '기타', summary, refined: summary ? 'done' : 'none', done: !!sample.done, chats: [], autoPending: false, revision: 0 });
    if (!noteId) continue;
    const saved = [];
    if (sample.attachment) {
      const folder = path.join(inboxDir, 'files', noteId);
      const name = '샘플 선거 결과.txt';
      const file = path.join(folder, name);
      await fs.mkdir(folder, { recursive: true });
      await fs.writeFile(file, '가상 자료\n후보 A: 12표\n후보 B: 8표\n무효: 1표\n');
      saved.push({ name, path: file });
    }
    await fs.writeFile(path.join(notes, `${noteId}.json`), JSON.stringify({ id: noteId, title: sample.title, sender: '샘플 교무부', datetime: `${day(sample.received)} 09:30`, body: sample.body, verified: sample.verified !== false, saved }));
  }
  const staging = `${tasksFile}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(staging, JSON.stringify(tasks, null, 2));
    await fs.rename(staging, tasksFile);
  } finally {
    await fs.unlink(staging).catch(() => {});
  }
  await seedDemoChats(tasksFile);
  await seedDemoSpans(tasksFile);
  await seedDemoDuplicates(tasksFile);
}

function listChatRooms() {
  return chatRooms().map(({ roomTitle: label }) => ({ key: roomHash(label), label }));
}

module.exports = { dataDir, inboxDir, seedDemo, listChatRooms };
