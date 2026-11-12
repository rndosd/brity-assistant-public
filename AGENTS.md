# 브리티 메신저 캘린더 작업 안내

- **좋은 결과** — 일반판 사용자에게 맞는 앱 설정과 안내를 같은 ZIP에서 확인할 수 있다.
- **기준** — 일반판은 새 설치와 소스 실행에서 개인 OpenAI API를 추천한다. 받는 사람이 읽을 설치·사용법은 [README](README.md)에 둔다.
- **상태** — 일반판·서룡판 전체 ZIP과 공통 패치를 로컬에서 만들 수 있다. GitHub 반영 상태는 기본 브랜치, 로컬 변경, 릴리스 자산에서 각각 확인한다.
- **AI가 확인할 것** — 자동 테스트, 패키지 내용, 격리된 앱 설정의 선택지와 기본값을 확인한다.
- **사람에게 물을 것** — 실제 쪽지나 학교 계정을 써야 하거나 배포 대상·승인 범위가 결과를 바꿀 때 확인한다.

## 진입점

| 작업 | 파일 |
| --- | --- |
| 앱 시작, AI 연결, 업데이트, IPC | [main.js](school-calendar/main.js), [preload.js](school-calendar/preload.js) |
| 설정 화면과 기본 선택 | [renderer/app.js](school-calendar/renderer/app.js), [renderer/index.html](school-calendar/renderer/index.html) |
| 업무·환경설정·키 저장 | [store.js](school-calendar/store.js), [ai-provider.js](school-calendar/ai-provider.js) |
| 쪽지·대화방 읽기 | [collector/](collector/), [collector-link.js](school-calendar/collector-link.js), [collect-chats.ps1](school-calendar/collect-chats.ps1) |
| 전체 ZIP, 패치, 실행기 | [build-zip.ps1](tools/build-zip.ps1), [updater.js](school-calendar/updater.js), [update-apply.ps1](school-calendar/update-apply.ps1), [launcher/](tools/launcher/) |

## 실행과 검증

Windows에서 `school-calendar` 폴더의 `npm ci`, `npm test`, `npm start`를 사용한다. 가상 데이터 화면은 `start-calendar-demo.cmd`로 열 수 있다. 샘플 모드에서는 AI 설정이 숨겨지므로 판별 검증은 새로 압축을 푼 사본을 일반 실행기로 연다. 실제 브리티 계정과 API 키 없이 **설정 → AI 연결 방식**을 확인할 수 있다.

저장소 루트에서 실행한다. 다른 결과물과 겹치면 별도 출력 폴더를 `-OutputDirectory`로 지정할 수 있다. 지정한 폴더는 미리 만들어 둔다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\build-zip.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File tools\build-zip.ps1 -Patch
powershell -NoProfile -ExecutionPolicy Bypass -File tools\build-zip.ps1 -Seoryong -FactchatGuideUrl $env:SCHOOL_CALENDAR_FACTCHAT_GUIDE
```

- **일반판 및 공통 패치** — 기본 명령은 일반판 전체 ZIP을 만든다. `-Patch`는 일반판 전체 ZIP과 `release/<버전>/`의 공통 패치 ZIP, `update.json`, `notes.md`를 만든다. 새 설치의 설정에서 OpenAI가 선택되고 학교 옵션은 숨겨진다. 기존 팩트챗 연결은 이어 쓸 수 있다.
- **서룡판** — `-Seoryong`은 ZIP 루트에 `seoryong.edition`을 넣는다. 실행 진입점이 이 파일에서 판과 학교용 안내 주소를 읽는다. 새 설치에서 팩트챗을 먼저 고르며 OpenAI도 선택할 수 있다. 예전 서룡 설치에서 팩트챗을 아직 연결하지 않았다면 서룡판 전체 ZIP을 사용한다. 공통 패치는 루트의 판 표시와 사용 데이터를 건드리지 않는다. 학교 안내 주소는 로컬 환경 변수나 빌드 인자로 제공한다.
- **배포 전 검사** — 일반판과 공통 패치에 학교 판 표시 파일, 학교 전용 안내 URL, 실제 쪽지·업무·시험 데이터가 빠졌는지 확인한다. `update.json`의 버전·파일명·SHA-256이 실제 자산과 일치해야 한다. 업데이트는 배포받는 PC에서 접근 가능한 릴리스 자산이 있어야 작동한다. GitHub의 공개 범위와 릴리스 유무를 확인하고, 이미 작업 중인 변경을 살펴 게시 범위를 정한다.

수집 원문과 사용자 데이터는 `collector/inbox`, `school-calendar/data`, `.qa` 등에 있을 수 있다. 배포와 검증에 쓸 표본은 가상 데이터로 만든다. 전체 ZIP과 패치의 파일 구성은 빌드 스크립트의 허용 목록을 기준으로 확인한다.
