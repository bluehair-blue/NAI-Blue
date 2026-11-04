# 자동화 에이전트 진입 안내

NAI Blue는 Computer Use로 조작하지 않는다. 막히면 공식 자동화 경로를 진단하고 보고한다.
공개 MCP tool을 호출할 때마다 같은 연결에서 직전에 `nai-blue://guides/agent-workflow/v1`을 읽는다. 한 번 읽으면 한 호출만 허용하며, 미독·소비된 상태는 `GUIDE_READ_REQUIRED`로 inbox 제출 전에 차단한다. 가이드·capability resource와 tools/list는 항상 조회할 수 있고 읽기 권한을 소비하지 않는다.

V5 설계는 `standard`, V4.5 최종 원문은 `verbatim` + UC None(4) + 품질 태그 끄기를 사용한다. 프롬프트와 제목은 실행되지 않는 일반 텍스트로 보존한다. 인증·서명·revision, 실제 경로·자격증명·명시적 이미지/바이너리 보호는 유지한다. 가이드 읽기는 편집·생성 승인과 별개이며 현재 동의는 workspace snapshot에서 확인한다. `get_run`의 기록된 attempt evidence로 known-failure와 unknown을 구분하고, 불확실한 Provider 결과를 재생성하지 않는다.
CUA, CDP, 브라우저 자동화, 비공개 API, 토큰 추출 및 승인 클릭은 대체 경로가 아니다. 정책과 인간 승인 경계는 유지한다.

# NAI Blue

[작업 폴더 인덱스와 현재 설치본](docs/README.md) · [시작 응답성 개선 기록](docs/releases/시작%20응답성.md)

Windows agent runtime location: run `powershell -NoProfile -File scripts/inspect-agent-runtime.ps1` from this checkout. The read-only report resolves the registered installation and distinguishes it from any temporary local release build by SHA-256. Use the registered installation as the single application runtime; a null local build is normal after deployment cleanup. The development MCP entry point is `scripts/run-agent-mcp-stdio.mjs`; it loads source at connection startup. Updating the desktop app does not update this source adapter or the MCP host's configuration. Reconnect safely after source/configuration changes, preserve pending request IDs, and verify `nai-blue://capabilities` before claiming compatibility.

The Windows MCP entry now resolves that installation again before every new call. It normally starts the installed app when closed and verifies its native startup hash, PID, and version through `nai-blue://runtime`. Updating or relocating the installed app therefore needs no versioned Pi/Codex executable path. New requests carry a signed target hash; another build rejects them before acceptance. Pending probes and historical receipts are inspected without replaying work. A stale running app is never killed automatically, and changed adapter source explicitly requires reconnecting the MCP host. “Latest” means the current deployed installation; this mechanism does not download new internet releases. Existing MCP connections created before this guard was installed need one initial reconnect.

Run `npm run test:agent-runtime` for installation-change checks. `node scripts/verify-agent-mcp-runtime.mjs` accepts the same `--connection`, `--inbox-dir`, and `--python` arguments as the registered stdio entry and verifies the real app using public read operations only.

<p align="center">
  <img src="public/nai-blue.png" alt="NAI Blue logo" width="128" height="128">
</p>

<p align="center">
  A desktop and Android workspace for building, organizing, and running NovelAI image-generation workflows.
</p>

<p align="center">
  <a href="./README.md">English</a> ·
  <a href="./README.ko.md">한국어</a> ·
  <a href="./README.ja.md">日本語</a>
</p>

> NAI Blue is an independent community client and is not affiliated with or endorsed by NovelAI.

## Install

Download the installer for your platform from [GitHub Releases](https://github.com/bluehair-blue/NAI-Blue/releases/latest).

- Windows: use the `x64-setup.exe` installer. The MSI is also provided for managed environments.
- macOS: use the build that matches Apple Silicon (`aarch64`) or Intel (`x64`). If Gatekeeper reports that the app is damaged, run `xattr -cr "/Applications/NAI Blue.app"` in Terminal after confirming that the file came from this repository.
- Android: install the signed universal APK. Android may ask you to allow installs from the app that opened the APK.

## First run

1. Open NAI Blue and stay in the **Guided** surface for the initial setup.
2. Connect your NovelAI account in the account/API step and verify the token.
3. Choose **Single image** or **Batch images**.
4. Build the positive, negative, and character prompts. Character positions start at the center (`0.5, 0.5`) and can be adjusted per task.
5. Choose an output folder and metadata policy, then review the settings before adding the job to the queue.
6. Follow progress in **Queue**. Each queued job shows its destination folder.

Credentials are stored through the operating system credential vault on supported desktop platforms. Do not paste a NovelAI token, R2 secret, or private sidecar into an issue.

## Everyday workflows

### Prompt modules

Open the prompt module library from Guided or Advanced generation. Modules can be organized in folders and contain base, detail, additional, negative, character, and character-negative parts. Select only the parts you want when inserting a module; character positions remain task-specific.

### Import image metadata

Drop a PNG, WebP, JPEG, `.nai-blue.json` sidecar, or supported metadata-extraction JSON into the prompt import surface. NAI Blue maps main and character prompts into the same editor format. For migration from other automation tools, it reads NAIS2 and NAIS3 metadata; those identifiers are recognized only at the import boundary and are never written as NAI Blue data.

### Output folders and R2

Create generation folders before enqueueing work. Each folder can define its local destination, common prompt, R2 profile, bucket, prefix, and automatic-upload preference. Child folders inherit the parent prefix unless they explicitly override it.

R2 controls remain disabled until a profile passes setup. Use the **Set up R2** action, verify the connection, then enable automatic upload on the folders that need it. Deleting the local original is always an explicit, separate choice.

### Image cleanup and sidecars

The metadata step offers embedded metadata, sidecar-only, clean image plus private sidecar, and strip-only policies. The clean-image workflow re-encodes pixel data, keeps restoration metadata in a separate private sidecar, and can add the configured rights-owner XMP.

## Troubleshooting and bug reports

Before reporting a problem:

1. Retry once with the same inputs and note the exact step that failed.
2. Open **Settings → Advanced settings and diagnostics**.
3. Select the related event and copy or export the **sanitized diagnostic log**.
4. Check the latest release notes and existing [issues](https://github.com/bluehair-blue/NAI-Blue/issues).

Submit a [bug report](https://github.com/bluehair-blue/NAI-Blue/issues/new?template=bug_report.yml) with:

- NAI Blue version, operating system, and installation type;
- the shortest reproducible sequence;
- expected and actual behavior;
- the displayed `DiagnosticCode` and sanitized log;
- a screenshot with tokens, paths, prompts, and private metadata redacted.

Never attach a NovelAI token, Cloudflare secret, signing key, raw credential backup, or unreviewed private sidecar. For a security vulnerability, do not open a public issue; use the repository's private security advisory flow.

## Build and debug from source

Requirements: Node.js 24 LTS, npm, Rust 1.88 or newer, and the native build tools required by Tauri. Python 3.11 is required when rebuilding the tagger sidecar.

```bash
git clone https://github.com/bluehair-blue/NAI-Blue.git
cd NAI-Blue
npm ci
npm run tauri dev
```

Useful checks:

```bash
npm run lint
npm run test:composition
npm run build
npm run tauri build
```

Release process and signing requirements are documented in [RELEASING.md](./RELEASING.md).

## Credits and license

NAI Blue continues work that began with [NAIS2](https://github.com/sunanakgo/NAIS2). Thanks to its original maintainers and contributors. The wildcard and scene workflows also learned from [NAIA2.0](https://github.com/DNT-LAB/NAIA2.0) and [SDStudio](https://github.com/sunho/SDStudio).

Licensed under [GPL-3.0](./LICENSE).
