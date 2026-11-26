'use strict';

// 수업 탭(2026-11-25 목업 확정, 진행-정리.md "수업 캘린더 이어받기").
// 왼쪽 업무 목록과 오른쪽 자세히 자리는 그대로 두고, 가운데 달력만 수업으로 바꾼다.
// app.js의 전역 함수(renderMonth·refreshDetail)를 감싸 수업일 때만 다르게 그린다.
(() => {
  const L = lessonModel;
  const PREFIX = 'lesson:';
  const view = { lessons: false };
  try { view.lessons = localStorage.getItem('calendar-main-tab') === 'lesson'; } catch {}

  const plan = () => state.snapshot.lessons || L.emptyPlan();
  const mode = () => L.lessonMode(state.snapshot.profile);
  const subjects = () => state.snapshot.profile?.subjects || [];
  const savedSchedule = () => plan()[mode()] || null;
  const dayOptions = (lessonMode = mode()) => ({ changes: plan().changes, mode: lessonMode });
  const periodTimes = () => plan().periodTimes || L.defaultPeriodTimes(state.snapshot.profile?.schoolLevel);

  // 과목 색은 앱이 정한 기본값(11/25 사용자: 고르기 없음). 교과 보기는 학년 색(과목 색과 섞지 않음).
  const SUBJECT_COLORS = { 국어: '#d8643a', 수학: '#3a7fd0', 과학: '#1f9a72', 사회: '#b47a1e', 도덕: '#b47a1e', 역사: '#b47a1e',
    영어: '#7b6fd6', 음악: '#cf5583', 미술: '#cf5583', 체육: '#5f9628', 실과: '#1f9a72', 창체: '#9a978d' };
  const GRADE_COLORS = { 1: '#3a7fd0', 2: '#1f9a72', 3: '#d8643a', 4: '#7b6fd6', 5: '#cf5583', 6: '#b47a1e' };
  const colorOf = cell => {
    const { grade, subject } = L.partsOf(cell);
    // "과학(전)"·"국어(도)"처럼 괄호 표시가 붙어도 과목 색은 같게.
    return grade ? GRADE_COLORS[grade] || '#9a978d' : SUBJECT_COLORS[subject.replace(/\s*\(.*\)\s*$/, '')] || '#9a978d';
  };
  const lessonId = (dateKey, period) => PREFIX + L.recordKey(mode(), dateKey, period);
  const parseId = id => {
    const [lessonMode, dateKey, period] = id.slice(PREFIX.length).split('|');
    return { lessonMode, dateKey, period: Number(period), record: id.slice(PREFIX.length) };
  };
  const isLesson = id => typeof id === 'string' && id.startsWith(PREFIX);

  // ── 업무·수업 탭 ──
  const workTab = $('main-tab-work');
  const lessonTab = $('main-tab-lesson');
  const tour = $('lesson-tour');
  const tourText = $('lesson-tour-text');
  const tourSkip = $('lesson-tour-skip');
  const tourRestart = $('lesson-tour-restart');
  const tourStorageKey = 'calendar-lesson-tour-seen';
  let tourSeen = false;
  let tourStep = '';
  let tourTarget;
  try { tourSeen = localStorage.getItem(tourStorageKey) === '1'; } catch {}

  function startTour() {
    tourSeen = true;
    try { localStorage.setItem(tourStorageKey, '1'); } catch {}
    tourStep = 'setup';
    renderTour();
  }

  function highlightTour(target) {
    if (tourTarget === target) return;
    if (tourTarget) {
      tourTarget.classList.remove('lesson-tour-target');
      const described = (tourTarget.getAttribute('aria-describedby') || '').split(/\s+/u).filter(id => id && id !== tourText.id);
      if (described.length) tourTarget.setAttribute('aria-describedby', described.join(' '));
      else tourTarget.removeAttribute('aria-describedby');
    }
    tourTarget = target;
    if (!target) return;
    target.classList.add('lesson-tour-target');
    target.setAttribute('aria-describedby', [target.getAttribute('aria-describedby'), tourText.id].filter(Boolean).join(' '));
  }

  function tourTargetVisible(target) {
    const rect = target.getBoundingClientRect();
    const scroll = target.closest('.week-zoom-days, .calendar');
    const bounds = scroll?.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    return rect.width > 0 && rect.height > 0 && x > Math.max(0, bounds?.left ?? 0) &&
      x < Math.min(innerWidth, bounds?.right ?? innerWidth) && y > Math.max(0, bounds?.top ?? 0) &&
      y < Math.min(innerHeight, bounds?.bottom ?? innerHeight);
  }

  function tourTargetInView(target) {
    if (target?.matches('.day-hit, .wz-open') && !tourTargetVisible(target)) {
      target.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    }
  }

  function placeTour(inDetail) {
    const detail = $('lesson-detail');
    if (inDetail) {
      if (tour.parentElement !== detail) detail.prepend(tour);
    } else {
      const empty = $('lesson-empty');
      if (tour.nextElementSibling !== empty) empty.before(tour);
    }
  }

  function tourDate() {
    const days = [...$('month').querySelectorAll('.day-hit')].filter(hit =>
      hit.dataset.focusKey?.startsWith('date-') && hit.closest('.day')?.querySelector('.day-items [data-focus-key^="calendar-lesson:"]'));
    const today = key(new Date());
    const visible = days.filter(tourTargetVisible);
    const options = visible.length ? visible : days;
    return options.find(hit => hit.dataset.focusKey === 'date-' + today) ||
      options.find(hit => hit.dataset.focusKey.slice(5) >= today) || options.at(-1);
  }

  function renderTour() {
    if (!view.lessons || !tourStep || !state.snapshot.lessons) {
      tour.hidden = true;
      placeTour(false);
      tourRestart.setAttribute('aria-expanded', 'false');
      highlightTour(undefined);
      return;
    }
    const date = tourDate();
    if (tourStep === 'setup' && (savedSchedule() || date || zoom.querySelector('.wz-open'))) tourStep = 'week';
    let target, message;
    if (tourStep === 'setup') {
      const dialog = $('timetable-dialog');
      target = dialog.open ? $('tt-file-pick') : !$('lesson-empty').hidden ? $('lesson-empty-open') : $('lesson-timetable-open');
      message = '시간표 파일을 넣거나 과목 표를 붙여넣어 보세요.';
    } else if (tourStep === 'done') {
      target = !$('lesson-detail').hidden ? $('lesson-detail') : undefined;
      message = '수업 자세히에서 메모를 남기거나 자료를 연결할 수 있어요.';
    } else if (!zoom.hidden) {
      target = zoom.querySelector('.wz-open');
      if (target) {
        tourStep = 'lesson';
        message = '주간 시간표에서 과목을 눌러 수업 자세히를 열어 보세요.';
      } else {
        target = zoom.querySelector('[data-focus-key="zoom-edit-done"]');
        if (target) message = '시간표 고치기를 끝내면 과목을 눌러 열 수 있어요.';
        else {
          target = zoom.querySelector('.wz-close');
          message = '이 주에는 수업이 없어요. 시간표를 닫고 수업이 있는 날짜를 눌러 보세요.';
        }
        tourStep = 'week';
      }
    } else {
      target = date;
      if (target) message = '수업이 있는 날짜의 숫자를 눌러 한 주를 펼쳐 보세요.';
      else {
        const term = plan().term;
        const shown = key(monthOf(state.month)).slice(0, 7);
        const override = Object.entries(plan().changes || {}).find(([id, cell]) => cell && id.startsWith(mode() + '|'));
        const nextDate = term && (shown < term.start.slice(0, 7) ? term.start : shown > term.end.slice(0, 7) ? term.end : '')
          || override?.[0].split('|')[1];
        if (nextDate && nextDate.slice(0, 7) !== shown) target = $(nextDate.slice(0, 7) > shown ? 'next' : 'previous');
        message = '이 달에는 수업이 없어요. 달력을 옮겨 수업이 있는 날짜를 눌러 보세요.';
      }
      tourStep = 'week';
    }
    placeTour(tourStep === 'done' && !!target);
    tour.dataset.step = tourStep;
    if (tourText.textContent !== message) tourText.textContent = message;
    tourSkip.textContent = tourStep === 'done' ? '완료' : '건너뛰기';
    tour.hidden = false;
    tourRestart.setAttribute('aria-expanded', 'true');
    if (tourTarget !== target) {
      highlightTour(target);
      tourTargetInView(target);
    }
  }

  tourRestart.addEventListener('click', startTour);
  tourSkip.addEventListener('click', () => {
    const focus = tourStep === 'done' && !$('lesson-detail').hidden ? $('detail-heading') : tourRestart;
    tourStep = '';
    renderTour();
    focus.focus({ preventScroll: true });
  });

  function selectTab(lessons) {
    if (weekImport?.saving) return;
    if (!lessons) clearWeekImport();
    if (view.lessons !== lessons && $('detail-panel').classList.contains('open')) {
      closeDetail();
      if ($('detail-panel').classList.contains('open')) return;
    }
    view.lessons = lessons;
    try { localStorage.setItem('calendar-main-tab', lessons ? 'lesson' : 'work'); } catch {}
    // 수업은 월간 달력으로만 본다. 목록 보기·묶어서 편집·업무 추가는 업무 탭에서.
    if (lessons && !$('agenda').hidden) setCalendarMode(false);
    workTab.setAttribute('aria-pressed', String(!lessons));
    lessonTab.setAttribute('aria-pressed', String(lessons));
    $('lesson-timetable-open').hidden = !lessons;
    tourRestart.hidden = !lessons;
    $('add-today').hidden = lessons;
    document.querySelector('.calendar-mode').hidden = lessons;
    $('batch-open').hidden = lessons;
    renderMonth();
    if (lessons && !tourSeen) startTour();
  }
  workTab.addEventListener('click', () => selectTab(false));
  lessonTab.addEventListener('click', () => selectTab(true));

  // ── 달력 ──
  const originalMonth = renderMonth;
  renderMonth = function renderLessonOrWorkMonth() {
    const month = $('month');
    month.classList.toggle('lesson-month', view.lessons);
    // 수업 탭: 업무 기호 설명(마감·일정 등)은 감춘다(11/26). 토·일 칸은 자세히가 덮는 자리라 그대로 둔다.
    month.closest('.calendar')?.classList.toggle('lesson-view', view.lessons);
    month.setAttribute('aria-label', view.lessons ? '날짜별 수업' : '날짜별 업무');
    $('lesson-empty').hidden = !view.lessons || !!savedSchedule();
    // 업무 탭에 다녀와도 크게 보던 주는 그대로(11/26 사용자 "업무로 갔다 와도 그냥 유지"): 감추기만 하고 주는 기억한다.
    if (!view.lessons) {
      if (view.edit) Object.assign(view.edit, { menu: null, pick: null });
      hideZoom();
      renderTour();
      return originalMonth();
    }
    // 업무 대신 빈 목록으로 달력 틀(날짜·학사일정·급식)을 그린 뒤 칸마다 수업을 넣는다.
    // 주 높이를 업무량에 맞추는 업무용 "업무 많은 주는 넓게"는 수업 탭에선 끈 채로 그린다.
    const work = state.snapshot;
    const fit = fitWeeks.checked;
    state.snapshot = { ...work, tasks: [] };
    fitWeeks.checked = false;
    try { originalMonth(); } finally { state.snapshot = work; fitWeeks.checked = fit; }
    const table = savedSchedule();
    const { term } = plan();
    for (const day of month.children) {
      const hit = day.querySelector('.day-hit');
      const items = day.querySelector('.day-items');
      if (!hit || !items) continue;
      const dateKey = hit.dataset.focusKey.slice(5);
      const lessons = L.lessonsOn(dateKey, table, term, dayOptions());
      items.replaceChildren(...lessons.map(({ period, cell, changed }) => lessonItem(dateKey, period, cell, changed)));
      hit.setAttribute('aria-label', `${dateLabel.format(fromKey(dateKey))}${lessons.length ? ` · 수업 ${lessons.length}개` : ''} · 누르면 이 주를 크게`);
    }
    renderZoom();
  };

  // ── 크게 보는 주(11/26 사용자 "다른 날들을 덮으면서 이번 주만 크게") ──
  // 수업 탭에서 날짜 칸의 빈 곳(키보드는 Enter)을 누르면 그 주가 달력 위를 덮고 크게 보인다.
  // 칸마다 교시·시각·과목·메모 두 줄·자료 수. 요일 줄과 달력 머리는 그대로 보이고, 자세히는 그 위(토·일 자리)에 열린다.
  const zoom = element('section', 'week-zoom');
  zoom.hidden = true;
  zoom.setAttribute('aria-labelledby', 'week-zoom-title');
  $('month').after(zoom);
  const mondayOf = dateKey => { const date = fromKey(dateKey); return key(shift(date, -weekday(date))); };
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

  function openZoom(monday, fromDay) {
    if (weekImport?.saving) return;
    if (view.zoomWeek !== monday) clearWeekImport();
    view.zoomWeek = monday;
    renderZoom();
    const month = $('month');
    if (fromDay && !reduceMotion.matches) {
      // 누른 주 줄에서 위아래로 펼쳐지며 다른 주를 덮는다.
      const top = Math.max(0, fromDay.getBoundingClientRect().top - zoom.getBoundingClientRect().top);
      const bottom = Math.max(0, zoom.offsetHeight - top - fromDay.offsetHeight);
      zoom.animate([{ clipPath: `inset(${top}px 0 ${bottom}px 0)`, opacity: 0.7 }, { clipPath: 'inset(0 0 0 0)', opacity: 1 }],
        { duration: 200, easing: 'cubic-bezier(.2,.7,.2,1)' });
    }
    $('week-zoom-title').focus({ preventScroll: true });
  }
  function closeZoom(focusBack) {
    if (!view.zoomWeek || weekImport?.saving) return;
    clearWeekImport();
    const monday = view.zoomWeek;
    view.zoomWeek = null;
    view.edit = null;
    hideZoom();
    renderTour();
    if (focusBack) $('month').querySelector(`[data-focus-key="date-${monday}"]`)?.focus({ preventScroll: true });
  }
  function stepZoom(days) { goWeek(key(shift(fromKey(view.zoomWeek), days))); }
  function goWeek(monday) {
    if (weekImport?.saving || view.zoomWeek === monday) return;
    clearWeekImport();
    if (view.edit) Object.assign(view.edit, { menu: null, pick: null, message: '', error: false });
    const next = fromKey(monday);
    const middle = shift(next, 3);
    view.zoomWeek = monday;
    if (monthOf(middle).getTime() !== monthOf(state.month).getTime()) { state.month = middle; renderMonth(); }
    else renderZoom();
  }

  // 머리 단추 그림(선 아이콘, 글자색을 따른다).
  const ICONS = { left: 'M10 3.5 5.5 8l4.5 4.5', right: 'M6 3.5 10.5 8 6 12.5', close: 'M4.5 4.5l7 7M11.5 4.5l-7 7',
    pencil: 'M3 13l.8-3.2L10.6 3l2.4 2.4-6.8 6.8L3 13z', check: 'M3.5 8.5 6.6 11.5 12.5 4.5' };
  function iconButton(cls, label, path, text) {
    const item = button(cls);
    item.insertAdjacentHTML('beforeend', `<svg class="wz-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="${path}"/></svg>`);
    if (text) item.append(element('span', null, text));
    else item.setAttribute('aria-label', label);
    if (!item.title) item.title = label;
    return item;
  }
  function hideZoom() {
    zoom.hidden = true;
    $('month').closest('.calendar')?.classList.remove('zooming');
  }
  function renderZoom() {
    if (!view.zoomWeek || !view.lessons) { hideZoom(); renderTour(); return; }
    // 요일 줄까지 덮는다: 왼쪽 시간 열 때문에 요일 칸이 달력과 어긋나므로 층이 제 요일을 단다.
    const month = $('month');
    const weekdays = document.querySelector('.calendar .weekdays');
    const top = weekdays.offsetTop;
    // 창이 작아 달력이 넘치면(노트북 1050×720 등) 층은 보이는 높이까지만 덮고, 표는 층 안에서 넘긴다.
    const calendar = month.closest('.calendar');
    calendar.classList.add('zooming');
    calendar.scrollTop = 0;
    const visible = calendar.clientHeight - parseFloat(getComputedStyle(calendar).paddingBottom || '0');
    const bottom = Math.min(month.offsetTop + month.offsetHeight, visible);
    Object.assign(zoom.style, { top: `${top}px`, left: `${month.offsetLeft}px`,
      width: `${month.offsetWidth}px`, height: `${Math.max(240, bottom - top)}px` });
    zoom.hidden = false;
    const editing = view.edit;
    zoom.classList.toggle('editing', !!editing);
    const start = fromKey(view.zoomWeek);
    const end = shift(start, 6);
    const today = key(new Date());
    // 머리(11/26 사용자 "간결하면서 현대적이고 세련된"): 제목 · [‹ 이번 주 ›] · 고치기/완료 · 닫기(✕).
    // 모두 왼쪽에 모은다: 오른쪽(토·일 자리)은 자세히가 열리면 가려진다.
    const head = element('div', 'week-zoom-head');
    const title = element('h3', null, `${start.getMonth() + 1}월 ${start.getDate()}일 – ${end.getMonth() === start.getMonth() ? '' : `${end.getMonth() + 1}월 `}${end.getDate()}일`);
    title.id = 'week-zoom-title';
    title.tabIndex = -1;
    const thisWeek = mondayOf(today) === view.zoomWeek;
    if (thisWeek) title.append(element('span', 'wz-badge', '이번 주'));
    const nav = element('div', 'wz-nav');
    nav.setAttribute('role', 'group');
    nav.setAttribute('aria-label', '주 옮기기');
    const previous = iconButton('wz-nav-step', '지난 주', ICONS.left);
    previous.dataset.focusKey = 'zoom-previous';
    previous.addEventListener('click', () => stepZoom(-7));
    const now = button('wz-nav-today', '오늘');
    now.dataset.focusKey = 'zoom-today';
    now.title = '오늘이 있는 주';
    now.disabled = thisWeek;
    now.addEventListener('click', () => goWeek(mondayOf(today)));
    const next = iconButton('wz-nav-step', '다음 주', ICONS.right);
    next.dataset.focusKey = 'zoom-next';
    next.addEventListener('click', () => stepZoom(7));
    nav.append(previous, now, next);
    const actions = element('div', 'wz-actions');
    if (editing) {
      const done = iconButton('wz-pill primary', '완료', ICONS.check, '완료');
      done.dataset.focusKey = 'zoom-edit-done';
      done.title = '고치기 끝내기 (Esc)';
      done.addEventListener('click', () => stopEdit());
      actions.append(done);
    } else {
      const edit = iconButton('wz-pill', '시간표 고치기', ICONS.pencil, '시간표 고치기');
      edit.dataset.focusKey = 'zoom-edit';
      edit.title = '이 주에서 바로 과목을 바꾸거나 두 수업을 맞바꿔요';
      edit.addEventListener('click', startEdit);
      const close = iconButton('wz-close week-zoom-close', '달력으로', ICONS.close);
      close.title = '한 달 달력으로 (Esc)';
      close.addEventListener('click', () => closeZoom(true));
      actions.append(edit, close);
    }
    if (weekImport?.saving) [...nav.children, ...actions.children].forEach(control => { control.disabled = true; });
    head.append(title, nav, actions);
    const table = savedSchedule();
    const { term } = plan();
    const week = Array.from({ length: 7 }, (_, index) => {
      const date = shift(start, index);
      const dateKey = key(date);
      const lessons = L.lessonsOn(dateKey, table, term, dayOptions());
      return { date, dateKey, lessons: new Map(lessons.map(lesson => [lesson.period, lesson])) };
    });
    let periods = Math.max(table?.length || 0, ...week.flatMap(day => [...day.lessons.keys()]));
    // 시정표에 있는 교시까지는 빈 줄도 보인다(빈 칸에서 바로 수업 넣기).
    if (table || editing) periods = Math.max(periods, plan().periodTimes?.length || 0);
    // 고칠 때는 한 줄 더: 그날만 한 교시가 늘어나는 경우.
    if (editing) periods = Math.min(12, Math.max(periods + 1, 4));
    const times = periodTimes();
    const days = element('div', 'week-zoom-days');
    days.style.gridTemplateRows = `auto repeat(${periods}, minmax(max-content, 1fr))`;
    days.append(element('span', 'week-zoom-corner'));
    week.forEach(({ date, dateKey }, index) => {
      const head = element('p', 'week-zoom-date');
      head.classList.toggle('saturday', index === 5);
      head.classList.toggle('sunday', index === 6);
      head.classList.toggle('is-today', dateKey === today);
      head.append(element('b', null, date.getDate() === 1 || index === 0 ? `${date.getMonth() + 1}/${date.getDate()}` : String(date.getDate())),
        ' ', element('span', null, L.WEEKDAYS[index] || ['토', '일'][index - 5]));
      days.append(head);
    });
    for (let period = 1; period <= periods; period += 1) {
      const time = times[period - 1];
      const label = element('p', 'week-zoom-time');
      label.append(element('b', null, `${period}교시`), ...(time ? [element('span', null, time[0]), element('span', null, time[1])] : []));
      days.append(label);
      week.forEach(({ dateKey, lessons }, index) => {
        const lesson = lessons.get(period);
        if (editing && index < 5) { days.append(editSlot(dateKey, period, index, lesson?.cell || '')); return; }
        const slot = element('div', 'week-zoom-slot');
        slot.classList.toggle('weekend', index >= 5);
        if (lesson) slot.append(zoomLesson(dateKey, period, lesson.cell, lesson.changed));
        else if (index < 5 && !weekImport?.saving) slot.append(addLesson(dateKey, period, index));
        days.append(slot);
      });
    }
    const focused = document.activeElement?.dataset?.focusKey;
    const empty = !editing && !table && periods === 0;
    zoom.replaceChildren(head, ...(editing ? [editTools(week)] : []), empty ? emptyWeek() : days);
    renderTour();
    if (editing?.menu) editMenu();
    if (focused?.startsWith('zoom-')) zoom.querySelector(`[data-focus-key="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
  }



  let weekImport;
  let weekUndo;
  const clearWeekImport = () => { weekImport = null; };

  function weekImportPanel(changed) {
    const weekStart = view.zoomWeek;
    const lessonMode = mode();
    if (weekImport?.weekStart === weekStart && weekImport.lessonMode === lessonMode) {
      weekImport.base.disabled = !changed || weekImport.saving;
      return weekImport.panel;
    }

    const panel = element('section', 'wz-import');
    panel.id = 'week-schedule-panel';
    panel.setAttribute('aria-label', '이 주의 시간표 가져오기 및 복원');
    const base = button('button small wz-base-restore', '기초 시간표');
    base.disabled = !changed;
    base.title = '이 주를 기초 시간표로 되돌리기';
    base.setAttribute('aria-label', base.title);
    base.dataset.focusKey = 'zoom-week-base';
    const field = element('textarea', 'wz-import-paste');
    field.id = 'week-schedule-paste';
    field.rows = 1;
    field.placeholder = '파일 붙여넣기';
    field.dataset.focusKey = 'zoom-week-import';
    field.setAttribute('aria-label', '시간표 파일이나 표 붙여넣기');
    const file = button('wz-import-file');
    file.setAttribute('aria-label', '시간표 파일 고르기');
    file.title = '시간표 파일 고르기';
    file.insertAdjacentHTML('beforeend', '<svg class="icon" aria-hidden="true" focusable="false"><use href="#i-folder"></use></svg>');
    file.id = 'week-schedule-file';
    file.dataset.focusKey = 'zoom-week-file';
    const source = element('div', 'wz-import-source');
    source.id = 'week-schedule-drop';
    source.append(field, file);
    const status = element('p', 'small-note wz-import-status');
    status.id = 'week-schedule-status';
    status.setAttribute('role', 'status');
    status.hidden = true;
    const undo = button('button text-button small', '되돌리기');
    undo.id = 'week-schedule-undo';
    undo.dataset.focusKey = 'zoom-week-undo';
    const bar = element('div', 'wz-import-bar');
    bar.append(base, source, undo);
    panel.append(bar, status);
    const session = { panel, base, weekStart, lessonMode, saving: false, revision: 0 };
    weekImport = session;
    if (!hasUndo()) undo.hidden = true;
    const fallbackSubject = () => subjects()[0] || '';
    const current = revision => weekImport === session && view.zoomWeek === weekStart && mode() === lessonMode &&
      view.lessons && !!view.edit && revision === session.revision;

    function hasUndo() { return weekUndo?.weekStart === weekStart && weekUndo.mode === lessonMode; }
    function message(text = '', error = false) {
      status.textContent = text;
      status.hidden = !text;
      status.classList.toggle('error', error);
    }
    function reset() {
      session.revision += 1;
      field.value = '';
      message();
      return session.revision;
    }
    async function saveWeek(schedule) {
      const before = weekLessonSlots(state.snapshot, weekStart, lessonMode);
      await persistWeek({ weekSchedule: { weekStart, mode: lessonMode, schedule }, captureImportUndo: true }, snapshot => {
        if (snapshot.lessonImportUndo) weekUndo = { weekStart, mode: lessonMode, token: snapshot.lessonImportUndo };
        const after = weekLessonSlots(snapshot, weekStart, lessonMode);
        const cleared = before.filter(slot => !after.includes(slot)).length;
        message(cleared ? `${cleared}칸 비움` : '');
      });
    }
    async function persistWeek(input, saved) {
      if (session.saving || !current(session.revision)) return;
      session.saving = true;
      const controls = [base, file, field, undo];
      const focused = document.activeElement;
      controls.forEach(control => { control.disabled = true; });
      zoom.querySelectorAll('.wz-nav button, .wz-actions button').forEach(control => { control.disabled = true; });
      message('이번 주 시간표를 저장하는 중이에요…');
      try {
        const snapshot = await api.saveLessons(input);
        sync(snapshot);
        saved(snapshot);
      } catch (error) {
        if (input.undoLessonImport) weekUndo = null;
        message(error.message, true);
      } finally {
        session.saving = false;
        controls.forEach(control => { control.disabled = false; });
        undo.hidden = !hasUndo();
        renderZoom();
        if (weekImport === session && controls.includes(focused)) (focused.hidden || focused.disabled ? field : focused).focus({ preventScroll: true });
      }
    }
    function parseTable(text, html) {
      reset();
      const result = L.readTimetable(text, { matrices: htmlMatrices(html), mode: lessonMode, fallbackSubject: fallbackSubject() });
      acceptRows(result.schedule, result.message);
    }
    function acceptRows(rows, failure) {
      try {
        const schedule = L.cleanSchedule(rows);
        if (schedule) { void saveWeek(schedule); return; }
        message(failure || '요일과 교시가 있는 시간표를 찾지 못했어요.', true);
      } catch (error) { message(error.message, true); }
    }
    async function loadFile(source, label, revision) {
      if (!current(revision)) return;
      const local = source.filePath && /\.(?:hwpx|xlsx)$/i.test(source.filePath);
      message(local ? `${label} 읽는 중…` : `AI가 ${label} 읽는 중…`);
      try {
        const result = await api.readTimetableSource(source);
        if (!current(revision)) return;
        if (result.matrices) {
          const options = { matrices: result.matrices, mode: lessonMode, fallbackSubject: fallbackSubject() };
          const parsed = /\.xlsx$/i.test(source.filePath || '') ? L.readTimetableSetup('', options) : L.readTimetable('', options);
          acceptRows(parsed.schedule, parsed.message);
        } else {
          const rows = lessonMode === 'subject'
            ? result.schedule?.map(row => row.map(value => L.classCell(value, fallbackSubject()))) : result.schedule;
          acceptRows(rows, result.note);
        }
      } catch (error) {
        if (current(revision)) message(error.message, true);
      }
    }
    async function receiveFiles(files) {
      const first = files[0];
      if (!first || session.saving) return;
      const revision = reset();
      try {
        const filePath = api.filePath(first);
        if (filePath) return await loadFile({ filePath }, first.name, revision);
        if (!/^image\//.test(first.type)) {
          message('한글(.hwpx), 엑셀(.xlsx), PDF 또는 그림 파일을 넣어 주세요.', true);
          return;
        }
        const bytes = new Uint8Array(await first.arrayBuffer());
        await loadFile({ image: { bytes, type: first.type } }, first.name || '붙여넣은 그림', revision);
      } catch {
        if (current(revision)) message('파일을 읽지 못했어요. 다시 넣어 주세요.', true);
      }
    }
    bindTimetableDrop(source, receiveFiles);
    base.addEventListener('click', () => {
      if (base.disabled || session.saving) return;
      reset();
      void saveWeek(null);
    });
    file.addEventListener('click', async () => {
      if (session.saving) return;
      const requestedAt = session.revision;
      const filePath = await api.pickTimetableFile().catch(() => '');
      if (!filePath || !current(requestedAt)) return;
      const revision = reset();
      await loadFile({ filePath }, filePath.split(/[\\/]/).pop(), revision);
    });
    field.addEventListener('paste', event => {
      if (!event.clipboardData || session.saving) return;
      event.preventDefault();
      const html = event.clipboardData.getData('text/html');
      const files = [...event.clipboardData.files];
      if (files.length && !/<table/i.test(html)) void receiveFiles(files);
      else parseTable(event.clipboardData.getData('text/plain'), html);
    });
    field.addEventListener('keydown', event => {
      if (event.key !== 'Enter' || event.shiftKey || event.isComposing || !field.value.trim()) return;
      event.preventDefault();
      parseTable(field.value, '');
    });
    undo.addEventListener('click', () => {
      if (!hasUndo() || session.saving) return;
      field.focus({ preventScroll: true });
      reset();
      void persistWeek({ undoLessonImport: weekUndo.token }, () => {
        weekUndo = null;
        message();
      });
    });
    return panel;
  }


  function weekLessonSlots(snapshot, weekStart, lessonMode) {
    const data = snapshot.lessons || L.emptyPlan();
    const start = fromKey(weekStart);
    return L.WEEKDAYS.flatMap((_, column) => {
      const day = key(shift(start, column));
      return L.lessonsOn(day, data[lessonMode], data.term, { changes: data.changes, mode: lessonMode })
        .map(({ period }) => L.recordKey(lessonMode, day, period));
    });
  }

  // ── 크게 보는 주에서 시간표 고치기(11/26 사용자 "시간표 수정을 엄청 편하게") ──
  // 과목을 골라 칸을 누르면 그 과목으로(칠하기), 칸 두 개를 차례로 누르거나 끌어 놓으면 맞바꾼다.
  // 주의 수업을 바꾸거나 맞바꾼다. 맞바꾸면 해당 수업의 메모와 자료도 이동한다.
  function startEdit() {
    if ($('detail-panel').classList.contains('open')) closeDetail();
    if ($('detail-panel').classList.contains('open')) return;
    view.edit = { menu: null, pick: null, extra: [], message: '', error: false };
    renderZoom();
    $('week-schedule-paste')?.focus({ preventScroll: true });
  }
  // 빈 교시(그날만 6교시가 없는 날 등)를 누르면 고치기로 들어가 그 칸의 과목 메뉴를 바로 연다
  // (11/26 사용자 "6교시가 없는날도 추가할 수 있게").
  function addLesson(dateKey, period, column) {
    const add = button('wz-add', '+');
    add.dataset.focusKey = `zoom-add-${dateKey}-${period}`;
    add.title = `${L.WEEKDAYS[column]}요일 ${period}교시에 수업 넣기`;
    add.setAttribute('aria-label', add.title);
    add.addEventListener('click', () => {
      startEdit();
      if (!view.edit) return;
      const changed = editKey(dateKey, period) in (plan().changes || {});
      const base = savedSchedule()?.[period - 1]?.[column] || '';
      view.edit.menu = { dateKey, period, column, cell: '', base, changed };
      renderZoom();
      zoom.querySelector(slotSelector(view.edit.menu))?.focus({ preventScroll: true });
    });
    return add;
  }
  function emptyWeek() {
    const empty = element('p', 'wz-empty', '이 주에 수업이 없어요.');
    return empty;
  }
  function stopEdit() {
    if (weekImport?.saving) return;
    clearWeekImport();
    view.edit = null;
    view.drag = null;
    renderZoom();
    zoom.querySelector('[data-focus-key="zoom-edit"]')?.focus({ preventScroll: true });
  }
  const editKey = (dateKey, period) => L.recordKey(mode(), dateKey, period);
  const cellLabel = cell => {
    const { grade, room, subject } = L.partsOf(cell);
    return grade ? `${grade}-${room} ${subject}` : subject;
  };

  // 고를 과목: 이 시간표에 나오는 과목만, 많이 나오는 순(11/26 사용자 "과목이 많아지면 위에 보기가 어지럽다").
  // 그 밖의 과목은 "다른 과목" 칸에 써 넣는다(학교급 과목 자동 완성).
  function menuNames() {
    const count = new Map();
    for (const cell of (savedSchedule() || []).flat()) if (cell) count.set(cell, (count.get(cell) || 0) + 1);
    for (const [id, cell] of Object.entries(plan().changes || {})) if (cell && id.startsWith(`${mode()}|`) && !count.has(cell)) count.set(cell, 0);
    for (const cell of view.edit.extra) if (!count.has(cell)) count.set(cell, 0);
    if (!count.size && mode() !== 'subject') return SCHOOL_SUBJECTS[state.snapshot.profile?.schoolLevel || '초등'] || SCHOOL_SUBJECTS.초등;
    return [...count].sort((a, b) => b[1] - a[1]).map(([cell]) => cell);
  }

  function editTools(week) {
    const edit = view.edit;
    const tools = element('div', 'wz-tools');
    const hint = element('p', 'wz-hint');
    hint.setAttribute('role', 'status');
    hint.classList.toggle('error', edit.error && !!edit.message);
    hint.classList.toggle('picking', !!edit.pick);
    hint.textContent = edit.message || (edit.pick
      ? `${cellLabel(edit.pick.cell)}와(과) 맞바꿀 칸을 누르세요 · Esc는 취소` : '');
    const changed = week.slice(0, 5).some(({ dateKey }) => L.changedOn(plan().changes, mode(), dateKey).size > 0);
    tools.append(weekImportPanel(changed));
    if (hint.textContent) tools.append(hint);
    return tools;
  }

  const slotSelector = at => `[data-focus-key="zoom-slot-${at.dateKey}-${at.period}"]`;
  function editSlot(dateKey, period, column, cell) {
    const edit = view.edit;
    const slot = button('week-zoom-slot editable');
    slot.disabled = !!weekImport?.saving;
    slot.dataset.focusKey = `zoom-slot-${dateKey}-${period}`;
    const changed = editKey(dateKey, period) in (plan().changes || {});
    const base = savedSchedule()?.[period - 1]?.[column] || '';
    slot.classList.toggle('changed', changed);
    const picked = edit.pick?.dateKey === dateKey && edit.pick?.period === period;
    const open = edit.menu?.dateKey === dateKey && edit.menu?.period === period;
    slot.classList.toggle('picked', picked || open);
    slot.setAttribute('aria-haspopup', 'dialog');
    slot.setAttribute('aria-expanded', String(open));
    slot.setAttribute('aria-label', `${L.WEEKDAYS[column]}요일 ${period}교시 ${cell ? cellLabel(cell) : '빈 칸'}${changed ? ` · 원래 ${base ? cellLabel(base) : '빈 칸'}` : ''}`);
    if (cell) {
      slot.style.setProperty('--subject', colorOf(cell));
      slot.append(element('span', 'wz-edit-cell', cellLabel(cell)));
    } else slot.append(element('span', 'wz-edit-empty', changed && base ? `원래 ${cellLabel(base)}` : ''));
    const here = { dateKey, period, column, cell, base, changed };
    slot.addEventListener('click', () => {
      if (edit.pick) {
        const from = edit.pick;
        edit.pick = null;
        if (from.dateKey === dateKey && from.period === period) { renderZoom(); return; }
        void swapCells(from, here);
        return;
      }
      Object.assign(edit, { menu: open ? null : here, message: '' });
      renderZoom();
    });
    // 끌어 놓기로 맞바꾸기.
    slot.draggable = !!cell;
    slot.addEventListener('dragstart', event => {
      view.drag = here;
      edit.menu = null;
      zoom.querySelector('.wz-menu')?.remove();
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', cellLabel(cell));
    });
    slot.addEventListener('dragend', () => { view.drag = null; });
    slot.addEventListener('dragover', event => {
      if (!view.drag) return;
      event.preventDefault();
      slot.classList.add('drop-target');
    });
    slot.addEventListener('dragleave', () => slot.classList.remove('drop-target'));
    slot.addEventListener('drop', event => {
      event.preventDefault();
      const from = view.drag;
      view.drag = null;
      slot.classList.remove('drop-target');
      if (from && !(from.dateKey === dateKey && from.period === period)) void swapCells(from, here);
    });
    return slot;
  }

  // 칸을 누르면 그 칸 옆에 뜨는 작은 메뉴: 과목 고르기·빈 칸·다른 과목 쓰기·자리 바꾸기·원래대로.
  function editMenu() {
    const edit = view.edit;
    const at = edit.menu;
    const slot = zoom.querySelector(slotSelector(at));
    if (!slot) { edit.menu = null; return; }
    const menu = element('div', 'wz-menu');
    menu.setAttribute('role', 'dialog');
    menu.setAttribute('aria-label', `${L.WEEKDAYS[at.column]}요일 ${at.period}교시 바꾸기`);
    const head = element('p', 'wz-menu-head');
    head.append(element('b', null, `${L.WEEKDAYS[at.column]} ${at.period}교시`), at.cell ? ` · 지금 ${cellLabel(at.cell)}` : ' · 빈 칸');
    const choose = value => {
      edit.menu = null;
      slot.focus({ preventScroll: true });
      void setCell(at, value);
    };
    const list = element('div', 'wz-menu-subjects');
    const chip = (value, text) => {
      const item = button('wz-chip', text);
      if (value) item.style.setProperty('--subject', colorOf(value));
      else item.classList.add('empty');
      item.dataset.focusKey = `zoom-menu-${value}`;
      if (value === at.cell) { item.setAttribute('aria-current', 'true'); item.disabled = true; }
      item.addEventListener('click', () => choose(value));
      return item;
    };
    list.append(...menuNames().map(name => chip(name, cellLabel(name))), ...(at.cell ? [chip('', '빈 칸')] : []));
    const custom = element('input', 'wz-custom');
    Object.assign(custom, { type: 'text', maxLength: 40, placeholder: mode() === 'subject' ? '다른 반·과목: 5-2 과학' : '다른 과목 쓰고 Enter' });
    custom.dataset.focusKey = 'zoom-menu-custom';
    custom.setAttribute('aria-label', '목록에 없는 과목 쓰기(Enter)');
    if (mode() !== 'subject') custom.setAttribute('list', subjectList().id);
    custom.addEventListener('keydown', event => {
      if (event.key !== 'Enter' || !custom.value.trim()) return;
      event.preventDefault();
      const value = mode() === 'subject' ? L.classCell(custom.value, subjects()[0]) : custom.value.trim();
      if (!value) return;
      if (!edit.extra.includes(value)) edit.extra.push(value);
      choose(value);
    });
    const actions = element('div', 'wz-menu-actions');
    if (at.cell) {
      const swap = button('button text-button small', '다른 칸과 자리 바꾸기');
      swap.dataset.focusKey = 'zoom-menu-swap';
      swap.addEventListener('click', () => {
        Object.assign(edit, { menu: null, pick: at, message: '' });
        slot.focus({ preventScroll: true });
        renderZoom();
      });
      actions.append(swap);
    }
    if (at.changed) {
      const back = button('button text-button small', `원래대로(${at.base ? cellLabel(at.base) : '빈 칸'})`);
      back.dataset.focusKey = 'zoom-menu-back';
      back.addEventListener('click', () => {
        edit.menu = null;
        slot.focus({ preventScroll: true });
        void saveEdit({ changes: { [editKey(at.dateKey, at.period)]: null } });
      });
      actions.append(back);
    }
    menu.append(head, list, custom, ...(actions.children.length ? [actions] : []));
    zoom.append(menu);
    // 칸 바로 아래(자리가 없으면 위), 층 밖으로 나가지 않게.
    const box = zoom.getBoundingClientRect();
    const cell = slot.getBoundingClientRect();
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    const left = Math.min(Math.max(4, cell.left - box.left), box.width - width - 4);
    const below = cell.bottom - box.top + 2;
    const top = below + height <= box.height - 4 ? below : Math.max(4, cell.top - box.top - height - 2);
    Object.assign(menu.style, { left: `${left}px`, top: `${top}px` });
  }
  // 메뉴 밖을 누르면 닫는다(다른 칸을 누르면 그 칸 메뉴로).
  document.addEventListener('pointerdown', event => {
    if (!view.edit?.menu || event.target.closest?.('.wz-menu, .week-zoom-slot.editable')) return;
    view.edit.menu = null;
    zoom.querySelector('.wz-menu')?.remove();
    renderZoom();
  }, true);

  async function saveEdit(input, done = '') {
    if (weekImport?.saving) return;
    try {
      sync(await api.saveLessons(input));
      if (view.edit) Object.assign(view.edit, { message: done, error: false });
    } catch (error) {
      if (view.edit) Object.assign(view.edit, { message: error.message, error: true });
    }
    renderZoom();
  }
  function setCell(at, cell) {
    if (at.cell === cell) return;
    return saveEdit({ changes: { [editKey(at.dateKey, at.period)]: cell } });
  }
  function swapCells(a, b) {
    if (a.cell === b.cell) { renderZoom(); return; }
    const label = `${a.cell ? cellLabel(a.cell) : '빈 칸'} ↔ ${b.cell ? cellLabel(b.cell) : '빈 칸'}`;
    const [ka, kb] = [editKey(a.dateKey, a.period), editKey(b.dateKey, b.period)];
    return saveEdit({ changes: { [ka]: b.cell, [kb]: a.cell }, swapRecords: [ka, kb] }, `${label} 맞바꿨어요`);
  }

  function zoomLesson(dateKey, period, cell, changed) {
    const id = lessonId(dateKey, period);
    const recordKey = id.slice(PREFIX.length);
    // 카드 = 자세히 여는 단추(과목·메모) + 자료 단추들. 단추 안에 단추를 둘 수 없어 카드는 묶음 칸이다.
    const card = element('div', 'week-zoom-lesson');
    card.style.setProperty('--subject', colorOf(cell));
    card.classList.toggle('changed', !!changed);
    const selected = state.selected === id;
    card.classList.toggle('selected', selected);
    const main = button('wz-open');
    main.setAttribute('aria-pressed', String(selected));
    main.dataset.focusKey = `zoom-${id}`;
    main.title = '수업 자세히';
    const record = plan().records[recordKey];
    const { grade, room, subject } = L.partsOf(cell);
    const name = element('span', 'wz-subject');
    name.append(element('span', 'wz-subject-text', grade ? `${grade}-${room} ${subject}` : subject));
    // 그날만 바꾼 수업은 과목 옆에 "바꿈"(11/26 점검: 평소 수업과 똑같이 보였다). 좁으면 과목 글자가 먼저 줄어든다.
    if (changed) {
      const tag = element('span', 'wz-changed', '바꿈');
      tag.title = '이 날만 바꾼 수업';
      name.append(tag);
    }
    main.append(element('span', 'sr-only', `${period}교시`), name);
    const memo = (record?.memo || '').split('\n').map(line => line.trim()).filter(Boolean).slice(0, 2).join('\n');
    if (memo) main.append(element('span', 'wz-memo', memo));
    const open = () => openLesson(id, main.dataset.focusKey);
    main.addEventListener('click', open);
    card.addEventListener('click', event => { if (event.target === card) open(); });
    card.append(main);
    // 자료는 달력에서 바로 연다(11/26 사용자 "캘린더에서도 자료 켜지게"). 셋까지, 넘치면 자세히에서.
    const files = record?.files || [];
    if (files.length) {
      const list = element('div', 'wz-files');
      files.slice(0, 3).forEach((file, index) => {
        const link = button('wz-file', file.name);
        link.title = `${file.path}\n누르면 엽니다.`;
        link.dataset.focusKey = `zoom-file-${recordKey}-${index}`;
        link.addEventListener('click', async () => {
          try {
            const latest = plan().records[recordKey]?.files[index];
            const result = await api.openLessonFile(recordKey, index, file.path, false, latest?.path === file.path ? latest.track : file.track);
            if (!result.missing) return;
          } catch (error) { notice(error.message); return; }
          // 못 찾으면 자세히를 열어 그 자료의 "다시 연결"을 보인다.
          openLesson(id, main.dataset.focusKey);
          panel.querySelectorAll('.lesson-file-name')[index]?.click();
        });
        list.append(link);
      });
      if (files.length > 3) {
        const more = button('wz-file wz-more', `+${files.length - 3}`);
        more.title = '자료 모두 보기';
        more.addEventListener('click', open);
        list.append(more);
      }
      card.append(list);
    }
    return card;
  }

  $('month').addEventListener('click', event => {
    if (!view.lessons) return;
    const hit = event.target.closest?.('.day-hit');
    if (!hit) return;
    // 업무 탭과 달리 업무 추가 창은 열지 않는다.
    event.stopPropagation();
    if ($('detail-panel').classList.contains('open')) closeDetail();
    openZoom(mondayOf(hit.dataset.focusKey.slice(5)), hit.closest('.day'));
  }, true);
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !view.zoomWeek || !view.lessons || document.querySelector('dialog[open]')) return;
    if (weekImport?.saving) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (view.edit) {
      // 열린 메뉴·고른 칸부터 풀고, 그다음 고치기를 끝낸다.
      event.preventDefault();
      event.stopPropagation();
      const at = view.edit.menu || view.edit.pick;
      if (at) {
        Object.assign(view.edit, { menu: null, pick: null, message: '' });
        zoom.querySelector(slotSelector(at))?.focus({ preventScroll: true });
        renderZoom();
      } else stopEdit();
      return;
    }
    if ($('detail-panel').classList.contains('open')) return; // Esc 한 번은 자세히부터 닫는다.
    closeZoom(true);
  }, true);
  // 달을 옮기면 크게 보던 주는 닫는다(업무 탭에서 옮겨도).
  for (const id of ['previous', 'next', 'today']) $(id).addEventListener('click', () => closeZoom(false));
  const zoomResize = new ResizeObserver(() => { if (view.zoomWeek) renderZoom(); });
  zoomResize.observe($('month'));
  zoomResize.observe($('month').closest('.calendar')); // 창 높이만 바뀌어도 층 높이를 맞춘다
  addEventListener('resize', () => { if (view.zoomWeek) renderZoom(); });

  function lessonItem(dateKey, period, cell, changed) {
    const id = lessonId(dateKey, period);
    const item = button('item lesson-item');
    item.classList.toggle('changed', !!changed);
    item.style.setProperty('--subject', colorOf(cell));
    const selected = state.selected === id;
    item.classList.toggle('selected', selected);
    item.setAttribute('aria-pressed', String(selected));
    item.dataset.focusKey = `calendar-${id}`;
    const record = plan().records[id.slice(PREFIX.length)];
    // 메모·자료가 붙은 수업은 과목 옆에 작은 점(11/26 점검: 달력만 봐서는 알 수 없었다).
    item.classList.toggle('has-note', !!(record?.memo?.trim() || record?.files.length));
    item.title =`${period}교시 ${cell}${changed ? ' (이 날만 바꿈)' : ''}${record?.memo ? ` · ${record.memo}` : ''}${record?.files.length ? ` · 자료 ${record.files.length}` : ''}`;
    const { cls, subject } = L.partsOf(cell);
    // 담임: "1 국어". 교과: "2 2-3 국어"(좁으면 과목부터 줄어든다).
    const title = element('span', 'item-title');
    title.append(element('span', 'lesson-period', String(period)), ' ',
      ...(cls ? [element('span', 'lesson-class', cls), ' ', element('span', 'lesson-subject', subject)] : [subject]));
    item.append(title);
    item.addEventListener('click', event => {
      event.stopPropagation();
      openLesson(id, item.dataset.focusKey);
    });
    return item;
  }

  // ── 수업 자세히 ──
  const panel = $('lesson-detail');
  let shown = null;
  function openLesson(id, focusKey) {
    if (state.selected === id) return;
    if (!openDetail(id, null, focusKey)) return;
    renderLesson();
    if (tourStep === 'lesson' && focusKey?.startsWith('zoom-') && !panel.hidden) {
      tourStep = 'done';
      renderTour();
    }
  }
  const originalRefresh = refreshDetail;
  refreshDetail = async function refreshWorkOrLesson(reset) {
    if (isLesson(state.selected)) { renderLesson(); renderTour(); return; }
    panel.hidden = true;
    shown = null;
    return originalRefresh(reset);
  };
  // 닫기 단추는 원래 closeDetail을 물고 있어서, 패널이 닫히는 것을 보고 수업 칸을 감춘다.
  new MutationObserver(() => {
    if (!$('detail-panel').classList.contains('open')) { panel.hidden = true; shown = null; renderTour(); }
  }).observe($('detail-panel'), { attributes: true, attributeFilter: ['class'] });

  let renderedFiles;
  let missingFiles;
  function renderLesson() {
    const id = state.selected;
    const { lessonMode, dateKey, period, record: recordKey } = parseId(id);
    const table = plan()[lessonMode];
    const lesson = L.lessonsOn(dateKey, table, plan().term, dayOptions(lessonMode)).find(item => item.period === period);
    const cell = lesson?.cell;
    $('detail-heading').textContent = '수업';
    $('detail-content').hidden = true;
    $('detail-toolbar').hidden = true;
    panel.hidden = false;
    if (!cell) {
      shown = null;
      panel.replaceChildren(element('p', 'small-note', '시간표에서 이 수업이 빠졌어요. 시간표 창에서 확인해 주세요.'));
      return;
    }
    const record = plan().records[recordKey] || { memo: '', files: [] };
    const { grade, room, subject } = L.partsOf(cell);
    const same = shown === id;
    shown = id;
    if (!same) {
      renderedFiles = null;
      missingFiles = new Set();
      panel.style.setProperty('--subject', colorOf(cell));
      panel.innerHTML = `<p class="lesson-detail-title"><span class="disc" aria-hidden="true"></span><span></span></p>
        <p class="when"></p>
        <section class="detail-section"><h3>자료</h3>
          <ul class="lesson-files"></ul>
          <div class="lesson-drop">파일을 여기에 끌어다 놓으세요 <button type="button" class="button text-button small lesson-pick">파일 고르기</button></div>
          <p class="small-note lesson-file-status" role="status"></p>
        </section>
        <section class="detail-section"><h3>메모</h3><textarea rows="3" aria-label="수업 메모" placeholder="수업 뒤 메모" maxlength="4000"></textarea>
          <p class="small-note lesson-memo-status" role="status"></p></section>
        <section class="detail-section lesson-history"><h3></h3><div class="lesson-prev-files"></div><ol class="lesson-past"></ol></section>`;
      panel.querySelector('.lesson-detail-title span:last-child').textContent = grade
        ? `${period}교시 · ${grade}학년 ${room}반 · ${subject}` : `${period}교시 ${subject}`;
      const time = periodTimes()[period - 1];
      panel.querySelector('.when').textContent = dateLabel.format(fromKey(dateKey)) + (time ? ` · ${time[0]}~${time[1]}` : '');
      // 그날만 바꾼 수업이면 원래 무엇이었는지 함께 보인다.
      if (lesson.changed) {
        const base = L.lessonsOn(dateKey, table, plan().term, { mode: lessonMode }).find(item => item.period === period)?.cell;
        const note = element('p', 'lesson-changed-note', `이 날만 바꾼 수업 · 원래 ${base ? cellLabel(base) : '빈 칸'}`);
        panel.querySelector('.when').after(note);
      }
      panel.querySelector('.lesson-history h3').textContent = `지난 ${grade ? `${grade}학년 ${room}반 ` : ''}${subject} 수업`;
      wireLesson(id, recordKey);
      if (record.files.length) {
        const status = panel.querySelector('.lesson-file-status');
        void api.refreshLessonFiles(recordKey).catch(error => { status.textContent = error.message; });
      }
    }
    const memo = panel.querySelector('textarea');
    if (document.activeElement !== memo && !memoTimer) memo.value = record.memo;
    const files = JSON.stringify(record.files.map(file => [file.path, file.name]));
    if (files !== renderedFiles) {
      renderedFiles = files;
      panel.querySelector('.lesson-files').replaceChildren(...record.files.map((file, index) => fileRow(recordKey, file, index)));
    }
    const past = L.earlierLessons(dateKey, period, table, plan().term, 3, dayOptions(lessonMode));
    // 메모·자료가 있는 지난 수업은 한 줄씩, 없는 수업은 날짜만 한 줄로 모은다
    // (11/26 점검: "메모 없음"만 세 줄 이어졌다). 날짜를 누르면 그 수업으로 간다.
    const goPast = lesson => () => {
      const date = fromKey(lesson.date);
      if (monthOf(date).getTime() !== monthOf(state.month).getTime()) state.month = date;
      openLesson(PREFIX + L.recordKey(lessonMode, lesson.date, lesson.period));
    };
    const pastLabel = lesson => {
      const date = fromKey(lesson.date);
      return `${date.getMonth() + 1}/${date.getDate()} ${lesson.period}교시`;
    };
    const pastRecordOf = lesson => plan().records[L.recordKey(lessonMode, lesson.date, lesson.period)];
    const filled = past.filter(lesson => pastRecordOf(lesson)?.memo?.trim() || pastRecordOf(lesson)?.files.length);
    const bare = past.filter(lesson => !filled.includes(lesson));
    const rows = filled.map(lesson => {
      const item = element('li');
      const link = button('lesson-past-link');
      const pastRecord = pastRecordOf(lesson);
      link.append(element('span', 'lesson-past-when', pastLabel(lesson)),
        element('span', `lesson-past-memo${pastRecord?.memo ? '' : ' empty'}`, pastRecord?.memo || ''));
      if (pastRecord?.files.length) link.append(element('span', 'lesson-past-files', `자료 ${pastRecord.files.length}`));
      link.title = '이 수업 자세히 보기';
      link.addEventListener('click', goPast(lesson));
      item.append(link);
      return item;
    });
    if (bare.length) {
      const item = element('li', 'lesson-past-bare');
      item.append(element('span', null, '메모·자료 없음'));
      for (const lesson of bare) {
        const link = button('button text-button small lesson-past-date', pastLabel(lesson));
        link.title = '이 수업 자세히 보기';
        link.addEventListener('click', goPast(lesson));
        item.append(link);
      }
      rows.push(item);
    }
    panel.querySelector('.lesson-past').replaceChildren(...(rows.length ? rows : [element('li', 'small-note', '아직 지난 수업이 없어요.')]));
    renderPreviousFiles(lessonMode, past[0]);
  }

  // 바로 지난 같은 과목(교과는 같은 반) 수업의 자료를 여기서 바로 연다(11/26 사용자 "딱 바로 지난 수업 자료만").
  // 메모는 아래 지난 수업 3개 목록에서 본다.
  function renderPreviousFiles(lessonMode, previous) {
    const box = panel.querySelector('.lesson-prev-files');
    const previousKey = previous && L.recordKey(lessonMode, previous.date, previous.period);
    const files = previous ? plan().records[previousKey]?.files || [] : [];
    const signature = JSON.stringify([previousKey, files.map(file => [file.path, file.name])]);
    if (box.dataset.signature === signature) return;
    box.dataset.signature = signature;
    box.hidden = !files.length;
    if (!files.length) { box.replaceChildren(); return; }
    const date = fromKey(previous.date);
    const status = element('p', 'small-note lesson-prev-status');
    status.setAttribute('role', 'status');
    // 지난 수업으로 넘어가기(11/26 사용자 "지난 수업으로 이동하는 것도").
    const go = () => {
      if (monthOf(date).getTime() !== monthOf(state.month).getTime()) state.month = date;
      openLesson(PREFIX + previousKey);
    };
    const label = element('p', 'lesson-prev-label');
    const jump = button('button text-button small lesson-prev-go', '그 수업 보기 ›');
    jump.addEventListener('click', go);
    label.append(element('span', null, `${date.getMonth() + 1}/${date.getDate()} ${previous.period}교시 자료`), jump);
    box.replaceChildren(label,
      ...files.map((file, index) => {
        const link = button('lesson-prev-file', file.name);
        link.title = `${file.path}\n누르면 엽니다.`;
        link.addEventListener('click', async () => {
          status.textContent = '';
          try {
            const latest = plan().records[previousKey]?.files[index];
            const result = await api.openLessonFile(previousKey, index, file.path, false, latest?.path === file.path ? latest.track : file.track);
            if (!result.missing) return;
          } catch (error) { status.textContent = error.message; return; }
          // 못 찾으면 그 수업으로 넘어가 그 자료의 "다시 연결"을 보인다.
          go();
          panel.querySelectorAll('.lesson-file-name')[index]?.click();
        });
        return link;
      }), status);
  }

  let memoTimer = null;
  async function saveMemo(recordKey, memo, status) {
    try {
      await api.saveLessonRecord(recordKey, { memo });
      status.textContent = '';
    } catch (error) {
      status.textContent = error.message;
      status.dataset.error = '';
    }
  }
  function wireLesson(id, recordKey) {
    const memo = panel.querySelector('textarea');
    const memoStatus = panel.querySelector('.lesson-memo-status');
    const fileStatus = panel.querySelector('.lesson-file-status');
    memo.addEventListener('input', () => {
      clearTimeout(memoTimer);
      memoStatus.textContent = '';
      memoTimer = setTimeout(async () => {
        memoTimer = null;
        if (state.selected === id) await saveMemo(recordKey, memo.value, memoStatus);
      }, 600);
    });
    memo.addEventListener('blur', () => {
      if (!memoTimer) return;
      clearTimeout(memoTimer);
      memoTimer = null;
      void saveMemo(recordKey, memo.value, memoStatus);
    });
    const drop = panel.querySelector('.lesson-drop');
    drop.addEventListener('dragover', event => { event.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', event => {
      event.preventDefault();
      drop.classList.remove('over');
      const paths = [...event.dataTransfer.files].map(file => api.filePath(file));
      fileStatus.textContent = paths.includes('') ? '폴더 밖에서 온 파일은 연결할 수 없어요. 파일 고르기로 넣어 주세요.' : '';
      const localPaths = paths.filter(Boolean);
      if (localPaths.length) void api.addLessonFiles(recordKey, localPaths).catch(error => { fileStatus.textContent = error.message; });
    });
    panel.querySelector('.lesson-pick').addEventListener('click', async () => {
      fileStatus.textContent = '';
      try {
        const paths = await api.pickLessonFiles();
        if (paths.length) await api.addLessonFiles(recordKey, paths);
      } catch (error) { fileStatus.textContent = error.message; }
    });
  }

  function fileRow(recordKey, file, index) {
    const row = element('li', 'lesson-file');
    const open = button('lesson-file-name', file.name);
    open.title = `${file.path}\n누르면 엽니다.`;
    const status = panel.querySelector('.lesson-file-status');
    const missing = missingFiles;
    const folder = button('button text-button small', '폴더');
    folder.title = '파일이 있는 폴더 열기';
    const relink = button('button text-button small lesson-file-relink', '다시 연결');
    relink.setAttribute('aria-label', `${file.name} 다시 연결`);
    relink.hidden = !missing.has(file.path);
    const tryOpen = async reveal => {
      status.textContent = '';
      try {
        const latest = plan().records[recordKey]?.files[index];
        const track = latest?.path === file.path ? latest.track : file.track;
        const result = await api.openLessonFile(recordKey, index, file.path, reveal, track);
        if (!status.isConnected) return;
        if (result.missing) {
          missing.add(file.path);
          status.textContent = '자료를 찾지 못했어요. 다시 연결에서 원본 파일을 골라 주세요.';
        } else {
          missing.delete(file.path);
        }
        const current = plan().records[recordKey]?.files[index];
        if (current?.path !== file.path) return;
        const control = panel.querySelector('.lesson-files').children[index]?.querySelector('.lesson-file-relink');
        if (!control) return;
        control.hidden = !result.missing;
        if (result.missing && [open, folder].includes(document.activeElement)) control.focus();
      } catch (error) { status.textContent = error.message; }
    };
    open.addEventListener('click', () => void tryOpen(false));
    folder.addEventListener('click', () => void tryOpen(true));
    relink.addEventListener('click', async () => {
      const restoreFocus = document.activeElement === relink;
      relink.disabled = true;
      try {
        if (await api.relinkLessonFile(recordKey, index, file.path)) {
          missing.delete(file.path);
          relink.hidden = true;
          status.textContent = '';
        }
      } catch (error) { status.textContent = error.message; }
      finally {
        relink.disabled = false;
        if (restoreFocus && status.isConnected && document.activeElement === document.body) {
          const next = relink.isConnected && !relink.hidden ? relink
            : panel.querySelector('.lesson-files').children[index]?.querySelector('.lesson-file-name');
          next?.focus();
        }
      }
    });
    const remove = button('button icon-button small lesson-file-remove', '×');
    remove.setAttribute('aria-label', `${file.name} 연결 빼기`);
    remove.title = '연결만 빼고 파일은 그대로 둡니다';
    remove.addEventListener('click', async () => {
      status.textContent = '';
      try {
        await api.removeLessonFile(recordKey, index, file.path);
        missing.delete(file.path);
      } catch (error) { status.textContent = error.message; }
    });
    row.append(open, folder, relink, remove);
    return row;
  }

  // ── 시간표 창(시간표·교시 시각·적용 기간, 11/25 사용자 "설정이 너무 복잡해지는데") ──
  const dialog = $('timetable-dialog');
  $('lesson-timetable-open').addEventListener('click', openTimetable);
  $('lesson-empty-open').addEventListener('click', () => void pickTimetableFile(true));
  $('timetable-close').addEventListener('click', () => { if (!timetableSaving) dialog.close(); });
  dialog.addEventListener('cancel', event => { if (timetableSaving) event.preventDefault(); });
  dialog.addEventListener('click', event => { if (!timetableSaving && event.target === dialog) dialog.close(); });
  dialog.addEventListener('close', () => {
    if (!dialog.open) resetTimetableInput();
  });
  $('lesson-view-change').addEventListener('click', () => { if (!timetableSaving) { dialog.close(); openSettings('role'); renderChips(); } });

  dialog.addEventListener('close', renderTour);

  function openTimetable() {
    if (dialog.open) return;
    resetTimetableInput();
    view.rows = 0;
    renderTimetable();
    const { term } = plan();
    $('term-start').value = term?.start || '';
    $('term-end').value = term?.end || '';
    setMessage('term-status', '');
    dialog.showModal();
    renderTour();
    $('timetable-heading').focus();
  }

  function renderTimetable() {
    const subjectMode = mode() === 'subject';
    $('lesson-view-text').replaceChildren(...(subjectMode
      ? [element('b', null, '교과 보기'), ` · 교시 학년-반 과목 · 학년별 색 · ${subjects().join(', ') || '과목 없음'}`]
      : [element('b', null, '담임 보기'), ' · 교시 과목 · 과목별 색']));
    const blank = () => ['', '', '', '', ''];
    const saved = savedSchedule() || [];
    // 시정표에 넣은 교시만큼은 줄이 저절로 생긴다(11/26 사용자 "시정표에 7교시가 있으면 알아서").
    const base = Array.from({ length: Math.max(saved.length, view.rows || 6, plan().periodTimes?.length || 0) }, (_, row) => saved[row] || blank());
    const times = periodTimes();
    const head = element('tr');
    head.append(element('th', null, ''), ...L.WEEKDAYS.map(day => element('th', null, day)));
    const rows = base.map((cells, row) => {
      const tr = element('tr');
      const periodCell = element('th');
      periodCell.append(element('span', 'grid-period', `${row + 1}`), element('span', 'grid-time', times[row]?.[0] || ''));
      tr.append(periodCell, ...cells.map((value, column) => {
        const td = element('td');
        const field = element('input');
        field.value = value;
        field.maxLength = 40;
        field.placeholder = subjectMode ? '공강' : '';
        field.setAttribute('aria-label', `${L.WEEKDAYS[column]}요일 ${row + 1}교시`);
        field.dataset.cell = `${row}-${column}`;
        if (!subjectMode) field.setAttribute('list', 'tt-subject-list');
        field.readOnly = timetableSaving;
        // 엑셀처럼: 방향키·Enter로 칸을 옮긴다(11/26 사용자 "시간표 수정을 엄청 편하게").
        field.addEventListener('keydown', event => moveInGrid(event, field, row, column));
        field.addEventListener('change', () => {
          if (timetableSaving) return;
          const next = base.map(line => line.slice());
          next[row][column] = subjectMode ? L.classCell(field.value, subjects()[0]) : field.value.trim();
          void saveSchedule(next);
        });
        td.append(field);
        return td;
      }));
      return tr;
    });
    const grid = $('lesson-grid');
    const focused = document.activeElement?.closest?.('#lesson-grid') ? document.activeElement.dataset.cell : null;
    subjectList();
    grid.replaceChildren(element('thead'), element('tbody'));
    grid.tHead.append(head);
    grid.tBodies[0].append(...rows);
    $('lesson-add-period').hidden = base.length >= 12;
    // 저장하면 표를 다시 그리므로 있던 칸으로 돌아간다.
    if (focused) grid.querySelector(`[data-cell="${focused}"]`)?.focus();
    renderTimes();
  }
  // 과목 자동 완성 목록(시간표 창·시간표 고치기 메뉴가 같이 쓴다): 학교급 과목+시간표에 나온 과목.
  function subjectList() {
    let list = $('tt-subject-list');
    if (!list) { list = element('datalist'); list.id = 'tt-subject-list'; document.body.append(list); }
    const level = state.snapshot.profile?.schoolLevel || '초등';
    list.replaceChildren(...[...new Set([...(SCHOOL_SUBJECTS[level] || SCHOOL_SUBJECTS.초등), '창체', ...(savedSchedule() || []).flat().filter(Boolean)])]
      .map(name => Object.assign(element('option'), { value: name })));
    return list;
  }
  function moveInGrid(event, field, row, column) {
    if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
    // 칸 글자를 통째로 고른 상태(옮겨 온 직후)거나 커서가 끝에 있으면 옆 칸으로.
    const whole = field.selectionStart === 0 && field.selectionEnd === field.value.length;
    const atStart = whole || (field.selectionStart === 0 && field.selectionEnd === 0);
    const atEnd = whole || field.selectionStart === field.value.length;
    const step = { ArrowUp: [-1, 0], ArrowDown: [1, 0], Enter: [event.shiftKey ? -1 : 1, 0],
      ArrowLeft: atStart ? [0, -1] : null, ArrowRight: atEnd ? [0, 1] : null }[event.key];
    if (!step) return;
    const target = $('lesson-grid').querySelector(`[data-cell="${row + step[0]}-${column + step[1]}"]`);
    if (!target) return;
    event.preventDefault();
    target.focus();
    target.select();
  }
  // 교시 더하기: 빈 줄은 저장할 때 잘리므로 화면에서만 늘려 두고, 칸을 채우면 저장된다.
  $('lesson-add-period').addEventListener('click', () => {
    view.rows = Math.min(12, Math.max((savedSchedule() || []).length, view.rows || 6, plan().periodTimes?.length || 0) + 1);
    renderTimetable();
    $('lesson-grid').tBodies[0].lastElementChild?.querySelector('input')?.focus();
  });

  async function saveSchedule(next) {
    try {
      sync(await api.saveLessons({ mode: mode(), schedule: next }));
      renderTimetable();
    } catch (error) { setMessage('tt-import-status', error.message, true); }
  }

  // 시간표 줄이 시각보다 많으면(7교시 더하기 등) 앞 교시에 이어 쉬는 10분·같은 길이로 채워 보인다(11/26 사용자 "6교시 이후로도").
  const minutes = time => { const [h, m] = time.split(':').map(Number); return h * 60 + m; };
  const clock = total => `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
  function withSuggested(times, rows) {
    const out = times.slice();
    while (out.length < Math.min(12, rows)) {
      const last = out.at(-1) || ['08:50', '08:50'];
      const length = out.length ? minutes(last[1]) - minutes(last[0]) : 40;
      const start = minutes(last[1]) + 10;
      if (start + length >= 24 * 60) break;
      out.push([clock(start), clock(start + length)]);
    }
    return out;
  }
  function renderTimes() {
    const saved = periodTimes();
    const gridRows = $('lesson-grid').tBodies[0]?.rows.length || 0;
    const times = withSuggested(saved, gridRows);
    $('period-times').replaceChildren(...times.map(([start, end], index) => {
      const row = element('label', 'period-time');
      const suggested = index >= saved.length;
      row.classList.toggle('suggested', suggested);
      if (suggested) row.title = '앞 교시에 이어 넣은 시각이에요. 고치면 저장돼요.';
      const make = (value, which) => {
        const field = Object.assign(element('input'), { type: 'time', value });
        field.readOnly = timetableSaving;
        field.setAttribute('aria-label', `${index + 1}교시 ${which === 0 ? '시작' : '끝'}`);
        field.addEventListener('change', async () => {
          if (timetableSaving || !field.value) return;
          const next = times.slice(0, Math.max(saved.length, index + 1)).map((pair, at) => at === index ? pair.map((old, slot) => slot === which ? field.value : old) : pair);
          try { sync(await api.saveLessons({ periodTimes: next })); setMessage('tt-import-status', ''); }
          catch (error) { setMessage('tt-import-status', error.message, true); field.value = value; }
        });
        return field;
      };
      row.append(element('span', 'period-name', `${index + 1}교시`), make(start, 0), element('span', null, '~'), make(end, 1));
      return row;
    }));
  }

  for (const id of ['term-start', 'term-end']) {
    $(id).addEventListener('change', async () => {
      const next = { start: $('term-start').value || null, end: $('term-end').value || null };
      try {
        sync(await api.saveLessons({ term: next }));
        setMessage('term-status', next.start || next.end ? `${next.start || '처음'}부터 ${next.end || '계속'}까지 수업을 보여요.` : '날마다 수업을 보여요.');
      } catch (error) { setMessage('term-status', error.message, true); }
    });
  }

  function bindTimetableDrop(target, receive) {
    target.addEventListener('dragover', event => {
      if (!event.dataTransfer?.types.includes('Files')) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      target.classList.add('drop-target');
    });
    target.addEventListener('dragleave', () => target.classList.remove('drop-target'));
    target.addEventListener('drop', event => {
      target.classList.remove('drop-target');
      if (!event.dataTransfer?.files.length) return;
      event.preventDefault();
      receive([...event.dataTransfer.files]);
    });
  }

  // 복사한 HTML 표(한글·엑셀·웹)를 칸 글자 배열로. 합친 칸은 빈 칸으로 채운다.
  function htmlMatrices(html) {
    if (!html) return [];
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    return [...parsed.querySelectorAll('table')].map(table => {
      const rows = [];
      [...table.rows].forEach((row, index) => {
        rows[index] ||= [];
        let column = 0;
        for (const source of row.cells) {
          while (rows[index][column] !== undefined) column += 1;
          source.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
          const paragraphs = [...source.children].filter(child => child.matches('p, div'));
          rows[index][column] = paragraphs.length ? paragraphs.map(child => child.textContent.trim()).filter(Boolean).join('\n') : source.textContent.trim();
          for (let down = 0; down < Math.min(source.rowSpan, 100); down += 1) {
            rows[index + down] ||= [];
            for (let right = 0; right < Math.min(source.colSpan, 40); right += 1) if (down || right) rows[index + down][column + right] = '';
          }
          column += Math.min(source.colSpan, 40);
        }
      });
      return rows;
    });
  }

  let timetableReadRevision = 0;
  let timetableSaving = false;
  let timetableUndo;
  const importBox = $('tt-import');
  const importField = $('tt-import-input');
  const importFile = $('tt-file-pick');
  const importUndo = $('tt-import-undo');

  function resetTimetableInput() {
    timetableReadRevision += 1;
    importField.value = '';
    importUndo.hidden = !timetableUndo || timetableUndo.mode !== mode();
    importBox.classList.remove('busy', 'drop-target');
    setMessage('tt-import-status', '');
    return timetableReadRevision;
  }
  async function persistTimetable(input, message) {
    if (timetableSaving) return;
    timetableSaving = true;
    const controls = [importFile, importField, importUndo];
    controls.forEach(control => { control.disabled = true; });
    setMessage('tt-import-status', '시간표를 저장하는 중이에요…');
    try {
      const snapshot = await api.saveLessons(input);
      sync(snapshot);
      if (input.undoLessonImport) timetableUndo = null;
      else if (snapshot.lessonImportUndo) timetableUndo = { mode: input.mode, token: snapshot.lessonImportUndo };
      setMessage('tt-import-status', message);
    } catch (error) {
      if (input.undoLessonImport) timetableUndo = null;
      setMessage('tt-import-status', error.message, true);
    } finally {
      timetableSaving = false;
      if (dialog.open) renderTimetable();
      importUndo.hidden = !timetableUndo || timetableUndo.mode !== mode();
      controls.forEach(control => { control.disabled = false; });
    }
  }
  async function setupResult(result, lessonMode) {
    const schedule = L.cleanSchedule(result.schedule);
    const periodTimes = L.cleanTimes(result.periodTimes);
    if (!schedule && !periodTimes) {
      setMessage('tt-import-status', '요일별 시간표나 교시 시각을 찾지 못했어요. 표를 확인해 주세요.', true);
      return;
    }
    const message = schedule && periodTimes ? '기초 시간표·교시 시각 반영'
      : schedule ? '기초 시간표 반영' : '교시 시각 반영';
    await persistTimetable({
      mode: lessonMode,
      ...(schedule ? { schedule } : {}),
      ...(periodTimes ? { periodTimes } : {}),
      captureImportUndo: true
    }, message);
  }
  function readSettingsTable(text, matrices, lessonMode) {
    return L.readTimetableSetup(text, { matrices, mode: lessonMode, fallbackSubject: subjects()[0] || '' });
  }
  async function parseSettingsTable(text, html) {
    resetTimetableInput();
    const lessonMode = mode();
    try { await setupResult(readSettingsTable(text, htmlMatrices(html), lessonMode), lessonMode); }
    catch (error) { setMessage('tt-import-status', error.message, true); }
  }
  const currentTimetableRead = (revision, lessonMode) =>
    dialog.open && revision === timetableReadRevision && lessonMode === mode();

  async function loadSettingsSource(source, label, revision, lessonMode) {
    if (!currentTimetableRead(revision, lessonMode)) return;
    const local = source.filePath && /\.(?:hwpx|xlsx)$/i.test(source.filePath);
    setMessage('tt-import-status', local ? `${label} 읽는 중…` : `AI가 ${label} 읽는 중…`);
    importBox.classList.add('busy');
    try {
      const result = await api.readTimetableSource({ ...source, settings: true });
      if (!currentTimetableRead(revision, lessonMode)) return;
      const imported = result.matrices ? readSettingsTable('', result.matrices, lessonMode) : {
        schedule: lessonMode === 'subject'
          ? result.schedule?.map(row => row.map(value => L.classCell(value, subjects()[0] || ''))) : result.schedule,
        periodTimes: result.periodTimes
      };
      await setupResult(imported, lessonMode);
    } catch (error) {
      if (currentTimetableRead(revision, lessonMode)) {
        setMessage('tt-import-status', error.message, true);
      }
    } finally {
      if (revision === timetableReadRevision) importBox.classList.remove('busy');
    }
  }
  async function timetableFiles(files) {
    const first = files[0];
    if (!first || timetableSaving) return;
    const revision = resetTimetableInput();
    const lessonMode = mode();
    try {
      const filePath = api.filePath(first);
      if (filePath) return await loadSettingsSource({ filePath }, first.name, revision, lessonMode);
      if (!/^image\//.test(first.type)) {
        setMessage('tt-import-status', '한글(.hwpx), 엑셀(.xlsx), PDF 또는 그림 파일을 넣어 주세요.', true);
        return;
      }
      const bytes = new Uint8Array(await first.arrayBuffer());
      await loadSettingsSource({ image: { bytes, type: first.type } }, first.name || '붙여넣은 그림', revision, lessonMode);
    } catch {
      if (currentTimetableRead(revision, lessonMode)) setMessage('tt-import-status', '파일을 읽지 못했어요. 다시 넣어 주세요.', true);
    }
  }
  async function pickTimetableFile(openOnSelection = false) {
    if (timetableSaving) return;
    const requestedAt = timetableReadRevision;
    const lessonMode = mode();
    const filePath = await api.pickTimetableFile().catch(() => '');
    if (!filePath || requestedAt !== timetableReadRevision || mode() !== lessonMode) return;
    if (openOnSelection && !dialog.open) openTimetable();
    await loadSettingsSource({ filePath }, filePath.split(/[\\/]/).pop(), resetTimetableInput(), lessonMode);
  }
  importFile.addEventListener('click', () => void pickTimetableFile());
  bindTimetableDrop(importBox, timetableFiles);
  bindTimetableDrop($('lesson-grid'), timetableFiles);
  importField.addEventListener('paste', event => {
    if (!event.clipboardData || timetableSaving) return;
    event.preventDefault();
    const html = event.clipboardData.getData('text/html');
    const files = [...event.clipboardData.files];
    if (files.length && !/<table/i.test(html)) void timetableFiles(files);
    else parseSettingsTable(event.clipboardData.getData('text/plain'), html);
  });
  importField.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing || !importField.value.trim()) return;
    event.preventDefault();
    parseSettingsTable(importField.value, '');
  });
  importUndo.addEventListener('click', () => {
    if (!timetableUndo || timetableUndo.mode !== mode() || timetableSaving) return;
    resetTimetableInput();
    void persistTimetable({ undoLessonImport: timetableUndo.token }, '');
  });

  // ── 설정 > 내 역할: 과목은 학교급별 목록에서 여러 개 고르고, 없으면 더한다(11/25 사용자) ──
  const SCHOOL_SUBJECTS = {
    초등: ['국어', '수학', '사회', '과학', '영어', '도덕', '실과', '음악', '미술', '체육'],
    중학교: ['국어', '수학', '영어', '사회', '역사', '도덕', '과학', '기술·가정', '정보', '음악', '미술', '체육', '한문'],
    고등학교: ['국어', '문학', '독서', '수학', '영어', '한국사', '통합사회', '통합과학', '물리학', '화학', '생명과학', '지구과학', '정보', '음악', '미술', '체육', '한문']
  };
  const chips = $('profile-subject-chips');
  const extra = $('profile-subject-extra');
  const hiddenSubjects = $('profile-subjects');
  const chosen = () => hiddenSubjects.value.split(',').map(item => item.trim()).filter(Boolean);
  function renderChips() {
    const picked = chosen();
    const names = [...new Set([...(SCHOOL_SUBJECTS[$('profile-school-level').value] || SCHOOL_SUBJECTS.초등), ...picked])];
    chips.replaceChildren(...names.map(name => {
      const chip = element('label', 'check-field small subject-chip');
      const box = element('input');
      box.type = 'checkbox';
      box.checked = picked.includes(name);
      box.addEventListener('change', () => {
        const next = chosen().filter(item => item !== name);
        if (box.checked) next.push(name);
        hiddenSubjects.value = next.slice(0, 10).join(', ');
        renderChips();
      });
      chip.append(box, name);
      return chip;
    }));
    renderRoleNote();
  }
  extra.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || !extra.value.trim()) return;
    event.preventDefault();
    hiddenSubjects.value = [...new Set([...chosen(), extra.value.trim()])].slice(0, 10).join(', ');
    extra.value = '';
    renderChips();
  });
  function renderRoleNote() {
    const elementary = $('profile-school-level').value === '초등';
    const subjectMode = $('profile-workplace').value === '학교' && (!elementary || $('profile-role').value === '전담');
    $('profile-lesson-mode').textContent = subjectMode
      ? `수업 탭은 교과 보기예요. 칸에 "교시 학년-반 과목"이 나오고 학년마다 색이 달라요.${chosen().length ? '' : ' 가르치는 과목을 하나 이상 골라 주세요.'}`
      : '수업 탭은 담임 보기예요. 우리 반 시간표가 "교시 과목"으로 나오고 과목마다 색이 달라요.';
  }
  for (const id of ['profile-workplace', 'profile-school-level', 'profile-role']) $(id).addEventListener('change', renderChips);
  $('settings-open').addEventListener('click', () => requestAnimationFrame(renderChips));

  // 보기 방식이 바뀌면(내 역할 저장) 달력을 다시 그린다. 시작할 때 고른 탭을 되살린다.
  if (view.lessons) selectTab(true);
  window.lessonTab = { selectTab, renderChips };
})();
