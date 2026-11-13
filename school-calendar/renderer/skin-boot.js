// 화면 꾸미기(스킨)를 첫 화면이 그려지기 전에 입힌다. 고르기·저장은 app.js. 이 PC에만 기억한다.
(() => {
  let skin = 'diary';
  try { const saved = localStorage.getItem('calendar-skin'); if (['diary', 'cute', 'evening'].includes(saved)) skin = saved; } catch {}
  document.documentElement.dataset.skin = skin;
})();
