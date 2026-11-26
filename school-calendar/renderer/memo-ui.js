'use strict';

(() => {
  const dialog = $('create-dialog');
  const text = $('memo-text');
  const draftKey = 'calendar-memo-draft';
  const flow = { phase: 'editing', draft: null, incoming: null, items: [], request: 0, sourceOpen: true, manualState: 'idle' };
  const inbox = $('ai-inbox-dialog');
  const inboxButton = $('ai-inbox-open');
  let inboxRequest;
  let inboxSignature;
  let openingBatch = false;
  let inboxPoll;
  const inboxEnabled = () => state.snapshot.showExternalAiWork !== false;
  const receivedTime = new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit'
  });
  const today = () => new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const newDraft = value => ({ id: crypto.randomUUID(), text: value, referenceDate: today() });
  const shortDate = value => value ? value.slice(5).replace('-', '/') : '날짜 정하기';
  function dateSummary(item) {
    if (item.kind === '기한 없음') return '기한 없음';
    const day = item.kind === '기간' ? `${shortDate(item.date)}~${shortDate(item.end)}` : shortDate(item.date);
    return [day, item.kind === '까지' ? '마감' : item.kind === '기간' ? '기간' : '일정', item.time].filter(Boolean).join(' ');
  }
  function remember() {
    if (!flow.draft) return;
    try {
      if (flow.draft?.text.trim()) localStorage.setItem(draftKey, JSON.stringify(flow.draft));
      else localStorage.removeItem(draftKey);
    } catch {}
  }
  function setPhase(phase) {
    flow.phase = phase;
    const saving = phase === 'saving' || flow.manualState === 'saving';
    dialog.dataset.createSaving = String(saving);
    const busy = phase === 'polishing' || saving;
    const reviewing = flow.items.length > 0;
    text.disabled = phase === 'saving';
    $('memo-source').hidden = !!flow.incoming || (reviewing && !flow.sourceOpen);
    $('memo-edit-source').hidden = !!flow.incoming || !reviewing;
    $('memo-edit-source').disabled = busy;
    $('memo-edit-source').textContent = flow.sourceOpen ? '원문 접기' : '원문 고치기';
    $('memo-edit-source').setAttribute('aria-expanded', String(flow.sourceOpen));
    $('memo-polish').hidden = !!flow.incoming || (reviewing && !flow.sourceOpen);
    $('memo-polish').disabled = busy || !text.value.trim();
    $('memo-polish').textContent = phase === 'polishing' ? '다듬는 중…' : reviewing ? '다시 다듬기' : 'AI로 다듬기';
    $('memo-register').hidden = phase !== 'review' && phase !== 'saving';
    $('memo-register').disabled = busy || !flow.items.some(item => item.selected);
    $('memo-register').textContent = phase === 'saving' ? '넣는 중…' : '달력에 넣기';
    $('memo-close').disabled = saving;
    $('memo-dismiss-inbox').hidden = !flow.incoming;
    $('memo-dismiss-inbox').disabled = busy;
    $('create-cancel').disabled = saving;
    $('create-mode-memo').disabled = saving;
    $('create-mode-direct').disabled = saving;
    $('memo-preview').hidden = !reviewing;
    $('memo-result-heading').hidden = !!flow.incoming || !reviewing;
    dialog.setAttribute('aria-busy', String(busy));
    for (const card of $('memo-preview').children) updateCard(card);
  }
  function updateCard(card) {
    const item = flow.items[Number(card.dataset.index)];
    if (!item) return;
    const busy = flow.phase === 'saving' || flow.phase === 'polishing' || flow.manualState === 'saving';
    for (const input of card.querySelectorAll('input,select,textarea,button')) input.disabled = busy;
    for (const input of card.querySelectorAll('[data-field]')) input.disabled = busy || !item.selected;
    card.querySelector('[data-field="date"]').disabled ||= item.kind === '기한 없음';
    card.querySelector('[data-field="end"]').disabled ||= item.kind !== '기간';
    card.querySelector('[data-field="time"]').disabled ||= item.kind === '기한 없음';
    card.querySelector('[data-field="end"]').closest('label').hidden = item.kind !== '기간';
    card.querySelector('.memo-date-toggle').textContent = dateSummary(item);
    card.querySelector('.memo-date-toggle').disabled = busy || !item.selected;
    card.classList.toggle('memo-excluded', !item.selected);
  }
  function field(parent, labelText, name, control) {
    const label = element('label', 'field', labelText);
    control.dataset.field = name;label.append(control);parent.append(label);
    return control;
  }
  function openDates(card, open) {
    for (const other of $('memo-preview').children) {
      const show = other === card && open;
      other.querySelector('.memo-proposal-dates').hidden = !show;
      const preview = other.querySelector('.memo-inbox-note');
      if (preview) preview.hidden = show || !preview.textContent;
      other.querySelector('.memo-date-toggle').setAttribute('aria-expanded', String(show));
    }
  }
  function drawPreview() {
    const cards = flow.items.map((item, index) => {
      const card = element('div', 'memo-proposal');card.dataset.index = String(index);
      const head = element('div', 'memo-proposal-head');
      const check = element('input');check.type = 'checkbox';check.checked = item.selected;
      check.setAttribute('aria-label', `${index + 1}번 업무 넣기`);
      check.addEventListener('change', () => { item.selected = check.checked;setPhase('review'); });
      const title = element('input', 'memo-title');title.dataset.field = 'title';
      title.setAttribute('aria-label', `${index + 1}번 업무 제목`);
      title.value = item.title;title.maxLength = 180;title.required = true;
      const toggle = button('memo-date-toggle', dateSummary(item));
      toggle.setAttribute('aria-label', `${index + 1}번 업무 ${flow.incoming ? '날짜·조건' : '날짜'} 고치기`);
      toggle.setAttribute('aria-expanded', 'false');
      toggle.setAttribute('aria-controls', `memo-dates-${index}`);
      const row = element('div', 'memo-proposal-dates');row.id = `memo-dates-${index}`;row.hidden = true;
      toggle.addEventListener('click', () => openDates(card, row.hidden));
      head.append(check, title, toggle);card.append(head);
      const kind = field(row, '날짜 지정', 'kind', element('select'));
      for (const [value, label] of [['까지','마감'],['그날','일정'],['기간','기간'],['기한 없음','기한 없음']]) {
        const option = element('option', null, label);option.value = value;kind.append(option);
      }
      kind.value = item.kind;
      const date = field(row, '날짜', 'date', element('input'));date.type = 'date';date.min = '0001-01-01';date.max = '9999-12-31';date.required = true;date.value = item.date || '';
      const end = field(row, '끝 날짜', 'end', element('input'));end.type = 'date';end.min = item.date || '0001-01-01';end.max = '9999-12-31';end.required = true;end.value = item.end || '';
      const time = field(row, '시간·교시', 'time', element('input'));time.maxLength = 12;time.placeholder = '선택';time.value = item.time;
      card.append(row);
      let notePreview;
      if (flow.incoming) {
        const note = field(row, '조건·메모', 'note', element('textarea'));
        note.rows = 2;
        note.maxLength = 500;
        note.value = item.note;
        note.closest('label').classList.add('memo-inbox-note-field');
        notePreview = element('p', 'memo-check-note memo-inbox-note', item.note);
        notePreview.hidden = !item.note;
        card.append(notePreview);
      } else if (item.note) card.append(element('p', 'memo-check-note', item.note));
      card.addEventListener('input', event => {
        const name = event.target.dataset.field;if (!name) return;
        item[name] = event.target.value;
        if (name === 'note' && notePreview) notePreview.textContent = item.note;
        if (name === 'kind') {
          if (item.kind === '기한 없음') { item.date = null;item.end = null;item.time = '';date.value = '';end.value = '';time.value = ''; }
          else if (item.kind !== '기간') { item.end = null;end.value = ''; }
        }
        end.min = date.value || '0001-01-01';updateCard(card);
      });
      return card;
    });
    $('memo-preview').replaceChildren(...cards);flow.sourceOpen = false;setPhase('review');
  }
  function setMode(requested, rememberMode = true) {
    if (flow.phase === 'saving' || flow.manualState === 'saving') return;
    let mode = requested;
    if (mode === 'last') {
      try { mode = localStorage.getItem('calendar-create-mode') || 'memo'; } catch { mode = 'memo'; }
    }
    mode = mode === 'direct' ? 'direct' : 'memo';
    dialog.dataset.createMode = mode;
    $('memo-form').hidden = mode !== 'memo';
    $('create-form').hidden = mode !== 'direct';
    for (const candidate of ['memo', 'direct']) {
      const tab = $('create-mode-' + candidate);
      const selected = mode === candidate;
      tab.setAttribute('aria-selected', String(selected));tab.tabIndex = selected ? 0 : -1;
    }
    if (rememberMode) try { localStorage.setItem('calendar-create-mode', mode); } catch {}
  }
  window.prepareCreateDialog = (requested, incoming) => {
    flow.incoming = incoming;
    $('create-heading').textContent = incoming ? '받은 업무 확인' : '업무 추가';
    $('create-mode-tabs').hidden = !!incoming;
    $('memo-close').textContent = incoming ? 'AI 박스으로' : '닫기';
    dialog.dataset.createInbox = String(!!incoming);
    $('memo-inbox-meta').hidden = !incoming;
    $('memo-inbox-source').textContent = incoming?.source || '';
    if (incoming) {
      flow.draft = null;
      text.value = '';
      flow.request++;
      flow.items = incoming.items.map(item => ({ ...item, selected: true }));
      setMode('memo', false);
      drawPreview();
      setMessage('memo-status', '날짜와 조건을 확인하고 달력에 넣을 업무를 골라 주세요.');
      return;
    }
    let saved;try { saved = JSON.parse(localStorage.getItem(draftKey)); } catch {}
    flow.draft = saved && typeof saved.text === 'string' && saved.text.length <= 4000 && typeof saved.id === 'string' && typeof saved.referenceDate === 'string' ? saved : newDraft('');
    text.value = flow.draft.text;flow.items = [];flow.request++;flow.sourceOpen = true;
    $('memo-preview').replaceChildren();setMessage('memo-status', '');setPhase('editing');
    $('memo-reference').textContent = `날짜 기준 ${flow.draft.referenceDate}`;
    setMode(requested);
  };
  window.setCreateMode = setMode;
  window.setCreateSaving = saving => { flow.manualState = saving ? 'saving' : 'idle';setPhase(flow.phase); };
  for (const mode of ['memo', 'direct']) {
    const tab = $('create-mode-' + mode);
    tab.addEventListener('click', () => setMode(mode));
    tab.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const target = event.key === 'Home' ? 'memo' : event.key === 'End' ? 'direct' : mode === 'memo' ? 'direct' : 'memo';
      setMode(target);$('create-mode-' + target).focus();
    });
  }
  $('memo-edit-source').addEventListener('click', () => {
    flow.sourceOpen = !flow.sourceOpen;setPhase(flow.phase);
    if (flow.sourceOpen) text.focus();
  });
  text.addEventListener('input', () => {
    flow.request++;flow.draft = newDraft(text.value);flow.items = [];flow.sourceOpen = true;
    $('memo-preview').replaceChildren();setPhase('editing');remember();
    $('memo-reference').textContent = `날짜 기준 ${flow.draft.referenceDate}`;
    setMessage('memo-status', '');
  });
  $('memo-polish').addEventListener('click', async () => {
    if (flow.phase === 'polishing' || flow.phase === 'saving' || flow.manualState === 'saving' || $('memo-form').hidden || !text.value.trim()) return;
    const request = ++flow.request;const draft = { ...flow.draft, text: text.value };
    remember();flow.items = [];$('memo-preview').replaceChildren();setPhase('polishing');
    setMessage('memo-status', '다듬는 중입니다. 달력에는 아직 넣지 않습니다.');
    try {
      const result = await api.memoPolish(draft);
      if (request !== flow.request || !dialog.open) return;
      flow.items = result.items.map(item => ({ ...item, selected: true }));drawPreview();
      setMessage('memo-status', flow.items.length ? '업무 후보를 고쳐 보고, 달력에 넣을 것만 골라 주세요.' : '업무 후보를 찾지 못했습니다. 메모는 남아 있으니 편하게 이어 적어 주세요.');
    } catch (error) {
      if (request === flow.request && dialog.open) { setPhase('editing');setMessage('memo-status', error.message, true); }
    }
  });
  $('memo-register').addEventListener('click', async () => {
    if (flow.phase !== 'review' || flow.manualState === 'saving' || $('memo-form').hidden) return;
    const invalid = [...$('memo-preview').querySelectorAll('input,select,textarea')].find(input => !input.checkValidity());
    if (invalid) openDates(invalid.closest('.memo-proposal'), true);
    if (!$('memo-form').reportValidity()) return;
    const items = flow.items.filter(item => item.selected).map(({ selected, ...item }) => item);
    if (!items.length) return;
    setPhase('saving');setMessage('memo-status', '');
    try {
      const tasks = flow.incoming ? await api.aiInboxRegister(flow.incoming.id, items) : await api.memoRegister({ draft: flow.draft, items });
      if (!flow.incoming) { flow.draft = newDraft('');text.value = '';flow.items = [];remember(); }
      dialog.close();
      notice(`${tasks.length}개 업무를 달력에 넣었습니다.`);

    } catch (error) { setPhase('review');setMessage('memo-status', error.message, true); }
  });
  $('memo-dismiss-inbox').addEventListener('click', async () => {
    if (!flow.incoming || flow.phase !== 'review' || !window.confirm('이 묶음을 AI 박스에서 빼시겠어요?')) return;
    setPhase('saving');
    try {
      await api.aiInboxDismiss(flow.incoming.id);
      dialog.close();
      notice('AI 박스에서 이 묶음을 뺐습니다.');
    } catch (error) { setPhase('review');setMessage('memo-status', error.message, true); }
  });

  function renderInbox(batches) {
    const count = $('ai-inbox-count');
    count.textContent = String(batches.length);
    count.hidden = !batches.length;
    inboxButton.setAttribute('aria-label', batches.length ? `AI 박스 ${batches.length}묶음` : 'AI 박스');
    const signature = JSON.stringify(batches);
    const list = $('ai-inbox-batches');
    if (signature !== inboxSignature) {
      inboxSignature = signature;
      const focused = document.activeElement?.dataset.batchId;
      list.replaceChildren(...batches.map(batch => {
        const row = element('li');
        const pick = button('button ai-inbox-pick');
        pick.dataset.batchId = batch.id;
        pick.append(element('strong', null, batch.source),
          element('span', 'small-note', `${batch.count}개 업무 · ${receivedTime.format(new Date(batch.receivedAt))}`));
        pick.addEventListener('click', () => void openBatch(batch.id));
        row.append(pick);
        return row;
      }));
      if (focused) (list.querySelector(`[data-batch-id="${CSS.escape(focused)}"]`) || $('ai-inbox-close')).focus();
    }
    list.hidden = !batches.length;
    setMessage('ai-inbox-status', batches.length ? '' :
      `AI 채팅에서 “${state.messenger.calendarName} AI 박스에 보내 줘”라고 요청해 보세요.`);
  }

  function refreshInbox() {
    if (!inboxEnabled()) return;
    if (!inboxRequest) {
      inboxRequest = api.aiInboxList().then(batches => {
        if (inboxEnabled()) renderInbox(batches);
      }).catch(error => {
        if (inbox.open) setMessage('ai-inbox-status', error.message, true);
      }).finally(() => { inboxRequest = null; });
    }
    return inboxRequest;
  }

  async function openBatch(id) {
    if (openingBatch || !inbox.open) return;
    openingBatch = true;
    try {
      const incoming = await api.aiInboxRead(id);
      if (!inbox.open || dialog.open || !inboxEnabled()) return;
      inbox.close();
      showCreate(key(new Date()), 'memo', incoming);
    } catch (error) {
      if (inbox.open) setMessage('ai-inbox-status', error.message, true);
    } finally { openingBatch = false; }
  }

  function openInbox() {
    if (inbox.open || dialog.open || !inboxEnabled()) return;
    inbox.showModal();
    $('ai-inbox-close').focus();
    void refreshInbox();
  }

  window.updateAiInboxVisibility = () => {
    const enabled = inboxEnabled();
    const wasHidden = inboxButton.hidden;
    inboxButton.hidden = !enabled;
    if (enabled && wasHidden) {
      void refreshInbox();
      inboxPoll = setInterval(() => { if (!document.hidden) void refreshInbox(); }, 5000);
    } else if (!enabled && !wasHidden) {
      clearInterval(inboxPoll);
      if (inbox.open) inbox.close();
    }
  };
  inboxButton.addEventListener('click', openInbox);
  $('ai-inbox-close').addEventListener('click', () => inbox.close());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void refreshInbox(); });
  $('memo-form').addEventListener('submit', event => event.preventDefault());
  $('memo-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('cancel', event => { if (flow.phase === 'saving' || flow.manualState === 'saving') event.preventDefault(); });
  dialog.addEventListener('close', () => {
    if (dialog.open) return;
    flow.request++;flow.phase = 'editing';
    if (flow.incoming) {
      flow.incoming = null;
      openInbox();
    } else remember();
  });
})();
