'use strict';

const { splitReply } = require('./renderer/note-view');

function buildWorkPrompt(task, note) {
  const sections = [
    '아래 자료를 참고해 학교 업무를 도와주세요. 해야 할 일과 기한을 정리하고, 진행에 필요한 초안이나 체크리스트를 만들어 주세요. 자료에 없는 사실은 추정하지 말고 확인이 필요한 점을 알려 주세요.',
    [`업무: ${task.title}`, ...(task.dates || []).map(entry => `${entry.kind === '까지' ? '기한' : entry.kind === '기간' ? '기간' : '날짜'}: ${entry.date}${entry.end ? `~${entry.end}` : ''}${entry.kind === '까지' ? '까지' : ''} ${entry.label}`),
      task.reply && '답장 필요', task.summary && `기존 정리: ${task.summary}`].filter(Boolean).join('\n'),
  ];
  if (note?.body) {
    const parts = splitReply(note.body);
    const content = parts ? [
      parts.reply && `회신\n${parts.reply}`,
      [parts.subject ? `이전 안내 · ${parts.subject}` : '이전 안내', parts.message].join('\n'),
    ].filter(Boolean).join('\n\n') : note.body;
    const label = note.verified === false ? '쪽지 참고 자료 (원문 확인 필요)' : '쪽지 참고 자료';
    sections.push(`${label}\n${content}`);
  }
  return sections.join('\n\n');
}

module.exports = { buildWorkPrompt };
