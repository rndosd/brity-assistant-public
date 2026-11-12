# 브리티 메신저 캘린더

브리티 메신저에서 받은 쪽지와 첨부를 한곳에서 보고, 업무와 마감일을 월 달력에 정리하는 Windows 앱입니다. 학교와 교육청에서 쓸 수 있습니다. 개인이 만든 비공식 도구입니다.

## 설치와 첫 실행

1. 배포한 곳에서 **일반판 Windows x64 ZIP**을 받아 문서처럼 쓰기 가능한 폴더에 전체 압축을 풉니다.
2. 실제 쪽지에 연결하기 전에 **Brity Messenger Calendar Sample.exe**로 가상 자료를 둘러볼 수 있습니다.
3. 브리티 메신저에 로그인한 뒤 **Brity Messenger Calendar.exe**를 열고 **브리티 연결**을 누릅니다. 가져온 쪽지는 브리티에서 읽음으로 표시됩니다.

설치 ZIP에는 실행에 필요한 파일이 들어 있습니다. 현재 이 GitHub 저장소에는 배포용 릴리스가 등록되어 있지 않습니다.

## AI 분류

AI 연결은 선택입니다. 처음에는 쪽지를 직접 정리할 수 있고, 설정에서 **개인 OpenAI API 키 · Luna**, **Claude Code CLI · Haiku**, **Codex CLI** 중 하나를 연결할 수 있습니다. 개인 OpenAI API가 일반판의 권장 방식입니다.

연결 시험은 가상 쪽지를 사용합니다. 연결이 성공하면 새 쪽지 자동 분류가 켜집니다. AI가 분류할 때 쪽지 본문과 인용된 이전 쪽지가 선택한 AI 서비스로 전달되며, 첨부 파일은 PC에 남습니다. 소속 기관의 쪽지 전송 기준을 확인한 뒤 연결하세요. 자동 분류는 설정에서 끌 수 있습니다.

- [설치 후 AI 연결 안내](school-calendar/AI-SETUP.txt)
- [OpenAI API 연결 안내](school-calendar/API-연결-안내.html)
- [Claude Code 연결 안내](school-calendar/Claude-연결-안내.html)
- [캘린더 사용법과 백업](school-calendar/README.md)

소스 실행, 테스트, 배포 파일 생성은 [에이전트·유지보수 안내](AGENTS.md)에 있습니다.
