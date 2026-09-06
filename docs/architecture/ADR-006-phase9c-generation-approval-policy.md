# ADR-006: Phase 9C의 영속 승인과 생성 실행 정책

- 결정일: 2026-09-05
- 구현 범위: Windows foreground의 `generation.enqueue`, 사람의 일회 승인·거절, versioned 실행 정책, 영속 예산 예약과 Queue 사실 기반 복구
- 선행 계약: [ADR-004](ADR-004-phase9-authenticated-inbox-core.md), [ADR-005](ADR-005-phase9-windows-foreground-inbox.md)
- 검증 기록: [Phase 9C validation](../releases/evidence/phase9c-validation-2026-09-05.json)
- 실제 Windows 검증: [Phase 9C desktop QA](../releases/evidence/phase9c-desktop-qa-2026-09-06.json)
- 후속 취소 계약: [ADR-007 — Phase 9D](ADR-007-phase9d-generation-cancellation.md), [9D 소프트웨어 검증](../releases/evidence/phase9d-validation-2026-09-06.json)
- Phase 9 전체 상태: 진행 중. 생성 enqueue의 실제 Windows 승인·거절·정상 재시작 경로를 검증했으며, 다른 mutation과 최종 운영 gate는 남아 있다.

## 실행 경로와 지원 입력

새 외부 명령은 `generation.enqueue` 하나다. 입력은 아래 두 필드만 허용하고, 반드시 만료 시간이 있는 인증된 envelope 안에 제출한다.

```json
{"name":"generation.enqueue","input":{"planId":"sha256:<64 hex>","planHash":"sha256:<64 hex>"}}
```

계획은 기존 `generation.plan`이 저장한 immutable repository에서 읽는다. 외부 prepared payload, 비용 동의서, 승인 시각이나 사람 actor를 받지 않는다. 저장된 Workflow Draft의 revision, 준비 결과, materialized seed, 현재 credential 가격 근거와 목적지를 기존 planner로 다시 검증한다. 승인 시 계획을 새로 만들거나 원본 예산을 늘리지 않는다. 계획 자체의 예산이 부족하거나 source가 변경되었다면 외부 caller는 새 계획을 검토하고 새 요청을 제출해야 한다.

실행은 `enqueueGeneration` → `enqueueReviewedMainPlan` → 기존 atomic Main Queue로 연결한다. `runId === batchId`이며 별도 생성 엔진은 없다. Queue startup recovery와 native owner 확보가 끝나기 전에는 처리하지 않는다. receipt의 `completed / result.status: ready`는 Queue 저장 완료이며 이미지 생성·파일 저장·R2 전송 완료가 아니다.

직접 출력 경로는 검토된 prepared output과 logical destination이 일치해야 한다. 전역 Folder document는 이 경우 reservation owner로만 사용하며 선택된 Folder가 검토한 경로를 대체하지 못한다. 선택 Folder 출력은 immutable Folder document binding이 있어야 한다. 현재 Workflow Draft planner가 그 binding을 제공하지 않는 입력은 실행하지 않는다. R2 delivery·원본 삭제·pinned credential 등 기존 planner/Queue의 미지원 경계도 그대로 유지한다.

## 승인과 idempotency

`nai-blue-agent-execution:<workspaceId>` CAS ledger에 원래 signed envelope, authenticated client/actor kind, request·plan hash, 원래/current policy revision, 만료 시간, 승인 결과와 실행 grant를 저장한다. native ready 파일이 retire되어도 UI가 대기 요청을 복원할 수 있다. secret이나 internal plan의 prepared payload는 이 ledger에 복제하지 않는다.

사람은 기존 Data Hub AI panel에서 request/client, source ID, 이미지 수, 예상 Anlas, 출력 영향, compatibility, 만료와 현재 제약을 검토하고 승인 또는 거절한다. UI의 기대값은 request hash·plan hash·policy revision에 묶인다. 그중 하나라도 바뀌면 오래된 버튼 요청은 실행하지 못한다. 정책 변경 시 대기 요청은 현재 revision으로 다시 검토되며 원래 revision도 남긴다.

승인은 CAS로 한 번만 소비한다. envelope에 `approvalToken`을 새로 넣거나 새 요청으로 바꾸지 않는다. 이 필드는 승인 권한이 아니며 외부 caller가 사람 승인을 주장할 수 없다. 원래 동일 envelope의 재제출은 갱신된 receipt를 재투영한다. 다른 request ID로 같은 workspace/client의 `context.idempotencyKey`를 재사용하면 admission CAS에서 거부한다. 새 작업에는 새 operation key가 필요하다.

Queue ID는 원래 workspace/client/request/hash/plan에 묶인 안정된 scope에서 만든다.

```text
batch/run: main-batch-agent-<digest>
job:       main-job-agent-<digest>-<ordinal>
```

각 Queue job snapshot에는 scope, plan ID/hash와 전체 grant digest를 포함한다. authenticated `agent` 또는 `service` kind와 `client:<clientId>` actor identity를 application 경계까지 유지한다. 이 binding은 batch/jobs/output reservations와 같은 Queue transaction에 저장되고 snapshot hash 검사에도 포함된다.

## 정책 권한과 저장

기존 settings에 `schemaVersion: 1`인 `AgentExecutionPolicy`를 저장하고, settings persistence version은 2로 올린다. 기존 저장 데이터의 새 필드 누락은 `suggest`로 정규화한다. 손상되거나 알 수 없는 권한 필드는 `observe + globalPause`로 제한하며 merge와 migration 양쪽에서 검증한다.

정책 변경은 사람 UI 전용 revision CAS이다. 변경 동안 요청 처리와 다른 권한 변경을 막고 기존 in-flight 작업을 기다린다. setter는 storage flush와 strict readback을 기다린다. 저장 실패 시 메모리 정책을 제한하고 제한된 정책의 저장도 시도한다. native authentication 전후에도 policy 저장 중인지 검사한다. 외부 inbox 및 기존 edit bridge에는 이 setter를 노출하지 않는다.

- `observe`: 조회만 허용한다.
- `suggest`: 조회·계획과 생성 승인 요청을 허용하며 자동 enqueue하지 않는다.
- `bounded-auto`: 사람이 명시적으로 선택하고 미래 만료 시간을 저장해야 한다. 활성화 기간은 한 번에 최대 24시간이다.
- 자동 실행 만료: `suggest` 의미로 낮추며 새 생성은 사람 검토가 필요하다.
- `globalPause`: 조회·계획과 대기 검토를 유지하면서 일회 승인을 포함한 새 enqueue를 막는다. 사람이 중지를 해제하고 현재 policy revision으로 다시 검토해야 한다.

generation 및 rolling 상한은 일회 승인에도 적용한다. 조정 가능한 정책 상한을 초과한 유효한 요청은 대기 상태로 남아 현재 이유를 표시한다. 사람이 정책을 변경한 뒤 갱신된 binding을 다시 승인해야 하며 승인 버튼이 상한을 몰래 늘리지 않는다. `synthetic-only`는 기본 allowlist에 없으며 사람이 명시적으로 허용해야 한다. overwrite·delete-original은 정책으로도 허용하지 않는다. 지원되지 않는 Folder/R2 mutation 권한 필드는 실제 handler 등록을 대신하지 않는다.

기본값은 1회 4장/20 Anlas, 동시 작업 2개, 시간당 10회/20장/100 Anlas, 일일 200 Anlas, client당 미해결 요청 3개다. 이 값은 `suggest`의 검토 한도이며 자동 실행 허가가 아니다. runtime capability는 같은 handler registry와 effective policy에서 계산하고, 실제 등록된 enqueue만 승인 기능을 가진 mutation으로 표시한다.

## 예산은 실제 청구액이 아닌 보수적 예상 노출액

Queue 호출 전에 workspace ledger의 한 CAS로 예상 Anlas·이미지 수·run·client 미해결 요청·동시 작업 상한을 예약한다. 여러 client나 coordinator instance가 동시에 요청해도 같은 budget authority를 사용한다. 거절 또는 만료된 admission은 Queue 작업을 만들지 않는다.

미해결·unknown grant는 시간이 지나도 rolling 계산에서 빠지지 않는다. Queue receipt 완료만으로 예약을 해제하지 않는다. 정확히 같은 grant에 묶인 모든 job이 terminal이고 attempt evidence가 완전하며 Provider outcome/billing risk가 불명확하지 않을 때만 정리된 것으로 본다. 그 사실을 처음 관측한 `exposureSettledAt`을 영속화하며, 정리된 노출액의 시간당·일일 window는 그 시각부터 계산한다. 취소나 실패만 보고 비용이 들지 않았다고 추정하지 않는다.

현재 저장소에는 실제 청구 Anlas authority가 없다. UI와 evidence의 수치는 승인된 예상 노출액이며 계정 청구 명세나 환불 기록이 아니다.

workspace CAS ledger는 현재 최대 1,000개 record를 허용한다. idempotency·감사 기록을 자동 삭제하지 않으며 한도에 도달하면 새 admission을 제한한다. 자동 실행 용량을 늘리려면 tombstone과 영속 예산 사실을 보존하는 별도 보관/migration 계약이 필요하다.

## 중단 후 복구

실행 grant와 Queue transaction은 서로 다른 저장소에 있다. grant 소비 후에는 같은 요청을 다시 enqueue하지 않고, deterministic batch/job ID·snapshot hash·grant binding으로 Queue 사실을 조회한다. Queue commit 뒤 receipt 기록이 실패해도 정확한 기존 batch를 찾아 원래 receipt를 복구한다. 파일 result는 저장된 receipt의 projection으로 다시 쓴다.

Queue 사실이 없거나 일치하지 않으면 `AGENT_EXECUTION_UNKNOWN`으로 남긴다. 원인이 확인되지 않은 호출을 재실행하지 않는다. legacy `accepted`, `COMMAND_OUTCOME_UNKNOWN`, `RESULT_NOT_PUBLIC` receipt에 새 승인 권한을 부여하지 않는다. 예외적으로 완료된 durable grant와 검증된 Queue 사실이 있는 요청의 receipt만 복구할 수 있다.

정상 중지·키 변경·정책 저장·사람 결정은 같은 foreground drain을 공유한다. 중지는 새 요청을 막고 진행 중인 작업과 owner 해제를 기다린다. 영속 대기 기록은 다음 시작에서 다시 읽으며, 앱이 닫힌 동안 실행하지 않는다.

## 함께 수정한 유료 batch 비용 동의

기존 Main adapter가 batch 전체 동의를 각 단일 이미지 job에 그대로 복사하여 executor의 정확한 단일 비용 검사와 충돌했다. 공통 경로에서 resource I/O 전에 batch 합계를 검증한 뒤 각 job의 정확한 비용과 상한으로 동의를 좁힌다. 원래 가격 근거·추정 시각·승인 시각은 유지한다. 비용 검사 자체를 완화하지 않는다.

## 검증과 남은 범위

계약·persistence 테스트는 실제 IndexedDB adapter와 Queue transaction을 사용한다. Provider executor 검사는 transport fixture를 사용한다. 브라우저 QA는 실제 panel/runtime/coordinator/settings와 IndexedDB를 사용하고 native/auth·계획 조회·Queue 실행은 명시적 fixture로 대체한다. 상세 실행 결과와 해시는 위 evidence에 둔다.

2026-09-06 격리된 standalone Windows Tauri 앱에서 실제 native 인증·production Python signer·기존 planner·Main Queue를 연결했다. GUI에서 저장한 직접 출력 draft에 충돌 시 저장 중단을 선택하고, `suggest` 정책의 30 Anlas 한도와 `synthetic-only` 허용을 명시적으로 저장했다. 예상 29 Anlas 계획의 승인 대기는 job 0개였고 정상 재시작 후 같은 원장이 복원되었다. 사람 승인 후 batch 1개·job 1개·reservation 1개가 저장되었으며 attempt와 artifact는 각각 0개였다. 동일 요청 replay, native run 조회, 정확한 batch 링크, 별도 요청의 `AGENT_HUMAN_REJECTED`, 승인 완료 후 정상 재시작과 동일 receipt 재투영을 확인했다. 이 결과는 Queue 저장 완료이며 Provider 실행이나 실제 비용 청구 증거가 아니다.

이 과정에서 기본 `unique` 충돌 정책만 제공하던 Guided 출력 UI에 기존 `error` 정책을 선택하는 컨트롤을 추가했다. 또 settings version 2의 보존된 preimage를 Folder projection reader가 거부하여 재시작 시 Folder authority가 복원되지 않던 결함을 수정했다. 기존 version 1과 현재 version 2만 허용하며 preimage·authoritative document·CAS 계약은 유지한다. 수정 후 비실시간 회귀 316파일·2,270테스트, lint, architecture(614모듈·3,382의존성·위반 0), secret-redaction 17테스트가 통과했다.

첫 실패 프로필의 `globalPause` 승인 비활성·job 0개 증거는 최종 EXE 이전 기록으로 구분한다. 최종 EXE SHA-256은 `F330FE8172F59361BFCDC45C88EE33E72B587538323591F8D09F377B4110DB1C`이며 두 QA 프로필의 client를 GUI에서 폐기하고 signer의 `CREDENTIAL_UNAVAILABLE`, 소유 프로세스와 진단 포트 9330·9331 종료를 확인했다. installer, 강제 native process crash, 실제 native bounded-auto, Provider·생성 파일·R2 결과는 아직 검증하지 않았다.

후속 Phase 9D는 `generation.cancel`을 같은 원장과 기존 Queue에 연결했으며 자동·브라우저 검증을 통과했다. 취소는 `suggest`와 `bounded-auto` 모두 사람 승인 전용이며 `globalPause`에서도 허용한다. 정확한 대상·grant 결합과 재취소 없는 복구 계약은 ADR-007을 따른다. 이 기록 시점의 9D 실제 Windows 첫 승인 receipt 오탐은 수정 binary에서 동일 grant 복구·replay와 완료 후 정상 재시작·client 폐기·프로세스 정리를 확인했다. storage/Scene retry, reservation 포기, Scene/Folder/R2 mutation은 계속 unavailable이다. MCP stdio, background/headless도 이 변경으로 활성화하지 않으며 Phase 9의 최종 운영 gate는 남아 있다.
