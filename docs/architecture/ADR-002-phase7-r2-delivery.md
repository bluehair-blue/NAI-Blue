# ADR-002: Phase 7 R2 전달의 불변 목적지와 복구 경계

- 결정일: 2026-09-05
- 코드 상태: Phase 7C 구현 완료 (`b3aa026b6804e050dc73fd556c42a296509506fa`)
- 운영 검증: 실제 Provider/R2/설치 앱 강제 종료 검증은 미확보
- 선행 계약: [ADR-001](ADR-001-modular-monolith-boundaries.md)
- 검증 기록: [Phase 7C validation](../releases/evidence/phase7c-validation-2026-09-05.json)

## 결정

1. Folder authority가 resolve한 bucket/prefix와 필드별 출처를 Main/Scene 계획에 전달한다. `null` bucket clear는 차단하며 prefix clear는 빈 prefix를 보존한다. legacy 입력의 누락 필드는 profile default를 상속한다. shared profile을 변경하지 않고, 유효 목적지를 반영한 internal profile snapshot과 공개 destination의 hash/bucket/key를 일치시킨다. `sourceProfileHash`는 Folder override 이전 shared profile의 검토/CAS 기준이다.
2. Main의 application capture와 Scene의 reviewed target은 `disabled | best-effort | required`를 고정한다. 공개 review에는 destination만 포함하고 credentialRef를 포함한 internal snapshot은 공개하지 않는다. application-reviewed Main의 exact filename이 allocation에서 바뀌면 거부한다. private 전달의 sidecar와 원본 보존 정책은 local OutputCommitSet allocation 전에 확정하며 public 전달도 예약과 writer의 보존 정책을 일치시킨다.
3. enqueue 전에는 source profile 변경과 readiness를 재검증한다. enqueue 후 실행과 재개에서는 각 job의 snapshot을 사용한다. required readiness 검사는 실제 신규 Provider 호출 직전에만 실행한다. 검증된 spool을 저장하는 경로에는 이 credential 검사를 적용하지 않는다.
4. required 준비 실패는 `r2-readiness`로 batch를 일시정지한다. 전송 전 `prepared`, billing risk `none`, 응답/spool 없음, transition 0건인 interrupted attempt만 같은 ID로 재개한다. 준비 대기는 생성 retry budget을 소진하지 않는다. possibly-dispatched/unknown은 이 경로로 재개할 수 없다.
5. local Artifact commit 뒤 application `enqueueR2Release`가 durable upload handles를 반환한다. private sidecar는 같은 commit lineage에 이미 존재하는 정확한 file/digest/size여야 한다. distribution 후처리는 이 원본 sidecar authority나 그 부재를 덮어쓰지 않는다. 현재 파일에서 누락된 authority를 합성하지 않는다.
6. startup과 사용자의 전달 재개는 `recoverQueueR2Release`를 공유한다. 동일 대상은 기존 upload repository의 dedupe로 같은 job에 연결된다. failed upload의 명시적 CAS 재개는 snapshot/multipart/verified proof를 보존한다. startup은 failed를 자동으로 retry하지 않으며 cancelled job도 재개하지 않는다.
7. foreground scheduler는 Phase 7 job의 profileSnapshot으로 eligibility/readiness를 판정한다. mutable current profile은 legacy job만 조회한다. repository 일시 오류와 각 job의 오류를 격리하고 대기 상태를 표시한다. verified/linking의 local 작업은 credential 없이 진행한다. 자동 전달 설정을 끄면 foreground 실행을 멈추고 durable job은 보존한다.
8. `queued`는 정상 접수이며 완료 증거가 아니다. Main/Scene/Library consumer가 접수와 handles를 표시하고 Queue fulfillment가 누락·실패 delivery의 재개 동작을 제공한다. 최종 release success는 exact HEAD size/SHA-256 metadata와 Artifact remoteRef의 profile ID/hash, bucket/key, Artifact ID, content/size, verified timestamp가 모두 일치해야 한다.
9. native PUT은 검증한 bytes를 그대로 전송한다. multipart resume도 전체 source identity와 같은 read에서 캡처한 range를 검증한다. 같은 timestamp의 독립 계획에는 Artifact identity를 포함한 서로 다른 job IDs를 부여하고, 동일 대상의 재접수는 repository가 dedupe한다.
10. current Queue writer는 `r2DeliveryVersion: 1`을 기록한다. 이 discriminator가 있는데 delivery binding이 없거나 불완전하면 거부한다. 실제 pre-Phase-7 snapshot의 reader 호환성은 유지한다.

## 지원 범위와 비목표

현재 Main application capture, Main durable adapter, Scene reviewed queue와 Artifact 후속 전달을 지원한다. 별도 WorkflowDraft planner adapter는 exact R2 destination을 만들지 않으므로 기존 R2 unsupported gate를 유지한다. capability에 없는 overwrite/delete-original, raw transport 도구, Agent credential 입력은 추가하지 않는다. Queue/repository/application 권한을 재사용하며 Phase 8–11 구현은 포함하지 않는다.

multipart는 메모리를 part 크기로 제한하기 위해 part마다 전체 파일을 다시 읽어 hash한다. 현재 part는 8 MiB, native body 상한은 64 MiB다. 큰 파일의 비용이 실제로 문제가 될 때 immutable private spool을 검토한다.

## 검증과 남은 운영 gate

Node 24.19.0에서 비실서비스 299 files / 2,065 tests를 통과했다. 이 중 R2 application/domain/service는 10 files / 75 tests, Queue domain/service는 31 files / 254 tests, persistence는 3 files / 15 tests다. rescue mode, secret redaction 17 tests, architecture 584 modules / 3,202 dependencies의 위반 0, lint, typecheck, build를 확인했다. Windows MSVC native `r2_native::` 14 tests도 통과했다.

브라우저의 실제 앱에서 Queue 기본 화면과 R2 native-unavailable 표시 및 error log 0건을 확인했다. 이 확인은 설치 앱에서 pending/succeeded/needs-attention 상태를 조작한 증거가 아니다. 실제 vault 잠금/회전, NovelAI 생성, 원격 R2 업로드/HEAD, PUT·HEAD·link 경계의 설치 앱 강제 종료는 다음 운영 gate로 남긴다. 코드와 fixture 성공으로 이 운영 증거를 대체하지 않는다.
