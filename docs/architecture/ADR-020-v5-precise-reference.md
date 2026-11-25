# ADR-020: V5 Precise Reference

- 날짜: 2026-11-25
- 상태: 구현하고 설치본에 올려 공개 MCP로 확인했다(2026-11-25, 실행 해시 `8a21a7b5…`). NovelAI에 실제로 보낸 적이 없다
- 기반: ADR-019(Scene의 Precise Reference 결합)
- 범위: 모델 카탈로그, 요청 조립과 레퍼런스 이미지 준비, 레퍼런스 설정 창, Scene 편집 계약(`scene.patch_many`), 어댑터 안내

## 배경

NovelAI가 2026-11-24에 V5 Full과 V5 Curated에 Precise Reference를 넣었다. 그 전까지 NAI Blue는 V5에 레퍼런스가 붙으면 화면을 잠그고 계획을 거절했다.

## 근거

요청 형식은 NovelAI가 문서로 내지 않았다. 아래 두 가지를 맞춰 정했다.

- NovelAI 공지(journal.novelai.net/precise-reference-v5): Full·Curated 지원, 타입은 Character·Style·Outfit과 그 조합, Character와 Character & Style의 "Prefer same outfit", 강도 0~5, Fidelity 없음, 인페인트 미지원, 레퍼런스 한 장당 5 Anlas
- 같은 주에 V5를 넣은 공개 구현체 두 곳(NAIS3 PR 98, MooshieUI PR 1114·1115)의 요청 조립 코드와 테스트. 둘의 키, 값, 버킷 표, 자르기 계산이 서로 같았다

NAI Blue에서 NovelAI로 실제 요청을 보내 확인하지는 않았다.

## 결정

### 1. 모델별 규칙

모델 카탈로그의 능력에 `preciseReferenceRules`를 둔다. 값은 `strengthMax`, `fidelity`, `outfit`, `inpainting`, `imageFit`이고, 레퍼런스가 없는 모델은 `null`이다.

| 모델 | 강도 | Fidelity | Outfit·같은 의상 우선 | 인페인트 | 이미지 맞춤 |
|---|---|---|---|---|---|
| V5 Full, V5 Curated | 0~5 | 없음 | 있음 | 불가 | 버킷 |
| V5 Full Medium | 레퍼런스 미지원 | | | | |
| V4.5, V4 | 0~1 | 있음 | 없음 | 가능 | 캔버스(전과 같음) |

V5 Full Medium은 공지에 없어 막아 둔다.

### 2. 요청 형식

V5도 V4.5와 같은 `director_reference_*` 다섯 배열을 쓰고 새 키는 없다. 다른 점은 값이다.

- 타입과 "같은 의상 우선"은 `base_caption` 문자열 하나로 나간다

  | 고른 타입 | 같은 의상 우선 | `base_caption` |
  |---|---|---|
  | character | 끔(기본) | `character` |
  | character | 켬 | `character_mainoutfit` |
  | character&style | 켬(기본) | `character&style` |
  | character&style | 끔 | `character&style_anyoutfit` |
  | style | | `style` |
  | outfit | | `costume` |

- `director_reference_secondary_strength_values`는 V5에서 0이다. V4.5는 전처럼 `1 - fidelity`다
- 이미지는 V5에서 97개 버킷(한 변 64의 배수, 1메가픽셀 이하, 256×4096부터 4096×256까지) 가운데 가로세로 비가 가장 가까운 것에 맞춘다. 덮도록 키운 뒤 가운데를 잘라 내고 여백은 넣지 않는다. 실제 투명도는 남기고, NovelAI 결과물이 알파 최하위 비트에 숨긴 메타데이터(254, 1)는 크기를 바꾸기 전의 원본 픽셀에서 255와 0으로 되돌린다
- V4.5의 요청 바이트는 바뀌지 않는다

타입과 토글을 합친 이 문자열이 계획·해시·자원 결합을 지나는 값이다. 그래서 토글을 바꾸면 계획 해시가 바뀐다. 컴포지션 문서의 `referenceType` 허용값에 `character_mainoutfit`과 `character&style_anyoutfit`이 늘었다.

### 3. 받지 않는 조합

계획과 생성 전에 같은 검사가 거절한다.

- V5 Full Medium에 레퍼런스, V5 인페인트에 레퍼런스: 모델 사유
- V4.5·V4에 outfit, 모델의 최대 강도를 넘는 값: `preciseReferences` 사유

V4.5·V4에서 "같은 의상 우선"은 거절하지 않고 그 모델의 고정 동작(`character`, `character&style`)으로 보낸다. 사람이 V5에서 켜 둔 토글이 모델을 바꿨다는 이유로 생성을 막지 않게 하려는 것이다.

### 4. 화면

레퍼런스 설정 창이 고른 모델의 규칙을 따른다. V5에서는 타입에 '의상 (V5)'이 생기고, 캐릭터·캐릭터 & 스타일에 '같은 의상 우선' 스위치가 보이고, 강도가 5까지 가고, 충실도가 없다. 잠금 안내는 레퍼런스가 없는 모델(V5 Full Medium)에서만 뜬다. 저장된 토글 값은 `preferSameOutfit`이고, 없으면 타입의 기본값이다. 타입을 바꾸면 토글은 새 타입의 기본값으로 돌아간다. 다른 모델에서 둔 값이 지금 모델에서 거절될 때(강도 초과, V4.5의 의상 타입)는 그 카드에 붉은 안내가 뜬다.

### 5. Scene 편집 계약(MCP)

`preciseReferences` 항목은 `{ artifactId, contentChecksum, referenceType, strength, fidelity?, preferSameOutfit? }`다.

- `referenceType`에 `outfit`이 늘었다. `strength`는 0~5다(모델의 최대는 계획에서 본다)
- `fidelity`는 생략할 수 있다. V4.5·V4에서 없으면 0.6이다
- `preferSameOutfit`은 character와 character&style에서만 받는다
- 전에 저장한 Scene은 그대로 읽히고 같은 계획 해시를 낸다

### 6. 설치본과 어댑터가 어긋나는 동안

어댑터는 이 체크아웃을 쓰고 앱은 설치본이라, 새 빌드를 설치하기 전까지 계약이 다르다.

- 어댑터가 받아들이는 `scene.patch_many`의 이전 해시를 지금 설치본(`9ed9266a…`)의 것으로 바꿨다. 설치본이 이미 가진 보관·`includeArchived` 이전의 해시와 안내는 뺐다
- 옛 모양(강도 1 이하, fidelity 있음, outfit·토글 없음)의 호출은 설치본에서도 된다. 새 모양을 설치본이 거절하면 어댑터가 앱 갱신 안내를 붙인다
- 설치본은 V5 Scene의 레퍼런스를 계속 거절한다. V5 레퍼런스는 새 빌드를 설치해야 된다
- 2026-11-25에 새 빌드를 설치해 이 구간은 끝났다. 앱이 알리는 `scene.patch_many` 해시가 어댑터의 것과 같다. 이전 해시의 수용과 안내는 코드에 남아 있다

## 검토 비서(Gemini 4 Neon)의 지적과 처리

코드와 실행으로 확인한 뒤 처리했다. 수정분은 다시 검토받지 않았다.

- 반영
  - 타입을 바꿔도 '같은 의상 우선' 값이 남아 새 타입의 기본 동작이 뒤집힌다 → 타입을 바꾸면 토글을 비운다
  - 강도를 1보다 크게 두거나 의상 타입을 둔 채 V4.5로 바꾸면 거절된다는 안내가 창에 없다 → 그 카드에 안내를 띄운다
  - 알파 비트 정리를 크기 변경 뒤에 해서 보간으로 번진 값(253 등)을 놓칠 수 있다 → 원본 크기에서 먼저 정리하고 그 뒤에 맞춘다
- 반영하지 않음
  - 강도의 음수·NaN, 변환되지 않은 `outfit`, 규칙이 없는 모델의 요청 조립: 슬라이더와 편집 계약이 0 이상의 유한한 값만 만들고, 타입이 변환을 강제하며, 요청 조립은 검증을 거친 값만 받는다(호출하는 곳은 `adaptGenerationParams` 뒤의 클라이언트 둘뿐이다)
  - 옛 데이터의 빈 `referenceType`에 기본값이 없다: 전에도 스냅샷이 빈 값을 넘겼고 결합 단계가 `character&style`로 채웠다. 기본값을 앞에서 넣으면 Style Lab 평가 문맥의 해시가 옛 데이터에서 달라진다
  - 개정을 올리지 않아 V4.5의 의상·강도 초과가 예전 증거로 승인될 수 있다: 증거는 레퍼런스 타입과 강도가 든 의미 해시가 같아야 맞고, 그런 값은 V4.5에서 만들어진 적이 없다. 승인과 상관없이 계획과 전송 전 검사가 거절한다
  - Medium에서 충실도 슬라이더 조건이 참이다: 잠금 안내 뒤에 가려져 조작되지 않는다
  - 편집 계약의 JSON Schema가 `preferSameOutfit`을 받는 타입을 표현하지 않는다, 전체 응답에는 앱 갱신 안내가 붙지 않는다, 더 예전 설치본의 해시를 뺐다, 안내에 V5 인페인트가 없다: 앞의 둘은 전부터 같은 방식이고, 더 예전 빌드는 설치돼 있지 않으며, MCP의 `imageSource`는 Image2Image뿐이다
  - 버킷 계산이 0 이하나 NaN 크기를 다루지 않는다: 읽힌 이미지의 크기는 1 이상의 정수다
- 확인 못 함으로 받은 것 가운데 직접 확인한 것: 설치본을 빌드한 커밋(`2d30f42`) 뒤에 앱 쪽 소스가 바뀌지 않아 고정한 해시가 설치본의 것이다. Scene 생성은 스토어의 레퍼런스 객체를 그대로 받아 `preferSameOutfit`이 빠지지 않는다

## 바꾸지 않은 것

- 모델 카탈로그 개정(`nai-blue-model-catalog-v2`)과 요청 조립 개정(`nai-blue-payload-v1`). 전에 거절되던 경로가 열렸을 뿐이라 예전 실행 증거가 이 경로를 대신 증명할 수 없고, 개정을 올리면 바뀌지 않은 경로의 증거가 모두 버려진다
- 예상 Anlas. 레퍼런스 비용을 넣지 않는 것은 V4.5와 같다
- Vibe Transfer. V5에서는 여전히 없다
- 화면에서 켤 수 있는 수와 Scene에 묶는 수(10)

## 검증

- 자동 검사: `npx vitest run` 2,985개 통과(건너뜀 4), `tsc --noEmit`, eslint, dependency-cruiser, knip, `node --test tests/scripts/agent-runtime-guard.test.mjs` 통과
- 새로 고정한 것: 버킷 97개와 맞춤 계산(300×200 → 1216×832, 1248×832로 키워 좌우 16), V5 요청의 문자열·강도·0 고정, V4.5 요청이 그대로인 것, 거절 다섯 가지, Scene 저장과 편집 계약의 새 모양, 설치본 해시 수용
- 화면: 개발 서버(빈 데이터, 설치본 아님)에서 레퍼런스 설정 창을 열어 확인했다
  - V5 Full: 잠금이 없고, 이미지를 넣으면 타입 목록에 '의상 (V5)'이 있고, 캐릭터 & 스타일에서 '같은 의상 우선'이 켜진 채 보이고, 의상으로 바꾸면 스위치가 사라지고, 충실도가 없다
  - V4.5: 스위치가 없고 충실도가 보인다. 강도 3과 의상 타입을 둔 채 바꾸면 값은 3.00으로 보이고 슬라이더는 끝에 붙으며 안내 두 줄이 뜬다
  - V5 Full Medium: 잠금 안내가 뜬다
  - 캐릭터에서 스위치를 켠 뒤 타입을 캐릭터 & 스타일로 바꾸면 저장값이 비고 스위치는 기본(켬)으로 보인다
- 실제 브라우저 캔버스의 맞춤(알파 비트를 섞은 시험 이미지): 300×200 → 1216×832, 832×1216 → 그대로, 2000×3000 → 832×1216. 투명 영역이 남고, 크기가 같거나 줄어든 둘은 알파가 0과 255뿐이다. 키운 하나는 투명 영역의 경계에만 중간 값이 생긴다. V4.5 경로는 전처럼 1536×1024 불투명이다(검토 반영 전 코드로 확인)

- 설치본(실행 해시 `8a21a7b5…`, 소스 `105f924`)에서 등록된 MCP 연결로 확인한 것(2026-11-25)
  - 설치된 실행 파일은 로컬 빌드(`a6798130…`)와 3바이트만 다르다. 묶을 때 들어가는 설치 형식 표시(`UNK` → `NSS`)다
  - `verify-agent-mcp-runtime.mjs`: verified true, 같은 해시. `nai-blue://capabilities`의 `schemaMismatches`가 비어 있다
  - 보관해 둔 확인용 프리셋 `stage4-check-20261122`를 복원해 V5 Full Scene에 outfit(강도 2.5)과 character·`preferSameOutfit: true`(강도 1.5)를 묶었고 `scene.resolve_many`가 그대로 돌려줬다. `fidelity`는 보내지 않았다
  - 그 Scene의 계획이 `ready`이고 호환성 프로필이 `…:nai-diffusion-5-full:generate:precise-reference+streaming`(`synthetic-only`)이다. 예상 12 Anlas이고 등록하지 않았다
  - 같은 Scene의 모델을 V4.5로 바꾸면 계획이 `invalid-model-settings`, `fieldPath: source.targets[0].preciseReferences`("Outfit Reference는 NAI Diffusion V5에서만 사용할 수 있습니다")로 거절된다
  - 끝에 Scene을 V5·`preciseReferences: null`로 되돌리고 프리셋을 다시 보관했다(리비전 7)
- 하지 않은 것: V5 레퍼런스를 묶은 실제 생성, 설치본의 레퍼런스 설정 창(사람이 보는 쪽)

## 알려진 한계

- NovelAI에 실제로 보낸 적이 없다. 형식은 공지와 다른 구현체에서 온 것이다
- 예상 Anlas와 예산 상한이 레퍼런스 비용(장당 5 Anlas)을 세지 않는다
- 강도를 1보다 크게 두거나 의상 타입을 둔 채 V4.5로 바꾸면 생성이 거절된다. 창의 안내대로 값을 고치면 된다
- 버킷 맞춤은 원본 크기의 캔버스를 한 번 더 쓴다. 아주 큰 원본에서는 그만큼 메모리를 쓴다
- 화면의 버킷 맞춤은 브라우저 캔버스의 보간을 쓴다. 다른 구현체의 Lanczos와 픽셀이 똑같지는 않다
- 예전 버전이 남긴 서버 캐시 키가 있는 레퍼런스는 V5에서도 그 키로 나간다. 지금 코드에는 키를 만드는 곳이 없다
