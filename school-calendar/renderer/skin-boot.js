// 화면 꾸미기(스킨)를 첫 화면이 그려지기 전에 입힌다. 고르기·저장은 app.js. 이 PC에만 기억한다.
// 처음 켜면 미니멀(2026-11-15 사용자: 할 일이 먼저 보이게). 이미 고른(저장된) 스킨은 그대로 둔다.
(() => {
  let skin = 'minimal';
  try { const saved = localStorage.getItem('calendar-skin'); if (['diary', 'cute', 'evening', 'minimal'].includes(saved)) skin = saved; } catch {}
  document.documentElement.dataset.skin = skin;
})();
