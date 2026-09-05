# ADR-005: Phase 9B Windows foreground inbox

- 결정일: 2026-09-05
- 구현 상태: Windows foreground의 인증된 조회·계획 수신과 사람의 client 관리 구현. 승인·변경 실행은 Phase 9C로 남긴다.
- 선행 계약: [ADR-004: 인증·영속 코어](ADR-004-phase9-authenticated-inbox-core.md)
- 검증 기록: [Phase 9B validation](../releases/evidence/phase9b-validation-2026-09-05.json)

## 활성화 범위

Windows 앱은 기존 저장소 migration, credential/Fragment hydration과 Queue startup 복구를 거친 뒤 하나의 native owner를 확보한다. 복구 결과가 불완전하거나 저장소·ACL 검증이 실패하면 inbox는 `app-unavailable`이다. 다른 프로세스가 owner이면 `busy`다. 기존 Main Queue와 Guided planner를 사용하며 별도 생성 엔진을 만들지 않는다.

현재 `suggest` 정책에서 `system.describe_capabilities`, `workspace.get_snapshot`, `generation.plan`, `generation.get_run`만 제공한다. snapshot은 저장된 Workflow Draft ID/revision 목록, run 조회는 stage 상태만 반환한다. 각 목록은 100개로 제한하고 누락 여부를 표시한다. `generation.plan`은 저장된 draft 참조, seed와 budget을 받아 실제 Guided planner의 전체 준비 결과를 immutable repository에 저장한다. 공개 결과에는 plan ID/hash, 개수와 비용 검토 정보만 넣는다. 계획은 Queue에 들어가지 않는다.

Data Hub의 AI 탭에는 같은 runtime registry를 사용하는 등록·키 교체·폐기, 접속 정보 복사와 수신 중지·재개 UI를 연결한다. 비밀키는 UI로 반환하지 않는다. 중지는 즉시 새 요청의 처리를 막고 진행 중인 요청과 owner 해제를 기다린다. 재개는 이 정리가 끝난 뒤 수행한다. 권한 변경도 진행 중인 요청 완료 후 native registry에 적용한다. 중지는 이번 앱 실행의 수신 제어이며 다음 앱 시작까지 유지되는 정책 설정은 아니다.

모든 capability는 `requiresAppProcess: true`, `canExecuteWhileAppClosed: false`다. mutation, 승인, versioned execution policy, rolling/outstanding 예산과 bounded-auto는 아직 unavailable이다. 다른 OS와 브라우저는 Windows 전용 상태를 표시한다. MCP stdio와 background/headless는 이 변경으로 활성화하지 않는다.

## Native authority와 인증

Tauri AppData의 다음 고정 위치를 native 모듈이 관리한다. 기본 Windows 위치는 `%APPDATA%/blue.bluehair.naiblue/agent-commands`다.

```text
agent-commands/
  control/clients.json
  control/registry.lock
  control/owner.lock
  inbox/<requestId>.ready.json
  inbox/<requestId>.submitted.json
  results/<requestId>.json
  rejections/<requestId>.json
```

`control/clients.json`의 versioned native metadata가 stable workspace ID와 client metadata의 authority다. 초기 계획의 일반 settings 저장 대신 native control metadata를 택했다. 인증 identity가 설정 backup/restore나 renderer 초기화에 따라 교체되지 않게 하기 위해서다. 키·metadata·receipt·plan을 일반 설정 backup에 추가하지 않는다. 손상된 registry를 새 identity로 자동 초기화하지 않는다.

Windows Credential Manager의 전용 service는 `blue.bluehair.naiblue.agent-commands`, account는 `<workspaceId>:<clientId>:<keyId>`다. 현재 keyring backend의 Generic Credential target은 `<workspaceId>:<clientId>:<keyId>.blue.bluehair.naiblue.agent-commands`, blob은 원시 32바이트 HMAC 키다. 등록·회전·폐기 API는 사람 UI가 호출하며 외부 command로 노출하지 않는다. key ID 변경과 폐기는 metadata와 vault를 함께 다룬다. native 인증은 HMAC을 검증하는 동일 signing payload에서 workspace/client/key/actor를 확인한다. TS 코어는 request hash, expiry와 공개 payload 정책을 검증한다.

OS 사용자 경계의 보호다. 같은 Windows 사용자로 실행되는 모든 프로그램을 서로 격리하는 보안 장치로 해석하지 않는다. 테스트 빌드는 production과 다른 `.agent-commands.test` service만 사용한다.

## 파일과 복구

현재 사용자와 SYSTEM만 허용하는 protected DACL로 private 디렉터리를 만들고, 열린 handle의 owner/DACL을 다시 검사한다. 상위 경로와 디렉터리를 handle로 고정하고 reparse point 및 hard link를 거부한다. owner는 프로세스가 유지하는 exclusive 파일 handle이며 registry 변경도 별도 lock으로 직렬화한다.

ready 파일은 검증된 ID에서만 경로를 만들고 64 KiB 이하로 읽는다. `.tmp`, `.submitted.json`과 안전하지 않은 이름은 수신 대상이 아니다. result publication은 임시 파일의 열린 handle을 원자 rename한다. 공개 result 자체는 64 KiB 한도를 유지하고 receipt projection에는 bounded ID와 고정 metadata를 위한 4 KiB를 추가 허용한다. result는 durable receipt의 projection으로 교체 가능하고 rejection은 같은 bytes만 재투영하며 다른 rejection evidence로 덮어쓰지 않는다. read 성공 후 retire는 읽었던 digest를 확인한 파일 handle 자체를 삭제하므로 도중에 바뀐 요청을 제거하지 않는다.

크기 초과와 잘못된 UTF-8은 protocol rejection 후 안전하게 retire하여 뒤의 정상 요청이 계속 처리되게 한다. 초과 파일은 전체를 메모리에 읽지 않고 exclusive handle을 유지한 채 같은 파일을 retire한다. ACL·link·실제 I/O 오류와 ledger 손상은 단순 잘못된 요청으로 축소하지 않으며 수신 불가 상태를 유지한다. publication 실패 뒤에는 기존 receipt를 재투영하고 handler를 다시 호출하지 않는다.

Queue startup은 기존 반환값에 `inboxReady`와 제한된 recovery issue 목록을 추가한다. provider spool의 정리되지 않은 손상, linked/orphan output 복구 실패, Scene 연결 미완료, R2 reconciliation 실패가 남으면 수신을 열지 않는다. 정리된 임시 spool 손상은 차단하지 않는다. 기존에 throw하던 복구 실패는 계속 promise rejection으로 전달하여 Queue coordinator의 기존 시작 차단을 보존한다. Provider 결과 미확정 상태는 기존 복구 규칙을 따르며 자동 재호출하지 않는다.

## 외부 제출 도구

`scripts/submit-agent-command.py`는 Python 표준 라이브러리만 사용한다. UI에서 복사한 비밀값 없는 JSON을 `connection.json`으로, 명령을 `command.json`으로 저장한다.

```json
{"name":"workspace.get_snapshot","input":{}}
```

```powershell
python scripts/submit-agent-command.py --connection connection.json --command command.json --request-id inspect-workspace-001
```

키는 `CredReadW`로 읽으며 argument, 환경변수, 파일 또는 stdout으로 전달하지 않는다. 입력 검증은 vault 조회 및 파일 저장 전에 수행하고 credential 패턴, 경로, image/base64와 signed URL 등을 거부한다. JSON 숫자는 safe integer 표기만 허용한다. float·지수 표기는 지원하지 않는다. `--expires-in`은 1–86400초, 기본 3600초다. 필요하면 `--inbox-dir`로 이미 native가 생성한 디렉터리를 지정한다. 도구가 inbox를 만들거나 앱을 켜지는 않는다.

같은 디렉터리에 exclusive `.tmp`를 쓰고 flush/fsync 후 no-replace rename한다. 서명된 공개 envelope를 `.submitted.json`에 보존한다. 같은 ID의 재제출은 현재 키와 client/command/hash/HMAC binding을 확인한 뒤 원래 timestamp와 expiry를 포함한 동일 bytes를 재사용한다. 완료 파일을 회수하기 위한 만료 후 replay는 가능하지만 신규 만료 요청은 앱이 거부한다. 다른 내용이나 키를 같은 ID에 덮어쓰지 않는다. 중단된 `.tmp`는 자동 소비하지 않고 해당 요청 상태를 확인해야 한다.

출력 `submitted-to-inbox / accepted: false`는 파일 제출 증거다. 앱 수락이나 실행 완료가 아니다. HMAC 키의 API 버퍼와 mutable copy는 지우지만 Python 내부의 임시 암호 연산 메모리까지 완전 zeroization을 보장하지 않는다.

## 검증 및 남은 경계

자동 테스트는 실제 WebCrypto, IndexedDB adapter, production Guided planner, Windows ACL·owner·atomic file 작업과 격리된 실제 Windows keyring을 사용한다. 브라우저 QA는 실제 Data Hub의 미지원 표시와 실제 등록 패널/runtime을 사용하지만 native port를 대체한다. 각 검증의 정확한 범위와 결과는 위 evidence에 기록한다.

별도 Python 프로세스 연동도 실행했다. production signer를 import하고 테스트 service만 바꾼 harness로 native 등록 → 실제 `CredReadW` → private inbox 제출 → native read/HMAC 인증/retire를 확인했다. 비밀키는 프로세스 간 전달하지 않았다. 이 추가 native 테스트는 `PHASE9_QA_PYTHON`에 Python 실행 파일 경로를 지정하면 수행하며, 지정하지 않은 일반 실행에서는 별도 프로세스 부분이 명시적으로 skip된다.

설치된 Tauri GUI에서 사람 등록부터 외부 제출·소비까지 연결한 QA, 강제 process crash와 실제 junction 공격 재현은 별도 운영 증거다. Provider/R2 요청이나 실제 생성은 수행하지 않는다. Phase 9 전체 완료는 승인·예산·실행 연결인 9C 이후 판정한다. 문제 발생 시 foreground startup 연결을 비활성화해도 native identity, receipt와 plan은 보존한다.
