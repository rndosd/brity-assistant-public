'use strict';

(() => {
  const dialog = $('batch-dialog');
  const dateInput = $('batch-date');
  const list = $('batch-rows');
  const save = $('batch-save');
  const selectAll = $('batch-select-all');
  const complete = $('batch-complete');
  const drafts = new Map();
  const selected = new Set();
  let controls = [];
  let week = false;
  let saving = false;
  let paused = false;
  let returningTo = null;

  const rowKey = (task, index) => `${task.id}:${index}`;
  const dayNames = { task: '마감', event: '일정', loose: '기한 없음', span: '기간', ref: '확인할 것' };

  function calendarRows(first, last) {
    const today = key(new Date());
    const rows = [];
    for (const task of state.snapshot.tasks) {
      if (task.type === '없음' || task.candidate) continue;
      const reference = task.type === '알아 둘 것';
      task.dates.forEach((entry, index) => {
        const date = rolledDay(task, entry, today);
        const end = lastDay(entry);
        if (date > last || (entry.kind === '기간' ? end < first : date < first)) return;
        rows.push({ task, entry, index, day: date < first ? first : date, label: entry.label,
          reference, checkable: reference || checkable(entry), closed: reference ? !!task.referenceSeen : !!entry.done });
      });
      if (!reference && !task.dates.length && !task.done && today >= first && today <= last) {
        rows.push({ task, index: null, day: today, label: task.title, reference: false, checkable: true, closed: false });
      }
    }
    return rows.sort((a, b) => a.day.localeCompare(b.day) || Number(a.closed) - Number(b.closed) ||
      timeOrder(a.entry?.time) - timeOrder(b.entry?.time) || a.label.localeCompare(b.label, 'ko'));
  }

  function originalValue(row, field) {
    if (field === 'done' || field === 'seen') return row.closed;
    if (field === 'date' && looseEntry(row.task, row.entry)) return '';
    return row.entry?.[field] ?? '';
  }

  function editRow(row, field, value) {
    const index = field === 'seen' ? 0 : row.index;
    const id = rowKey(row.task, index);
    const draft = drafts.get(id) || { id: row.task.id, index, revision: row.task.revision };
    if (value === originalValue(row, field)) delete draft[field];
    else draft[field] = value;
    if (Object.keys(draft).length > 3) drafts.set(id, draft);
    else drafts.delete(id);
    setMessage('batch-message', '');
  }

  function valueFor(row, field) {
    const index = field === 'seen' ? 0 : row.index;
    return drafts.get(rowKey(row.task, index))?.[field] ?? originalValue(row, field);
  }

  function refreshActions() {
    const selectable = controls.filter(item => item.row.checkable);
    const checked = selectable.filter(item => item.choose.checked);
    $('batch-select-all-label').hidden = !selectable.length;
    selectAll.checked = checked.length > 0 && checked.length === selectable.length;
    selectAll.indeterminate = checked.length > 0 && checked.length < selectable.length;
    complete.disabled = saving || !checked.some(item => item.status.value === 'open');
    save.disabled = saving || !drafts.size;
    save.textContent = saving ? '저장 중…' : drafts.size ? `변경 ${drafts.size}건 저장` : '저장';
  }

  function setStatus(row, closed) {
    const field = row.reference ? 'seen' : 'done';
    editRow(row, field, closed);
    for (const item of controls) {
      if (item.row === row || (row.reference && item.row.task.id === row.task.id)) {
        item.status.value = closed ? 'closed' : 'open';
      }
    }
    refreshActions();
  }

  function openDetails(row) {
    paused = true;
    returningTo = rowKey(row.task, row.index);
    $('batch-return').hidden = false;
    dialog.close();
    if (!selectTask(row.task.id, 'batch-open')) resume();
  }

  function makeRow(row) {
    const line = element('div', 'batch-row');
    const id = rowKey(row.task, row.index);
    line.dataset.row = id;
    const choose = element('input');
    choose.type = 'checkbox';
    choose.setAttribute('aria-label', `${row.label} 선택`);
    choose.disabled = !row.checkable;
    choose.checked = row.checkable && selected.has(id);
    choose.addEventListener('change', () => {
      if (choose.checked) selected.add(id);
      else selected.delete(id);
      refreshActions();
    });
    const title = button('batch-title', row.label);
    title.title = `${row.task.title} 자세히`;
    title.append(element('span', 'batch-kind', dayNames[row.entry ? markType(row.task, row.entry) : 'loose']));
    title.addEventListener('click', () => openDetails(row));

    const dates = element('div', 'batch-dates');
    const time = element('input');
    function field(name, label, parent, input = element('input')) {
      input.dataset.field = name;
      input.setAttribute('aria-label', `${row.label} ${label}`);
      input.title = label;
      input.type = name === 'time' ? 'text' : 'date';
      input.value = valueFor(row, name);
      input.addEventListener('input', () => {
        editRow(row, name, input.value);
        if (name === 'date') time.disabled = !input.value;
        refreshActions();
      });
      parent.append(input);
      return input;
    }
    const date = field('date', row.entry?.kind === '기간' ? '시작 날짜' : '날짜', dates);
    if (row.entry?.kind === '기간') {
      field('end', '끝 날짜', dates);
      time.hidden = true;
    } else {
      time.placeholder = '시간';
      time.maxLength = taskModel.TIME_MAX;
      time.disabled = !date.value;
    }

    const status = element('select', 'batch-status');
    status.setAttribute('aria-label', `${row.label} 상태`);
    status.append(new Option(row.reference ? '확인 전' : '할 일', 'open'), new Option(row.reference ? '확인함' : '완료', 'closed'));
    status.value = valueFor(row, row.reference ? 'seen' : 'done') ? 'closed' : 'open';
    status.hidden = !row.checkable;
    status.addEventListener('change', () => setStatus(row, status.value === 'closed'));
    line.append(choose, title, dates);
    if (!time.hidden) field('time', '시간 또는 교시', line, time);
    line.append(status);
    controls.push({ row, choose, status });
    return line;
  }

  function render() {
    const anchor = fromKey(dateInput.value);
    const start = week ? shift(anchor, -weekday(anchor)) : anchor;
    const first = key(start);
    const last = week ? key(shift(start, 6)) : first;
    $('batch-day').setAttribute('aria-pressed', String(!week));
    $('batch-week').setAttribute('aria-pressed', String(week));
    $('batch-range-label').textContent = week ? `${shortDate(first)} ~ ${shortDate(last)}` : '';
    controls = [];
    const fragment = document.createDocumentFragment();
    let previousDay;
    let group;
    for (const row of calendarRows(first, last)) {
      if (row.day !== previousDay) {
        group = element('section', 'batch-day');
        group.append(element('h3', 'batch-day-heading', shortDate(row.day)));
        fragment.append(group);
        previousDay = row.day;
      }
      group.append(makeRow(row));
    }
    if (!controls.length) fragment.append(element('p', 'small-note', '이 기간에 표시할 업무가 없어요.'));
    list.replaceChildren(fragment);
    refreshActions();
  }

  function open(date) {
    if (paused) return resume();
    dateInput.value = date;
    week = false;
    render();
    dialog.showModal();
  }

  function resume() {
    paused = false;
    $('batch-return').hidden = true;
    render();
    dialog.showModal();
    [...list.querySelectorAll('.batch-row')].find(line => line.dataset.row === returningTo)?.querySelector('.batch-title').focus();
  }

  function close() {
    if (saving || (drafts.size && !window.confirm('저장하지 않은 변경을 버리시겠어요?'))) return;
    drafts.clear();
    selected.clear();
    setMessage('batch-message', '');
    dialog.close();
  }

  $('batch-open').addEventListener('click', () => open(state.dayKey || key(new Date())));
  $('day-batch').addEventListener('click', event => {
    const date = event.currentTarget.dataset.date;
    $('day-dialog').close();
    open(date);
  });
  $('batch-return').addEventListener('click', () => {
    closeDetail();
    if (!$('detail-panel').classList.contains('open')) resume();
  });
  $('detail-close').addEventListener('click', () => {
    if (paused && !$('detail-panel').classList.contains('open')) resume();
  });
  function changeRange(nextWeek) {
    week = nextWeek;
    selected.clear();
    render();
  }

  $('batch-day').addEventListener('click', () => { if (week) changeRange(false); });
  $('batch-week').addEventListener('click', () => { if (!week) changeRange(true); });
  dateInput.addEventListener('change', () => {
    if (!taskModel.validDate(dateInput.value)) dateInput.value = state.dayKey || key(new Date());
    changeRange(week);
  });
  selectAll.addEventListener('change', () => {
    selected.clear();
    for (const { row, choose } of controls) {
      if (!row.checkable) continue;
      choose.checked = selectAll.checked;
      if (choose.checked) selected.add(rowKey(row.task, row.index));
    }
    refreshActions();
  });
  complete.addEventListener('click', () => {
    for (const item of controls) if (item.choose.checked && item.status.value === 'open') setStatus(item.row, true);
  });
  $('batch-close').addEventListener('click', close);
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  save.addEventListener('click', async () => {
    if (saving || !drafts.size) return;
    saving = true;
    const disabled = [...dialog.querySelectorAll('button, input, select')].filter(node => !node.disabled);
    for (const node of disabled) node.disabled = true;
    refreshActions();
    const count = drafts.size;
    let saved = false;
    try {
      const updated = await api.batchEdit([...drafts.values()]);
      const revisions = new Map(state.snapshot.tasks.map(task => [task.id, task.revision]));
      if (updated.tasks.some(task => task.revision > revisions.get(task.id))) sync(updated);
      drafts.clear();
      selected.clear();
      saved = true;
      setMessage('batch-message', `${count}건을 저장했어요.`);
    } catch (error) {
      setMessage('batch-message', error.message, true);
    } finally {
      saving = false;
      for (const node of disabled) node.disabled = false;
      if (saved) render();
      else refreshActions();
    }
  });
})();
