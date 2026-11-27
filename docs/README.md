# NAI Blue 문서 인덱스

저장소와 문서를 찾는 시작점이다. 제품 소개는 루트 [README](../README.ko.md)에, 변경 이력과 검증 근거는 Git 커밋 메시지에 있다.

## 지금 상태

- 사용본: 등록된 Windows 설치 `E:/AI_Project_Library/projects/nais/NAI Blue/NAI-Blue.exe` 하나만 쓴다. 1.4.0 로컬 빌드(소스 `a60e45c`), 2026-11-26 설치, SHA-256 `50317f31a0de77ef36aa40d10a9cbb7aa6158ebc4f53e50d4c5f08edb288cefd`. `scripts/inspect-agent-runtime.ps1`로 다시 확인한다.
- 릴리즈: 1.5.0(태그 `v1.5.0`)은 2026-11-27 기준 데스크톱 자산까지 올라간 Draft이고 Android 서명 승인 뒤 게시된다. 절차는 [RELEASING.md](../RELEASING.md).
- MCP 어댑터는 이 체크아웃의 최신 커밋을 쓴다. 소스가 바뀌면 기존 MCP 연결을 다시 연결한다.

| 주제 | 문서 | 상태 |
|---|---|---|
| MCP 토큰 효율 재설계 | [ADR-016](./architecture/ADR-016-mcp-token-efficiency.md) | 검증중. 실제 에이전트의 생성 한 바퀴는 미측정 |
| MCP 호출 마감·재개·실행 이력 | [ADR-017](./architecture/ADR-017-mcp-call-deadline-and-execution-history.md) | 사용본 |
| 요청별 구간 시간, 프리뷰, 로컬 이미지 등록 | [ADR-018](./architecture/ADR-018-agent-timings-previews-import-location.md) | 사용본 |
| Scene의 Precise Reference와 프리셋 보관 | [ADR-019](./architecture/ADR-019-scene-precise-references-and-preset-archive.md) | 사용본. 보관함 화면과 레퍼런스를 묶은 실제 생성은 미확인 |
| V5 Precise Reference | [ADR-020](./architecture/ADR-020-v5-precise-reference.md) | 사용본. NovelAI에 실제로 보낸 생성과 설정 창은 미확인 |
| 화면 감사 개선 | [의도](./의도/화면%20감사%20개선.md), [구현 계획](./의도/화면%20감사%20개선%20구현%20계획.md) | 사용본. 영어·일본어 헤더 보완은 1.5.0부터 |
| 의존성 일괄 갱신(Rust 1.93, Tauri 2.12) | 커밋 `f369055`~`18ef534` | 검증중. 설치본 동작과 macOS 빌드는 미확인, 1.5.0에는 없음 |

진행 중인 큰 작업은 [의도 인덱스](./의도/INDEX.md)에 있다.

## 문서

| 경로 | 내용 |
|---|---|
| `architecture/` | 결정 기록 ADR-001~020, [영속화 지도](./architecture/persistence-map.md), import graph |
| `research/` | V5 프롬프트와 작가 태그 연구, 프롬프트 메타데이터 빈도 정렬 |
| `의도/` | 큰 작업의 의도와 구현 계획 |
| [에이전트 자동화 안내](./에이전트%20자동화%20안내.md) | MCP 사용 규칙과 Windows 실행 환경 |
| `images/` | README 스크린샷. `npm run docs:screenshots`로 다시 만든다 |
| `releases/evidence/queue-edge-benchmark.json` | 대기열 벤치마크 기준선. 테스트와 벤치마크 스크립트가 이 경로를 참조한다 |
| `local/`, `_trash/` | Git에 넣지 않는 로컬 자료. 현재 동작의 기준은 소스 코드와 추적된 문서다 |

2026-11-27에 9월의 phase 검증 기록, 1.0.0 인수인계 문서, 지난 릴리즈 기록과 성능 보고서를 저장소에서 내렸다. ADR의 `git show fd72fc3:…` 표기가 그 파일을 Git 이력에서 꺼내는 명령이다. `refs/archive/tasks/startup-responsiveness/initial-worktree`(`9df1790`)는 시작 응답성 작업 전의 미커밋 소스를 보존한 ref다.

## 코드

| 경로 | 용도 |
|---|---|
| `src/` | 웹 UI, 도메인, 애플리케이션, 어댑터와 상태 관리 |
| `src-tauri/` | Rust/Tauri 데스크톱·Android 런타임 |
| `cloudflare/` | Cloudflare transfer worker |
| `public/` | Vite가 그대로 배포하는 정적 자산 |
| `tests/` | 단위·계약·특성화·마이그레이션 테스트 |
| `scripts/` | 검증, QA, 빌드와 릴리즈 자동화 |
| `.github/` | CI와 릴리즈 workflow |

루트에는 저장소 진입점(`README*.md`, `LICENSE`, `AGENTS.md`)과 제품·릴리즈 계약(`DESIGN.md`, `RELEASING.md`, `android-release-policy.json`), 각 도구가 표준 위치에서 찾는 설정 파일을 둔다.
