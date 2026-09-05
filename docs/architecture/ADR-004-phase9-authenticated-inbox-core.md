# ADR-004: Phase 9A 인증된 command inbox의 영속 처리 코어

- 결정일: 2026-09-05
- 구현 상태: 9A application core 구현. Phase 9 전체와 외부 실행 활성화는 미완료.
- 선행 계약: [ADR-001](ADR-001-modular-monolith-boundaries.md), [ADR-002](ADR-002-phase7-r2-delivery.md), [ADR-003](ADR-003-phase8-human-intent-assessment.md)
- 검증 기록: [Phase 9A validation](../releases/evidence/phase9a-validation-2026-09-05.json)

이 문서는 9A checkpoint 당시의 범위를 기록한다. 이후 native foreground 조회·계획 연결은 [ADR-005: Phase 9B](ADR-005-phase9-windows-foreground-inbox.md)에 구현 및 검증 범위를 기록했다.

## 결정과 범위

Phase 9를 인증·영속 코어, native 수신·등록, 승인·실행의 순서로 구현한다. 이번 9A는 실제 HMAC 검증, IndexedDB receipt와 immutable plan, planner를 호출하는 `generation.plan` handler, readiness 순서 및 파일별 처리 코어를 제공한다. 현재 앱의 `main.tsx`에 inbox를 연결하지 않는다. 기존 편집 bridge의 `request.json/result.json`은 기존 역할을 유지한다.

이번 checkpoint의 실제 외부 capability는 unavailable이다. 코어 registry에서 handler를 사용할 수 있다는 사실은 설치된 앱에 파일 watcher, OS vault client 등록, UI 승인 또는 Queue 실행이 연결되었다는 뜻이 아니다. `requiresAppProcess: true`, `canExecuteWhileAppClosed: false`는 모든 descriptor에 고정한다.

## 인증과 공개 계약

1. envelope는 schema 1, API `nai-blue.agent/v1alpha1`이다. command는 `{ name, input }`이며 unknown 필드, `user` actor, 외부 actor ID를 거부한다. request ID는 1–100자의 ASCII 영문·숫자·밑줄·하이픈이며 Windows 예약 device name을 허용하지 않는다.
2. 직렬화와 SHA-256은 기존 `composition-canonical-json-v1`을 재사용한다. 이는 RFC 8785 구현이 아니다. 순환 참조를 피하기 위해 **request hash는 `requestHash`와 `authentication` 전체를 제외한 envelope**로 계산한다. **HMAC은 `authentication.signature`만 제외한 envelope 전체**를 서명하며 request hash, key ID, workspace/client, 시각, command와 context가 모두 서명에 포함된다. wire signature는 `hmac-sha256:`와 소문자 16진수 64자리다.
3. WebCrypto verifier는 주입된 등록 client lookup에서 검증용 `CryptoKey`를 받는다. unknown/revoked client, actor/key 불일치, hash 및 HMAC 오류를 거부한다. caller가 주장한 ID 대신 등록 client에서 `client:<clientId>` actor ID를 만든다. 이 adapter는 OS vault 구현이나 client provisioning이 아니다.
4. request와 공개 JSON result는 각각 64 KiB로 제한하고 기존 sync payload scanner로 credential, image/base64, signed URL, private absolute path를 거부한다. approval reference는 별도 opaque reference 검증을 거치며 9A에서 승인 권한으로 사용하지 않는다. 임의 handler 예외 메시지나 코드가 파일로 전달되지 않도록 고정 protocol error code만 rejection에 투영한다.

## Durable receipt와 replay

IndexedDB `nai-blue-db/keyval`의 `nai-blue-agent-command-receipt:<requestId>`가 replay authority다. strict read 및 원자적 CAS로 `accepted`를 먼저 저장한 소유자만 handler에 들어간다. 같은 ID/hash/client/command는 저장된 receipt를 반환하고 다른 내용은 `IDEMPOTENCY_CONFLICT`다. 생성 enqueue의 client idempotency key 연결은 9C 범위이며 9A에서 enqueue는 열리지 않는다.

완료 result는 공개 검사를 통과한 내용과 canonical digest로 보존한다. result file publish 실패는 receipt를 변경하거나 handler를 재호출하지 않는다. handler 진입 후 예외는 `needs-input / COMMAND_OUTCOME_UNKNOWN`으로 남기며, receipt 완료 commit 자체가 실패하면 기존 `accepted`를 보존한다. 재시작 후 `accepted`는 미확정 상태로 반환한다. 자동 재실행 또는 실패 추정은 하지 않으며 향후 복구·사람 확인 경로에서 다룬다.

만료는 신규 수락·실행에 적용한다. claim 저장 대기 중 만료 시각을 넘으면 handler를 호출하지 않고 그 claim을 `rejected / REQUEST_EXPIRED`로 완료한다. 서명과 현재 client 권한을 재검증한 기존 ID/hash의 조회는 만료 후에도 같은 결과를 반환하므로 전송 실패 후 회수가 가능하다. revoked client는 replay도 거부한다. 저장된 replay를 찾은 뒤에는 현재 handler validator를 호출하지 않아 앱 업데이트가 기존 결과 회수를 막지 않는다.

공유 keyval의 strict read와 CAS도 같은 무결성 규칙을 적용한다. 저장된 object/null/number/undefined를 없는 key로 바꾸지 않는다. `get`이 undefined를 반환하면 같은 transaction의 `getKey`로 실제 부재와 명시적으로 저장된 undefined를 구별한다. 손상된 receipt나 plan은 그대로 보존하고 오류를 반환하며, read와 claim 사이에 손상이 발생해도 원자적 CAS가 덮어쓰지 않는다. 이 수정은 기존 strict persistence 호출자에도 적용된다.

`.tmp`와 안전하지 않은 filename은 읽지 않는다. file processor의 포트는 검증된 request ID만 받으며 body와 filename ID가 일치해야 한다. native adapter는 읽기 전 byte 상한, reparse/symlink, ACL, directory 경계 및 atomic publication을 직접 보장해야 한다. 이 요구는 주입한 테스트 포트로 검증되었다고 간주하지 않는다. 저장소 손상·완료 commit 충돌은 `accepted: false` 파일로 덮어쓰지 않고 처리 불가 오류로 남긴다.

## Immutable generation plan

`nai-blue-generation-plan:<digest>`에 전체 내부 plan과 schema/checksum을 보존한다. 같은 plan ID와 같은 canonical 내용은 동일 삽입이며 다른 내용은 충돌이다. 저장소는 기본 구조 및 ID/hash 관계, JSON 직렬화 가능성, 8 MiB 한도와 전체 저장 record checksum을 확인한다. Blob, typed array, undefined 등을 JSON으로 조용히 손실시키지 않는다. 이 checksum은 의미 검증이나 실행 승인 수단이 아니며 enqueue 전 기존 planner의 authoritative replay가 계속 필요하다.

`createAgentGenerationPlanHandler`는 실제 기존 `planGeneration`과 저장소를 호출한다. 초기 지원 입력은 기존 Workflow Draft의 ID/revision, 1–100개 count, random/fixed/increment seed 및 budget이다. detached prepared capture, caller가 넣은 bytes/경로, seed replay와 assessment 설정은 이 handler에서 받지 않는다. 반환값은 plan ID/hash, 예상 Anlas, job 수, 필요한 budget approval 등 최소 검토 정보다. 내부 prepared 값과 private path는 공개 결과에 넣지 않는다. `ready` 또는 `needs_input` 계획도 저장 commit에 성공해야 결과를 반환한다.

계획의 mutable status와 expiry를 기존 `GenerationPlan`에 추가하지 않는다. command의 승인·만료 binding 및 plan 조회 후 정확한 입력 재구성은 다음 실행 단위에서 연결한다. plan repository와 receipt는 Queue/Artifact와 같이 설정 backup/restore 대상에 추가하지 않는다. 자동 만료 삭제나 overwrite API는 제공하지 않는다.

## Policy와 startup 경계

registry는 command별 read/plan/mutation 의미를 application에서 고정하고 handler 등록과 일치하는지 확인한다. handler가 enqueue를 read라고 등록해도 실행할 수 없다. `observe`는 read만, `suggest`는 read와 plan만 사용한다. mutation은 모든 mode/global-pause 조합에서 unavailable이다. `bounded-auto` 값이 주입되어도 9A에서는 승인·rolling limit 검증이 구현된 것으로 해석하지 않는다.

startup seam은 migration → recovery → hydration → owner 획득 → ready 처리 순서를 await한다. recovery가 false이거나 어느 단계가 실패하면 `app-unavailable`, owner가 이미 있으면 `busy`다. 현재 `initializeQueueAfterRestart()`에는 일부 실패가 diagnostics에만 남는 경로가 있으므로, 실제 `main.tsx` 연결 전에 전체 복구 결과를 명시적으로 집계해야 한다. 이번 테스트는 seam 순서를 검증하며 실제 Queue startup 변경을 주장하지 않는다.

## 후속 단위와 Phase 10/11

- **9B:** native keyring 전용 client namespace, 사람 UI 등록·회전·폐기, stable workspace ID, private inbox 디렉터리/ACL/안전한 bounded read, 단일 owner 및 결과 atomic publication. Queue의 모든 복구 실패를 집계한 뒤 실제 foreground startup과 read/plan handler를 연결한다. UI와 inbox가 같은 registry를 사용하도록 한다. 현 native credential 구현은 keyring이며 Stronghold라는 기존 설명을 그대로 구현 근거로 삼지 않는다.
- **9C:** durable plan/replan binding과 expiry, single-use approval, 동일 요청 resume, 사람 UI의 versioned execution policy, durable per-run/rolling/outstanding 예산 예약을 연결한다. policy 변경·pause·expiry 및 concurrent admission을 검증한 뒤 기존 Queue enqueue/cancel/recovery 명령을 연다. NAI/R2 transport를 중복 구현하지 않는다.
- **Phase 10:** Phase 9의 실제 foreground 경로가 검증될 때까지 spike 대기다. SDK, sidecar, 외부 MCP config를 추가하지 않았다. Go/No-Go 실측 결과는 아직 없다.
- **Phase 11:** foreground 유지(A)를 현재 기준으로 두며 background/headless 구현은 No-Go 상태다. app-off 사용량, availability/latency 목표, credential/owner/update 복구 증거가 없으므로 최종 운영 판정 완료로 표시하지 않는다. hidden WebView나 daemon을 추가하지 않는다.

## 검증과 rollback

`npm run test:agent-inbox`는 실제 WebCrypto HMAC과 fakeIndexedDB를 사용해 인증, 동시 claim, 충돌, 공개 경계, DB close/reopen, publish 실패, 미확정 receipt, expiry replay, planner 저장 및 startup 순서를 검사한다. file transport·client lookup·owner는 테스트 포트다. 설치된 Windows 앱, OS-private key storage, ACL, 프로세스 강제 종료, Provider 또는 R2 네트워크 실행 증거는 아니다.

9A는 현재 앱의 생성·편집·Queue startup 동작을 변경하지 않는다. 이후 inbox 연결을 해제하더라도 이미 저장한 plan과 receipt는 보존해야 한다. 설정 초기화 또는 result 파일 삭제로 command 기록을 초기화하지 않는다.
