# MCP 토큰 효율 재설계

- 결과: 에이전트가 가이드를 읽지 않아도 NAI Blue MCP를 바로 쓰고, 같은 작업에서 MCP로 들어오는 글자 수가 지금의 1/10 이하가 된다. 풀려는 불편은 에이전트가 사용 지침을 호출마다 다시 읽느라 토큰을 쓰는 것이다. 쓰는 사람은 Pi의 Gemini 4 Neon, Codex, Claude 같은 에이전트다
- 완료 기준: Pi의 Gemini 4 Neon이 새 구조로 나하린 12장을 생성한다. 그 세션에서 가이드 강제 읽기와 `GUIDE_READ_REQUIRED`가 0회이고, MCP 유입 글자 수가 2026-11-05 나하린 생성(약 1,140,000자) 대비 1/10 이하임을 측정 스크립트로 보인다
- 제약: 앱 재빌드 없이 어댑터(`src/adapters/agent/mcp/`, `scripts/run-agent-mcp-stdio.mjs`)만 바꾼다. 정확한 계획 ID·해시 검증, 결과를 모를 때 재생성 금지, 클라이언트별 동의, 서명된 요청 같은 앱 쪽 검증은 그대로 둔다. 어댑터를 바꾼 뒤에는 MCP 재연결이 필요하다
- 하지 않는 것: 앱 명령 계약과 영수증 형식 변경, Rust·Python 명령 목록 변경, 설치본 배포, 생성 품질이나 프롬프트 손질
- 미정: 목표 배수(초안 1/10), 묶음 도구의 이름과 개수, 완료 대기의 최대 시간
- 출발점:
  - 잠금은 `src/adapters/agent/mcp/mcp-stdio-server.ts`의 `guideRead`이고, 검사는 `tests/application/agent/manual-guide-gate.test.ts`다. 가이드 읽기 한 번이 호출 한 번만 허용하고 실패한 호출도 소비한다
  - 가이드와 도구 설명은 `src/adapters/agent/mcp/agent-workflow-guide.ts`에 있다. 가이드 17,969자, 연결 안내 645자, 도구 목록 약 43,000자(도구 19개마다 금지 문구 약 330자와 출력 스키마 726자 반복)
  - 도구 설명에 실시간 상태 문구가 섞여 있고, `tools/list`마다 `system.describe_capabilities` 확인 명령이 앱으로 나간다(2026-11-05에 58회)
  - 2026-11-05 공개 호출 54회: 가이드 재독 약 972,000자(약 89%), 응답 약 125,000자. 응답 중앙값은 `workspace.get_snapshot` 11,251자, `scene.resolve_many` 14,062자, `generation.plan` 4,974자, `generation.get_run` 4,952자
  - 영수증은 `%APPDATA%/blue.bluehair.naiblue/agent-commands/results`에 있고, Pi의 MCP 설정은 `agent-runtime/ade-workspace/mcp-config.toml`이다
  - 호출마다 가이드를 읽으라고 적은 문서: `AGENTS.md`, `README.md`, PPP의 `docs/photobooth-remake-production-standard.md`, `docs/workflows/PHOTOBOOTH_ILLUSTRATIONS.md`, `docs/workflows/IMAGE_PIPELINE.md`
- 기준 커밋: 8678e21
