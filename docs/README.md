# NAI Blue 디렉터리 인덱스

## 현재 사용본과 최신 결과

- 정식 소스: `E:/AI_Project_Library/projects/nais/NAI-Blue`.
- 실제 실행 경로: `E:/AI_Project_Library/projects/nais/NAI Blue/NAI-Blue.exe`. 등록된 Windows 설치 하나만 사용한다.
- 대표 결과: [시작 응답성 개선 기록](./releases/시작%20응답성.md). 상태: 사용본 설치 검증 완료, 웹 빌드 캐시 정리는 정책 차단으로 미완료.
- 사용본 SHA-256: `eff17f920840ca68dbad5cb720f68457494a7f19967ad00aacdb2fb693263bec` (1.3.6 로컬 최적화 빌드).
- [측정 근거](./releases/evidence/시작%20응답성%20측정.json): CPU·메모리·타이머 지연, 테스트와 실제 MCP 검증. 생성·수정 시각은 파일의 `recordedAt` 참조.
- 변경 이력: `git log --oneline -- "docs/releases/시작 응답성.md"`; 커밋 ID는 완료 보고와 Git에서 확인한다.
- 기존 작업 보존: `refs/archive/tasks/startup-responsiveness/initial-worktree` (`9df17902d65bccb7138bf3db856d05d80b527bcd`). 작업 전 `main`의 `37d9a9a3548023865f7a7eb3ebce27c27747ee3c`와 미커밋 소스·테스트를 별도 보존했고 원래 `main`은 이동하지 않았다.
- 확인 시각: 2026-11-04 17:36:00 KST. 이전 문서의 최초 생성 시각은 미확인.

앱 실행 파일·빌드 폴더·자동 백업 파일의 이름은 도구 및 기존 복원 규약이 강제하므로 유지한다. Rust 빌드 출력은 배포 후 제거했고 웹 `dist`는 삭제 정책 차단으로 남아 있으며, 사용자 데이터와 복구 이력은 별개로 보존한다.

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
