# ADR-011: Phase 10B 개발용 MCP stdio 연결

- 날짜: 2026-09-07.
- 기준 commit: Phase 10A `eda11d0`.
- 범위: 승인된 공식 SDK 설치, 공유 입력 계약, 서명 bridge, 개발용 stdio 실행부와 자동 검증.
- 전체 Phase 10: 실제 Tauri 앱·설치 경로 spike의 Go/No-Go는 **미판정**. 개발용 transport 검증을 운영 승격으로 해석하지 않는다.

## 중단 지점과 재개

SDK와 입력 계약·서명 bridge가 미커밋 상태로 남아 있었고, stdio 서버 초안 뒤의 실행 스크립트와 실제 프로세스 검증이 없었다. 재개 시 현재 checkout을 검사했고, 설치 SDK에서 type-only인 `InternalError`를 생성자로 사용하던 TypeScript 오류를 확인해 SDK의 `ProtocolError(INTERNAL_ERROR, ...)`로 수정했다.

`@modelcontextprotocol/server`와 `@modelcontextprotocol/client`는 각각 **2.0.0**으로 package/lockfile에 고정했다. 설치는 사용자의 2026-09-06 `구현 시작해` 지시에 따른다. 설치 중 system npm launcher가 Node 25로 실행된 경고 이후, 실제 npm CLI를 Node 24.19.0으로 실행해 설치 상태를 확인했다. npm이 제거했던 무관한 기존 40개 optional package의 `libc` metadata는 복구했으며 기존 dependency version은 변경하지 않았다.

## 연결과 authority

```text
MCP client → 공식 SDK stdio → 공유 입력 검증 → Python CredReadW 서명/파일 공개
  → Phase 9 per-request inbox → foreground application dispatcher/receipt/Queue
  → bounded result reader → 기존 receipt 검증 → MCP structured result
```

- [`agent-command-input.ts`](../../src/application/agent/agent-command-input.ts)는 기존 read/plan/enqueue/cancel/storage-retry validator를 추출하고 같은 위치에서 JSON Schema 2020-12 metadata를 제공한다. 기존 handler들도 이 validator를 사용한다. 별도 MCP command allowlist나 application SDK import는 없다.
- [`runtime-capability-registry.ts`](../../src/application/agent/runtime-capability-registry.ts)는 등록된 입력 계약의 `inputSchemaHash`를 반환한다. Schema URI/정규식 전체를 public result에 넣지 않으므로 shared redaction을 완화하지 않는다. Sidecar는 동일한 공유 schema를 읽고 hash가 다르면 해당 tool을 unavailable로 표시한다.
- [`mcp-stdio-server.ts`](../../src/adapters/agent/mcp/mcp-stdio-server.ts)는 SDK framing, tool/resource schema, receipt projection만 담당한다. `.dependency-cruiser.cjs`가 SDK import를 이 adapter 디렉터리로 제한한다.
- [`run-agent-mcp-stdio.mjs`](../../scripts/run-agent-mcp-stdio.mjs)는 기존 app inbox와 공개 connection JSON을 받아 Node 파일 조회와 Python bridge를 연결한다. Vite SSR loader는 개발 환경에서 TypeScript 원본을 읽는 용도이며 listener를 열지 않는다. 이 실행부는 설치용 binary가 아니다.
- [`submit-agent-mcp-command.py`](../../scripts/submit-agent-mcp-command.py)는 기존 Windows credential reader와 no-replace publisher를 재사용한다. TypeScript가 생성한 canonical unsigned/signing 문자열의 구조·hash·신원을 확인하고 정확한 signing bytes에 HMAC을 계산한다. 소수 `maxAnlas`는 Python의 숫자 재직렬화에 hash를 맡기지 않아도 된다. 기존 integer-only CLI의 계약은 변경하지 않는다.

## 호출·재조회 계약

Tool arguments는 `{ requestId, input }`다. `requestId`는 호출자가 호출 전에 정하고 timeout/crash 뒤에도 유지해야 한다. Application input에는 transport 필드를 섞지 않는다.

같은 ID의 archive가 있으면 원래 timestamp/expiry/hash와 command를 재사용한다. 내용이 바뀌면 거절한다. 같은 프로세스의 동시 동일-ID 공개는 하나의 Promise로 합치며, 프로세스 간 충돌은 기존 no-replace 파일 규칙으로 거절한다. 서명·공개가 시작된 뒤 caller 취소나 sidecar 오류는 새 ID 생성, 자동 재제출, 파일 정리 또는 Queue 취소의 근거가 아니다. 남은 `.tmp`는 검사 없이 지우지 않는다.

`application-receipt`는 원본 receipt를 보존한다. `accepted`, `needs-input`, `COMMAND_OUTCOME_UNKNOWN`, `cancel-requested`, run handle을 MCP task 완료로 바꾸지 않는다. 사람 승인은 앱에서 진행하며 그 결과는 같은 request resource 또는 동일 command replay로 조회한다. SDK의 별도 elicitation/task workflow를 추가하지 않는다.

관측 취소는 `observation-cancelled`이며 application acceptance에 대한 새 주장을 하지 않는다. Ready file 공개만 확인되면 `submitted-to-inbox`, `accepted: false`다. Archive만 있고 ready/result가 없으면 `submission-unconfirmed`다. 응답 부재를 app-off 또는 app-ready의 증거로 사용하지 않는다.

## Tool/resource discovery

`tools/list`와 `nai-blue://capabilities` 읽기는 매번 **새로운 read-only capability request**를 제출하고 현재 응답을 기다린다. 과거 receipt를 readiness cache로 쓰지 않는다. 현재 응답을 얻지 못하면 tool 목록은 비우고 resource에 `app-state-unconfirmed`와 unavailable descriptors를 반환한다. Descriptor 집합·중복·필드·schema hash를 검증한다. Application의 승인·pause·budget 정책은 그대로 유지한다.

초기 resource는 현재 capability snapshot과 `nai-blue://requests/{requestId}`의 저장 결과다. 저장 결과는 설정된 workspace/client/key/actor에 연결된 요청만 읽으며 재전송하지 않는다. 과거 receipt 읽기는 현재 client 재인증의 증거가 아니다. 신규/재전송 acceptance는 현재 키와 앱 인증을 다시 거친다. 별도 workspace/scene/artifact/R2 preview resource는 구현하지 않았으며 advertise하지 않는다.

설정된 개발 transport 한도는 tool 호출 동시 8개, 기본 결과 대기 3초(0~30초), Python bridge 10초 timeout, stdin/stdout frame buffer 262,144 bytes다. Request/archive는 65,536 bytes, native receipt wrapper는 69,632 bytes, result 자체는 65,536 bytes로 기존 제한을 유지한다. 이 값은 application budget/rate policy가 아니며 운영 부하 측정값도 아니다.

## 실행 방법

기존 Windows 앱에서 사람이 등록한 client의 공개 연결 정보가 있어야 한다. 아래 placeholder는 실제 로컬 경로로 교체한다. Python은 기존 bridge처럼 표준 라이브러리만 사용한다.

Native inbox에는 실제 AppData 경로를 읽을 수 있는 **standalone Python**을 사용한다. 2026-09-07 native QA에서 WindowsApps Store Python 3.14.3은 존재하는 앱 디렉터리를 `FileNotFoundError`로 처리했고, 같은 `safe_path` 검사를 standalone Python 3.12.14는 통과했다. 실패는 credential 접근 이전이었다. WindowsApps 실행 별칭을 그대로 선택하지 말고 검증된 Python 실행 파일을 `--python`으로 지정한다.

```powershell
& '<Node-24-executable>' 'E:\AI_Project_Library\projects\nais\NAI-Blue\scripts\run-agent-mcp-stdio.mjs' `
  --connection '<public-connection.json>' `
  --inbox-dir '<existing-agent-commands\inbox>' `
  --python '<Python-executable>'
```

개발 shell에서는 `npm run --silent agent:mcp:stdio -- ...`도 가능하다. MCP host가 실행하는 command는 Node 직접 실행을 권장한다. 일반 `npm run`의 안내 출력이 protocol stdout에 섞일 수 있기 때문이다. Connection JSON은 `workspaceId`, `clientId`, `keyId`, `actorKind` 네 필드만 포함하며 secret을 넣지 않는다.

이번 작업은 사용자 MCP config를 편집하거나 client를 등록하지 않았으며 sidecar binary를 build/install하지 않았다. 실제 설치/config 연결 시에는 정확한 실행 명령·대상 config·native client registration을 별도로 검토한다. SDK 설치 승인을 이 단계들의 승인으로 확대하지 않는다.

## 검증과 남은 gate

[Phase 10B 검증 기록](../releases/evidence/phase10b-validation-2026-09-07.json)은 소스 해시, 실행 명령, 결과와 검증 환경을 보존한다. 실제 SDK in-memory transport와 별도 child-process stdio 검증은 구분한다. Child-process 검증은 실제 파일과 WebCrypto dispatcher/IndexedDB adapter를 사용하되 서명 키는 fixture이고 IndexedDB 엔진은 `fake-indexeddb`다. Windows publisher의 별도 bridge 테스트도 credential 접근은 fixture로 대체한다.

Production CLI 자체는 공식 `StdioClientTransport`와 실제 Python을 연결해 별도로 실행했다. 임의의 미등록 credential을 조회한 상태에서 handshake 성공, 빈 tool 목록, 요청 파일 미생성, stderr/protocol error 없음, client 종료 후 subprocess 종료를 확인했다. 이 검사는 실제 key store의 성공적인 서명이나 Tauri 처리 증거가 아니다. 최종 MCP 6개 파일·46개 테스트와 Agent inbox 17개 파일·198개 테스트가 통과했다. Persistence 199개·Queue 302개·secret redaction 17개, 아키텍처 622 modules/3,440 dependencies, lint, TypeScript, build도 통과했다. Suite 간 중복이 있으므로 테스트 수를 합산하지 않는다.

JSON Schema의 표준 `maxLength`는 Unicode code point를 세고 기존 draft ID validator는 UTF-16 code unit을 센다. Metadata의 `x-maxUtf16Length: 200`과 설명으로 이를 명시하고 실제 제출 전에 같은 application validator로 더 강한 제한을 적용한다. 일반 schema validator만으로 모든 Unicode 입력의 정확한 수락 집합이 일치한다고 주장하지 않는다. 실제 opaque ID·seed/count/budget/reference fixture의 parity를 검증한다. Output schema는 transport wrapper이며 receipt 내용의 강한 검증은 기존 receipt parser와 public scanner가 담당한다.

아직 필요한 증거는 다음과 같다.

1. 실제 등록 MCP client와 실행 중인 Tauri app을 함께 사용하는 stdio/inbox/receipt 경로.
2. 실제 app-off/복구 오류 상태, 사람 승인 후 enqueue·cancel, 장시간 Queue polling, client 폐기/rotation의 native 관측.
3. Windows sidecar path, 설치·업데이트·rollback 실험과 정리.
4. 실제 운영 usage·availability·security/credential·crash evidence. Phase 11은 [ADR-010](ADR-010-phase11-foreground-retention.md)의 foreground 유지/No-Go를 계속 따른다.

## 2026-09-07 후속: 실제 Windows 읽기 경로 검증

[Phase 10C native 검증 기록](../releases/evidence/phase10c-native-validation-2026-09-07.json)에 실제 앱 경로의 후속 증거를 남긴다. 별도 identifier/WebView profile의 debug Tauri 앱에 현재 frontend를 포함하고, 사용자가 직접 등록한 client와 공식 SDK client → production stdio runner → standalone Python → 실제 Windows credential/inbox → foreground dispatcher/IndexedDB를 연결했다. Fixture signer, native adapter 대체, mock dispatcher는 사용하지 않았다.

현재 capability/schema hash, 병렬 snapshot/run 조회, native receipt/resource 동일성, 동일 ID replay, 실제 앱 종료 중 미수락 제출과 재시작 후 무재제출 처리를 확인했다. 이 검증에서 생성 계정, Queue 등록, Provider 호출은 필요하지 않다. 재실행에는 [`qa-phase10c-mcp-native.mjs`](../../scripts/qa-phase10c-mcp-native.mjs)의 `--help`를 사용하며 `live`, `app-off`, `revoked`는 실제 앱/클라이언트 상태를 먼저 준비해야 한다. Script가 그 상태를 대신 만들지 않는다.

이 후속 검증은 위 남은 항목 중 읽기 경로·정상 종료/재시작의 범위를 좁힌다. 클라이언트 폐기와 앱 종료의 최종 정리 상태는 검증 기록에 별도로 명시한다. MCP를 통한 사람 승인 enqueue/cancel, 장시간 run polling, native key rotation, 강제 종료 시 불명 mutation, 설치·업데이트·rollback과 실제 운영 증거는 별도로 남는다. 전체 Phase 10 Go/No-Go와 Phase 11 foreground 결정은 자동 승격하지 않는다.

## Rollback

개발 stdio entry/adapter/bridge, 추가 SDK 개발 의존성과 해당 tests/scripts를 제거할 수 있다. 기존 inbox·receipt·plan·Queue 데이터, OS key store, 사용자 config, production binary의 migration은 없다. 공유 validator는 기존 application 동작을 유지하는 추출이며 Phase 9 foreground authority는 계속 유효하다.
