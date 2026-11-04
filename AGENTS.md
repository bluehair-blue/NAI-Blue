<!-- AUTONOMY DIRECTIVE — DO NOT REMOVE -->
NAI Blue는 Computer Use로 조작하지 않는다. 막히면 공식 자동화 경로를 진단하고 보고한다.
에이전트는 `nai-blue://guides/agent-workflow/v1`을 읽고 등록된 MCP를 사용한다. CUA·CDP·브라우저 자동화·비공개 API·토큰 추출 또는 승인 클릭으로 정책과 호환성 검증을 우회하지 않는다. 앱 내 인간 승인은 인간이 직접 수행한다.
각 공개 MCP tool 호출 직전 같은 연결에서 최신 가이드를 다시 읽는다. 가이드 읽기는 한 호출에서 소비되며 권한 승인을 대신하지 않는다. 가이드·capability resource와 tools/list는 이 gate의 예외다. V5는 standard, V4.5 최종 원문은 verbatim 모드를 사용한다.

EXECUTE TASKS TO COMPLETION WITHOUT ASKING FOR PERMISSION.
DO NOT STOP TO ASK "SHOULD I PROCEED?" — PROCEED. DO NOT WAIT FOR CONFIRMATION ON OBVIOUS NEXT STEPS.
IF BLOCKED, TRY AN ALTERNATIVE APPROACH. ONLY ASK WHEN TRULY AMBIGUOUS OR DESTRUCTIVE.

# Overview

You possess highly advanced problem-solving capabilities, but you may sometimes become overly absorbed in a problem—a “rabbit hole”—in pursuit of a perfectly complete conclusion. To ensure practical and timely feedback, strictly follow the **Heuristic & Validation Limits** below.

## Comments

Most important elements—including code lines, modules, and files—require comments to support code review, debugging, and refactoring.

Each comment should address the following:

1. What dependencies the element requires
2. Which other elements it interacts with
3. Why the element is necessary
4. How it works and what outcome it produces

Comments should not be excessively detailed, but they should not be so broad that they become unhelpful.

Add comments only after considering the maintenance-efficiency trade-off: the value of the comment should justify the cost of maintaining it.

## The Inefficiency of Over-Fixation

1. Do not spend too much time trying to solve a single problem. The maximum number of attempts is three.

Remember that failure is the mother of success. If a problem appears difficult to resolve within the current session, leave an insight that introduces a perspective different from the approaches already attempted, hand the problem off to another session, and continue with other work.

2. Attempting to validate every minor issue can reduce both efficiency and overall consistency.

In some cases, an appropriate heuristic produces better results than exhaustive validation.

## Solutions

* Do not attempt to write code that perfectly covers every edge case. First provide the most intuitive and generally applicable solution that satisfies at least 80% of the user’s requirements.

* Do not investigate excessively deep root causes, such as internal bugs in a specific library or framework. When an immediately applicable workaround or heuristic-based alternative exists, prioritize it.

* When progress is blocked by insufficient information, do not repeatedly question the user or wait until a perfect logical model can be established. Assume the most probable general scenario as a heuristic and develop the answer fully based on that assumption. However, clearly state the assumptions you made.

* Do not attempt internal self-correction more than three times to resolve the same error or logical contradiction. If a perfect solution is not found within three attempts, stop validating. Conclude the response by presenting the currently identified limitations of the problem and the best available imperfect alternative.

* Apply strict logical or mathematical validation only to the user-defined critical path. For extreme edge cases with a probability of occurrence below 1%, or for secondary performance optimizations, omit exhaustive validation and use heuristics instead.

* When you recognize a dilemma in which two or more conditions conflict and complete logical consistency cannot be achieved, stop validation immediately. Do not force a contrived solution. Present only the trade-offs of each option and leave the final decision to the user.

<!-- END AUTONOMY DIRECTIVE -->

## NAI Blue workspace source of truth

- Keep one Windows application runtime at the registered installation path. The user explicitly requires old executable copies, installer/source distribution copies, and obsolete build caches to be deleted, with Git commits/branches/tags retained. Do not create binary rollback/backup copies. Move a verified new build into that installation only after the existing process is safely stopped; preserve source changes, credentials, application data, and durable pending/unknown requests. Required runtime dependencies are not alternate app copies. After deployment, remove disposable build output and verify the installed hash, process path, and public MCP response.
- To locate the current Windows installation and this checkout's release build, run `powershell -NoProfile -File scripts/inspect-agent-runtime.ps1` first. It reads current uninstall registration and reports executable versions, hashes, running paths, and the MCP entry point without changing anything. Do not recursively search old checkouts or assume Program Files contains the current installation.
- The installed app and source-based MCP adapter update separately. `scripts/run-agent-mcp-stdio.mjs` loads this checkout when the MCP connection starts, with file watching disabled. An app update does not update the checkout, rewrite host MCP settings, or reload an existing adapter. Verify capabilities after a safe reconnect; preserve pending requests. Same version numbers do not prove identical builds.
- Windows MCP now re-resolves the registered installation for every new call and verifies the app's native startup hash and PID through `nai-blue://runtime`. It starts only the sole registered app when closed; it never terminates an existing process. Signed `expectedRuntimeHash` prevents pending new work from executing on a different build. Installed updates are detected without changing Pi/Codex command paths. Source changes explicitly require MCP reconnection; historical receipts stay readable. “Latest” is the current canonical deployed installation, not an automatic remote download.

- The repository root of the current checkout is the canonical working directory.
- Run repository searches, edits, installs, builds, and tests from that E-drive checkout.
- Do not use a C-drive or OneDrive NAI Blue checkout, mirror, cache, or generated guidance as a source of truth; those project copies are legacy unless the user explicitly reactivates one.
- Current runtime code, current user direction, and freshly passing tests are the implementation authority.
- The canonical upstream is the `origin` remote at `https://github.com/bluehair-blue/NAI-Blue.git`; the retired private review repository must not be restored as a remote or release authority.
- `1.0.0` resets only the public version line and tag. Existing features, persisted data, installation identity, and migration compatibility must not be reset.
- These rules govern project/source locations. External toolchains may remain installed elsewhere when the build explicitly requires them.
