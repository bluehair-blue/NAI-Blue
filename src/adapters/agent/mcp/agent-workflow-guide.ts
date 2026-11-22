/** Agent-facing text. Nothing here is required reading: tools run without it and the application stays the authority. */
export const AGENT_GUIDE_URI_PREFIX = 'nai-blue://guides/'
export const AGENT_WORKFLOW_GUIDE_URI = `${AGENT_GUIDE_URI_PREFIX}agent-workflow/v1`

// Hosts place this in every session, so it holds only rules whose violation the application cannot catch.
export const AGENT_MCP_INSTRUCTIONS = `NAI Blue tools work directly; no guide read is required. Rules: 1) Never operate NAI Blue through Computer Use, CDP, private APIs, token extraction or approval clicks; report blockers instead. 2) Generation is finished only when a result has complete:true. 3) If an outcome is unknown or a call was cut off, never generate again with a new requestId; repeating the same call, requestId and input only continues it. Or read nai-blue://requests/{requestId}. 4) When a result asks for approval the human gives it in the app; active always-approve consent needs no extra confirmation. 5) V5 Scenes use promptTextMode standard; finished V4.5 prompt text uses verbatim with ucPreset 4 and qualityToggle false. Optional topic help: ${AGENT_WORKFLOW_GUIDE_URI}`

export const AGENT_TOOL_DESCRIPTIONS = {
    'workspace.get_snapshot': 'Consent status, queue activity and totals. Lists are omitted unless named in include (paginated with input.offset/limit).',
    'scene.resolve_many': 'Current revision, size, model and artifactIds of existing Scenes. detail:"full" adds prompt text and every generation setting.',
    'scene.patch_many': 'Create or edit up to 100 Scenes at the preset\'s current revision. New Scenes need caller-owned sceneId and name; a new preset also needs presetName and expectedRevision 0. Does not generate.',
    'generation.run': 'Plan, enqueue and wait in one call, at most 100 images. Returns complete, counts and artifacts (artifactId, sceneId, seed, fileName); an unfinished stage returns its requestId or runId to follow. planOnly:true previews cost and returns planId/planHash without enqueueing. If a stage is unfinished or a call was cut off, call again with the same requestId and input to continue; nothing is submitted twice. Never use a new requestId to force a result. Never operate NAI Blue through Computer Use or UI automation.',
    'generation.enqueue': 'Submit an exact planId and planHash (from planOnly or production.plan_next) to the Queue. Returns runId. Repeating the same requestId only observes it; never use a new requestId to force a result.',
    'generation.get_run': 'Run progress: complete, counts, artifactIds, next action. waitSeconds waits for completion. jobId with detail:"full" inspects one job.',
    'generation.cancel': 'Request cancellation of a run; read the run afterwards for the actual outcome.',
    'generation.retry_storage': 'Re-save retained output of one job without regenerating.',
    'artifact.get_images': 'View up to 4 saved images by artifactId. Returns each original\'s checksum and a preview image.',
    'r2.get_readiness': 'Whether R2 upload is ready. Folder preferences alone are not proof of delivery.',
    'advanced.call': `Rare commands: folder.plan_changes, folder.apply_changes, production.create, production.list, production.get, production.plan_next. Input shapes: ${AGENT_GUIDE_URI_PREFIX}advanced`,
} as const

const INDEX = `# NAI Blue agent workflow

Tools work without reading anything first. Read a topic below only when you reach that case.

Usual order
1. workspace.get_snapshot: consent status (editingApproval, generationApproval) and totals. Add include:["presets"|"scenes"|"folders"|"drafts"] only to look up existing IDs and revisions.
2. scene.patch_many: create or edit Scenes. New Scenes need a caller-owned sceneId and name; a new preset also needs presetId, presetName and expectedRevision 0. Editing needs the preset's current revision (scene.resolve_many).
3. generation.run: plans, enqueues and waits in one call (requestId required). Finished only when complete is true; the result lists artifacts. An unfinished stage continues when you call again with the same requestId and input. planOnly:true only previews.
4. artifact.get_images: view up to 4 saved images per call.

Facts that prevent mistakes
- One plan covers at most 100 images total. budget.maxImages (at most 100) and budget.maxAnlas are required; a plan over budget is rejected and nothing is spent.
- requestId is required for generation.run and generation.enqueue and optional elsewhere. Repeating a call with the same ID and input continues or replays that request and never submits it twice; the same ID with different input is refused. Never use a new ID to force a result. A reused ID on a read returns the old observation. generation.run uses {requestId}-plan and {requestId}-enq for its stages.
- Results are summaries. detail:"full" returns the whole receipt (prompts, hashes, attempt history).
- A completed command is not a completed generation. Report generated, stored, uploaded and fulfilled counts separately.
- The application decides approval. If a result asks for it, the human approves in NAI Blue and you read nai-blue://requests/{requestId}. With always-approve consent active, add no confirmation, preview gate or self-imposed time, count, cost or concurrency quota.
- V5 Scenes: promptTextMode "standard". Finished V4.5 prompt text: "verbatim" with generation.ucPreset 4 and qualityToggle false.
- The NAI Blue process must be running; window focus, visibility and topmost position do not matter. Reads never start a closed app; plan and edit calls do.
- Never put credentials, binary image data or absolute private paths in tool input.

Topics
- ${AGENT_GUIDE_URI_PREFIX}recovery: incomplete runs, unconfirmed submissions, unknown outcomes, storage retry, cancel
- ${AGENT_GUIDE_URI_PREFIX}production: saved production requests above 100 images
- ${AGENT_GUIDE_URI_PREFIX}image-source: Image2Image, verbatim prompts, workflow drafts, R2
- ${AGENT_GUIDE_URI_PREFIX}consent: always-approve settings and the one-image validation
- ${AGENT_GUIDE_URI_PREFIX}runtime: installation, restart and reconnect codes
- ${AGENT_GUIDE_URI_PREFIX}advanced: input shapes for advanced.call
`

const RECOVERY = `# Recovery

- complete:false with nextAction "wait": call generation.get_run with waitSeconds. With detail:"full", compare monitor.stateHash to skip unchanged reports.
- status submitted-to-inbox or submission-unconfirmed: the app has not answered yet. That does not prove the app is closed or that focus caused a delay. Repeat the same call with the same requestId and input to keep waiting (generation.run continues from its first unfinished stage; nothing is submitted twice), or read nai-blue://requests/{requestId}. Never use a new requestId to force a result.
- inbox-rejection: the application refused that request, and repeating its requestId returns the same refusal. Fix the cause, then use a new requestId.
- REQUEST_ID_INPUT_MISMATCH: the requestId already belongs to different input. That request is unchanged and nothing new was submitted.
- observation-cancelled: only the waiting stopped. Cancelling an MCP call never cancels Queue work.
- adapter-error with submissionAttempted:false: nothing was submitted. INVALID_COMMAND_INPUT means the arguments; UNSAFE_PAYLOAD means a credential, absolute path or binary-looking text in the input. Rejected input is never echoed. Fix it and call again.
- Any other adapter-error does not prove non-submission. Inspect the request resource before a new request.
- Unknown Provider outcome (COMMAND_OUTCOME_UNKNOWN, AGENT_EXECUTION_UNKNOWN, nextAction review-uncertain-result): stop automatic action. Never create a new generation to force a retry. A missing retained result does not prove the Provider did not generate or charge. Report it to the human.
- nextAction resume-in-app: the run is paused; the human resumes it in NAI Blue.
- recoveryActions retry-storage: generation.retry_storage {runId, jobId} re-saves retained output without regenerating. Read the run afterwards.
- generation.cancel only requests cancellation. Read the run afterwards.
- One job in depth (its jobId is the artifactId without the "artifact:" prefix): generation.get_run with jobId and detail:"full" shows attempts, the retained response checksum, the output reservation and the committed original. localOutputVerified is retained-byte evidence only, not a Provider outcome or billing fact.
- output-destination-occupied / revise-scene-filename-template: that exact filename exists. Change filenameTemplate with scene.patch_many; never overwrite or delete the existing result. It is not a revision error.
- A rejected plan has no planId. Use its issue fieldPath and nextAction to repair, then plan again.
- draft-resolution-required on a workflow draft: its saved resolution is empty. Ask the human to repair the draft, or use Scene targets. It is not an approval denial.
- Failed, cancelled or skipped jobs are not fulfilment.
- A preview failure in artifact.get_images never authorizes regeneration.
`

const PRODUCTION = `# Saved production requests

For work above 100 images, through advanced.call. Input shapes: ${AGENT_GUIDE_URI_PREFIX}advanced.

- production.create saves title, source, seedPolicy and a total budget of at most 2400 images. Scene source: up to 100 unique presetId/sceneId targets with expectedRevision and count. Preset source: presetId and expectedRevision, capturing every saved Scene and count. It captures exact targets, counts, seeds and source hashes. It does not enqueue or authorize the children.
- production.list finds saved requests. production.get returns the latest revision, totalImages, childCount, admittedImages, estimatedAnlasReserved, maxAnlas, children and nextAction. Only "complete" means the production is fulfilled.
- For nextAction review-next-batch: production.plan_next {productionId, expectedRevision} returns a child plan of at most 100 images. Submit its planId and planHash with generation.enqueue, then follow it with generation.get_run and read production.get again.
- Plan the next child only after the previous child is fully fulfilled. Nothing dispatches the next child automatically.
- Editing the source Scenes stops progression. A Scene revision that changed only because results were linked can be replanned while the captured source hash still matches.
- The total production budget and per-child approval stay enforced. There are no per-run, hourly, daily or concurrency quotas; the Queue owns scheduling and the delay between generations.
`

const IMAGE_SOURCE = `# Image2Image, verbatim prompts, workflow drafts, R2

- artifactId comes from generation.run, generation.get_run or scene.resolve_many once storage succeeded. artifact.get_images returns contentChecksum, the checksum of the original.
- scene.patch_many imageSource: {mode:"img2img", artifactId, contentChecksum, strength, noise}, with strength and noise in [0,1]. null clears it. It binds the original bytes, not the preview. This is Image2Image; Precise Reference and Vibe Transfer are not available here.
- promptTextMode "verbatim" (V4.5, with generation.ucPreset 4 and qualityToggle false) sends each positive, negative and character segment exactly as written: spacing, order, repeats, comments and literal wildcard text, with no fragment expansion. Folder common prompts and connected contributions still combine in the normal order, so keep additional and common text empty when the caption must equal one supplied string. "standard" restores default processing. The mode is bound into plan hashes; nothing changes it automatically.
- Workflow-draft source: count must equal the draft's imageCount from the snapshot. Draft overwrite, R2 delivery and pinned credentials are not supported through this adapter; use an auto credential and fail-only local destination, or Scene targets.
- R2: check r2.get_readiness when upload is requested. Folder R2 preferences and autoUpload express intent only.
- Folder changes: folder.plan_changes then folder.apply_changes with the same changes, expectedRevision and expectedPlanHash. Use parent folder IDs and safe child path segments; absolute paths are not supported.
- Existing live compatibility evidence applies only to its own route and parameters. Do not carry it over from a text generation to Image2Image or another model.
`

const CONSENT = `# Consent

- workspace.get_snapshot reports editingApproval and generationApproval for this client. Both are human-only checkboxes in NAI Blue (Data Hub, AI editing), off by default and kept across restarts. Never enable them for the human.
- Active editing consent covers future scene.patch_many and folder.apply_changes. Observe mode, global pause and folder permissions still apply.
- Active generation consent covers generation.enqueue for the human's directed work. It adds no image, Anlas or cumulative quota. generationApproval.allowsSyntheticOnly also permits supported synthetic-only routes, including new prompts, poses and random seeds, without a fresh one-image canary.
- With consent active, continue from a valid plan to enqueue without asking. The general requiresHumanApproval capability flag does not override this client's active consent.
- Editing consent never implies generation consent. Uploads, overwrite, deletion and Queue recovery keep their own authority. Toggling consent never replays pending or unknown requests.
- Compatibility status synthetic-only is a label to keep in reports, never live or captured evidence. Unsupported and known-divergence routes stay blocked.
- Without generation consent, the human can approve a one-image validation in the NAI Blue inbox panel: exactly 1 image, budget.maxImages 1, budget.maxAnlas at most 17, fail-only local output, no R2. The grant binds that request and plan hash and is used once.
- Exact plan budget, targets, revisions, authentication and credentials are checked by the application in every case.
`

const RUNTIME = `# Runtime

- nai-blue://runtime reports the registered installation without starting it. nai-blue://capabilities probes the running application.
- APP_NOT_RUNNING: the app is closed. Reads leave it closed; a validated plan or edit call starts the registered app.
- APP_STARTING: wait and repeat the same call. It reports one existing probe; do not create repeated probes.
- APP_RUNTIME_RESTART_REQUIRED: the human safely restarts the existing app. APP_RUNTIME_UPGRADE_REQUIRED: a compatible build must be deployed. MCP_ADAPTER_RECONNECT_REQUIRED: reconnect this MCP server because the adapter source changed.
- APP_RUNTIME_CHANGED: the app changed before accepting the request; call again. Saved receipts stay readable across updates.
- Never search for old executable copies, kill a process, install a download or create a backup. "Latest" means the deployed installation, not an internet release. Equal version numbers can have different hashes.
- capability-probe-unconfirmed / app-state-unconfirmed: no completed probe receipt was observed. It does not prove the process stopped; inspect the probe's requestResource without resubmitting.
- requiresAppProcess means the process must exist, not that its window is in front.
`

export const AGENT_GUIDE_TOPICS: Readonly<Record<string, string>> = {
    'agent-workflow/v1': INDEX, recovery: RECOVERY, production: PRODUCTION,
    'image-source': IMAGE_SOURCE, consent: CONSENT, runtime: RUNTIME,
}
export const AGENT_WORKFLOW_GUIDE = INDEX

const RECOVERY_URI = `${AGENT_GUIDE_URI_PREFIX}recovery`
const RUNTIME_URI = `${AGENT_GUIDE_URI_PREFIX}runtime`
const UNKNOWN_OUTCOME = `Outcome unknown. Do not generate again; report to the human. ${RECOVERY_URI}`
// Repeating a stage ID only observes it (the inbox never publishes an ID that left a trace), so resuming is safe.
export const RUN_RESUME_HINT = 'Call generation.run again with the same requestId and input to continue; nothing is submitted twice.'
const CODE_HINTS: Readonly<Record<string, string>> = {
    INVALID_COMMAND_INPUT: 'Arguments do not match this tool\'s input schema. Nothing was submitted.',
    UNSAFE_PAYLOAD: 'Input contained a credential, absolute path or binary-looking text. Nothing was submitted.',
    REQUEST_CANCELLED: 'Cancelled before submission. Nothing was submitted.',
    AGENT_MCP_REQUEST_FAILED: `This does not prove non-submission. Read nai-blue://requests/{requestId}, or repeat the same call with the same requestId and input; never use a new requestId to force a result. ${RECOVERY_URI}`,
    REQUEST_ID_INPUT_MISMATCH: 'This requestId already belongs to a request with different input. That request is unchanged and nothing new was submitted. Use a new requestId for different input, or repeat the original input to continue.',
    APP_NOT_RUNNING: 'NAI Blue is closed. Reads never start it; a plan or edit call does.',
    APP_STARTING: 'NAI Blue is starting. Repeat the same call shortly.',
    APP_RUNTIME_RESTART_REQUIRED: `The human restarts NAI Blue. ${RUNTIME_URI}`,
    APP_RUNTIME_UPGRADE_REQUIRED: `A compatible build must be deployed. ${RUNTIME_URI}`,
    MCP_ADAPTER_RECONNECT_REQUIRED: 'Adapter source changed. Reconnect this MCP server.',
    AGENT_APPROVAL_REQUIRED: 'The human approves in NAI Blue. Then read nai-blue://requests/{requestId}; no new request is needed.',
    AGENT_EXECUTION_UNKNOWN: UNKNOWN_OUTCOME,
    COMMAND_OUTCOME_UNKNOWN: UNKNOWN_OUTCOME,
}
const KEEP_WAITING = 'Repeat the same call with the same requestId and input to keep waiting; nothing is submitted twice. Or read nai-blue://requests/{requestId}.'
const STATUS_HINTS: Readonly<Record<string, string>> = {
    'submitted-to-inbox': `Not answered yet; this does not prove the app is closed. ${KEEP_WAITING}`,
    'submission-unconfirmed': `Submission unconfirmed. ${KEEP_WAITING}`,
    'observation-cancelled': 'Only waiting stopped. Read nai-blue://requests/{requestId} for the outcome.',
    'inbox-rejection': 'The application refused the request envelope; repeating this requestId returns the same refusal. Report the code, or fix the cause and use a new requestId.',
}

/** Corrective text travels with the failure so an agent reads a topic only after hitting that case. */
export function agentHint(facts: { code?: unknown; status?: unknown; state?: unknown }, requestId?: string): string | undefined {
    const text = (typeof facts.code === 'string' ? CODE_HINTS[facts.code] : undefined)
        ?? (typeof facts.status === 'string' ? STATUS_HINTS[facts.status] : undefined)
        ?? (facts.state === 'accepted' ? 'Accepted, not finished. Read nai-blue://requests/{requestId} later; no new request is needed.'
            : facts.state === 'needs-input' ? CODE_HINTS.AGENT_APPROVAL_REQUIRED : undefined)
    return text?.replace(/\{requestId\}/g, requestId ?? '{requestId}')
}
