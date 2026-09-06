# ADR-008: Phase 9E의 저장 결과 등록 복구

- 결정일: 2026-09-06
- 선행 계약: [ADR-007](ADR-007-phase9d-generation-cancellation.md), [ADR-006](ADR-006-phase9c-generation-approval-policy.md)
- 구현 범위: Windows foreground의 `generation.retry_storage`, 저장이 끝난 결과의 Artifact 등록과 Queue 완료
- 검증 기록: [Phase 9E validation](../releases/evidence/phase9e-validation-2026-09-06.json)
- 현재 상태: 시작 복구 순서의 P1 수정을 독립 검토로 확인하고 최종 자동 검증을 통과했다. 실제 native 안전 거절 QA와 정리 5개 검사를 통과했으며 정상 파일 등록의 native 성공은 미검증이다. Phase 9 전체 완료, MCP 또는 background/headless 활성화를 뜻하지 않는다.

## 지원할 입력과 효과

```json
{"name":"generation.retry_storage","input":{"runId":"<existing-batch-id>","jobId":"<existing-job-id>"}}
```

`runId === batchId`이며 해당 배치의 job 하나만 대상으로 한다. Agent 진입은 현재 commit-set 계약인 `reservationSchemaVersion: 1`과 미리 결합된 output transaction·artifact reference가 있는 작업으로 제한한다. 지정한 OutputWriter journal의 `files-committed` 상태와 job·예약·목적지·commit-set 연결을 확인한다. legacy 작업의 기존 수동·시작 복구 계약은 유지한다.

실행은 기존 `retryGenerationStorage` → runtime command adapter → `retryQueueLinkedOutput` → `OutputWriter.retryFilesCommittedWorkflow`로 연결한다. 이미 저장된 이미지의 Artifact 등록을 마치고 같은 Queue job을 성공으로 전이한다. 새 이미지 생성, 파일 재작성, Provider 호출, spool 재실행, 다른 job 실행, R2 업로드와 Scene 결과 연결 재시도는 이 명령의 효과에 포함하지 않는다.

입력에 파일 경로, journal 원문, Provider 재시도 또는 강제 처리 옵션을 받지 않는다. 검토 대상에는 run·job·output transaction·artifact의 공개 식별자와 immutable snapshot·예약 결합의 hash만 저장한다. 실제 경로와 저장 기록은 기존 repository와 writer가 관리한다.

## 사람 승인과 같은 원장

`suggest`와 `bounded-auto` 모두 사람의 일회 승인을 요구하며 `observe`는 거부한다. `globalPause`의 기존 의미는 새 enqueue 차단이다. 이번 명령은 새 Provider 실행 없이 저장이 끝난 결과의 등록만 처리하므로 일시 중지 중에도 사람 승인을 허용한다. 다른 mutation의 일시 중지 예외로 확대하지 않는다.

기존 workspace CAS 원장에 명시적인 storage record/grant를 추가하고 enqueue 저장 형식을 유지한다. 동일 client의 operation key는 enqueue·cancel·storage 사이에서도 유일해야 한다. 전체 원장 용량과 인증·정책 개정·만료 검사는 공유한다. storage record를 새 생성의 이미지 수, 비용, 동시성, 예상 노출액 합산에 넣지 않는다.

승인은 원래 request hash, run ID, job ID, immutable target hash와 policy revision에 결합한다. 승인 화면에는 기존 결과를 등록하는 효과와 정확한 배치·작업·결과 ID를 표시한다. 내부 journal phase나 임의 경로를 사용자가 입력하도록 만들지 않는다.

## 실행 중 변경과 원자적 Queue 검사

대상 조회와 실행 직전에 현재 job·attempt·예약·journal을 확인한다. 취소 표시, Provider 결과 불명 또는 유실, 허용되지 않은 Queue 상태, 현재 프로세스의 활성 writer, 유효한 lease가 있는 작업은 targeted retry로 복구하지 않는다.

최종 `recoverFilesCommittedSuccess` transaction은 현재 job·lease·attempt를 다시 읽고 취소·Provider 상태·output 연결·예약 소유권과 읽었던 attempt 번호를 검증한다. Artifact를 새로 등록한 뒤 이 검사가 거부되면 기존 보상 경로로 새 등록만 되돌린다. 기존 결과 파일이나 다른 작업을 삭제하지 않는다.

시작 복구는 coordinator가 실행되기 전 이전 프로세스의 lease를 회수하는 기존 권한을 유지한다. 실행 중인 앱에서 호출하는 targeted retry의 유효 lease 거부와 구분한다. 같은 OutputWriter 인스턴스의 transaction 점유는 쓰기·재시도·복구 경로에 공통 적용한다.

Queue가 소유한 `files-committed` 기록을 취소·불명 결과·연결 불일치 때문에 보류하면 그 기록을 보존한다. 뒤이은 일반 journal 정리도 Queue가 이미 판정한 transaction을 건너뛰어 보류 결정을 다시 rollback으로 바꾸지 않는다.

## 완료와 재시작

```json
{"status":"storage-registered","runId":"<batch-id>","batchId":"<batch-id>","jobId":"<job-id>","artifactId":"<artifact-id>"}
```

완료는 같은 transaction·artifact에 연결된 Queue 성공과 정확한 Artifact lineage가 함께 존재한다는 의미다. 특정 Agent 호출이 등록을 수행했다는 인과관계나 R2 전달 완료를 주장하지 않는다. 시작 복구가 먼저 같은 목표 상태를 완성한 경우도 정확한 사실 대조로 확인할 수 있다.

승인 grant를 소비한 뒤 결과가 불명확하면 원래 복구 명령을 다시 호출하지 않는다. `reconcile`은 Queue와 Artifact를 조회하며, 둘 중 하나만 존재하거나 대상 결합이 달라졌으면 unknown으로 남긴다. 성공 후 journal이 정리됐다는 이유만으로 원래 복구 작업을 다시 시작하지 않는다.

## 검증 경계

실제 Queue가 만드는 hash 형태의 `outputTransactionId`를 shared payload scanner가 binary로 오탐했다. 계약 테스트 RED 1건으로 재현한 뒤 exact opaque identifier field 집합에 `outputtransactionid`만 추가했다. 임의 필드의 같은 문자열과 credential·image·절대 경로에 대한 거부는 유지한다. 수정 후 코어 4파일·93테스트와 최종 회귀에서 통과했다.

P1 수정 후 Node 24.19.0 비실시간 회귀는 323파일·2,396테스트, 실패·pending 0이다. lint, architecture 618모듈·3,419의존성·위반 0, secret-redaction 17테스트, TypeScript·Vite build와 native dev build가 모두 exit 0이며 native build는 13.38초에 완료됐다. 최종 binary SHA-256은 `D79AB66047CC3CBD4AFC5A045C9D6B10AB87458D7F62257D2FC57D918416D6DE`다. 이전 2,391테스트와 33.12초 build는 수정 전 후보 history로 분리 보존한다. Queue/Writer 집중 검증 6파일·137테스트, Agent bridge 25테스트, foreground/panel 2파일·19테스트는 회귀와 중복되는 부분 검증이며 별도 합산하지 않는다.

정상 `files-committed` 등록 복구는 실제 IndexedDB·실제 OutputWriter와 메모리 filesystem/platform을 사용하는 자동 테스트로 검증했다. Artifact 등록·동일 Queue 성공, 취소나 Provider unknown이 끼어든 경우의 등록 보상, 유효 lease·활성 writer 거부, attempt CAS와 Queue 소유 journal 보존을 포함한다. 새 image write·network fetch가 없고 다른 job이 변하지 않는 것을 확인했다. 실제 native에서 저장 완료 파일을 등록하는 성공 경로는 아직 검증하지 않았다.

브라우저 QA 15개 검사와 390px 화면을 확인했고 page/console error는 0이다. 실제 panel/runtime/settings/IndexedDB를 사용하지만 native 인증·계획·Queue·storage retry 포트는 fixture다. 수정 전 후보 native 앱은 client 등록·명령 제출 전에 종료했다. 최종 binary의 실제 Windows 앱에서 production Python signer가 서명한 `generation.retry_storage`는 기존 cancelled·attempt 0 job에 대해 `AGENT_STORAGE_TARGET_UNAVAILABLE`로 거절되었다. jobs·승인 원장·예약은 변하지 않았고 native 결과 파일은 IndexedDB receipt와 같았다. 같은 요청 replay도 receipt와 저장 사실을 바꾸지 않았다. GUI에서 QA client를 폐기한 뒤 signer는 `CREDENTIAL_UNAVAILABLE`을 반환했으며 정상 창 종료와 Vite 종료 후 소유 PID 37016 및 포트 9331·9192의 listener가 남지 않았다. 이 native 5개 검사는 안전 거절·projection·replay·폐기·정리 범위이며 실제 files-committed 파일 등록 성공은 미검증이다. Provider나 원격 저장소를 호출하지 않은 검사를 실사용 생성·R2 증거로 해석하지 않는다. Phase 10 MCP spike는 미시작이며 Phase 11 background/headless는 No-Go를 유지한다.

독립 검토의 P1은 시작 시 Provider reconcile이 files-committed job을 queued-spooled로 전이해 후행 복구에서 거부하던 순서 문제였다. 일반 queued 상태를 허용하지 않고 검증된 Provider 성공·정확한 v1 snapshot/journal/reservation·비활성 writer 조건을 만족한 작업만 후행 output recovery가 처리하도록 유지했다. 전체 startup 정상 2건이 RED에서 실패하고 GREEN에서 통과했으며 filtered skip 25건은 통과 수에 더하지 않는다. missing spool·reservation 불일치·cancelled 보존 3건을 포함한 집중 검사 4파일·67테스트와 typecheck·lint도 통과했다. 독립 검토의 P1은 해소됐다.
