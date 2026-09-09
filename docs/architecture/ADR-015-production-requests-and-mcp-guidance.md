# ADR-015: 저장된 생산 요청과 단계별 MCP 안내

- 날짜: 2026-09-09
- 상태: 첫 실행 단위. 저장된 요청에서 묶음별 검토·승인으로 진행한다. 전체 자동 실행은 미완료.
- 기반: ADR-013, ADR-014와 현재 Scene/Folder/Queue/실행 승인 권한.
- 검증: [첫 실행 단위 검증 기록](../releases/evidence/production-requests-2026-09-09.json). Node 24 전체 테스트 2,540개 통과, 4개 건너뜀; 브라우저 UI 6개 확인. 실제 호스트·Provider 검증과 구분한다.

## 이번 결정

사람과 에이전트가 최대 2,400장의 대상·수량·seed·총 Anlas 상한을 한 생산 요청으로 저장한다.
앱의 검증된 100개 job / 400개 출력 claim 원자적 등록 한도를 유지하며 요청을 100장 이하의
묶음으로 나눈다. 새 생성기나 두 번째 실행 대기열을 만들지 않는다.

이번 계약은 **저장된 생산 요청 + 묶음별 명시적 검토·승인**이다. 전체 승인 한 번으로 다음
묶음을 자동 등록하지 않는다. 저장한 요청은 실행 권한이 아니며 에이전트 실행은 기존
`generation.enqueue` 승인 coordinator와 실행당/시간당/일일 한도를 그대로 통과한다.

## 보존과 실행

- 요청은 대상 ID·수량·원본 저작 내용 hash·seed 전체 순서·총예산을 고정한다. 최대 32개 요청과
  8 MiB의 canonical/checksum CAS 저장소를 기존 IndexedDB KV 안에 사용하며 기존 기록을 자동 삭제하지 않는다.
- 한 묶음을 새로 검토할 때 이전 묶음의 생성·저장·선택한 업로드·결과 연결 충족을 확인한다.
  Queue 등록이나 성공만으로 다음 묶음 또는 전체 완료를 허용하지 않는다.
- 결과 이미지 연결만으로도 Scene 문서 revision은 바뀐다. 새 묶음 검토에서는 원본 저작 hash가
  일치하는 경우에만 현재 revision으로 새 계획을 만든다. 기존 계획의 엄격한 revision 검증은 유지한다.
- 현재 폴더·공통 설정·출력 이름·R2 목적지·비용은 **각 묶음 검토 시** 계산하고 다시 승인한다.
  모든 미래 묶음의 합성 프롬프트·리소스·저장 위치가 최초 요청에 완전히 동결됐다는 계약은 아니다.
- 검토 이후 원본/폴더/가격/예약이 변하면 기존 Scene 검증에서 거절한다. 부모 예산 예약은 이 검증 뒤,
  실제 Queue commit 직전에 수행하므로 알려진 검토 충돌은 새 검토로 복구할 수 있다.
- 부모의 비용 예약은 CAS로 전체 상한을 검사한다. 불확실한 등록도 비용을 보존하며 자동 재시도하지 않는다.
- Queue snapshot의 `productionBinding`은 생산 ID·묶음 index·계획 ID/hash를 보존한다. 재시작 시
  부모가 기록한 run ID와 Queue의 job ID/ordinal/idempotency/계획 연결/semantic intent/파일명을 확인한 후에만
  누락된 등록 확인을 복구한다. 같은 개수의 다른 작업을 자신의 결과로 채택하지 않는다.

폴더 작업대에서 기존 선택을 생산 요청으로 저장하고, 다시 열어 다음 묶음을 검토한다.
현재 선택한 생산 요청의 집계는 수동 새로고침이며 각 실행 묶음의 실시간 감시는 기존 작업 기록을 사용한다.
이미 등록한 묶음의 일시정지·중단·복구도 기존 작업 기록을 사용한다. 전체 요청의 별도 제어·자동 진행은 남는다.

## MCP 안내

MCP 연결 시에는 짧은 `initialize.instructions`만 제공한다. 각 도구 설명은 해당 작업의
조건·다음 행동을 안내하고, 전체 절차는 `nai-blue://guides/agent-workflow/v1`을 명시적으로
읽을 때 제공한다. 리소스 목록은 제목·URI 등 metadata만 반환한다. 가이드는 앱이 꺼져 있어도
읽을 수 있고 inbox 명령을 생성하거나 실행하지 않는다.

| 명령 | 동작 |
| --- | --- |
| `production.create` | 명시한 Scene 대상 또는 저장된 preset 전체를 현재 버전으로 캡처하여 요청 저장. 실행하지 않음 |
| `production.list` | 저장된 요청의 ID·제목·버전·수량 목록 |
| `production.get` | 전체 결과 집계·비용 예약·묶음 상태·다음 행동 조회 |
| `production.plan_next` | 최신 요청 revision으로 다음 100장 이하 묶음 검토. `planId`/`planHash` 반환 |
| 기존 `generation.enqueue` | 반환된 계획을 기존 승인·예산 체계로 Queue 등록 |

새 조회는 새 requestId를 사용한다. 동일 requestId 재전달은 과거 영수증의 replay이며 새 조회가 아니다.
영수증 완료와 이미지 생성·저장·배포 완료는 서로 다르다. 알 수 없는 생성 결과를 새 ID로 재실행하지 않는다.

MCP의 instructions와 resources를 모델 컨텍스트에 넣는 주체는 호스트이다. 서버가 안내를 제공했다고
실제 Codex/Claude가 읽었다고 간주하지 않는다. 실제 호스트 연결 및 모델 사용성 검증은 별도이다.

- [MCP InitializeResult](https://modelcontextprotocol.io/specification/2025-11-25/schema#initializeresult)
- [MCP Resources](https://modelcontextprotocol.io/specification/2025-11-25/server/resources)

## 남은 계약

전체 요청 한 번의 동의에서 각 묶음 권한을 안전하게 파생하는 자동 진행, 전체 실행 입력의 동결,
전체 단위 일시정지·중단·피드백 이행, 영속 이벤트·정체 감시, 연속 번호 관리, 최종 URL 내보내기는 남는다.
2,400장 분할/기록 검증은 2,400장의 실제 Provider 생성·파일 저장·R2 업로드 완료를 의미하지 않는다.
실제 Codex 연결·Windows 설치본·NAI·R2·처음 사용자 검증과 에이전트 깨우기는 완료로 주장하지 않는다.

## Windows 연결 준비 중 발견한 누락 (2026-09-09)

첫 구현의 SDK 통합 시험은 Python/Windows 수신 경계를 대체했다. 실제 개발용 실행부를 점검하자
`production.*` 네 명령이 Python 서명 도구와 Rust 인증 수신부의 명령 목록에서 빠져 있었다.
두 목록을 기존 application catalog와 맞추고, 세 언어의 명령 목록 일치 검사 및 Python의 실제
서명·파일 공개 시험을 추가했다. Rust 검사는 네 명령을 허용하고 존재하지 않는 생산 승인·강제 실행
명령은 계속 거절한다. 생성 권한은 기존 `generation.enqueue`와 사람 승인에 남는다.

기존 native QA 스크립트는 초기 안내·가이드 검색/읽기 및 생산 요청 조회도 검사한다. 폐기된 이전
시험 클라이언트로 안내 읽기와 신규 제출 거절을 검증했고, 새 독립 시험 앱을 빌드했다.
새 앱의 클라이언트 등록 및 실제 생산 요청 검증은 별도 증거를 얻기 전까지 미완료이다.
[연결 준비 검증 기록](../releases/evidence/production-native-readiness-2026-09-09.json)을 참조한다.
