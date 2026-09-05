# ADR-005: Phase 9B Windows foreground inbox

- 결정일: 2026-09-05
- 구현 상태: Windows foreground의 인증된 조회·계획 수신과 사람의 client 관리 구현. 승인·변경 실행은 Phase 9C로 남긴다.
- 선행 계약: [ADR-004: 인증·영속 코어](ADR-004-phase9-authenticated-inbox-core.md)
- 검증 기록: [Phase 9B validation](../releases/evidence/phase9b-validation-2026-09-05.json)
- 실제 데스크톱 QA: [Phase 9B desktop QA](../releases/evidence/phase9b-desktop-qa-2026-09-05.json) — 독립 실행 Windows Tauri 앱의 등록·제출·계획·재시작 replay 검증 완료

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

OS 사용자 경계의 보호다. 같은 Windows 사용자로 실행되는 모든 프로그램을 서로 격리하는 보안 장치로 해석하지 않는다. Rust 자동 테스트의 `#[cfg(test)]` 경로만 production과 다른 `blue.bluehair.naiblue.agent-commands.test` service를 사용한다. 일반 debug/release 실행 파일은 production service를 사용한다. 실제 GUI QA에서는 별도 앱 ID·WebView 프로필·workspace로 격리하되 production service와 실제 Python 제출 도구 사이의 연결을 검증했다.

### 공개 식별자와 오류 코드

공유 payload scanner는 `clientId`, `workspaceId`, `correlationId`, `idempotencyKey`, `draftId`, `runId`, `jobId`를 기존 `id`·`requestId`·`planId`와 같은 공개 식별자 필드로 취급한다. native가 생성한 32자리 난수 hex ID를 일반 binary payload로 오인하지 않기 위한 명시적 목록이며 임의의 `*Id` 필드로 확장하지 않는다.

`code`와 `issueCodes`에서는 128자 이하의 대문자 snake case·소문자 kebab case machine code에 같은 일반 entropy 예외를 적용한다. `SOURCE_REVISION_CONFLICT`가 우연히 Base64로 해석되어 control byte 비율로 차단되던 문제를 바로잡았다. 두 예외 모두 credential·JWT·image signature·경로 검사를 유지하며 임의의 본문 필드에는 적용하지 않는다. 결과를 표현하기 위해 protocol 이름을 바꾸거나 context 검사를 제거하지 않는다.

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

2026-09-05 실제 데스크톱 QA는 production frontend를 내장한 독립 실행 Windows debug Tauri EXE에서 수행했다. 실제 WebView2·native port·Windows Credential Manager와 production Python signer를 사용했으며 native port를 대체하지 않았다. 앱 ID는 `blue.bluehair.naiblue.phase9bqa`, WebView 프로필과 workspace는 QA 전용이었다. 최종 EXE SHA-256은 `4618A50C4AFAA333167708C11CE9880CD6F3BDE04AF1D0DB7C5C0B17BEA2989E`다. 다음 항목을 확인했다.

- 사용자 승인 아래 GUI에서 QA client 1개를 등록하고 접속 정보를 복사하여 별도 Python 프로세스가 제출한 요청을 앱이 인증·처리했다.
- GUI에서 저장한 파란색 프롬프트 draft revision 1을 계획했다. 예상 비용 29 Anlas와 budget 0의 `needs_input` 결과를 얻었고 Queue·reservation·artifact는 모두 0건이었다.
- GUI에서 빨간색 프롬프트로 수정한 revision 2와 앱 재시작 뒤에도 기존 요청의 receipt와 저장된 plan bytes가 그대로 replay되었다. 새 request ID로 이전 revision을 요청하면 `SOURCE_REVISION_CONFLICT`가 공개 결과로 반환되었다.
- 수신 중지·재개와 앱 종료 중 제출 후 재시작 소비를 확인했다. 앱이 닫혀 있을 때는 transport 제출만 완료되었다.
- QA client의 키를 교체한 뒤 폐기했다. 교체 전 키와 폐기된 현재 키를 사용한 Python 제출은 `CREDENTIAL_UNAVAILABLE`로 실패했다. 폐기 뒤 기존 서명 archive를 재투영한 요청은 `AUTHENTICATION_FAILED`로 거부되고 원래 receipt는 보존되었다.

최종 non-live 검증은 311개 파일의 2,205개 테스트, lint, architecture, secret-redaction 17개 검사와 build를 통과했다. QA 앱의 종료와 9329 포트 종료도 확인했다. 상세 관측과 artifact 연결은 [desktop QA evidence](../releases/evidence/phase9b-desktop-qa-2026-09-05.json)에 둔다.

이 증거는 standalone 실행 파일의 실제 GUI/native 경로에 해당한다. 설치된 MSI의 설치·업데이트 경로와 기존 production 앱 프로필, 강제 process crash, 실제 junction 공격 재현, Provider/R2 호출·실제 이미지 생성은 검증하지 않았다. Phase 9C의 승인·예산·변경 실행, Phase 10 MCP와 Phase 11 background/headless는 남아 있다. Phase 9 전체 완료는 9C 이후 판정한다. 문제 발생 시 foreground startup 연결을 비활성화해도 native identity, receipt와 plan은 보존한다.
