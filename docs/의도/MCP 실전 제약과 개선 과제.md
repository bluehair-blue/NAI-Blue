# NAI Blue MCP 실전 제약과 개선 과제

2026-11-22 PPP 포토부스 나하린(NHR) V5 레퍼런스·포즈 시안 생성 실전 세션에서 실제로 겪은 NAI Blue MCP의 제약 사항과 개선 과제를 정리한다.

---

## 1. 외부에서 수정한 로컬 이미지를 `imageSource(img2img)`로 연결할 수 없음

- **겪은 상황**: V5로 뽑은 2컷 포즈 시안을 사용자가 외부 인페인팅으로 보정(손가락 수정·오른쪽 여백 확장, `640×768`)해 확정했으나, 이를 V4.5 Full `img2img`의 입력으로 넘길 MCP 경로가 없었다.
- **원인**: `scene.patch_many`의 `imageSource`는 NAI Blue 앱이 발급한 `artifactId` + `contentChecksum`만 받으며, 로컬 이미지 파일을 아티팩트로 등록·임포트하는 MCP 도구가 없다.
- **개선 방향**: 로컬 PNG/WebP를 NAI Blue 아티팩트로 등록해 `artifactId`와 `contentChecksum`을 반환하는 도구(예: `artifact.import_local` 등) 또는 Scene `imageSource`의 로컬 파일 등록 흐름을 추가한다.

## 2. `Precise Reference` / `Vibe Transfer` 미지원 (`img2img`만 지원)

- **겪은 상황**: 기존 PPP 에셋(`char_img_metadata/NHR/1~10.json`)은 `director_reference`(Character Reference)로 외형 일관성을 유지했으나, MCP의 `imageSource.mode`는 `"img2img"`만 허용된다.
- **영향**: V5 레퍼런스의 포즈·구도를 가져오면서 V4.5 정식 화풍과 캐릭터 디테일을 동시에 지키는 실험 범위가 `img2img` 강도/노이즈 조절만으로 제한된다.
- **개선 방향**: 앱이 지원하는 Character/Precise Reference(또는 Vibe Transfer) 설정을 `scene.patch_many` 스키마에 정식 노출한다.

## 3. `generation.run`·`scene.patch_many`가 `submitted-to-inbox`로 끊겨 왕복이 늘어남

- **겪은 상황**: 앱이 실행 중이고 항상 승인(`editingApproval`, `generationApproval`)이 켜진 상태였는데도, `scene.patch_many`와 `generation.run` 호출이 매번 `submitted-to-inbox`로 즉시 반환됐다.
  - 확인된 요청 예: `nhr-v5-ref-patch-1`, `nhr-v5-ref-run-1-plan`, `nhr-v5-draft-run-1-plan`, `nhr-v5-draft2-run-1-plan` 등.
  - 특히 `generation.run`은 "Plan, enqueue and wait in one call" 설명과 달리 `stage: "plan"`에서 끊겨, 에이전트가 매번 `sleep → plan receipt 조회 → generation.enqueue → sleep → enq receipt 조회 → generation.get_run(waitSeconds: 45)`의 6~10회 수동 왕복을 반복해야 했다.
- **영향**: MCP 토큰 효율 재설계(ADR-016)로 줄이려던 왕복 수와 대기 턴이 그대로 늘어났다.
- **개선 방향**: `scene.patch_many`의 내부 대기 시간을 조금 늘리고, `generation.run`은 주어진 `waitSeconds` 예산 안에서 `plan` → `enqueue` → `run` 단계의 inbox 응답까지 이어서 기다리도록 개선한다.

## 4. 생성 결과의 실제 저장 경로 미반환 및 0번 job `fileName: null`

- **겪은 상황**:
  1. 실제 이미지는 `E:\AI_Project_Library\개인 자료\Windows 폴더\사진\NAI_Blue_Scene\`에 저장됐지만, MCP 응답(`generation.plan`, `generation.get_run`, `artifact.get_images`)에는 출력 폴더 경로가 없어 에이전트가 디스크를 재귀 탐색해야 했다.
  2. `nhr-v5-draft2-run-1-plan`과 `nhr-v5-draft3-run-gpt-1`에서 0번 job(`ordinal: 0`)의 `destination.fileName`이 `null`로 내려왔다(실제 디스크에는 `..._0.png`로 정상 저장됨).
- **개선 방향**:
  - 모든 job의 `destination.fileName`이 `null` 없이 실제 저장 파일명을 반환하도록 수정한다.
  - `generation.get_run` 또는 `workspace.get_snapshot(include: ["folders"])`에서 기본 출력 폴더의 실제 저장 경로(또는 파일별 저장 경로)를 확인할 수 있게 한다.

## 5. `artifact.get_images` 프리뷰 해상도(`320×480`)가 낮아 세부 검수에 부족함

- **겪은 상황**: `1024×1536` 또는 `512×768` 생성 결과를 `artifact.get_images`로 확인하면 `320×480` 축소본만 내려와, 반쯤 감긴 눈의 시선 방향·손가락 이상·이어폰 줄·손목시계 개수 같은 세부 사항을 정확히 판별하기 어려웠다. 결국 로컬 저장 폴더를 찾아 원본 PNG를 직접 열어야 했다.
- **개선 방향**: `artifact.get_images`에 선택적 프리뷰 크기 옵션(예: `maxSide` 또는 `detail: "full"` 시 긴 변 768~1024px)을 제공한다.

## 6. 임시 테스트 프리셋·Scene 삭제/정리 도구 부재

- **겪은 상황**: 포즈 시안 반복 테스트 과정에서 `nhr-photobooth-v5-ref-20261122`, `draft`~`draft5` 등 일회성 프리셋이 계속 쌓였으나, MCP로 삭제하거나 정리할 수 없어 사용자가 앱 UI에서 직접 지워야 했다.
- **개선 방향**: 테스트 프리셋/Scene을 삭제하거나 보관함으로 숨길 수 있는 정리 도구를 검토한다.

---

## 우선순위 제안 (PPP 포토부스 작업 기준)

1. **1순위**: `generation.run` / `scene.patch_many`의 `submitted-to-inbox` 조기 반환 해소 (체감 속도·토큰 효율 직결)
2. **1순위**: 외부 보정 로컬 이미지의 `imageSource` 등록/임포트 지원 (인페인팅 후 V4.5 Img2Img 연계 필수)
3. **2순위**: 0번 job `fileName: null` 수정 + 실제 출력 경로 반환 + `artifact.get_images` 프리뷰 해상도 옵션
4. **3순위**: `Precise Reference` 지원 및 테스트 프리셋 정리 도구

---

## 참고: NAI Blue 밖에서 발생한 이슈 (구분 기록)

- 동일 세션 중 에이전트 런타임(Copilot/Gemini)의 `mcp_call` 도구 호출 직렬화에서 `changes: [...]`, `targets: [...]` 배열 내부 객체가 `[null]`로 전달되는 오류가 발생해 GPT 워커로 우회 실행했다. 이는 NAI Blue MCP 서버 측 버그가 아닌 호출 클라이언트 측 이슈다.
  - 2026-11-23 원인과 처리: Copilot 할당량이 떨어져 Vertex로 넘어간 Gemini 4 Neon 호출에서만 났다(9건 모두, Copilot 경유 19건은 정상). ADE의 `mcp_call`이 입력을 모양이 선언되지 않은 객체로 받았기 때문이고, 그 대화를 Vertex에 다시 보내 재현했다. ADE에서 도구를 `mcp_tool`로 바꾸고 입력을 `argumentsJson`(JSON 객체 문자열) 하나로 받게 고쳤다(`projects/CodexNext/ADE`의 INDEX '남은 일과 주의'). Pi 콘솔과 워커를 다시 켜야 적용된다.
