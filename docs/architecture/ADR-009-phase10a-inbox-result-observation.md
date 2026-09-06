# ADR-009: Phase 10A inbox 결과 조회 선행 연결부

- 날짜: 2026-09-06.
- 상태: 선행 연결부 구현·검증. **실제 MCP stdio/앱 spike는 미실행이며 Go/No-Go 미판정**.
- 기준: Phase 9E `23d9e6c` 이후. 전체 Phase 10 완료나 SDK·sidecar 설치를 의미하지 않는다.
- 요구 문서: 로컬 `docs/local/plans/agent-automation/phase-10-mcp-stdio.md`.

## 결정과 실제 소비자

Phase 9의 외부 Python submitter는 Windows Credential Manager에서 키를 읽어 요청을 서명하고, 원래 envelope를 `.submitted.json`에 보존한 뒤 `.ready.json`으로 공개한다. 동일 request ID는 원래 요청을 재사용한다. 새 MCP 경로에서 필요한 결과 조회를 먼저 구현하며, 별도 command dispatcher·Queue·키 저장소를 만들지 않는다.

[`inbox-result-projection.ts`](../../src/adapters/agent/mcp/inbox-result-projection.ts)는 기존 application envelope/receipt parser, request/result digest, shared public-payload scanner와 ingress rejection vocabulary를 재사용한다. 실제 소비자인 [`inspect-agent-command.mjs`](../../scripts/inspect-agent-command.mjs)는 기존 native 디렉터리의 파일만 읽는다. 개발용 Vite SSR loader로 동일 TypeScript 검증을 실행하며 HTTP listener를 열지 않는다. SDK 설치, 임시 MCP protocol 구현, 앱 시작, 요청 제출·재전송, credential 읽기, Queue 취소는 수행하지 않는다.

## 관측 계약

| 관측 결과 | 반환과 의미 |
| --- | --- |
| archive와 동일한 ready 파일, 결과 없음 | `submitted-to-inbox`, `accepted: false`, `requiresAppProcess: true`. 현재 app-off/ready/error 여부는 알 수 없다. |
| archive만 있고 ready·결과 없음 | `submission-unconfirmed`, `accepted: false`. archive 저장 뒤 ready 공개가 중단될 수 있어 제출 완료로 단정하지 않는다. |
| 유효한 receipt | `application-receipt`와 원본 receipt. request ID/hash/client/command와 result digest가 일치해야 한다. |
| 유효한 rejection | `inbox-rejection`, `accepted: false`와 기존 고정 code. native rejection에는 request hash가 없으므로 파일 이름으로만 연결되는 거절 관측이다. |
| 두 projection 공존·변조·크기 초과·불안전한 내용·읽기 실패 | CLI는 `observation-unavailable`과 고정 `AGENT_OBSERVATION_FAILED`만 stderr에 출력하고 exit 1. |
| SIGINT/SIGTERM 관측 취소 | `observation-cancelled`와 동일 request ID. 기존 Queue 동작은 변경하지 않는다. |

Receipt의 `accepted`는 처리 불명 상태일 수 있다. `needs-input`, 승인/요청/run handle, `COMMAND_OUTCOME_UNKNOWN`은 원래 값 그대로 유지한다. `completed` receipt는 command 처리 결과이지 생성·출력·R2 성공의 일반적인 증명이 아니다. 저장된 capability receipt 역시 역사적 응답이며 현재 tool advertisement의 근거로 캐시하지 않는다.

Archive의 schema와 hash 검사는 HMAC 재인증이 아니다. 과거 receipt 관측은 현재 client가 폐기되지 않았다는 증거도 아니며 새 명령 수락 권한을 제공하지 않는다. 실제 sidecar의 서명과 신규 acceptance 전 재인증은 Phase 9 OS-private store와 앱이 담당해야 한다.

요청/archive는 65,536 bytes, receipt 파일은 native와 동일한 69,632 bytes까지 읽는다. Public result 자체의 65,536-byte 제한은 기존 parser가 적용한다. 나머지 receipt metadata까지 다시 그 제한에 넣지 않는다. 파일과 부모 디렉터리의 symlink/junction 및 파일 hardlink를 거절한다. 이 개발 harness는 native ACL/handle 소유권 구현을 대체하지 않으며 적대적 filesystem 경합을 검증한 증거도 아니다.

## 사용과 검증

이미 사람 등록과 기존 submitter로 제출한 요청에 대해 아래 명령을 사용한다. `<...>`는 사용자가 보유한 실제 공개 경로/식별자로 대체한다. 타임아웃과 재실행은 조회만 수행한다.

```powershell
npm run agent:inspect -- --inbox-dir '<existing-native-inbox>' --request-id '<saved-request-id>' --wait-ms 30000
npm run test:agent-mcp-prerequisites
```

새 검증은 fixture 파일, 실제 Node CLI, shared TypeScript parser, 실제 HMAC 검증 dispatcher와 IndexedDB adapter를 사용한다. IndexedDB 엔진은 `fake-indexeddb`이며 native 앱은 실행하지 않는다. 요청 간 결과 교환, 원본 receipt 동일성, 연결 종료 후 반복 조회, 미공개 archive, 관측 취소, 큰 result/metadata, 소수 result, secret/base64/private path/signed URL 거절을 검증한다. [검증 기록](../releases/evidence/phase10a-validation-2026-09-06.json)에 명령·범위·결과와 해시를 남긴다.

## 실제 stdio spike에 남은 경계

1. 공식 SDK 설치와 지원 schema dialect를 실제 설치본으로 확인한다. 2026-09-06 `npm view` 조회 결과 `@modelcontextprotocol/server`와 `@modelcontextprotocol/client`는 각각 `2.0.0`, Node 요구는 `>=20`이었다. [공식 SDK v2 문서](https://ts.sdk.modelcontextprotocol.io/v2/)와 [공식 저장소](https://github.com/modelcontextprotocol/typescript-sdk)를 대조했다. 아직 설치본과 lockfile pin은 없다.
2. 현재 command validators에서 공유 schema metadata를 추출한다. 별도 MCP command allowlist/schema library를 추가하지 않는다. Runtime registry와 실제 available tool/resource의 일치 검증은 아직 미실행이다.
3. 외부 프로세스에 현재 ready/error를 보장하는 lifecycle 계약이 없다. owner lock·timeout·과거 capability receipt를 readiness로 대신하지 않는다. 이 정보와 capability freshness를 실제 앱 spike에서 결정한다.
4. 기존 Python signer의 입력은 safe integer만 지원한다. TypeScript의 소수 `maxAnlas` 입력까지 full round-trip을 주장할 수 없다. 이 변경은 소수 **결과** 읽기만 지원한다.
5. 실제 stdio concurrency, caller timeout/crash/restart, request handle 보존, Queue run polling/cancel, needs-input mapping, revoked identity, Windows 설치·업데이트 경로를 검증한다. 요청 expiry와 client identity expiry는 별개이며 현재 client registry에는 identity expiry 필드가 없다.

요구 문서의 설치 경계에 따라 **별도 동의 후 실행할 개발 의존성 설치안**은 다음과 같다. 대상은 이 E-drive checkout의 `package.json`, `package-lock.json`, `node_modules`이며 사용자 MCP 설정 파일의 변경은 포함하지 않는다. 현재 변경에 이 SDK 설치는 포함되지 않았다.

```powershell
npm install --save-dev --save-exact @modelcontextprotocol/server@2.0.0 @modelcontextprotocol/client@2.0.0
```

이후 실제 sidecar 설치·MCP client 등록·외부 Agent config 변경은 구체적인 command와 대상 config를 제시하는 별도 단계다. 임의 client 등록이나 기존 사용자 profile의 credential 변경으로 native QA를 대신하지 않는다. Spike가 No-Go라면 Phase 9 inbox를 유지하며 socket·daemon·remote HTTP를 추가하지 않는다.

## Rollback

새 inspector, projection과 해당 테스트/package script를 제거하면 된다. 기존 receipt/plan/Queue/키/사용자 config는 변경하지 않았으므로 데이터 rollback이나 migration이 없다. Background/headless 결정은 [ADR-010](ADR-010-phase11-foreground-retention.md)의 A foreground 유지에 따른다.
