# ADR-018: 요청별 구간 시간, 프리뷰 확대, 로컬 이미지 등록, 저장 위치

- 날짜: 2026-11-22
- 상태: 구현함. 자동 검사까지 했다. 설치본에 올리지 않았다
- 기반: ADR-016, ADR-017. 원인과 계획은 [MCP 실전 제약 원인과 구현 계획](../의도/MCP%20실전%20제약%20원인과%20구현%20계획.md)
- 범위: 앱(디스패처·조정자·계획 준비·Scene 저장소의 계측, 프리뷰, 등록 핸들러, `generation.get_run`), 어댑터(`src/adapters/agent/mcp/`, `scripts/run-agent-mcp-stdio.mjs`), 명령 이름 목록(TypeScript, Python, Rust)

## 문제

- 빌드 A를 올린 뒤에도 편집 7.9초, 계획 9초, 등록 25초가 걸렸고 어디서 걸리는지 모른다. 구간 시간을 User Timing으로 남겼지만 릴리스 빌드에는 개발자 도구가 없다. 추정으로 고친 원인(성공 job 조회)은 실측과 맞지 않았다
- 프리뷰가 긴 변 480px PNG로 고정이라 눈, 손가락, 소품을 판별하지 못했다
- 사람이 앱 밖에서 고친 이미지를 Image2Image 입력으로 쓸 길이 없었다
- 결과가 어느 폴더에 저장됐는지 응답에 없어 에이전트가 디스크를 뒤졌다

## 결정

### 1. 요청마다 구간 시간을 파일로 남긴다

수신함 요청 하나를 처리할 때마다 `agent-commands/timings/<requestId>.json`을 쓴다. 내용은 고정된 구간 이름, 시작 오프셋, 걸린 시간, 숫자로 된 부가 정보(건수와 크기)뿐이다. 글, ID, 경로, 프롬프트는 들어가지 않는다.

```json
{ "schemaVersion": 1, "requestId": "…", "command": "scene.patch_many", "outcome": "projected",
  "totalMs": 7890.1, "spans": [{ "name": "agent-dispatch:handler", "offsetMs": 12.3, "ms": 7801.2, "detail": { "records": 651 } }] }
```

- 구간은 디스패처, 계획 준비의 모든 await, 편집의 대상 확인·이력 쓰기·Scene 저장·화면 반영, 등록의 적격성·예약·Queue 등록, 실행 이력의 읽기·검증·쓰기에 둔다. 실행 이력 검증 구간은 레코드 수와 정리된 건수를 싣는다. 이력이 실제로 정리됐는지를 이것으로 본다
- 쓰기는 결과를 내보낸 뒤에 시작하고 기다리지 않는다. 실패해도 요청에 영향이 없다
- 파일은 최근 500개만 남긴다. 정리는 앱을 켠 뒤 첫 쓰기와 그 뒤 100번째 쓰기마다 요청 경로 밖에서 한다
- `scripts/measure-agent-command-latency.mjs`가 구간별 중앙값과 핸들러 시간 중 구간이 덮는 비율을 낸다
- 응용 계층(`src/application`)은 `@/lib`를 가져올 수 없어, 수신함 런타임이 기록기 하나를 설치하고 조정자와 편집 서비스가 그것을 쓴다

### 2. 프리뷰는 JPEG이고 크기와 영역을 고를 수 있다

`artifact.get_image` 입력에 `maxSide`(64~1536, 기본 480)와 `region`(원본 기준 0~1 좌표의 `x, y, width, height`)을 더했다. 영역(없으면 전체)의 긴 변을 `maxSide`에 맞추고 확대하지 않는다. 모든 프리뷰는 흰 바탕의 JPEG다. 1MiB 상한은 그대로이고, 넘으면 품질을 0.9에서 0.6까지 낮춰 본 뒤 거절한다. 영수증의 `resource`는 실제 `mimeType`, 프리뷰 크기, 원본 크기(`sourceWidth`, `sourceHeight`)를 싣는다.

MCP의 `artifact.get_images`는 `{ artifactIds(1~4), maxSide?, region? }`이고 두 인수는 나열한 이미지 전부에 적용된다. 프리뷰 바이트 합이 2.5MB에 닿으면 남은 이미지는 읽지 않고 다음 호출로 미룬다.

### 3. `artifact.import`: 고정된 폴더의 파일을 이름으로 등록한다

입력은 `{ fileName }`뿐이다. 사진 폴더 바로 아래의 `NAI_Blue_Import` 한 곳에서만 읽는다. 경로 입력도, 수신함을 지나는 이미지 바이트도 없다.

- 파일명은 구분자·`..`·콜론·장치 이름이 없는 맨 이름이고 소문자 `.png`나 `.webp`로 끝난다
- 순서: 편집 동의 확인(없으면 아무것도 읽지 않는다) → 폴더가 없으면 만든다 → 파일 존재 → 디스크의 크기 25MB 이하 → PNG·WebP 서명 → 디코드와 화소 수 상한 → SHA-256
- 아티팩트 ID는 체크섬에서 만든다(`artifact:import-<앞 32자리>`). 같은 내용을 다시 등록하면 같은 아티팩트가 돌아오고, 기존 레코드를 덮어쓰지 않는다. 출처 job과 Scene이 없는 레코드다
- 결과는 `{ status, artifactId, contentChecksum, width, height, format, byteLength, fileName }`이고 거절은 `IMPORT_FILE_NOT_FOUND`, `IMPORT_NOT_AN_IMAGE`, `IMPORT_TOO_LARGE`, `IMPORT_ORIGINAL_MISSING`, `IMPORT_UNAVAILABLE`, `AGENT_EDITING_CONSENT_REQUIRED` 중 하나다. 경로는 싣지 않는다
- 레코드는 처음 등록한 파일명을 가리키고 바꾸지 않는다. 같은 내용을 다른 이름으로 다시 넣었는데 처음 파일이 없으면 `IMPORT_ORIGINAL_MISSING`과 처음 파일명을 돌려준다. 그 이름으로 되돌리면 다시 읽힌다
- 쓰기 직전에 편집 동의를 한 번 더 확인한다
- 돌려받은 `artifactId`와 `contentChecksum`을 `scene.patch_many`의 `imageSource`에 그대로 쓴다. 기존 검증과 읽기 경로는 바꾸지 않았다
- 효과는 `plan`으로 분류했다. Scene, 프롬프트, Queue, 파일을 바꾸지 않고 사람이 둔 파일에 색인만 붙이기 때문이다. 실행 조정자의 승인 흐름에 넣지 않는 대신 핸들러가 이 클라이언트의 편집 동의(항상 승인)를 요구한다. 동의가 꺼져 있으면 건별 승인 없이 거절된다

명령 이름은 TypeScript(`AGENT_COMMAND_NAMES`), Python(`submit-agent-command.py`), Rust(`agent_commands.rs`) 세 곳에 더했다.

### 4. 저장 위치는 휴대 경로로 돌려준다

`generation.get_run`의 저장된 job 행에 `directory: { root, segments }`를 싣는다. `root`는 표준 폴더 종류(`pictures` 등)이거나 사람이 고른 폴더를 뜻하는 `bookmark`다. 세그먼트는 배열로 둔다. 한 문자열로 합치면 한글 이름에서 경로 검사에 걸린다. 절대 경로, 북마크 ID, 표시 경로는 싣지 않는다. 공개 값 검사기는 `directory.segments`의 맨 세그먼트(200자 이하, 구분자·콜론·`..`·`+`·`=` 없음)에만 base64·hex 추정을 건너뛴다. `PB_ALL_KHR_20261019_cut1` 같은 폴더 이름이 base64로 오인되어 위치가 통째로 빠졌기 때문이다. 값은 저장된 아티팩트 레코드에서 온다(저장된 job마다 읽기 한 번). 출력이 하위 폴더에 놓여 예약 경로로 파일명을 못 내던 경우도 레코드의 파일명으로 채운다.

어댑터 요약은 모든 결과가 한 폴더면 `outputDirectory`로 한 번만 싣는다.

### 5. 안내

같은 Scene을 반복할 때는 `filenameTemplate`에 `{seed}`나 `{timestamp}`를 두라는 것, `root: "pictures"`가 사용자의 사진 폴더라는 것, 등록 순서와 거절 코드별 조치를 가이드와 `hint`에 넣었다. 도구 목록의 고정 유입은 instructions와 합쳐 9,000자 안이다(도구 12개).

## 어댑터가 예전 앱과 통신하는 동안

어댑터는 소스에서 바로 읽히고 앱은 설치본이라 어댑터가 먼저 바뀐다.

- 프리뷰: 새 인수는 호출자가 쓸 때만 보낸다. 예전 앱의 PNG도 받는다(영수증의 `mimeType`으로 파일과 서명을 고른다). 예전 앱에 새 인수를 보내면 앱이 입력을 거절한다
- 등록: 예전 앱은 모르는 명령 이름을 수신 단계에서 거절한다
- 기능 목록: `artifact.import` 하나만 빠진 목록을 받아들이고 그 명령을 쓸 수 없다고 표시한다. 그 밖의 차이는 지금처럼 거절한다. 예전 `artifact.get_image` 입력 스키마의 해시도 맞는 것으로 본다
- 저장 위치: 행에 `directory`가 없으면 요약에서 뺀다

## 검토 비서(Gemini 4 Neon)의 지적과 처리

- 반영: 계획 문서의 배포 순서 서술(어댑터가 먼저 바뀐다), 가져오기 파일명의 장치 이름 변형(`con .png`, `com¹.png`), 처음 파일이 사라진 뒤의 재등록(`IMPORT_ORIGINAL_MISSING`), 쓰기 직전의 동의 재확인, `artifact.get_images`의 응답 바이트 합 상한, 예전 앱이 `maxSide`·`region`을 거절할 때의 안내, 폴더 이름 세그먼트의 base64 오인(실제 검사기로 재현했다), `region` 경계 검증
- 반영하지 않음: 가져오기 폴더 안의 심볼릭 링크 거부(링크를 만들 수 있는 주체는 그 파일을 직접 복사할 수도 있다), `artifact.import`를 실행 조정자에 넣기(만료는 디스패처가 모든 명령에 확인하고 기록은 영수증에 남는다. 건별 승인이 없는 것은 한계에 적었다), 도구 스키마에 `maxSide`·`region`의 범위 싣기(설명에 있고 목록이 9,000자 한도에 닿아 있다), 계측 구간의 요청별 격리와 첫 쓰기의 정리(아래 한계), 확장자와 실제 형식의 일치 강제와 디코드 전 화소 수 확인(읽기는 레코드의 형식을 따르고, 사용자가 직접 둔 25MB 이하 파일이다)

## 바꾸지 않은 것

- 요청 서명, 수신함 파일 흐름, 영수증 형식, 승인·예산·revision 판정
- 절대 경로와 이미지 바이트는 여전히 입력과 결과에 실리지 않는다. 공개 값 검사 규칙에서 달라진 것은 4절의 폴더 세그먼트 예외 하나다
- 실행 조정자의 승인 대상 명령 목록

## 검증

- 전체 테스트 2,940개 통과(4개 건너뜀), 런타임 가드 테스트 7개, Rust `agent_commands` 테스트 4개, 타입 검사, 린트, 구조 검사, 의존성 검사 통과. Python 발행기는 `agent-mcp-submission-tool.test.ts`가 실제로 실행해 새 명령 이름, 소수 `region`, 긴 파일명과 한글 파일명을 서명·발행했다
- 새 어댑터를 실행 중인 설치본(빌드 A, 해시 `bdd711b0…`)에 붙여 읽기 호출로 확인했다. 도구 12개가 나오고, 기능 목록은 `artifact.get_image`를 쓸 수 있음으로, `artifact.import`를 `app-build-without-command`로 표시했다. 인수 없는 `artifact.get_images`는 PNG 320×480을 돌려줬고, `maxSide`를 주면 앱이 거절하고 예전 빌드일 수 있다는 안내가 붙었다. `generation.get_run` 요약에는 파일명이 있고 `outputDirectory`는 없었다
- 하지 않은 것: 설치본 교체, 실제 WebView에서의 JPEG 프리뷰와 구간 시간 파일 쓰기, 실제 사진 폴더에서의 등록, 등록한 이미지로의 Image2Image 생성

## 알려진 한계

- `artifact.import`는 건별 승인 흐름이 없다. 편집 동의(항상 승인)가 꺼져 있으면 거절된다
- 가져온 아티팩트는 가져오기 폴더의 파일을 가리킨다. 그 파일을 지우거나 이름을 바꾸면 Image2Image 입력으로 읽히지 않는다
- 구간 시간은 프로세스 전체의 버퍼에서 요청 구간에 시작한 것을 모은다. 요청 처리 중에 화면에서 일어난 Scene 저장 같은 구간이 섞일 수 있다
- 저장 위치는 저장된 job마다 아티팩트 읽기 한 번을 더한다
- 실제 WebView의 JPEG 크기와 품질, 실제 사진 폴더에서의 등록은 설치본에 올린 뒤에 확인한다
