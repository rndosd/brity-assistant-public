# 브리티 메신저 캘린더 작업 안내

- **좋은 결과** — 일반판 사용자에게 맞는 앱 설정과 안내를 같은 ZIP에서 확인할 수 있다.
- **기준** — 정식 릴리스는 브리티·GOE의 일반판과 서룡판을 같은 버전으로 함께 배포한다. 일반판은 새 설치와 소스 실행에서 개인 OpenAI API를 추천한다. 받는 사람이 읽을 설치·사용법은 [README](README.md)에 둔다.
- **상태** — 일반판·서룡판 전체 ZIP과 공통 패치를 로컬에서 만들 수 있다. GitHub 반영 상태는 기본 브랜치, 로컬 변경, 릴리스 자산에서 각각 확인한다.
- **AI가 확인할 것** — 자동 테스트, 패키지 내용, 격리된 앱 설정의 선택지와 기본값을 확인한다.
- **사람에게 물을 것** — 실제 쪽지나 학교 계정을 써야 하거나 배포 대상·승인 범위가 결과를 바꿀 때 확인한다.

## 진입점

작업을 시작하거나 이어받을 때 저장소 루트의 [진행 정리](진행-정리.md)를 먼저 읽는다. 수정·검증·배포 또는 새로운 막힘으로 상태가 달라질 때마다 작업 중에 같은 문서를 갱신한다. 맨 위에는 현재 상태와 다음 확인을 짧게 유지하고, 로컬 수정·가상 시험·실제 앱 확인·배포를 구분한다. 해결한 항목은 남은 문제에서 지우고 세부 근거는 기존 시험이나 결과 문서에 연결한다.

GOE 쪽(`collector/goe`, `collector-link-goe.ps1`, GOE판 빌드·배포)은 따로 [GOE 진행 정리](../../Codex/Projects/brity-assistant/goe/진행-정리.md)를 먼저 읽고, 고칠 때마다 그 턴에 그 문서의 "열린 항목"에 중요한 변경을 적는다. 무엇을 왜 바꿨는지, 확인한 것과 미확인, 커밋·배포 여부를 한 항목으로 쓴다. GOE와 브리티를 함께 고쳤으면 두 문서 모두에 적는다.

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
powershell -NoProfile -ExecutionPolicy Bypass -File tools\build-zip.ps1 -Goe -Patch
```

- **일반판 및 공통 패치** — 기본 명령은 일반판 전체 ZIP을 만든다. `-Patch`는 일반판 전체 ZIP과 `release/<버전>/`의 공통 패치 ZIP, `update.json`, `notes.md`를 만든다. 새 설치의 설정에서 OpenAI가 선택되고 학교 옵션은 숨겨진다. 기존 팩트챗 연결은 이어 쓸 수 있다.
- **Electron 교체** — 기존 앱의 업데이트 버튼으로 Electron도 바꾸려면 `-Patch -ElectronRuntimeZip <공식 Windows x64 ZIP>`을 사용한다. 공식 SHA-256을 확인하고, 대상 버전에서 업데이트 버튼으로 설치한 뒤 Electron 버전과 자료 보존을 확인한다.
- **서룡판** — `-Seoryong`은 ZIP 루트에 `seoryong.edition`을 넣는다. 실행 진입점이 이 파일에서 판과 학교용 안내 주소를 읽는다. 새 설치에서 팩트챗을 먼저 고르며 OpenAI도 선택할 수 있다. 예전 서룡 설치에서 팩트챗을 아직 연결하지 않았다면 서룡판 전체 ZIP을 사용한다. 공통 패치는 루트의 판 표시와 사용 데이터를 건드리지 않는다. 학교 안내 주소는 로컬 환경 변수나 빌드 인자로 제공한다.
- **수정 동기화** — 네 판을 같은 소스 커밋과 `school-calendar/package.json` 버전으로 빌드한다. 공통 기능을 고치면 네 판 모두에 반영하고, 특정 메신저의 수집·연결을 고치면 그 메신저의 일반판과 서룡판에서 같은 수정이 동작하는지 확인한다. 한 판에서 발견한 오류도 같은 기능을 쓰는 다른 판에서 점검한다.
- **GOE판** — `-Goe`는 GOE 전용 수집기와 `goe.edition`을 담은 전체 ZIP을 만든다. `-Patch`를 함께 주면 동일 버전의 GOE 전체 ZIP, 전용 패치, `update-goe.json`과 `notes-goe.md`를 `release/<버전>/`에 별도 이름으로 만든다. 실제 쪽지 없이 확인할 때는 GOE 샘플 실행기를 사용한다. 보낸 지 7일 이내인 쪽지의 첨부를 GOE에 설정된 저장 폴더 그대로 받고(설정 변경 없음) 원본은 그 폴더에 남기며, 캘린더 보관함에 사본을 둔다. 이전에 가져온 쪽지는 자세히에서 **첨부만 다시 받기**를 사용한다. 첨부는 쪽지 창의 이름·크기로 고른다(결정은 `school-calendar/DESIGN.md` 끝).
- **배포 전 검사** — 일반판과 공통 패치에 학교 판 표시 파일, 학교 전용 안내 URL, 실제 쪽지·업무·시험 데이터가 빠졌는지 확인한다. `update.json`의 버전·파일명·SHA-256이 실제 자산과 일치해야 한다. 업데이트는 배포받는 PC에서 접근 가능한 릴리스 자산이 있어야 작동한다. GitHub의 공개 범위와 릴리스 유무를 확인하고, 이미 작업 중인 변경을 살펴 게시 범위를 정한다.
- **배포 경로와 완료 확인** — 브리티는 `rndosd/brity-assistant-public`의 `update.json`, GOE는 `rndosd/goe-messenger-calendar`의 `update-goe.json`을 쓴다. 서룡판 전체 ZIP도 같은 버전으로 만들어 각 판의 기존 배포 경로에 제공한다(GOE 서룡판 빌드는 `-Goe -Seoryong`). 배포 후 두 저장소의 최신 릴리스와 업데이트 정보, 일반판·서룡판 설치 ZIP 네 개가 모두 같은 버전인지 실제 자산에서 확인한 뒤 완료로 기록한다.
- **릴리스 자산** — 전체 ZIP·패치 ZIP·`update.json` 세 개만 올리고, 노트는 `-Patch`가 만든 `notes.md`를 그대로 쓴다(맨 위에 받을 파일 하나의 링크, 맨 아래에 나머지는 받지 않아도 된다는 안내). 진단 도구 `calendar-diagnose.zip`은 README가 v0.4.1 릴리스를 가리키므로 다시 올리지 않는다.

## 바뀐 점 문구

`school-calendar/CHANGES.json`의 항목은 앱의 바뀐 점 창과 릴리스 노트(`notes.md`)에 그대로 나간다. 받는 사람은 선생님이다.

- **선생님이 겪는 일로** — 무엇을 고쳤는지보다 이제 무엇이 되는지, 무엇이 안 생기는지를 쓴다. "~과정을 개선했습니다", "더 정확히" 같은 흐린 말 대신 전에 겪던 불편과 지금 달라진 점을 구체적으로 쓴다.
- **쉬운 말** — 감지·초점·트레이·수신함 확인·재시도 같은 개발 용어와 내부 이름(수집기, 함수·파일명, 오류 코드)을 쓰지 않는다. 화면에 보이는 단추·메뉴 이름은 그대로 쓴다.
- **짧게** — 한 항목에 한 가지, 한두 문장. 괄호 속 나열은 피한다. 선생님이 알 필요 없는 내부 수정(테스트, 빌드, 코드 정리)은 넣지 않는다.
- **할 일이 있으면 앞에** — 업데이트 뒤 선생님이 해야 할 것(설정 바꾸기, 다시 연결 등)은 첫 항목에 쓴다.
- **판 구분** — 한 판에만 해당하면 "GOE판에서"처럼 앞에 밝히고, 같은 판 항목끼리 모은다.
- 새 판을 내기 전에 항목을 이 기준으로 한 번 읽어 다듬는다.

수집 원문과 사용자 데이터는 `collector/inbox`, `school-calendar/data`, `.qa` 등에 있을 수 있다. 배포와 검증에 쓸 표본은 가상 데이터로 만든다. 전체 ZIP과 패치의 파일 구성은 빌드 스크립트의 허용 목록을 기준으로 확인한다.
