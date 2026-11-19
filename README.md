# 브리티 메신저 캘린더

브리티 메신저에서 받은 쪽지와 첨부를 한곳에서 보고, 업무와 마감일을 월 달력에 정리하는 Windows 앱입니다. 학교와 교육청에서 쓸 수 있습니다. 개인이 만든 비공식 도구입니다.

- **첨부는 자동으로 내려받습니다.** 새로 받은 쪽지의 첨부는 Windows **다운로드** 폴더(설정의 **첨부 저장 폴더**에서 바꿀 수 있음)에 저절로 복사되고, 캘린더의 쪽지 자세히에서 눌러 바로 엽니다. **지난 쪽지 불러오기**로 가져온 쪽지의 첨부는 복사하지 않고 원래 자리에서 엽니다.
- **화면 꾸미기**에서 다이어리·파스텔·저녁·미니멀·고대비·팝·레트로·신문 스킨을 고를 수 있습니다.

## 설치와 첫 실행

### ⬇️ [최신 판 내려받기 (Releases)](https://github.com/rndosd/brity-assistant-public/releases/latest)

GOE 메신저용 **GOE 메신저 캘린더**는 [rndosd/goe-messenger-calendar 릴리스](https://github.com/rndosd/goe-messenger-calendar/releases/latest)에서 따로 받습니다.

위 링크에서 **`brity-messenger-calendar-windows-x64-<판>.zip`** 을 받으세요. 이 페이지 위쪽의 초록색 **Code → Download ZIP** 이나 **Source code** 는 프로그램 소스라서 실행 파일이 들어 있지 않습니다.

1. 받은 ZIP을 문서처럼 쓰기 가능한 폴더에 **전체 압축 풀기**합니다. ZIP을 연 채로 안의 파일을 바로 실행하면 켜지지 않습니다.
2. 실제 쪽지에 연결하기 전에 **Brity Messenger Calendar Sample.exe**로 가상 자료를 둘러볼 수 있습니다.
3. **Brity Messenger Calendar.exe**를 열고, 위쪽 **1단계 · AI 연결**에서 AI를 먼저 연결합니다(아래 [AI 분류](#ai-분류)).
4. 브리티 메신저에 로그인한 뒤 위쪽 **2단계 · 브리티 연결**의 **브리티 연결**을 누릅니다. 가져온 쪽지는 브리티에서 읽음으로 표시됩니다.
   브리티는 **원 뷰**로 써 주세요(브리티 **환경설정 › 일반 › 뷰 모드**). 클래식 뷰에서는 쪽지를 놓칠 수 있고, 캘린더도 클래식 뷰를 알아보면 원 뷰로 바꾸라고 알립니다.

처음 시작 순서는 앱 위쪽이나 설정 → 백업·정보의 **처음 시작 안내**에서도 볼 수 있습니다([처음 시작 안내](school-calendar/처음-시작-안내.html)).

설치 ZIP에는 실행에 필요한 파일이 모두 들어 있어 따로 설치할 것이 없습니다.

**켜지지 않을 때**
- 처음 열 때 Windows가 "PC 보호" 창을 띄우면 **추가 정보 → 실행**을 누릅니다(서명하지 않은 개인 제작 프로그램이라 뜹니다).
- 켜자마자 꺼지면(오류 0x80000003) 최신 전체 ZIP을 받아 새 폴더에 풀고 실행기로 켜 주세요. 압축을 푼 폴더 권한에 다른 앱(Codex 등)의 항목만 있고 '모든 응용 프로그램 패키지' 읽기 권한이 없으면 Electron이 멈추는데, 0.4.2부터 실행기가 이를 알아채 캘린더의 `runtime` 폴더에만 그 권한을 더합니다. 직접 고치려면 명령 프롬프트에서 `icacls "<캘린더 폴더>\runtime" /grant *S-1-15-2-1:(OI)(CI)(RX)`를 실행합니다.
- 그래도 켜자마자 꺼지면 **[진단 도구(calendar-diagnose.zip)](https://github.com/rndosd/brity-assistant-public/releases/download/v0.4.1/calendar-diagnose.zip)**를 받아 주세요. 풀어서 나온 두 파일을 캘린더 폴더(`runtime` 폴더가 있는 곳)에 넣고 **캘린더-진단.cmd**를 두 번 누르면, 샘플을 여러 방식으로 켜 본 결과가 바탕 화면 **캘린더-진단.txt**에 남습니다. 이 파일을 만든 분에게 보내 주세요. PC 설정은 바꾸지 않고, 쪽지·업무 자료는 담기지 않으며, 어디로도 자동으로 보내지 않습니다.

## AI 분류

쪽지에서 날짜와 할 일을 뽑아 달력에 올리는 일을 AI가 하므로, 브리티보다 먼저 연결하기를 권합니다. AI 없이 가져온 쪽지는 날짜 없이 제목 그대로 할 일에 쌓이고, 나중에 AI를 연결하면 목록 위 **AI로 정리**로 한꺼번에 정리할 수 있습니다. 설정에서 API 키 방식(**개인 OpenAI API 키 · Luna**, **개인 Claude API 키 · Haiku**)이나 구독 계정 방식(**Claude Code CLI · Haiku**, **Codex CLI**) 중 하나를 연결합니다. 개인 OpenAI API가 일반판의 권장 방식입니다.

쪽지 정리에는 Luna(OpenAI)·Haiku(Claude)를 씁니다. 이 앱이 시험을 마친 모델이고, 쪽지마다 부르기 때문에 비용을 낮추려고 고정해 두었습니다. Codex는 ChatGPT 계정의 기본 모델로 돌아 이보다 상위 모델이 쓰일 수 있고, 그만큼 구독 한도가 더 빨리 줄 수 있습니다.

연결 시험은 가상 쪽지를 사용합니다. 연결이 성공하면 새 쪽지 자동 분류가 켜집니다. AI가 분류할 때 쪽지 본문과 인용된 이전 쪽지를 선택한 AI 서비스가 읽습니다. OpenAI·Claude API 키로 보낸 내용은 AI 학습에 쓰이지 않고(두 회사 공식 안내), 구독 방식은 그 계정의 데이터 설정을 따릅니다. 첨부 파일은 PC에 남습니다. 자동 분류는 설정에서 끌 수 있습니다.

- [처음 시작 안내](school-calendar/처음-시작-안내.html)
- [설치 후 AI 연결 안내](school-calendar/AI-SETUP.txt)
- [OpenAI API 연결 안내](school-calendar/API-연결-안내.html)
- [Claude API 키 연결 안내](school-calendar/Claude-API-연결-안내.html)
- [Claude Code 연결 안내](school-calendar/Claude-연결-안내.html)
- [Codex 연결 안내](school-calendar/Codex-연결-안내.html)
- [캘린더 사용법과 백업](school-calendar/README.md)

소스 실행, 테스트, 배포 파일 생성은 [에이전트·유지보수 안내](AGENTS.md)에 있습니다.
