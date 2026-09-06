# ADR-010: Phase 11 foreground 유지와 background/headless No-Go

- 결정일: 2026-09-06.
- 작성·근거 평가 책임자: Codex. 사용자 요청에 따른 현상 유지 판정이며 사용자·보안 검토자의 승인 서명을 대신하지 않는다.
- 상태: **A foreground 유지; B background WebView와 C runtime-neutral core는 No-Go**. 구현·데이터 변경 없음.
- 평가 기준 commit: `23d9e6c79aabc9e4a434118ce87f608e20fc9e18`.

## 결정 근거

[9B 실제 Windows QA](../releases/evidence/phase9b-desktop-qa-2026-09-05.json)는 앱 종료 중 ready 파일 제출, result 부재, 재시작 후 처리를 확인했다. [9C QA](../releases/evidence/phase9c-desktop-qa-2026-09-06.json)는 사람 승인과 durable Queue 등록·정상 재시작을 확인했다. [9D](../releases/evidence/phase9d-validation-2026-09-06.json)는 첫 binary의 취소 전이와 수정 binary의 동일 grant 복구·replay·정상 재시작을 구분한다. [9E](../releases/evidence/phase9e-validation-2026-09-06.json)의 native 5개 검사는 안전 거절과 정리이며 정상 파일 등록 복구의 native 성공은 미검증이다.

이 증거는 반복 app-off 사용량, background 필요성, 실제 Provider·출력·R2, 설치·업데이트·강제 crash와 운영 완료를 증명하지 않는다. Phase 10 spike는 별도 진행 중이며 이 결정에서는 pending이다. Phase 10 Go가 나오더라도 background 실행을 허용하지 않는다.

Background 구현의 8개 Go gate는 모두 미충족이다.

| Gate | 현재 부족한 증거 |
| --- | --- |
| 반복 app-off 요구 | 관찰 기간·표본·제출 수·수동 실행 횟수·대기 시간과 foreground로 해결되지 않는 사례 |
| 정량 서비스 목표 | availability, wake latency, 최대 queue duration의 사용자 요구 수치와 측정 |
| 비용 대비 우선순위 | migration/운영 비용을 감수할 background 가치에 대한 사용자 판단 |
| Threat model 승인 | local attacker·multi-user·inbox 변조·client/HMAC rotation 검토와 승인자 기록 |
| Credential 권한 | background의 Stronghold/NovelAI/R2 접근, 잠김·prompt·철회·최소 권한 검토와 승인 |
| 수명·복구·migration | single writer/handoff, 강제 crash, 설치·업데이트·downgrade와 rollback 실험 |
| 플랫폼 구분 | Windows/Android별 lifecycle·권한·wake·종료 capability matrix와 실제 검증 |
| UI 없는 호출 통제 | NovelAI/R2 per-run/rolling rate·budget·pause·cancel·unknown outcome 및 복구 운영 증거 |

## 유지하는 계약

[Runtime capability registry](../../src/application/agent/runtime-capability-registry.ts)의 `requiresAppProcess: true`, `canExecuteWhileAppClosed: false`를 유지한다. [UI/foreground runtime](../../src/composition-root/foreground-agent-command-runtime.ts)과 dispatcher는 같은 registry를 사용한다. MCP projection의 실제 앱 일치 여부는 Phase 10 증거가 별도로 필요하다.

파일 제출은 `submitted-to-inbox`, `accepted: false`이며 durable acceptance·Queue 등록·Provider/출력/R2 완료와 다르다. 종료된 앱은 새 receipt를 만들지 않는다. [Startup barrier](../../src/composition-root/agent-command-runtime.ts)의 migration·recovery·hydrate·owner 획득을 통과한 foreground만 inbox를 처리한다.

[현재 wiring](../../src/composition-root/runtime-agent-commands.ts)은 IndexedDB receipt/plan/execution과 auth/fragment/settings store에 결합한다. 2026-09-06 현재 checkout에서 `npm run test:architecture`는 exit 0, 618모듈·3,419의존성·위반 0이었다. 이것은 계층 규칙 검사이며 headless 실행 가능성의 증거가 아니다. `git merge-base --is-ancestor 71a2e8b HEAD`와 `git merge-base --is-ancestor 23d9e6c HEAD`도 exit 0이었다.

## 범위와 재개

Daemon, hidden WebView, Android service, process-neutral core, repository 이중화, remote HTTP, 측정 dashboard를 추가하지 않는다. 이번 결정에는 code/data rollback이 없다. 이후 전환은 기존 Phase 9 foreground authority로 돌아오는 데이터·credential·단일 owner 절차를 먼저 검증해야 한다. 보안/credential과 rollback 검토는 각각 승인 책임자·일시·근거가 필요하며 현재 승인은 기록되지 않았다.

재개 시 8개 gate를 기간·표본·수치·재현 명령·결과·승인 기록으로 채우고, MCP를 사용할 경우 Phase 10 실제 sidecar/app 경로 근거를 함께 평가한다. B와 C 중 선택한 한 경로에만 후속 ADR과 구현 계획을 만든다. B는 숨김 WebView lifecycle spike, C는 repository/credential/owner migration 계획과 검증이 선행한다. B를 C의 필수 단계로 취급하지 않는다. 어느 경로든 실제 app-off 행동과 registry/UI/inbox/MCP 표시의 일치 및 foreground rollback 검증을 acceptance criteria로 삼는다.

전체 gate 표와 로컬 근거 대조 기록은 checkout의 `docs/local/decisions/ADR-phase11-foreground-gate-2026-09-06.md`에 보존한다. 해당 자료는 Git에서 제외되므로 이 ADR과 위 release evidence가 Git으로 공유되는 판단 근거다. No-Go 문서 작성은 Phase 9/10 운영 gate의 완료를 의미하지 않는다.
