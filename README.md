# 브리티 메신저 캘린더

브리티 메신저에서 받은 쪽지와 첨부를 한곳에서 보고, 업무와 마감일을 월 달력에 정리하는 Windows 앱입니다. 학교와 교육청에서 쓸 수 있습니다. 개인이 만든 비공식 도구입니다.

- **첨부는 자동으로 내려받습니다.** 새로 받은 쪽지의 첨부는 Windows **다운로드** 폴더(설정의 **첨부 저장 폴더**에서 바꿀 수 있음)에 저절로 복사되고, 캘린더의 쪽지 자세히에서 눌러 바로 엽니다. **지난 쪽지 불러오기**로 가져온 쪽지의 첨부는 복사하지 않고 원래 자리에서 엽니다.
- **화면 꾸미기**에서 다이어리·파스텔·저녁·미니멀·고대비·팝·레트로·신문·숲속 수첩·자개함·색실 작업실·스테인드글라스·칠판 한쪽 스킨을 고를 수 있습니다.
- **구글 캘린더**에서 업무를 보려면 **설정 → 달력 연동 → 구글 계정 연결**을 누르고 브라우저에서 연결을 허용하세요.

## 설치와 첫 실행

### ⬇️ [최신 판 내려받기 (Releases)](https://github.com/rndosd/brity-assistant-public/releases/latest)

GOE 메신저용 **GOE 메신저 캘린더**는 [rndosd/goe-messenger-calendar 릴리스](https://github.com/rndosd/goe-messenger-calendar/releases/latest)에서 따로 받습니다. GOE판에서는 쪽지 **자세히 → GOE에서 원문 보기**를 누르면 메신저에서 받은 쪽지 창이 열립니다.

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

## 받은 쪽지로 AI에서 업무 시작하기

**답장을 써야 할 때** 쪽지 원문 오른쪽의 화살표를 누르면 브리티 답장 창이 열립니다. GOE판의 열기 아이콘은 GOE 원문을 엽니다. 내 말을 다듬으려면 옆의 반짝이는 연필을 누르세요. “금요일은 어렵고 월요일 오전은 가능하다고 해 줘”처럼 하고 싶은 말을 적습니다. **다듬기**를 누르면 받은 쪽지에 맞춰 답장 초안을 씁니다. 확인할 내용이 있으면 보기 하나를 고르세요. 초안은 같은 칸에서 길이에 맞게 펼쳐지고 직접 고칠 수 있습니다. 원하는 대로 고친 뒤 **브리티에서 답장**을 누르면 문구가 복사되고 답장 창이 열립니다. GOE판에서는 **복사하고 원문 보기**를 누르고, 열린 원문에서 직접 **답장**을 누르세요. 메신저의 답장 칸에 붙여넣으세요. 보낼 내용과 상대를 확인한 뒤 메신저에서 직접 전송하세요. 답장 다듬기에 쓸 AI는 **설정 → AI 연결**에서 고르세요.

**프로젝트 자료와 함께 일할 때**는 쪽지 아래 **프로젝트에서 시작**을 누르세요. 맡길 일을 적고 앱과 프로젝트 이름, 가져갈 첨부를 고릅니다. Codex는 등록된 로컬 프로젝트를, Claude Code는 이 PC에서 사용한 프로젝트 폴더를 표시합니다. 목록에 없으면 **다른 폴더 고르기…**로 직접 선택하세요. 프로젝트 안의 **캘린더 쪽지**에 원문과 지시, 선택한 첨부 사본이 들어갑니다. 이미 저장된 첨부를 선택하지 않으면 파일 위치를 알려 줍니다. 지시를 쓸 때 새 채팅에 알려 줄 배경도 함께 적을 수 있습니다. Codex에서는 새 채팅의 첫 메시지를 확인하고 보내세요. Claude Code는 선택한 폴더에서 터미널을 열고 지시한 작업을 시작합니다.

**설정 → 에이전트**에서 Codex 데스크톱과 Claude Code를 이 PC에서 열 수 있는지 확인하고 설치 안내를 볼 수 있습니다. 설치 뒤 **설치된 앱 다시 찾기**를 누르세요. 기존 채팅에 쪽지를 공유하려면 같은 탭에서 **MCP 연결 요청 복사**를 누르고 이 PC의 Codex나 Claude Code 채팅에 붙여넣어 보내세요. 복사한 요청에는 이 PC의 연결 프로그램 위치와 앱별 등록·확인 방법이 들어 있습니다. **연결 프로그램 확인**은 캘린더 쪽을 검사하며, AI 앱에서는 MCP 목록의 `calendar` 연결 상태를 확인하세요.

쪽지에서 AI 업무 단추나 결과를 숨기려면 **설정 → 에이전트 → 쪽지에 AI 앱 작업 메뉴와 결과 보이기**를 끕니다. 저장된 결과는 다시 켜면 볼 수 있습니다.

### 이미 쓰던 채팅에서 공유한 쪽지를 열 때

1. 쪽지 **자세히 → 다른 방법 → AI로 보내기**에서 함께 보낼 첨부를 고르고 **AI로 보내기**를 누릅니다. 쪽지 원문과 고른 첨부의 사본을 공유합니다.
2. 처음 한 번 **처음 쓰는 AI 앱에 연결 → MCP 연결 요청 복사**를 누르고 Codex나 Claude Code 채팅에 붙여넣어 보냅니다. 다른 AI 앱은 **직접 설정**에서 형식을 골라 **MCP 설정 복사**를 사용합니다. 캘린더 업데이트나 설치 폴더 이동 뒤에도 같은 Windows 계정에서 기존 설정을 쓸 수 있습니다. 샘플 실행기는 가상 자료용 연결을 따로 씁니다.
3. **요청 문장 복사**를 누르고 평소 쓰는 Codex나 Claude Code 채팅에 붙여 넣습니다. 원하는 일을 덧붙이면 공유한 자료로 작업한 뒤 초안이 원래 쪽지의 **AI 작업 결과**에 저장됩니다. 로컬 MCP를 쓸 수 없는 앱에서는 **공유 폴더 열기**로 업무.md와 첨부 사본을 직접 올릴 수 있습니다.

쪽지 카드에 바로 초안을 받으려면 **자세히 → 다른 방법 → 업무 맡기기**에서 Codex나 Claude Code를 고릅니다. 요청을 쓰고 첨부를 골라 맡기면 PC에 설치해 로그인한 프로그램이 초안을 작성합니다. 두 방식의 초안은 같은 쪽지의 **AI 작업 결과**에서 각각 열어 볼 수 있습니다.

캘린더에서 Claude Code에 맡기려면 Claude Code 2.1.248 이상이 필요합니다. [Claude Code 명령줄 안내](https://code.claude.com/docs/en/cli-reference)

| 쓰는 앱 | 처음 연결 |
| --- | --- |
| Codex | **Codex**를 골라 복사한 내용을 `~/.codex/config.toml`에 추가합니다. [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) |
| Claude Code | **Claude Code**를 골라 복사한 설정을 프로젝트의 `.mcp.json`에 추가하고, 다시 연 Claude Code의 `/mcp`에서 `calendar`를 확인합니다. [Claude Code MCP](https://code.claude.com/docs/en/mcp) |
| Claude Desktop · Cursor | **공용 JSON**을 골라 복사한 뒤 그 앱의 로컬 MCP 설정에서 기존 `mcpServers` 안에 `calendar` 항목을 추가합니다. [Claude Code MCP](https://code.claude.com/docs/en/mcp) · [Cursor MCP](https://cursor.com/docs/context/mcp) |
| Google Antigravity | **공용 JSON**을 골라 복사한 뒤 MCP 설정의 `mcpServers` 안에 `calendar` 항목을 추가합니다. [Antigravity MCP](https://antigravity.google/docs/mcp) |
| Grok Build | **Grok Build**를 골라 복사한 내용을 `~/.grok/config.toml`에 추가합니다. [Grok Build MCP](https://docs.x.ai/build/features/mcp-servers) |
| VS Code | **VS Code**를 골라 복사한 뒤 사용자 MCP 설정의 `servers` 안에 `calendar` 항목을 추가합니다. [VS Code MCP](https://code.visualstudio.com/docs/copilot/customization/mcp-servers) |
| Orca · Herdr | 같은 Windows PC에서 띄운 Codex나 Claude Code에 해당 에이전트의 MCP 설정을 추가합니다. [Orca](https://orca.dev/docs/cli/skills) · [Herdr](https://herdr.dev/tui/docs/agents/) |

한 Windows 계정에서 브리티·GOE를 합쳐 업무 한 건을 공유합니다. 외부 에이전트가 초안을 돌려줄 때까지 공유를 유지해 주세요. 새 쪽지를 공유하거나 **공유 끝내기**를 누르면 현재 공유에서 자료를 가져오거나 새 결과를 등록할 수 없고, 이미 받은 초안은 쪽지 카드에 남습니다.

업데이트 뒤 결과 저장 도구가 보이지 않으면 AI 앱을 닫고 캘린더를 다시 열어 연결 프로그램을 갱신한 뒤 AI 앱을 여세요. 기존 MCP 설정을 그대로 사용합니다. 예전 판에서 공유한 쪽지는 한 번 다시 공유해야 결과를 받을 수 있습니다.

가져온 본문과 첨부는 AI 서비스로 전달될 수 있으니 공유 전에 내용을 확인해 주세요. 이미 전달한 내용은 AI 채팅에 남을 수 있습니다.

소스 실행, 테스트, 배포 파일 생성은 [에이전트·유지보수 안내](AGENTS.md)에 있습니다.
