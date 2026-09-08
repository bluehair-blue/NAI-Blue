# ADR-013: 전용 에이전트 도구와 폴더 생성 작업 연결

- 날짜: 2026-09-08
- 상태: 구현. 자동 검증과 실제 호스트/Provider 검증은 아래에서 구분한다.
- 요구: ADR-012의 제품 완료 기준. 화면 조작을 에이전트 실행 경로로 사용하지 않는다.

## 결정

사람과 에이전트가 동일한 Scene/Folder 저장소를 편집하고 동일한 durable Queue를 사용한다.
에이전트용으로 별도 생성기, 임시 프롬프트 파일 가져오기, 두 번째 대기열을 만들지 않는다.
앱이 실행 중인 Windows foreground MCP 통로를 유지한다.

| 도구 | 실제 동작 |
| --- | --- |
| `workspace.get_snapshot` | 저장된 에셋·묶음·폴더 ID와 현재 버전을 페이지로 조회한다. `{offset?,limit?}`를 받는다. |
| `scene.resolve_many` | 지정 에셋의 편집 데이터와 결과 Artifact ID를 읽는다. |
| `scene.patch_many` | 프롬프트·파라미터·수량·파일명·폴더를 생성/수정하고 같은 화면에 반영한다. |
| `folder.plan_changes` | 기존 저장 위치 아래의 폴더 생성/편집 및 R2 설정 변경을 검토한다. |
| `folder.apply_changes` | 검토한 버전과 계획이 같은 경우 기존 폴더 검증·권한·CAS를 통해 저장한다. |
| `r2.get_readiness` | 기존 R2 연결별 사용 가능 상태를 읽는다. 비밀키는 반환하지 않는다. |
| `generation.plan` | 저장된 에셋별 장수와 seed 정책·비용 한도로 생성 계획을 만든다. |
| `generation.enqueue` | 검토한 계획을 기존 승인 정책에 따라 실제 Scene Queue에 등록한다. |
| `generation.get_run` | 같은 run의 생성·저장·업로드 상태를 조회한다. |

화면은 작업을 만든 주체와 관계없이 기존 Queue를 읽어 대기/생성 중/실패/완료를 표시한다.
완료 이미지는 기존 실행기의 Artifact 등록 → Scene 연결 → 결과 표시 경로를 사용한다.
실행 통로의 `submitted-to-inbox`는 대기열 등록 성공이 아니다. 앱의 완료 영수증 안에
`status: ready`와 실제 `runId === batchId`, `jobIds`가 있어야 등록 성공이다.

## 입력과 저장 위치

한 번에 최대 100개 에셋을 편집한다. 생성 계획은 대상별 장수 합계 최대 100장이다.
그보다 큰 생산은 에이전트가 조회 결과와 영수증을 보존하면서 여러 요청으로 나누어 제출한다.
기존 실행당/시간당/일일 비용 및 동시 작업 한도를 그대로 적용한다.

에셋 생성 예시의 ID와 폴더 ID는 실제 조회 결과/호출자가 정한 고유 ID로 바꾼다.
기존 묶음을 편집할 때에는 `presetName`을 생략하고 조회한 `expectedRevision`을 사용한다.

```json
{
  "presetId": "uniform-expressions",
  "presetName": "교복 표정",
  "expectedRevision": 0,
  "changes": [
    {
      "sceneId": "happy",
      "name": "웃는 표정",
      "prompts": {"additional": "blue hair, school uniform, smiling, classroom"},
      "generation": {"model": "nai-diffusion-4-5-full", "steps": 28, "cfgScale": 5.5},
      "width": 832,
      "height": 1216,
      "generationFolderId": "existing-folder-id",
      "productionCount": 3,
      "filenameTemplate": "happy_{seed}"
    },
    {
      "sceneId": "calm",
      "name": "차분한 표정",
      "prompts": {"additional": "blue hair, school uniform, calm expression, classroom"},
      "generationFolderId": "existing-folder-id",
      "productionCount": 2
    }
  ]
}
```

`generation.plan`은 다음과 같이 저장된 대상과 현재 버전을 참조한다. 이 예시의
`expectedRevision: 1`은 실제 저장 결과가 1일 때만 유효하다. 이미지가 연결되거나
사람이 편집한 뒤에는 다시 조회한다. 파라미터/프롬프트 사본을 Queue에 직접 밀어 넣지 않는다.

```json
{
  "source": {
    "kind": "scene",
    "targets": [
      {"presetId": "uniform-expressions", "sceneId": "happy", "expectedRevision": 1, "count": 3},
      {"presetId": "uniform-expressions", "sceneId": "calm", "expectedRevision": 1, "count": 2}
    ]
  },
  "seedPolicy": {"kind": "increment", "firstSeed": 1000},
  "budget": {"maxImages": 5, "maxAnlas": 20}
}
```

계획 결과의 `planId`, `planHash`를 그대로 `generation.enqueue`에 전달한다. MCP 도구의
공통 바깥 입력은 `{requestId, input}`이다. 통신 결과를 모를 때는 같은 requestId로
조회/재요청하며 새 ID로 동일 생성을 제출하지 않는다.

저장 위치는 이미 설정한 루트의 폴더 ID와 하위 `pathSegment`로 지정한다. 임의의
새 절대 경로/드라이브 루트를 전송하는 API는 이번 범위에 포함하지 않는다. 최초 루트는
앱의 저장 위치 설정에서 등록한다. 공개 명령에 경로를 인코딩해서 우회하지 않는다.
폴더 생성은 실제 디렉터리 권한 확인과 생성이 일어날 수 있다.

폴더 생성/편집은 `autoUpload` 및 기존 `r2ProfilePolicy` / `r2BucketPolicy` /
`r2PrefixPolicy`를 지원한다. 값은 `{mode: inherit}`, `{mode: clear}` 또는
`{mode: set, value: ...}`이다. 연결이 잠시 사용 불가여도 저장한 업로드 선호를 끄지 않는다.
실제 업로드는 계획 시의 고정 목적지, 승인 정책, 자격 증명 확인을 모두 통과해야 한다.

## 승인과 재시작

- 기본 제안 모드에서는 원본 입력의 바뀌는 내용을 앱에서 확인하고 승인한다.
- 제한 자동 모드는 별도 에셋 편집 허용, 기존 폴더 생성/이름 변경 권한,
  R2 연결별 업로드 권한, 비용/수량/만료 한도를 사용한다.
- 기존 정책을 읽을 때 새 에셋 편집 권한은 꺼진 상태로 추가한다. 이전 생성 권한을 확대하지 않는다.
- 변경 대상을 현재 버전과 해시로 고정하고, 승인 후 다시 읽어 같을 때만 저장한다.
- 저장 결과를 기록하기 전에 중단되면, 정확히 일치하는 저장 결과만 확인해서 복구한다.
  결과가 불명확할 때 편집이나 생성을 자동으로 다시 실행하지 않는다.
- Scene 생성 계획은 ID/seed/검토 시각과 해시를 저장한다. 재시작 후 현재 저장소를
  다시 읽어 동일 계획인지 확인하고, 원래 승인 ID에 연결된 batch/job만 재사용한다.

## 실제 Codex 연결

현재 소스의 stdio 실행 진입점은 `scripts/run-agent-mcp-stdio.mjs`다. Node 24,
실제 Python 실행 파일, 실행 중인 앱에서 등록한 공개 접속 JSON, 기존 inbox가 필요하다.
비밀키는 Windows 자격 증명 저장소에 남고 Python 서명 경로에서만 읽는다.

1. 최신 빌드의 NAI Blue에서 AI 접속을 등록하고 비밀키 없는 접속 정보를 JSON 파일로 저장한다.
2. 해당 JSON과 inbox, Node 24/Python 경로로 Codex MCP 서버를 등록한다.
   로컬 Codex CLI의 `mcp add --help`로 아래 형식을 확인했다.
3. 새 MCP 도구 목록에서 `scene.patch_many`, `folder.apply_changes`, Scene `generation.plan`
   지원을 확인하고 위의 저장 → 계획 → 등록 흐름을 실행한다.

```powershell
codex mcp add nai-blue -- <NODE_24_EXE> <REPO>/scripts/run-agent-mcp-stdio.mjs --connection <PUBLIC_CONNECTION_JSON> --inbox-dir <APP_INBOX> --python <PYTHON_EXE>
```

이 문서의 명령은 설치를 실행한 기록이 아니다. 2026-09-08 현재 Codex 설정에는
NAI Blue MCP가 없으며, 이번 구현 중 호스트 설정·클라이언트 등록·실제 NAI 비용 지출·R2 공개를 변경하지 않았다.

## 검증 경계

- 공식 MCP SDK의 실제 handshake/tool schema/호출 → dispatcher → 영구 계획 → 기존 승인 coordinator →
  실제 IndexedDB Scene Queue 등록/동일 요청 재전달 검증을 수행한다. 해당 테스트의 native inbox/서명은 모의 포트다.
- 실제 Scene 저장소·Artifact 연결·Zustand 결과 표시·저장된 탐색 구조의 재수화로
  프리뷰와 설정 버전/결과 이력이 유지되는지 검증한다. Artifact/이미지는 테스트 자료다.
- 모의 테스트 통과를 실제 Codex 호스트 연결, 실제 NAI 생성, 실제 R2 업로드 완료로 보고하지 않는다.
- 전체 검증 결과와 남은 실제 실행 증거는 `docs/releases/evidence/agent-folder-production-2026-09-08.json`에 기록한다.

폴더 전체 삭제/새 드라이브 루트 등록, 무인 앱 기동, 설치형 sidecar 패키징,
한 요청에서 100장을 넘는 자동 분할 실행은 이번 코드의 지원 범위가 아니다.
