# 브리티 메신저 캘린더

브리티 메신저에서 받은 쪽지와 첨부를 한곳에서 보고, 업무와 마감일을 월 달력에 정리하는 Windows 앱입니다. 학교와 교육청에서 쓸 수 있습니다. 개인이 만든 비공식 도구입니다.

## 설치와 첫 실행

### ⬇️ [최신 판 내려받기 (Releases)](https://github.com/rndosd/brity-assistant-public/releases/latest)

위 링크에서 **`brity-messenger-calendar-windows-x64-<판>.zip`** 을 받으세요. 이 페이지 위쪽의 초록색 **Code → Download ZIP** 이나 **Source code** 는 프로그램 소스라서 실행 파일이 들어 있지 않습니다.

1. 받은 ZIP을 문서처럼 쓰기 가능한 폴더에 **전체 압축 풀기**합니다. ZIP을 연 채로 안의 파일을 바로 실행하면 켜지지 않습니다.
2. 실제 쪽지에 연결하기 전에 **Brity Messenger Calendar Sample.exe**로 가상 자료를 둘러볼 수 있습니다.
3. 브리티 메신저에 로그인한 뒤 **Brity Messenger Calendar.exe**를 열고 **브리티 연결**을 누릅니다. 가져온 쪽지는 브리티에서 읽음으로 표시됩니다.

설치 ZIP에는 실행에 필요한 파일이 모두 들어 있어 따로 설치할 것이 없습니다.

**켜지지 않을 때**
- 처음 열 때 Windows가 "PC 보호" 창을 띄우면 **추가 정보 → 실행**을 누릅니다(서명하지 않은 개인 제작 프로그램이라 뜹니다).
- Windows 11 26H2에서 켜자마자 꺼지면 0.4.1 전체 ZIP을 받아 새 폴더에 풀고 샘플을 실행해 보세요. 0.4.1에는 Electron 45.2.2가 들어 있습니다. 기존 캘린더가 열리는 PC에서는 머리줄의 **업데이트**로 Electron도 함께 바뀝니다.
- 그래도 켜자마자 꺼지면 **[진단 도구(calendar-diagnose.zip)](https://github.com/rndosd/brity-assistant-public/releases/download/v0.4.1/calendar-diagnose.zip)**를 받아 주세요. 풀어서 나온 두 파일을 캘린더 폴더(`runtime` 폴더가 있는 곳)에 넣고 **캘린더-진단.cmd**를 두 번 누르면, 샘플을 여러 방식으로 켜 본 결과가 바탕 화면 **캘린더-진단.txt**에 남습니다. 이 파일을 만든 분에게 보내 주세요. PC 설정은 바꾸지 않고, 쪽지·업무 자료는 담기지 않으며, 어디로도 자동으로 보내지 않습니다.

## AI 분류

AI 연결은 선택입니다. 처음에는 쪽지를 직접 정리할 수 있고, 설정에서 **개인 OpenAI API 키 · Luna**, **Claude Code CLI · Haiku**, **Codex CLI** 중 하나를 연결할 수 있습니다. 개인 OpenAI API가 일반판의 권장 방식입니다.

연결 시험은 가상 쪽지를 사용합니다. 연결이 성공하면 새 쪽지 자동 분류가 켜집니다. AI가 분류할 때 쪽지 본문과 인용된 이전 쪽지가 선택한 AI 서비스로 전달되며, 첨부 파일은 PC에 남습니다. 소속 기관의 쪽지 전송 기준을 확인한 뒤 연결하세요. 자동 분류는 설정에서 끌 수 있습니다.

- [설치 후 AI 연결 안내](school-calendar/AI-SETUP.txt)
- [OpenAI API 연결 안내](school-calendar/API-연결-안내.html)
- [Claude Code 연결 안내](school-calendar/Claude-연결-안내.html)
- [캘린더 사용법과 백업](school-calendar/README.md)

소스 실행, 테스트, 배포 파일 생성은 [에이전트·유지보수 안내](AGENTS.md)에 있습니다.
