# ADR-016: MCP 어댑터의 토큰 효율 재설계

- 날짜: 2026-11-22
- 상태: 구현함. 자동 검사와 설치본 읽기 확인까지 했고, 실제 에이전트의 생성 한 바퀴는 아직 재지 않았다
- 기반: ADR-011, ADR-015. 의도는 [MCP 토큰 효율 재설계](../의도/MCP%20토큰%20효율%20재설계.md)
- 범위: `src/adapters/agent/mcp/`와 `scripts/run-agent-mcp-stdio.mjs`. 앱 명령 계약, 영수증 형식, Rust·Python 명령 목록은 그대로다

## 문제

2026-11-05 나하린 생성에서 공개 호출 54회에 MCP로 들어온 글자가 약 1,171,000자였다.

- 약 83%(970,000자)가 가이드 재독이다. 가이드(17,969자)를 읽어야 호출 한 번이 허용되고, 실패한 호출도 그 읽기를 소비했다. Pi 기록에 `GUIDE_READ_REQUIRED`가 든 줄이 100개다
- 도구 목록이 약 43,000자였다. 도구마다 같은 금지 문구와 출력 스키마가 반복되고, 설명에 실시간 가용 상태가 섞여 목록 문구가 앱 상태에 따라 바뀌었다. `tools/list`마다 앱에 확인 명령이 나갔다
- 응답이 영수증 전체였다(54회에 약 157,000자). `generation.plan`은 job마다 프롬프트 원문을, `generation.get_run`은 job마다 시도·전이 이력을, `scene.resolve_many`는 Scene마다 프롬프트 전문을, `workspace.get_snapshot`은 요청하지 않은 목록까지 실었다
- 한 번의 생성에 계획, 등록, 반복 조회, 이미지마다 한 번의 읽기가 따로 호출됐다. 호출마다 모델은 문맥 전체를 다시 읽는다

## 결정

### 1. 잠금을 없앤다

`GUIDE_READ_REQUIRED`와 호출 전 가이드 읽기를 지웠다. 어떤 도구도 가이드 없이 호출된다.

앱이 판정할 수 없는 행동 규칙(우회 금지, `complete: true` 전에는 끝난 것이 아님, 결과를 모르면 다시 생성하지 않음, 승인은 사람이, V5·V4.5의 프롬프트 모드)은 `initialize.instructions`에 800자 안으로 둔다. 호스트가 instructions를 모델에 넘기지 않을 수 있으므로, 다시 생성하지 말라는 규칙은 `generation.run`·`generation.enqueue`의 설명과 끝나지 않은 응답의 `hint`에도 있다.

서명, 정확한 계획 ID·해시, revision, 동의, 예산은 앱이 판정한다. 잠금은 그 위에 더한 읽기 강제였으므로 없애도 앱의 판정은 달라지지 않는다.

### 2. 가이드를 주제별 참고서로 나눈다

`nai-blue://guides/agent-workflow/v1`은 기본 순서와 주제 목록만 담는다(2,648자). 주제는 `recovery`, `production`, `image-source`, `consent`, `runtime`, `advanced`이고 `nai-blue://guides/<주제>`로 읽는다. 틀린 호출과 대기 상태의 응답에는 `hint` 한 줄이 붙고, 필요하면 그 주제의 URI를 가리킨다.

### 3. 도구 목록을 고정하고 줄인다 (43,000자 → 7,743자)

- `tools/list`는 앱에 묻지 않는 고정 응답이다. 가용 상태는 호출 결과와 `nai-blue://capabilities`가 말한다. 스키마 해시 비교도 그 resource에 남는다
- 설명은 도구별 한두 문장이고 `outputSchema`는 싣지 않는다
- 입력 스키마는 앱 계약 스키마에서 `pattern`, 글자 길이, `$schema`, `not`, 정수 범위 전체에 해당하는 상한을 걷어낸 모양이다. `strength` 0~1이나 Scene 100개 같은 작은 범위는 남긴다. 검증은 지금처럼 계약의 `validate`가 한다
- 드문 명령(`folder.plan_changes`, `folder.apply_changes`, `production.*`)은 `advanced.call { command, input }`으로 받고, 입력 모양은 `nai-blue://guides/advanced`에 있다. 10월 20일 이후 이 명령들의 호출은 1,550여 회 중 1회였다
- 목록에서 빠진 명령도 계약이 있으면 제 이름으로 계속 호출된다(`generation.plan`, `artifact.get_image`, `system.describe_capabilities`, `production.*`, `folder.*`). 검증 스크립트와 기존 습관이 깨지지 않는다

목록: `workspace.get_snapshot`, `scene.resolve_many`, `scene.patch_many`, `generation.run`, `generation.enqueue`, `generation.get_run`, `generation.cancel`, `generation.retry_storage`, `artifact.get_images`, `r2.get_readiness`, `advanced.call`.

### 4. 응답은 요약이 기본이다

어댑터가 앱의 영수증을 검증한 뒤 줄여서 돌려준다. `detail: "full"`은 예전과 같은 전체 관찰을 돌려주고, `nai-blue://requests/{requestId}`는 그대로 전체 영수증이다.

- 겉모양은 `{ state, requestId, result }`다. 영수증이 아닌 상태와 어댑터 오류는 `status`, `code`와 `hint`를 싣는다
- 본문은 `content`의 JSON 글 하나다. 같은 내용을 `structuredContent`로 한 번 더 싣지 않는다
- `workspace.get_snapshot`: 동의 상태, 대기열 요약, 전체 개수. 목록은 `include`로 고른 것만
- `scene.resolve_many`: 프롬프트를 뺀 요약
- 계획: 계획 ID·해시, 장수, 예상 Anlas, 호환 상태, 경고, 대상별 한 줄. 거절된 계획은 줄이지 않는다
- `generation.get_run`: `complete`, 집계, 다음 행동, 주의·복구 항목, 저장된 job의 `artifactId`, 끝나지 않은 job의 ID와 상태
- `generation.enqueue`: `runId`와 장수

2026-11-05의 영수증 54개를 새 요약에 다시 넣으면 응답 합계가 156,959자에서 25,995자가 된다.

### 5. 왕복을 묶는다

- `generation.run`은 계획 → 등록 → 완료 대기를 한 호출로 한다. 단계마다 앱의 판정을 따르고, 끝나지 않은 첫 단계를 그대로 돌려준다. `planOnly: true`는 등록 없이 미리보기만 한다
- `generation.run`과 `generation.enqueue`는 호출자가 정한 `requestId`가 필수다. 응답이 오기 전에 연결이 끊겨도 호출자가 `nai-blue://requests/{requestId}-enq`를 읽을 수 있어야 다시 생성하지 않는다. 단계별 ID는 `<requestId>-plan`, `<requestId>-enq`이고, 같은 요청을 다시 보내면 같은 영수증이 돌아온다. 그 밖의 도구는 `requestId`를 비우면 어댑터가 만들어 응답에 싣는다
- 계획 뒤 단계에서 어댑터가 실패하면 응답은 그 단계의 `requestId`나 `runId`를 싣는다. 이미 대기열에 들어간 작업을 잃지 않기 위해서다
- 완료 대기: `waitSeconds`(0~50, `generation.run`의 기본 40)는 호출 전체의 시간이다. 앞 단계가 쓴 시간만큼 대기가 줄고 마지막 조회를 위해 5초를 남긴다. 호스트의 도구 시간 제한(흔히 60초) 안에 응답하기 위해서다. 조회는 새 ID로 2~5초 간격이다
- `artifact.get_images`는 한 호출에 4장까지 순서대로 읽는다. 480px 미리보기 한 장이 base64로 약 0.5MB라 응답 하나를 2MB 근처로 묶었다. ID 전부를 먼저 검증한 뒤에 첫 읽기를 보낸다

### 6. 실제 유입을 잰다

연결 프로그램이 응답마다 종류, 도구 이름, 글자 수, 이미지 수를 `output/mcp-usage/<날짜>.jsonl`에 한 줄씩 적는다. 내용은 적지 않고, 쓰기에 실패해도 호출은 계속된다. `--no-usage-log`로 끈다. `scripts/measure-agent-mcp-inflow.mjs --date <날짜> --baseline 2026-11-05`가 그날의 합계를 내고, 이전 구조의 유입(저장된 영수증 + 호출당 가이드 + 도구 목록)과 비교한다.

## 검토 비서(Gemini 4 Neon)의 지적과 처리

- 반영: 끊긴 `generation.run`의 복구 경로(필수 `requestId`), 단계별 실패 보고, 호출 전체 시간 상한, 행동 규칙을 설명과 `hint`에도 두기, 작은 범위 제약 유지, 이미지 묶음 축소와 순차 읽기, `generation.plan`을 `planOnly`로 합치기, 사용 기록 끄는 인수
- 반영하지 않음: 경고가 있는 계획에서 자동 등록을 멈추기(항상 승인이 켜져 있으면 확인을 더하지 않는다는 기존 결정과 어긋난다. 예산 상한이 비용을 막는다), 가이드 주제 수 줄이기(주제는 읽을 때만 비용이 든다), `scene.retry_link`와 `output.abandon_reservation`의 누락(입력 계약이 없어 예전에도 목록에 없었다)

## 바꾸지 않은 것

- 요청 서명, inbox 파일 흐름, 영수증 저장과 재생, 실행 중인 앱의 해시 확인, 읽기 명령이 닫힌 앱을 켜지 않는 규칙
- 제출 전 입력 안전 검사와, 제출 뒤 오류에서 미제출을 단정하지 않는 규칙
- 앱의 승인·예산·revision·호환성 판정

## 검증

- 에이전트 테스트 191개, 런타임 가드 테스트 7개, 타입 검사, 린트, 구조 검사 통과. 새 기본 동작은 `tests/application/agent/mcp-token-efficiency.test.ts`가, 영수증 수준의 계약은 `detail: "full"`로 기존 두 테스트가 지킨다
- 설치본 1.3.6(실행 중)에 등록된 연결로 읽기 호출을 확인했다. `workspace.get_snapshot` 414자(예전 중앙값 11,251자), 완료된 실행의 `generation.get_run` 974자, `scene.resolve_many` 561자, `artifact.get_images`로 이미지 2장을 한 호출에 받았다
- 하지 않은 것: `generation.run`의 실제 생성, 호스트별(Pi, Codex, Claude Code) 동작, `scripts/qa-phase10c-mcp-native.mjs`의 실행(고치기만 했다)

## 알려진 한계

- 완료 대기는 조회마다 영수증 파일 하나를 남긴다
- 입력이 틀렸을 때 어느 필드인지는 알려 주지 않는다. 계약의 검증기가 위치 없이 거절하기 때문이다
- 이름으로 프리셋을 찾는 조회는 없다. 목록을 쪽 단위로 읽는다
- 사용 기록의 글자 수는 어댑터가 내보낸 양이고, 호스트가 모델에 실제로 넣은 토큰 수와는 다를 수 있다
