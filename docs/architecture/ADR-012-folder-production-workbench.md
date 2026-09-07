# ADR-012: 폴더 중심 에셋 작업대 — 1단계

- 날짜: 2026-09-07
- 상태: 구현. 브라우저 및 자동 검증 범위는 아래에 기록한다.
- 요구 자료: `docs/local/plans/NAI_Blue_Folder_to_CDN_Brief.md`
- 범위: 폴더 작업면, 서로 다른 프롬프트의 일괄 입력, 저장되는 생산 수량, 기존 실행 계획의 출력 경로 미리보기.

## 사용 흐름

기본 진입점은 `/folders`다. 폴더 선택 → 항목 추가 또는 검색 → 대상과 수량 선택 → 생성 검토 → 기존 Queue 승인 순서로 진행한다. Guided와 기존 Scene 편집기는 계속 접근할 수 있다.

- 생성 폴더 ID를 가진 항목을 Scene 프리셋 전체에서 모아 표시한다. `모든 폴더`, `폴더 미지정`, 선택 폴더, 명시적 하위 폴더 포함을 지원한다. 기존 수동 출력 항목을 기본 폴더에 임의로 연결하지 않는다.
- 검색 결과 전체 선택은 실제 항목 ID 집합을 저장한다. 실행 대상은 현재 검색 결과와 선택 ID의 교집합이다. 검색 밖의 선택은 실행에서 제외한다고 표시한다.
- 목록과 썸네일은 페이지당 60개만 렌더링한다. 폴더별 검색, 선택, 보기, 페이지 및 스크롤은 화면에 머무는 동안 복구한다. 영구 작업 상태와 UI 탐색 상태를 혼합하지 않는다.
- 표 붙여넣기는 탭으로 구분한 `이름 / 프롬프트 / 수량 / 파일명 템플릿(선택)`을 지원한다. 쉼표는 프롬프트 내용이다. 수량 생략은 1, 유효 범위는 1–999, 입력 항목은 최대 2,400개다. 다중 줄 인용 CSV는 지원하지 않는다. 한국어/영어 이름·프롬프트 헤더는 생략 가능하다.
- 기존 Scene 폴더의 기본 템플릿을 선택하면 생성 설정, 공통·네거티브·캐릭터 설정을 복사하고 행별 프롬프트를 추가한다. 결과 이미지나 원격 배포 연결은 복사하지 않는다.

## 데이터와 실행 소유권

새 폴더 저장소나 별도 dispatcher는 만들지 않는다. 생성 폴더 변경은 기존 설정 저장소 → 폴더 application 계획 → repository 경로를 이용한다. 표시 이름과 경로 이름의 기존 분리, 폴더 해석, 상속 규칙을 유지한다.

새 항목은 기존 표준 ScenePreset import 한 번으로 추가한다. `flushSceneAuthorityRuntime()`은 기존 runtime의 commit 대기를 노출하며, 성공 전 repository에서 추가한 ID 전부를 다시 확인한다. 저장 결과가 불확실하면 다시 import하지 않는다.

`SceneAuthoringRecord.productionCount?: number`는 반복 제작 시 사용할 수량이며 1–999 정수다. 같은 선택의 대량 수량 편집은 한 번의 store 갱신으로 반영한다. 이 값은 repository에 저장되고 재시작 후 유지된다. 기존 문서는 이 필드 없이 유효하다. `queueCount` 및 개별 대기열 파일명은 기존처럼 임시 상태이며 재시작 때 복구할 실행 목록으로 사용하지 않는다. 작업대의 추가 직후에는 pending Queue 항목을 만들지 않는다.

계획과 실행은 `prepareSceneQueueReview` / `enqueueReviewedSceneQueue`를 사용한다. 대상 preset ID, scene ID, 수량과 기존 명시적 파일명을 전달한다. 비용 검토, revision 재검증, 원자적 전체 출력 파일 예약, 불확실한 Provider 결과의 기존 복구 규칙을 그대로 사용한다. 승인된 실행은 기존 대기열에서 확인한다.

## 파일명, 로컬 위치, R2 키와 URL

파일명은 기존 Scene planner가 계산한다. 로컬 표시 경로는 실제 출력 할당기가 해석한 directory와 할당된 filename에서 얻는다. 이 경로는 일시적인 GUI 정보이며 durable reservation에 추가하지 않는다.

R2 키는 동일한 실행 계획의 `planR2Release` 결과다. profile/folder prefix를 화면에서 다시 붙이지 않는다. 충돌 정책이 `suffix`일 때의 실제 계획 키도 그대로 보여준다. 공개 URL 문자열은 계획에 연결된 공개 기본 주소와 확정 키를 사용해 경로 요소마다 인코딩한다. private 또는 유효한 공개 주소가 없는 연결에는 URL을 만들지 않는다.

실행 검토에서 25개씩 전체 파일명·최종 프롬프트·로컬 경로·R2 키·예정 URL을 확인하고 전체 계획 JSON을 복사할 수 있다. JSON은 `status: planned`, `publicAccessVerified: false`를 명시한다. 이것은 업로드 완료 목록이나 공개 접근 확인 결과가 아니다.

## 이번 단계의 경계

- 2,400개는 입력·화면 조작 검증 규모다. 현재 측정된 Windows Queue 한도인 실행당 100장 / 출력 파일 400개를 높이지 않는다. 한도를 넘는 선택에는 실행 전 안내를 표시한다. 미측정 브라우저 환경의 생성 실행도 열지 않는다.
- 수천 장의 자동 분할 제출, 예약 번호 이어쓰기, `{expression}` / `{index:03}` 새 변수, 새 프롬프트 상속 정책, 전체 생성 폴더 복제, 기존 공개 URL 교체·캐시 무효화, 업로드된 URL의 공개 접근 검사, 새 MCP 폴더 명령은 후속 단계다.
- 직접 경로와 상태가 보이는 GUI 및 계획 JSON을 제공하지만 실제 외부 에이전트가 새 폴더 명령으로 실행한 증거는 아니다.
- 실제 NovelAI 호출, 실제 R2 업로드·공개, 설치 앱 교체, crash/device 검증을 이번 자동 검증에 포함하지 않는다.

## 검증 방법

- `tests/presentation/workflow/folder-workbench.test.ts`: 서로 다른 프롬프트의 2,400개 입력, 복사 독립성, 폴더 범위, 한 번의 수량 갱신, pending Queue 불변.
- `tests/lib/scene-authority-runtime.test.ts`: 생산 수량 저장·재시작 복원과 임시 대기열 초기화.
- `tests/services/queue/scene-queue-r2-planning.test.ts`, `tests/composition-root/core-runtime-output-planning.test.ts`, `tests/domain/r2/public-url.test.ts`: 기존 계획의 실제 할당 경로·키와 공개 URL 문자열.
- `scripts/qa-folder-workbench.mjs`: 독립 브라우저에서 표 추가·재시작, 2,400개 검색/선택/수량 편집/페이지 이동, 목록·썸네일 및 390px/1440px 화면을 검증한다. Provider 호출이나 Queue 승인 없이 수행한다. 증거는 ignored `artifacts/folder-workbench/`에 쓴다.
- 기존 전체 Vitest, ESLint, TypeScript/Vite build와 architecture check를 함께 실행한다.

2026-09-07 검증 결과: 전체 Vitest **2,450 통과 / 4 건너뜀 / 실패 0**, ESLint 및 TypeScript/Vite build 통과, architecture check 위반 0. 브라우저 검사 **9/9 통과**, uncaught page error 0. 붙여넣기 3개 항목의 수량 `3/2/1` 및 일괄 편집 수량이 새로고침 후 유지됐다. 2,400개 자료에서 검색 결과 1,200개 선택 → 각 3장 → 3,600장 계획 수량 표시, 다른 검색에서 대상 0개, 폴더 복귀 시 선택 복원, 최대 60개 DOM 항목과 390px/1440px 화면의 조작을 확인했다. 이 수량 표시는 실제 3,600장 실행 증거가 아니다.
