# NAI Blue

<p align="center">
  <img src="public/nai-blue.png" alt="NAI Blue 로고" width="128" height="128">
</p>

<p align="center">
  NovelAI 이미지 생성 작업을 작성하고 정리하며 실행하는 데스크톱·Android 작업공간
</p>

<p align="center">
  <a href="./README.md">English</a> ·
  <a href="./README.ko.md">한국어</a> ·
  <a href="./README.ja.md">日本語</a>
</p>

> NAI Blue는 독립 커뮤니티 클라이언트이며 NovelAI와 제휴하거나 공식 승인을 받은 제품이 아닙니다.

## 설치

[GitHub Releases](https://github.com/bluehair-blue/NAI-Blue/releases/latest)에서 운영체제에 맞는 설치 파일을 받으세요.

- Windows: 일반적으로 `x64-setup.exe`를 사용합니다. 관리형 환경을 위한 MSI도 제공합니다.
- macOS: Apple Silicon은 `aarch64`, Intel Mac은 `x64` 빌드를 사용합니다. 출처를 확인한 파일인데도 손상되었다는 경고가 나오면 터미널에서 `xattr -cr "/Applications/NAI Blue.app"`을 실행하세요.
- Android: 서명된 universal APK를 설치합니다. APK를 연 앱에 ‘알 수 없는 앱 설치’ 권한을 허용해야 할 수 있습니다.

## 처음 사용하기

1. NAI Blue를 실행하고 최초 설정은 **Guided** 화면에서 진행합니다.
2. 계정/API 단계에서 NovelAI 계정을 연결하고 토큰을 검증합니다.
3. **개별 이미지** 또는 **여러 이미지** 작업을 선택합니다.
4. 메인·네거티브·캐릭터 프롬프트를 작성합니다. 캐릭터 위치 기본값은 중앙인 `0.5, 0.5`이며 작업마다 따로 조정할 수 있습니다.
5. 출력 폴더와 메타데이터 정책을 정한 뒤 설정을 검토하고 대기열에 추가합니다.
6. **대기열**에서 진행 상황과 각 작업의 생성 폴더를 확인합니다.

지원되는 데스크톱에서는 운영체제 자격 증명 보관소에 인증 정보를 저장합니다. NovelAI 토큰, R2 secret, private sidecar를 이슈에 붙이지 마세요.

## 주요 사용 흐름

### 프롬프트 모듈

Guided 또는 고급 생성 화면에서 프롬프트 모듈 라이브러리를 엽니다. 폴더로 모듈을 분류하고 베이스·세부·추가·네거티브·캐릭터·캐릭터 네거티브 파트를 저장할 수 있습니다. 삽입 시 필요한 파트만 선택할 수 있으며 캐릭터 좌표는 모듈이 아니라 현재 작업에 종속됩니다.

### 이미지 메타데이터 불러오기

프롬프트 불러오기 영역에 PNG, WebP, JPEG, `.nai-blue.json` sidecar 또는 지원되는 메타데이터 추출 JSON을 놓으세요. 메인 프롬프트와 캐릭터 프롬프트가 동일한 편집 형식으로 변환됩니다. 다른 자동화 도구에서 이전할 수 있도록 NAIS2·NAIS3 메타데이터를 읽되, 해당 식별자는 가져오기 경계에서만 인식하며 NAI Blue 데이터로 다시 기록하지 않습니다.

### 생성 폴더와 R2

작업을 대기열에 넣기 전에 생성 폴더를 만드세요. 폴더마다 로컬 저장 위치, 공통 프롬프트, R2 프로필, 버킷, 프리픽스, 자동 업로드 여부를 설정할 수 있습니다. 하위 폴더는 명시적으로 덮어쓰지 않는 한 상위 프리픽스를 이어받습니다.

R2 프로필 설정과 연결 확인이 끝나기 전에는 R2 옵션이 비활성화됩니다. **R2 설정** CTA로 이동해 연결을 검증한 뒤 필요한 폴더에서 자동 업로드를 켜세요. 로컬 원본 삭제는 항상 별도의 명시적 선택입니다.

### 이미지 정화와 sidecar

메타데이터 단계에서 이미지 내장, sidecar 전용, 정화 이미지와 private sidecar 분리, 완전 제거 중 하나를 고를 수 있습니다. 정화 흐름은 픽셀만 다시 인코딩하고 복원용 메타데이터를 private sidecar로 분리하며, 설정한 권리 소유자 XMP를 추가할 수 있습니다.

## 디버깅 및 오류 제보

제보 전 다음을 확인하세요.

1. 같은 입력으로 한 번 다시 시도하고 실패한 정확한 단계를 기록합니다.
2. **설정 → 고급 설정 및 진단**을 엽니다.
3. 관련 이벤트를 선택하고 **정제된 진단 로그**를 복사하거나 내보냅니다.
4. 최신 릴리즈 안내와 기존 [이슈](https://github.com/bluehair-blue/NAI-Blue/issues)를 확인합니다.

[버그 리포트](https://github.com/bluehair-blue/NAI-Blue/issues/new?template=bug_report.yml)에는 다음을 포함하세요.

- NAI Blue 버전, 운영체제, 설치 방식
- 가장 짧은 재현 순서
- 기대한 결과와 실제 결과
- 표시된 `DiagnosticCode`와 정제된 로그
- 토큰·경로·프롬프트·private 메타데이터를 가린 스크린샷

NovelAI 토큰, Cloudflare secret, 서명 키, 원본 credential backup, 검토하지 않은 private sidecar는 첨부하지 마세요. 보안 취약점은 공개 이슈 대신 저장소의 비공개 Security Advisory로 제보하세요.

## 소스 빌드와 디버깅

Node.js 24 LTS, npm, Rust 1.93 이상, Tauri용 네이티브 빌드 도구가 필요합니다. 태거 sidecar를 다시 빌드할 때는 Python 3.11도 필요합니다.

```bash
git clone https://github.com/bluehair-blue/NAI-Blue.git
cd NAI-Blue
npm ci
npm run tauri dev
```

주요 검사 명령:

```bash
npm run lint
npm run test:composition
npm run build
npm run tauri build
```

릴리즈와 서명 절차는 [RELEASING.md](./RELEASING.md)를 참고하세요.

## 크레딧 및 라이선스

NAI Blue는 [NAIS2](https://github.com/sunanakgo/NAIS2)에서 시작된 작업을 이어갑니다. 원 개발자와 기여자에게 감사드립니다. 와일드카드와 씬 작업 흐름은 [NAIA2.0](https://github.com/DNT-LAB/NAIA2.0), [SDStudio](https://github.com/sunho/SDStudio)도 참고했습니다.

[GPL-3.0](./LICENSE) 라이선스로 배포합니다.
