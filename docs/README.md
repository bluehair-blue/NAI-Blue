# NAI Blue 디렉터리 인덱스

## 현재 사용본과 최신 결과

- 정식 소스: `E:/AI_Project_Library/projects/nais/NAI-Blue`.
- MCP 토큰 효율 재설계 (2026-11-22): [ADR-016](./architecture/ADR-016-mcp-token-efficiency.md). 가이드 잠금을 없애고 도구 목록·응답을 줄이고 생성 왕복을 묶었다. 상태: 검증중(자동 검사와 설치본 읽기 확인 완료, 실제 에이전트의 생성 한 바퀴는 미측정). 유입은 [측정 스크립트](../scripts/measure-agent-mcp-inflow.mjs)로 잰다. 기존 MCP 연결은 재연결해야 적용된다. 의도는 [의도 인덱스](./의도/INDEX.md).
- MCP 호출 마감·재개·실행 이력 정비 (2026-11-22): [ADR-017](./architecture/ADR-017-mcp-call-deadline-and-execution-history.md). 상태: 사용본(2026-11-22 설치, 공개 MCP 검증 완료). 생성 한 번의 호출이 6~10회에서 2회로 줄었고 조기 반환이 없어졌다. 이 빌드의 앱 처리 시간(편집 7.9초, 계획 9초, 등록 25초)은 목표에 못 미쳤고 지금 설치본에서 이뤘다(아래 ADR-018 줄). 실측과 남은 단계는 [원인과 구현 계획](./의도/MCP%20실전%20제약%20원인과%20구현%20계획.md).
- 요청별 구간 시간, 프리뷰 확대, 로컬 이미지 등록, 저장 위치 (2026-11-22): [ADR-018](./architecture/ADR-018-agent-timings-previews-import-location.md). 상태: 사용본(2026-11-22 설치, 공개 MCP로 프리뷰·등록·저장 위치·구간 시간 확인). 2장 생성이 `generation.run` 한 번으로 끝난다. 구간 시간으로 찾은 두 원인의 수정(무작위 시드 계획의 조회 생략, 이력 보관 50건)까지 설치본에 있다. 지금 설치본의 처리 시간은 편집 0.8초, 2장 계획 0.2초, 2장 등록 1.3초다(목표 3초·3초·8초, 프리셋 328개·Scene 3,262개).
- Scene의 Precise Reference 결합과 프리셋 보관 (2026-11-22): [ADR-019](./architecture/ADR-019-scene-precise-references-and-preset-archive.md). 상태: 사용본(2026-11-22 설치, 공개 MCP로 레퍼런스 계획과 보관·복원 확인). `scene.patch_many`의 `preciseReferences`와 `presetArchived`, 프리셋 관리 창의 보관함. 설치본의 보관함 화면과 레퍼런스를 묶은 실제 생성은 미확인이다. 기존 MCP 연결은 재연결해야 한다.
- V5 Precise Reference (2026-11-25): [ADR-020](./architecture/ADR-020-v5-precise-reference.md). 상태: 사용본(2026-11-25 설치, 공개 MCP로 V5 레퍼런스 계획 확인). V5 Full·Curated에서 레퍼런스 설정 창과 `scene.patch_many`의 `preciseReferences`가 Outfit 타입, 같은 의상 우선, 강도 0~5를 받는다. NovelAI에 실제로 보낸 생성과 설치본의 레퍼런스 설정 창은 미확인이다. 기존 MCP 연결은 재연결해야 한다.
- 화면 감사 개선 (2026-11-26): [의도](./의도/화면%20감사%20개선.md), [구현 계획](./의도/화면%20감사%20개선%20구현%20계획.md). 상태: 사용본(2026-11-26 설치, 설치본 해시와 실행 경로 확인). 첫 설치본(`5bc990f3…`, 소스 `f25b88d`)을 검수해 완료 기준 2·3·5·7·8의 미달과 탐침으로 찾은 결함을 고친 보완 빌드(소스 `3e5198e`, 계획의 '8단계 검수 보완')가 지금 설치본이다. 릴리즈 전에 영어·일본어에서 상단 메뉴가 도구 버튼 위로 넘치던 것(GitHub Actions의 `test:responsive-layout`이 `main`에서 실패하던 원인)을 고쳤고(`7dda372`), 이 수정은 지금 설치본에는 없고 1.5.0에 들어간다. 그 소스에서 `lint`·`tsc`·`vitest`(3,057건)·`test:responsive-layout`(en-US와 기본 언어)·`qa:category-design`·`qa:readable-choices`·`qa:keyboard-scope`(17/17)·`qa:audit-regressions`(14/14)·`test:architecture`·`test:dependencies`·`test:android-port`가 통과했다. 완료 기준 9의 설치본 동선은 사용자가 설치한 뒤 릴리즈를 요청해 닫았다. 미확인: 공개 MCP 실응답(기존 연결은 재연결해야 한다).
- 실제 실행 경로: `E:/AI_Project_Library/projects/nais/NAI Blue/NAI-Blue.exe`. 등록된 Windows 설치 하나만 사용한다.
- MCP 자동 실행 수정 (2026-11-06 12:41 KST): [정식 연결 프로그램](../scripts/run-agent-mcp-stdio.mjs)과 [명령 분류](../src/adapters/agent/mcp/mcp-stdio-server.ts)를 새 연결에서 검증했다. 목록·상태·읽기는 닫힌 앱을 그대로 두고, 계획·변경 요청만 앱을 시작한다. 기존 연결은 재연결 시 적용된다.
- [실제 설치본 검증](../scripts/verify-agent-mcp-runtime.mjs): 앱을 닫고 등록된 연결 인수에 `--verify-launch`를 추가해 재현한다. 목록·기능·상태 조회 후에도 프로세스가 없었고, 폴더 변경 미리보기 요청에서만 시작해 완료 응답을 받았다. 실행 전후 설치본 SHA-256과 워크스페이스 응답 다이제스트가 일치했다. 회귀 테스트 38개 통과. 변경 커밋은 `git log -- scripts/agent-runtime-guard.mjs`에서 확인한다.
- 대표 결과: [저장 이미지 폴더 탐색](./releases/저장%20이미지%20폴더%20탐색.md). 상태: 사용본 설치·공개 MCP 검증 완료, 빌드 출력 부재 확인. 생성: 2026-11-06 12:10 KST, 수정: 12:28 KST.
- 사용본 SHA-256: `50317f31a0de77ef36aa40d10a9cbb7aa6158ebc4f53e50d4c5f08edb288cefd` (1.4.0 로컬 빌드, 2026-11-26 설치. 소스는 커밋 `a60e45c`. 어댑터는 이 체크아웃의 최신 커밋을 쓴다).
- 이전 결과: [시작 응답성 개선 기록](./releases/시작%20응답성.md), 소스 변경 이력은 Git에 보존한다.
- [측정 근거](./releases/evidence/시작%20응답성%20측정.json): CPU·메모리·타이머 지연, 테스트와 실제 MCP 검증. 생성·수정 시각은 파일의 `recordedAt` 참조.
- 변경 이력: `git log --oneline -- "docs/releases/시작 응답성.md"`; 커밋 ID는 완료 보고와 Git에서 확인한다.
- 기존 작업 보존: `refs/archive/tasks/startup-responsiveness/initial-worktree` (`9df17902d65bccb7138bf3db856d05d80b527bcd`). 작업 전 `main`의 `37d9a9a3548023865f7a7eb3ebce27c27747ee3c`와 미커밋 소스·테스트를 별도 보존했고 원래 `main`은 이동하지 않았다.
- 시작 응답성 기록 확인 시각: 2026-11-04 18:18:40 KST. 이전 문서의 최초 생성 시각은 미확인.
- 후속 결과: 초기 화면 준비 25.7초 → 5.5초. 전체 테스트 2,853개 통과. [최신 검증·캐시 삭제 명령](./releases/시작%20응답성.md). 기존 Codex MCP 연결은 이번 소스 변경 후 재연결이 필요하다.

앱 실행 파일·빌드 폴더·자동 백업 파일의 이름은 도구 및 기존 복원 규약이 강제하므로 유지한다. `src-tauri/target`과 `dist`는 자동 삭제가 정책에 차단된 뒤 2026-11-06 12:26 KST에 두 경로 모두 없는 것을 확인했다. `.triadflow/`는 기존 협업 런타임 세션이며 대표 검증 기록은 위 문서·측정 파일에 모은다. 사용자 데이터와 복구 이력은 보존한다.

이 문서는 저장소 검색과 문서 탐색의 시작점이다. 도구가 루트 경로를 계약으로 사용하는 설정 파일은 옮기지 않고, 소스와 문서는 아래 책임에 따라 찾는다.

## 실행 코드와 개발 도구

| 경로 | 용도 |
|---|---|
| `src/` | 웹 UI, 도메인, 애플리케이션, 어댑터와 상태 관리 |
| `src-tauri/` | Rust/Tauri 데스크톱·Android 런타임 |
| `cloudflare/` | Cloudflare transfer worker |
| `public/` | Vite가 그대로 배포하는 정적 자산 |
| `tests/` | 단위·계약·특성화·마이그레이션 테스트 |
| `scripts/` | 검증, QA, 빌드와 릴리스 자동화 |
| `.github/` | CI와 릴리스 workflow |

## 문서

| 경로 | 용도와 보존 정책 |
|---|---|
| `architecture/` | 현재 구조, ADR, import graph와 [영속화 지도](./architecture/persistence-map.md) |
| `research/` | 제품 동작을 검증하는 재현 가능한 연구 기록 |
| `releases/` | 현재 릴리스 인계와 배포 기준 문서 |
| `local/plans/` | 진행 중인 로컬 계획 문서 |
| `local/handoffs/` | 세션·릴리스 인계 기록 |
| `local/reviews/` | UI/UX 및 코드 리뷰 원문과 정리본 |
| `_trash/` | 완료·대체·오래된 문서의 삭제 전 보관 위치 |

`docs/local/`과 `docs/_trash/`는 Git에 포함하지 않는다. 현재 동작의 기준은 소스 코드와 추적된 문서이며, 로컬 자료는 배경 정보로만 사용한다.

## 루트에 유지하는 파일

- `README*.md`, `LICENSE`, `DESIGN.md`, `RELEASING.md`: 저장소 진입점과 제품·릴리스 계약
- `package*.json`, `tsconfig*.json`, `vite.config.ts`, `vitest.config.ts`, `eslint.config.js`, `tailwind.config.js`: 각 도구의 표준 탐색 위치
- `android-release-policy.json`, `.dependency-cruiser*`: 테스트와 CI가 직접 읽는 정책·설정 및 명시적 UI 전환 기준선

## 생성물과 로컬 상태

`node_modules/`, `dist/`, `artifacts/`, `release-artifacts/`, `.wrangler/`, `.idea/`, `.remember/`, `src-tauri/target/`, `src-tauri/gen/android/`은 설치·빌드·QA·도구가 관리한다. 경로를 임의로 옮기지 말고, 정리가 필요하면 관련 스크립트와 실행 중인 프로세스를 먼저 확인한다.

## 분류 규칙

1. 장기 기준 문서는 `architecture/` 또는 해당 도메인 문서 폴더에 둔다.
2. 진행 중인 계획·인계·리뷰는 `local/` 아래에 둔다.
3. 완료되거나 대체된 로컬 문서는 `_trash/`로 옮긴다.
4. 새 루트 파일은 도구가 루트 위치를 요구할 때만 추가한다.
