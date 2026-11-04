# Fixture provenance

기준일: 2026-08-12 (Asia/Seoul)

이 디렉터리의 모든 JSON fixture는 `provenance.json`에 등록한다. 현재 코드에서 합성하거나 정제한 로컬 계약 자료만 유지하며, 실제 credential·사용자 경로·원본 이미지 바이트는 저장하지 않는다.

| Fixture | 출처 | 모델 | 캡처 날짜 | 변환 | 민감정보 제거 |
| --- | --- | --- | --- | --- | --- |
| `payload/v5-medium.json` | 공식 Effort 공지와 공개 웹 클라이언트의 합성 설정 계약; Provider 미검증 | `nai-diffusion-5-full-medium` | 2026-10-14 | 아니오 | 예 |
| `image-metadata-release-v2.json` | 사용자 제공 release/v2 sidecar 구조를 고정 합성 값으로 정리한 메타데이터 import contract | `nai-diffusion-4-5-full` | 2026-08-12 | 예 | 예 |
| `metadata/data-hub-sample.nai-blue.json` | Data Hub parser와 대량 읽기 contract를 위한 합성 Metadata v2 sidecar | `nai-diffusion-4-5-full` | 2026-07-26 | 아니오 | 예 |
| `payload/v4-5-text.request.json` | current NAI verifier/request contract | `nai-diffusion-4-5-full` | 2026-07-11 | 예 | 예 |
| `payload/v4-5-text.expected.json` | current payload builder local characterization | `nai-diffusion-4-5-full` | 2026-07-11 | 예 | 예 |
| `payload/supported-online-matrix.json` | release covering matrix | V4/V4.5 required; V3/Furry V3 probe-only | 2026-07-16 | 예 | 예 |
| `fragments/inline-selection.json` | current fragment processor | 해당 없음 | 2026-07-11 | 예 | 예 |
| `fragments/composition-resolver-v2.json` | current fragment grammar and deterministic resolver contract | 해당 없음 | 2026-07-11 | 예 | 예 |
| `legacy/old-only.json` | current migration contract의 합성 old-only state | 해당 없음 | 2026-07-11 | 아니오 | 예 |
| `legacy/new-only.json` | current migration contract의 합성 new-only state | 해당 없음 | 2026-07-11 | 아니오 | 예 |
| `legacy/both-present.json` | current migration contract의 합성 coexistence state | 해당 없음 | 2026-07-11 | 아니오 | 예 |
| `legacy/malformed-old.json` | current migration contract의 합성 malformed state | 해당 없음 | 2026-07-11 | 아니오 | 예 |
| `legacy/partial-write.json` | current migration contract의 합성 partial-write state | 해당 없음 | 2026-07-11 | 아니오 | 예 |
| `legacy/interrupted-session.json` | current migration contract의 합성 interrupted state | 해당 없음 | 2026-07-11 | 아니오 | 예 |
| `legacy/store-backup-roundtrip.json` | old-store와 backup/import round-trip contract; image bytes redacted | 해당 없음 | 2026-07-12 | 예 | 예 |
| `legacy/old-backup-with-obsolete-remote-state.json` | obsolete remote state 무시와 local backup 복원 contract | 해당 없음 | 2026-07-13 | 예 | 예 |
| `legacy/production-authority-startup.json` | fresh/upgrade/interruption/corruption startup matrix | 해당 없음 | 2026-07-13 | 아니오 | 예 |
| `workflows/main/default-direct-prompt.json` | current Main direct-prompt path | `nai-diffusion-4-5-full` | 2026-07-11 | 예 | 예 |
| `workflows/main/current-workflow.json` | current Main store → adapter → payload → output golden capture | V4/V4.5 | 2026-07-11 | 예 | 예 |
| `workflows/scene/cancel-guards.json` | current Scene session guards | workflow-agnostic | 2026-07-11 | 예 | 예 |
| `workflows/scene/current-workflow.json` | current Scene builder/worker/queue/save golden capture | `nai-diffusion-4-5-full` | 2026-07-11 | 예 | 예 |
| `workflows/scene/character-rotation-sequence.json` | current rotation store fixed-order runtime projection | workflow-agnostic | 2026-07-12 | 아니오 | 예 |
| `workflows/stylelab/prompt-template.json` | current Style Lab prompt formatter | `nai-diffusion-4-5-full` | 2026-07-11 | 예 | 예 |
| `workflows/stylelab/current-workflow.json` | current Style Lab multi-preview golden capture | `nai-diffusion-4-5-full` | 2026-07-11 | 예 | 예 |
| `product-guidance/token-gate-current-models.json` | NovelAI 공식 model/quality-tag 문서와 합성 prompt | current registered models | 2026-07-16 | 예 | 예 |

`product-guidance/token-gate-current-models.json`은 provider payload나 tokenizer 파일을 포함하지 않는다. 공식 tokenizer artifact와 golden 결과가 확보되기 전까지 계산 사용량과 safety margin은 `null`이다.

## Redaction policy

fixture를 저장하기 전에 `tests/helpers/redaction.ts`의 `redactSnapshot()` 또는 `redactSnapshotJson()`을 적용한다. 다음 값은 허용하지 않는다.

- NovelAI token 또는 Authorization bearer 값
- remote-service key, password, cookie, credential과 전체 session object
- R2 access key, secret, API token 또는 account identifier
- 사용자 홈을 포함한 절대 파일 경로
- 원본 이미지·mask·reference의 전체 data URI/base64 또는 binary bytes

redaction 결과는 범주별 `[REDACTED:…]` marker로 대체한다. 실제 credential이 필요한 smoke test 입력과 실제 생성 이미지 bytes는 이 fixture 트리에 넣지 않는다.

## Capture rules

- 새 fixture의 source, model, KST 날짜, 정규화와 redaction을 manifest에 기록한다.
- 합성 자료는 `captureKind: synthetic-derived`, 현행 코드 특성화는 `local-characterization`으로 표시한다.
- fixture를 추가하거나 제거할 때 이 표와 `provenance.json`을 함께 갱신한다.
