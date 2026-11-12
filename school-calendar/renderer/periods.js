'use strict';

const calendarPeriods = (() => {
  function receivedDay(datetime) {
    const match = datetime.match(/^\s*(\d{4})\s*[-.년/]\s*(\d{1,2})\s*[-.월/]\s*(\d{1,2})(?!\d)/);
    if (!match) return null;
    const [, year, month, day] = match;
    const value = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(+parsed) && parsed.toISOString().slice(0, 10) === value ? value : null;
  }

  function deadlineLanes(tasks) {
    const ranges = tasks.filter(task => task.noteId && task.category === '할 일' && !task.done && task.due)
      .map(task => ({ task, start: receivedDay(task.datetime), end: task.due }))
      .filter(range => range.start && range.start < range.end)
      .sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end) || a.task.id.localeCompare(b.task.id));
    const ends = [];
    for (const range of ranges) {
      const available = ends.findIndex(end => end <= range.start);
      range.lane = available < 0 ? ends.length : available;
      ends[range.lane] = range.end;
    }
    return ranges;
  }

  function daysBetween(from, to) {
    return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
  }

  return { deadlineLanes, daysBetween, receivedDay };
})();

if (typeof module !== 'undefined') module.exports = calendarPeriods;
