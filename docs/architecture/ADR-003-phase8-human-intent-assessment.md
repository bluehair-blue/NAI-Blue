# ADR-003: Phase 8A 사람의 요청 충족 판정과 변경 이력

- 결정일: 2026-09-05
- 구현 범위: 8A human assessment, Guided Main 및 Scene 선택 생성, Queue 평가 화면
- 조건부 기능: 8B Agent evaluator와 8C candidate search는 `available: false`
- 선행 계약: [ADR-001](ADR-001-modular-monolith-boundaries.md), [ADR-002](ADR-002-phase7-r2-delivery.md)
- 검증 기록: [Phase 8A validation](../releases/evidence/phase8a-validation-2026-09-05.json)

## 결정

생성·저장·R2 전달은 기술적 사실이며, 사람이 요청한 이미지인지의 판정과 별도로 유지한다. Style Lab의 취향 선호 event와 repository는 변경하거나 acceptance로 재해석하지 않는다.

1. 생성 전에 선택한 `VisualRubric` snapshot, version, canonical SHA-256, `requiredAcceptedCount`를 계획에 넣는다. Main의 full plan hash와 `visual-rubric` source binding에 반영하고 replay 때 다시 검증한다. Provider semantic hash는 평가 설정으로 바뀌지 않는다. 여러 preset을 포함하는 Scene Queue는 각 Scene 계획·정확한 output commit set·R2 목적지·루브릭을 하나의 run plan hash로 묶는다.
2. 모든 관련 Queue snapshot의 `intentAssessment`는 원본 `runId`, `planHash`, 전체 평가 requirement를 포함한다. Queue 원자적 enqueue 및 hash/readback 검증을 재사용한다. 기존 snapshot은 이 필드가 없으며 기존 동작을 유지한다. 명시적 재시도는 원본 binding을 복사한다.
3. V1 이벤트는 사람만 지원한다. `schemaVersion`, event `type`, ID, run/plan 및 rubric binding, evaluator, 조건별 결과, 점수, 판정, 시각을 엄격히 검증한다. 허용되지 않은 필드와 `agent`/`hybrid`, 모델·confidence 입력은 거부한다. 신뢰된 로컬 호출자의 `ActorRef.kind === 'user'`와 event actor ID가 일치해야 저장한다. 기존 외부 Agent 편집 명령 allowlist는 intent/preference 기록을 허용하지 않는다.
4. 필수 조건 하나라도 `fail`이면 높은 soft score와 관계없이 artifact는 `rejected`다. 판단 보류 조건이나 필요한 점수 누락은 `needs-review`다. 점수 기준이 없는 hard-only rubric은 모든 필수 조건 통과 시 승인한다. soft score는 사람이 rubric의 가중치를 참고해 입력하는 종합 점수이며 모델 점수가 아니다.
5. 평가 저장소는 기존 shared IndexedDB의 strict read와 원자적 compare-and-set을 사용한다. run별 immutable binding과 append-only events를 저장한다. 같은 ID·같은 내용은 재접수해도 한 번만 기록한다. 정정은 현재 artifact head를 `supersedesAssessmentId`로 지정한 새 event여야 하며 동시 정정은 충돌 처리한다. 오류나 손상된 기록은 초기화하지 않고 거부한다.
6. 후보는 원본 Queue job과 유효한 재시도 ancestor/root chain, Artifact의 `sourceJobId`와 checksum이 일치하는 distinct artifact다. event 도착 순서나 timestamp로 이전 평가를 되살리지 않는다. 분기·누락·충돌하는 chain은 승인 수에 넣지 않는다. 필요한 승인 수에 이르면 run이 `accepted`이며, 부족하면 `needs-review`다. run 전체의 `rejected`는 명시적인 `close-as-rejected` event로만 발생한다. 닫힌 run에 새로운 평가를 추가하지 않는다.
7. Queue fulfillment는 run projection을 사용해 여러 artifact 및 retry batch를 집계한다. artifact 한 장의 거절은 run 종료가 아니다. 충분히 승인된 run의 미평가 잉여 이미지는 acceptance를 다시 미평가로 바꾸지 않는다. 기술적 실패·불확실성 표시는 그대로 유지한다.
8. 평가 화면은 Artifact ID로 등록된 원본을 조회한다. 로컬 bytes의 길이와 SHA-256이 등록된 내용과 일치하고 이미지가 표시된 뒤에만 평가를 저장한다. 화면을 닫거나 다른 후보로 이동하면 object URL을 해제한다. 경로나 bytes를 외부 Agent 결과로 내보내지 않는다.

## 사용과 저장 범위

Guided 단일·배치 생성의 검토 단계 또는 Queue의 Scene 선택 화면에서 사람 평가를 켜고 필수 조건·승인 수·선택적 점수 기준을 입력한다. 생성 후 Queue의 fulfillment 영역에서 **요청 충족 판정**을 열어 저장·정정·명시적 종료를 수행한다. 기존 완료 job에 기준을 소급해서 붙이거나 Advanced Main에 새로운 설정 UI를 추가하지 않는다.

생성 전 폼은 로컬 편집 상태이며 Queue enqueue 이후에 평가 기준이 영속화된다. 평가 event는 `nai-blue-intent-assessment:<encoded runId>` key에 보존한다. 이 증거는 Queue/Artifact와 마찬가지로 기존 설정 백업·복원 범위에 자동 편입하지 않는다. 설정 내보내기는 평가 기록 백업이 아니다. Queue 또는 Artifact를 제거하면 기존 event만으로 후보 lineage를 합성하지 않는다.

현재 lineage 조회는 UI 요청 시 Queue를 페이지 단위로 읽는다. 실제 기록량으로 병목이 확인되면 원본 run index를 추가한다. 자동 점수, candidate loop, Provider 호출, workflow 영구 변경은 이 구현에 없다.

## 검증과 남은 범위

`npm run test:assessment`는 parser, hard-first 판정, append-only/CAS, 중복·정정·부분 평가·재시도 lineage, Main/Scene 계획과 Queue 재개방, 외부 actor 거부, Style Lab 분리 테스트를 실행한다. 전체 비실서비스 회귀 검사, persistence/rescue, Queue, secret redaction, architecture, lint, build 결과는 위 검증 기록에 남긴다.

`npm run dev -- --host 127.0.0.1` 실행 후 `npm run qa:assessment`로 격리된 Chromium에서 실제 Queue 화면을 검증한다. 완료된 Queue/Artifact fixture와 실제 IndexedDB를 사용하고 파일 byte reader만 테스트 PNG로 대체한다. 이미지 표시, hard fail + 높은 점수의 거절, 페이지 재로딩 후 복원, 정정·중복 방지, 명시적 run 종료와 모바일 폭을 확인한다. 이 증거는 설치된 Tauri 앱의 실제 filesystem/vault, Provider 생성 또는 강제 종료 검증을 대신하지 않는다. 8B/8C의 실측 Go gate는 계속 닫혀 있다.
