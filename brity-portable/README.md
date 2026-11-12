# 브리티 쪽지를 Codex 채팅에 모으기

ZIP을 Windows PC의 쓰기 가능한 폴더에 풀고 `Start-Brity.cmd`를 더블클릭합니다. 설정을 AI에 맡기려면 이 폴더를 Codex에서 열고 `AI-설치-질문.txt`의 내용을 보냅니다.

브리티에 로그인한 상태에서 실행합니다. 스크립트는 기본 30초 간격으로 안 읽은 쪽지를 확인합니다. 본문과 첨부 사본은 스크립트 옆 `inbox`에 저장합니다. Codex 연결을 설정하면 새로 수집한 쪽지의 본문과 첨부 저장 경로도 선택한 채팅에 기록합니다. 첨부 파일은 PC에 저장합니다.

1. **브리티 첨부 다운로드 폴더**를 확인합니다. 기본값은 `C:\BrityWorks\BrityMessenger\download`입니다. 다른 폴더를 쓴다면 **찾아보기**를 누릅니다. 처음 설치해서 폴더가 아직 없다면 브리티에서 테스트 첨부를 한 번 내려받아 폴더를 확인합니다.
2. 이 PC의 Codex에 로그인하고, 받을 로컬 채팅을 고릅니다. 채팅 링크 또는 ID를 붙여 넣고 **연결 시험 및 저장**을 누릅니다. 가짜 테스트 메시지가 그 채팅에 표시되는지 확인합니다. 연결 전 `inbox`에 이미 저장돼 있던 쪽지는 전송 대상에서 제외됩니다.
3. Codex에 보낼 수 있는 업무 자료의 범위를 확인한 뒤 **감시 시작**을 누릅니다. 브리티를 트레이에 두고 이 설정 창을 닫아도 감시는 계속됩니다. 스크립트가 연 쪽지는 브리티에서 읽음 처리됩니다. 처음 시작하면 기존에 안 읽은 쪽지도 수집 대상입니다.
4. PC를 다시 켤 때마다 실행하려면 **로그인 시 자동 시작**을 누릅니다. 끄려면 **자동 시작 해제**를 누릅니다. 현재 감시는 **감시 중지**로 멈춥니다. 다른 채팅을 지정할 때도 감시를 먼저 멈춥니다.

채팅에 적힌 첨부 경로는 파일을 저장한 PC에서 사용할 수 있습니다. 경로가 비어 있으면 첨부 저장이 완료되지 않은 것입니다. 설정 창에서 연결이 실패하면 최신 Codex 데스크톱 앱 또는 Codex CLI가 설치돼 있는지 확인하고, 같은 PC에서 해당 채팅을 열 수 있는지 확인합니다. 전송이 시작된 뒤 완료를 확인하지 못한 쪽지는 중복 전송을 피하기 위해 보류됩니다. `inbox\watch.log`에 `codex-review-needed`가 있으면 선택한 채팅을 확인합니다.

## PowerShell에서 실행하기

쪽지 본문을 열기 전에 목록만 확인합니다.

   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\collect-notes.ps1
   ```

받을 채팅을 지정합니다. `<채팅-ID>`를 실제 값으로 바꿉니다.

   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\watch.ps1 -ConnectCodex 'codex://threads/<채팅-ID>'
   ```

브리티를 트레이에 두고 감시를 시작합니다.

   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\watch.ps1 -Loop
   ```

다른 PowerShell 창에서 `watch.ps1`을 `-Stop` 옵션으로 실행하면 진행 중인 처리가 끝난 뒤 감시가 멈춥니다. Codex 연결을 설정하기 전에는 `inbox`에만 저장합니다. PC마다 설치한 브리티의 메뉴 이름이 다르면 `labels.json`의 해당 값을 확인합니다.
