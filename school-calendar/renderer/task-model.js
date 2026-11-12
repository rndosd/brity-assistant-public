'use strict';

// 업무 한 건의 분류 구조. 저장(store.js)과 화면(app.js)이 함께 쓴다.
// 유형: 할 일 / 알아 둘 것 / 없음. 날짜 0~3개, 날짜마다 짧은 이름과 까지(□)·그날(●).
const taskModel = (() => {
  const TYPES = ['할 일', '알아 둘 것', '없음'];
  // 기간(━): 시작일~끝일. 여러 날 이어지는 행사·운영(○○ 주간, 수련회). 끝낼 □는 없다.
  const DATE_KINDS = ['까지', '그날', '기간'];
  const MAX_DATES = 3;
  const LABEL_MAX = 40;

  function validDate(value) {
    if (typeof value !== 'string' || !/^(?!0000)\d{4}-\d\d-\d\d$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(+date) && date.toISOString().slice(0, 10) === value;
  }

  function cleanLabel(value, fallback) {
    const text = (typeof value === 'string' ? value : '').replace(/[\u0000-\u001f]+/g, ' ').trim();
    return (text || fallback || '').slice(0, LABEL_MAX).trim();
  }

  // 들어온 날짜 목록을 정리한다. strict이면 틀린 값에서 멈추고, 아니면 틀린 줄은 버린다(AI 답).
  function normalizeDates(list, fallbackLabel, strict = false) {
    if (!Array.isArray(list)) {
      if (strict) throw new Error('dates');
      return [];
    }
    const result = [];
    for (const item of list) {
      const ok = item && validDate(item.date) && DATE_KINDS.includes(item.kind);
      if (!ok) {
        if (strict) throw new Error('dates');
        continue;
      }
      // 기간: date가 시작, end가 끝(시작보다 뒤). AI가 끝을 틀리게 주면 시작일 하루(그날)로 남긴다.
      let kind = item.kind;
      const spans = kind === '기간' && validDate(item.end) && item.end > item.date;
      if (kind === '기간' && !spans) {
        if (strict) throw new Error('dates');
        kind = '그날';
      }
      const entry = { date: item.date, label: cleanLabel(item.label, fallbackLabel), kind, ...(spans && { end: item.end }) };
      if (!entry.label) {
        if (strict) throw new Error('label');
        continue;
      }
      if (entry.kind === '까지') entry.done = item.done === true;
      if (result.some(other => other.date === entry.date && other.kind === entry.kind)) continue;
      result.push(entry);
    }
    if (strict && result.length > MAX_DATES) throw new Error('dates');
    // 넷 이상이면 가까운 셋만 남긴다.
    return result.sort((a, b) => a.date.localeCompare(b.date)).slice(0, MAX_DATES);
  }

  // 날짜 한 줄의 마지막 날. 기간이면 끝일, 아니면 그날.
  function lastDay(entry) {
    return entry.kind === '기간' && entry.end ? entry.end : entry.date;
  }

  function isLegacy(task) {
    return !!task && !TYPES.includes(task.type) && typeof task.category === 'string';
  }

  // 옛 구조(category·kind·due·done)를 새 구조로 옮긴다. UI-수정안 6절.
  function fromLegacy(task) {
    if (!isLegacy(task)) return task;
    const { category, kind, due, done, privacyHold, ...rest } = task;
    const label = cleanLabel(task.title, '업무');
    let type = '할 일';
    let dates = [];
    if (category === '인사') type = '없음';
    else if (category === '참고') {
      type = '알아 둘 것';
      if (validDate(due)) dates = [{ date: due, label, kind: '그날' }];
    } else if (validDate(due)) {
      dates = [kind === '참석' ? { date: due, label, kind: '그날' } : { date: due, label, kind: '까지', done: done === true }];
    }
    return {
      ...rest, type, dates,
      done: type === '할 일' && !dates.length ? done === true : false,
      reply: category === '할 일' && kind === '회신', replied: false, uncertain: false
    };
  }

  // AI 답을 새 구조로 바꾼다. 새 형식(type·dates)과 옛 형식(category·kind·due)을 모두 받는다.
  function fromResult(result, fallbackTitle) {
    if (!result || typeof result !== 'object') throw new Error('result');
    const title = typeof result.title === 'string' && result.title.trim() ? result.title.trim().replace(/[\r\n]+/g, ' ').slice(0, 180) : fallbackTitle;
    const summary = typeof result.summary === 'string' ? result.summary.trim().slice(0, 4000) : '';
    if (TYPES.includes(result.type)) {
      const dates = result.type === '없음' ? [] : normalizeDates(result.dates, title);
      // 버린 날짜가 있으면 선생님이 확인하도록 표시한다.
      const dropped = result.type !== '없음' && Array.isArray(result.dates) && dates.length < Math.min(result.dates.length, MAX_DATES);
      return { type: result.type, title, summary, dates, reply: result.reply === true, uncertain: result.uncertain === true || dropped };
    }
    if (['할 일', '참고', '인사'].includes(result.category)) {
      if (result.due !== null && result.due !== undefined && result.due !== '' && !validDate(result.due)) throw new Error('due');
      const moved = fromLegacy({ category: result.category, kind: result.kind, due: validDate(result.due) ? result.due : null, title, done: false });
      return { type: moved.type, title, summary, dates: moved.dates, reply: moved.reply, uncertain: false };
    }
    throw new Error('result');
  }

  // 체크할 수 있는 □ 목록. 까지 날짜마다 하나, 날짜 없는 할 일은 업무 전체에 하나.
  function boxes(task) {
    if (task.type !== '할 일') return [];
    const dated = (task.dates || []).map((entry, index) => ({ index, entry })).filter(({ entry }) => entry.kind === '까지')
      .map(({ index, entry }) => ({ index, done: entry.done === true }));
    if (dated.length || (task.dates || []).length) return dated;
    return [{ index: null, done: task.done === true }];
  }

  function finished(task) {
    const list = boxes(task);
    return list.length > 0 && list.every(box => box.done);
  }

  // 상시(pinned): 선생님이 직접 켠 할 일. 남은 □가 있는 동안 목록 맨 위 "상시" 묶음에 늘 보인다.
  function isPinned(task) {
    return task.pinned === true && task.type === '할 일' && !finished(task);
  }

  // 상시 줄에 붙일 기준 날짜: 남은 까지 가운데 가장 이른 것, 없으면 오늘 뒤의 가장 이른 그날.
  function pinnedDue(task, today) {
    const dates = (task.dates || []).slice().sort((a, b) => a.date.localeCompare(b.date));
    return dates.find(entry => entry.kind === '까지' && !entry.done) || dates.find(entry => lastDay(entry) >= today) || null;
  }

  // "이영덕 외 48" → 49, "홍길동" → 1, 알 수 없으면 null.
  function recipientCount(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    const more = value.match(/외\s*(\d+)\s*명?/);
    if (more) return Number(more[1]) + 1;
    return value.split(/[,;]/).map(part => part.trim()).filter(Boolean).length || null;
  }

  return { TYPES, DATE_KINDS, MAX_DATES, LABEL_MAX, validDate, normalizeDates, lastDay, isLegacy, fromLegacy, fromResult, boxes, finished, isPinned, pinnedDue, recipientCount };
})();

if (typeof module !== 'undefined') module.exports = taskModel;
