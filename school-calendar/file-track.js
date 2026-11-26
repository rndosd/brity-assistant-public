'use strict';

// 선생님이 옮긴 파일 따라가기(2026-11-25 사용자 "받은 첨부 파일을 정리해 놓을 거 아니야 … 거기서 또 열었을 때 그게 열리게").
// NTFS 파일은 같은 드라이브 안에서 옮기거나 이름을 바꿔도 번호(파일 ID)가 그대로다. 사본을 만들 때 번호를 적어 두고,
// 경로에 없으면 번호로 새 위치를 묻는다. 다른 드라이브로 옮기거나 새 파일로 덮어 저장하면 번호가 바뀌어 못 찾는다.
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');

async function fileTrack(filePath) {
  if (process.platform !== 'win32') return null;
  try {
    const stat = await fs.stat(filePath, { bigint: true });
    if (!stat.isFile() || !stat.ino) return null;
    const drive = /^[a-z]:\\/i.exec(path.resolve(filePath))?.[0];
    return drive ? { volume: drive.toUpperCase(), dev: stat.dev.toString(16), ino: stat.ino.toString(16) } : null;
  } catch {
    return null;
  }
}

function validTrack(track) {
  return !!track && /^[A-Z]:\\$/.test(track.volume) && /^[0-9a-f]{1,32}$/.test(track.ino) && /^[0-9a-f]{1,16}$/.test(track.dev);
}

function queryNameById(volume, ino) {
  return new Promise(resolve => {
    // chcp 65001: 한글 경로가 깨지지 않게. 안내 문장은 Windows 언어마다 달라 \\?\ 뒤의 경로만 읽는다.
    execFile('cmd.exe', ['/d', '/c', `chcp 65001>nul & fsutil file queryFileNameById ${volume} 0x${ino}`],
      { windowsHide: true, encoding: 'utf8', timeout: 5000 }, (error, stdout) => {
        const found = !error && /\\\\\?\\([A-Za-z]:\\[^\r\n]+)/.exec(stdout || '');
        resolve(found ? found[1].trim() : null);
      });
  });
}

// 번호로 찾은 파일이 정말 같은 파일인지(같은 드라이브·같은 번호) 다시 확인해서 돌려준다.
async function findTracked(track) {
  if (process.platform !== 'win32' || !validTrack(track)) return null;
  const found = await queryNameById(track.volume, track.ino);
  if (!found) return null;
  const again = await fileTrack(found);
  return again && again.dev === track.dev && again.ino === track.ino ? found : null;
}

module.exports = { fileTrack, findTracked, validTrack };
