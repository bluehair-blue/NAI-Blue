# ADR-007: Phase 9D의 승인된 배치 취소

- 결정일: 2026-09-06
- 선행 계약: [ADR-006](ADR-006-phase9c-generation-approval-policy.md)
- 후속 저장 결과 등록 복구: [ADR-008 — Phase 9E](ADR-008-phase9e-storage-registration-recovery.md)
- 구현 범위: Windows foreground의 `generation.cancel`, 같은 workspace 승인 원장과 기존 Queue 취소 경로
- 검증 기록: [Phase 9D 검증](../releases/evidence/phase9d-validation-2026-09-06.json). 실제 Windows 취소 QA의 첫 승인 오류를 수정한 binary에서 동일 grant 복구·replay를 확인했으며 완료 후 정상 재시작·native receipt 동일성·client 폐기·프로세스 정리를 포함한 native 7개 검사를 통과했다. 자동 검증과 실제 native 검증의 범위를 구분하며 Phase 9 전체는 진행 중이다.
- Phase 9 전체 상태: 진행 중. 저장 재시도, 추가 명령, 운영 QA, MCP와 background/headless는 별도 범위다.

## 입력과 사람 승인

외부 입력은 인증된 만료 시간 포함 envelope의 아래 명령 하나다.

```json
{"name":"generation.cancel","input":{"runId":"<existing-batch-id>"}}
```

`runId === batchId`이며 전체 배치를 대상으로 한다. 지원 대상은 job 1~100개의 배치다. 조회 결과에 다음 페이지가 남거나 빈 배치이면 거부하므로 100개를 넘는 배치를 일부만 승인하지 않는다. 외부 actor, 부분 job 목록, 강제 취소, 원본 삭제, 예약 포기, Provider 재시도 입력은 받지 않는다. 기존 등록 client 인증을 통과한 후 앱이 읽은 배치와 job snapshot의 정확한 대상 집합을 검토한다.

취소는 `suggest`와 `bounded-auto` 모두 사람의 일회 승인이 필요하다. `observe`는 조회 전용으로 유지한다. `globalPause`는 새 생성 등록을 막는 기능이므로 이미 등록된 작업의 승인된 취소를 막지 않는다. 생성 비용·동시성·미해결 생성 한도 역시 취소에 적용하지 않는다. 전체 원장 용량과 동일 client의 operation idempotency 검사는 유지한다.

승인 UI는 생성 비용과 새 출력 효과 대신 중단할 배치, 정확한 job 목록과 개수, 만료, 중단 효과를 표시한다. 기대값은 원래 request hash, run ID, target hash, policy revision에 결합한다. target hash는 배치와 job의 immutable identity 및 snapshot hash를 묶으며 진행률 같은 가변 상태를 승인 대상으로 만들지 않는다. 정책 개정과 최종 인증 검사는 실행 직전에도 적용한다.

## 같은 원장과 실행 경계

기존 `nai-blue-agent-execution:<workspaceId>` CAS 원장에 취소 전용 record/grant를 추가한다. 기존 enqueue record와 grant의 저장 모양을 유지하고 파서는 두 명령의 명시적 형식만 수용한다. 새 request ID로 같은 client의 operation key를 enqueue와 cancel 사이에서 재사용해도 충돌이다. 취소 record는 생성 예상 노출액·이미지·동시성 합산과 settlement에서 제외한다.

기존 foreground의 사람 결정·정책 저장·client 변경·중지 drain, durable receipt 저장소와 native 결과 투영을 재사용한다. 취소용 두 번째 원장이나 Queue는 만들지 않는다. 실행은 기존 `cancelGeneration` → runtime command adapter → 같은 Queue coordinator의 batch cancel로 전달한다.

Queue의 기존 `cancelReason`에는 취소 grant의 canonical digest로 만든 `agent-cancel:<64 lowercase hex>`를 허용한다. 기존 `user`, `batch`, `shutdown` 값은 유지한다. operation marker를 저장한 뒤 진행 중 요청의 AbortController를 중단하므로 빠른 종료가 원래 취소 식별자를 잃게 하지 않는다.

## 완료와 불명 결과

성공 receipt의 결과는 다음처럼 취소 요청이 저장된 대상을 나타낸다.

```json
{"status":"cancel-requested","runId":"<batch-id>","batchId":"<batch-id>","jobIds":["<job-id>"]}
```

이는 모든 작업의 즉시 종료나 Provider 처리·과금 취소를 보장하지 않는다. 이미 끝난 작업은 바꾸지 않는다. 다른 배치는 취소하지 않는다.

취소 grant를 소비한 뒤 예외나 결과 저장 실패가 발생하면 원래 command를 다시 실행하지 않는다. 복구는 정확한 batch/job snapshot과 각 job의 grant marker 또는 grant에 보존한 기존 중단 사실을 대조한다. `previouslyStoppedJobIds`에 포함된 job도 원장 배열만으로 인정하지 않는다. Queue의 `cancelRequestedAt`이 있으면 그 시각을 사용하고, 없으면 terminal job의 `updatedAt`을 사용한다. 해당 시각과 `consentedAt`이 모두 canonical timestamp이며 중단 시각이 `consentedAt` 이하일 때만 승인 전 중단 사실로 인정한다. 일부 대상만 일치하거나 정확한 marker와 승인 전 중단 근거가 모두 없으면 unknown으로 보존한다. 현재 작업이 terminal이라는 사실만 보고 해당 취소 operation의 성공을 추정하지 않는다.

일반 대기 작업의 미사용 출력 예약은 기존 Queue 취소 transaction에서 정리한다. Provider 결과가 불명확하거나 검증된 spool·생성 결과가 있는 경우에는 해당 evidence, receipt, reservation과 collision claim을 보존한다. 취소 완료를 기존 생성 grant의 예상 노출액 반환이나 결과 폐기 근거로 사용하지 않는다.

## 공유 Queue 복구 보정

기존 `requestCancel`은 취소 표시가 있으면 무조건 반환하여, 재시작 복구가 `running`을 `queued`나 `blocked`로 바꾼 뒤 중단 처리가 끝나지 않을 수 있었다. 중복 표시만으로 반환하는 경로를 실행 중 요청에 한정하고, 실행 중이 아닌 작업은 최초 취소 시각과 이유를 보존한 채 기존 취소 transaction으로 정리한다.

시작 복구는 먼저 Provider/spool 사실과 출력 연결, lease를 복구한 뒤 남은 취소 표시를 처리한다. 실행 중 통신 중단이 Provider unknown으로 바뀌는 경로도 같은 원칙을 따른다. scheduling 상태의 취소가 Provider outcome이나 저장된 결과를 덮어쓰지 않도록 한다.

## 남은 범위

실제 Windows 첫 binary에서 사람 승인 후 Queue는 정확한 grant marker로 `cancelled`가 되었고 attempt 0, 미사용 reservation abandoned, active collision claims 0이었다. `originalCollisionKey` tombstone row 1개는 남았다. 그러나 취소 후 재조회가 채운 `previouslyStoppedJobIds`의 긴 native job ID를 shared payload scanner가 binary로 오탐하여 receipt는 `AGENT_EXECUTION_UNKNOWN`이 되었다. 대상·snapshot·grant hash는 일치했으며 Queue 취소 자체의 실패가 아니었다.

scanner의 exact opaque identifier field 집합에 `previouslystoppedjobids`만 추가했다. bearer credential, image data URL, encoded image bytes와 Windows 절대 경로 검사는 유지한다. 실제 native ID 형태로 재현한 RED 2건을 수정 후 같은 두 suite 122테스트가 통과했다. 첫 실패 원본과 당시 소스·검증 해시는 evidence의 history에 보존한다.

수정 binary `E26E11EEDEA626E0087D59141A7FE2DAA085A2534B4E148CE2D2BA4ED6C7E7C1`에서는 이미 소비된 동일 grant와 Queue marker를 대조하여 completed receipt를 복구했다. 최초 승인 당시 job의 timestamp·marker는 변하지 않았고 attempt 0을 유지했다. replay도 receipt·jobs·ledger를 바꾸지 않았으며 실제 UI batch 링크를 확인했다. 최초 binary의 승인·Queue 취소와 수정 binary의 복구·replay를 서로 구분한다. 완료 후 정상 재시작에서도 receipt·jobs·ledger가 같았고 native public receipt와 IndexedDB receipt의 동일성을 확인했다. QA client를 폐기한 후 signer는 `CREDENTIAL_UNAVAILABLE`(exit 1)을 반환했으며 소유 프로세스와 진단/Vite listener는 각각 0개다. 수정 binary에서 새로운 queued→cancelled native 전이는 실행하지 않았으며 해당 보정은 실제 Queue의 native 형태 long-ID 자동 회귀로 검증했다.

수정 후 Node 24.19.0에서 비실시간 회귀 319파일·2,320테스트(실패·pending 0), 전체 lint, architecture 616모듈·3,399의존성·위반 0, secret-redaction 17테스트, TypeScript와 Vite build가 통과했다. 수정 native dev build는 13.45초에 성공했다. 앞선 소스 시점의 브라우저 QA 12개 검사와 390px 레이아웃 검사를 통과했고 page/console error는 0개다. 실제 panel/runtime/settings/IndexedDB를 사용했으며 native 인증·계획 조회·Queue 취소 포트는 fixture다. scanner 수정 후 브라우저 QA를 재실행한 것으로 기록하지 않는다. 소스 LF 정규화 해시와 원본 검증 artifact 해시는 위 기록에 둔다. 실제 native QA는 위 두 binary의 명시된 범위에서 완료했으며 이 결과를 실제 Provider 중단이나 미실행 native 시나리오의 증거로 확대하지 않는다.

후속 `generation.retry_storage`의 저장 결과 등록 복구는 [ADR-008](ADR-008-phase9e-storage-registration-recovery.md)에 구현·검증 범위를 둔다. 실제 IndexedDB/OutputWriter와 메모리 platform의 성공 자동 검증 및 실제 native 안전 거절을 구분하며 native 성공 등록은 미검증이다. Scene 결과 연결 재시도, 명시적 예약 포기와 다른 조건부 명령은 별도 구현 단위다. 실제 native 취소, 강제 process crash, 실제 Provider·파일 저장·R2, installer/upgrade 증거는 수행한 검사만 별도 기록한다. Phase 10·11을 이 구현으로 활성화하지 않는다.
