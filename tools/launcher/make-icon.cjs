'use strict';

// 앱 아이콘 만들기(한 번만 돌리고 결과를 저장소에 둔다):
//   school-calendar\node_modules\electron\dist\electron.exe tools\launcher\make-icon.cjs
// 결과: school-calendar\assets\app.ico(16~256 여러 크기), app.png(256).
// 모양: 먹색 머리띠가 있는 종이 달력에 빨간 체크(□✓)와 할 일 두 줄. 색은 앱 화면(style.css)과 같다.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const out = path.join(__dirname, '..', '..', 'school-calendar', 'assets');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
  <rect x="18" y="26" width="220" height="212" rx="34" fill="#fffdf8" stroke="#1f1d1a" stroke-width="14"/>
  <path d="M18 60 a34 34 0 0 1 34 -34 h152 a34 34 0 0 1 34 34 v34 h-220 z" fill="#1f1d1a"/>
  <rect x="70" y="8" width="20" height="44" rx="10" fill="#1f1d1a" stroke="#fffdf8" stroke-width="6"/>
  <rect x="166" y="8" width="20" height="44" rx="10" fill="#1f1d1a" stroke="#fffdf8" stroke-width="6"/>
  <rect x="50" y="122" width="72" height="72" rx="8" fill="none" stroke="#1f1d1a" stroke-width="12"/>
  <path d="M64 156 l22 24 l52 -64" fill="none" stroke="#b8322a" stroke-width="18" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M146 146 h60 M146 178 h44" stroke="#5c574d" stroke-width="12" stroke-linecap="round"/>
</svg>`;
const SIZES = [256, 64, 48, 40, 32, 24, 20, 16];

// 512로 한 번 그린 뒤 크기마다 줄인다.
function renderMaster() {
  return new Promise((resolve, reject) => {
    const size = 512;
    const win = new BrowserWindow({ width: size, height: size, show: false, transparent: true, frame: false, useContentSize: true,
      webPreferences: { offscreen: true } });
    let latest = null;
    win.webContents.on('paint', (_event, _dirty, image) => { if (!image.isEmpty()) latest = image; });
    win.webContents.once('did-finish-load', () => setTimeout(() => {
      const image = latest;
      win.destroy();
      if (!image) reject(new Error('Nothing was painted'));
      else resolve(image);
    }, 800));
    const html = '<html><body style="margin:0;background:transparent;overflow:hidden">' +
      '<img src="data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64') + '" width="512" height="512" style="display:block"></body></html>';
    win.loadURL('data:text/html;base64,' + Buffer.from(html).toString('base64')).catch(reject);
  });
}

function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + 16 * images.length;
  for (const { size, png } of images) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += png.length;
    entries.push(entry);
  }
  return Buffer.concat([header, ...entries, ...images.map(image => image.png)]);
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const images = [];
  const master = await renderMaster();
  for (const size of SIZES) images.push({ size, png: master.resize({ width: size, height: size, quality: 'best' }).toPNG() });
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'app.ico'), ico(images));
  fs.writeFileSync(path.join(out, 'app.png'), images[0].png);
  fs.writeFileSync(path.join(out, 'app.svg'), svg);
  console.log('icon written', images.map(image => `${image.size}:${image.png.length}`).join(' '));
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
